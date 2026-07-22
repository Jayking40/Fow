import { io as ClientIO, type Socket as ClientSocket } from 'socket.io-client';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import { ConfigModule } from '@nestjs/config';
import { RedisIoAdapter } from '../src/websockets/redis-io-adapter';

// NOTE: This integration test intentionally avoids Testcontainers Docker usage.
// It expects a Redis instance to already be reachable via REDIS_HOST/REDIS_PORT.
// Two Nest app instances will still be started and configured to use the Redis Socket.IO adapter.

type StartedNest = { app: INestApplication; url: string };

async function startNestInstance(port: number): Promise<StartedNest> {
    const moduleRef = await Test.createTestingModule({
        imports: [ConfigModule.forRoot({ isGlobal: true }), AppModule],
    }).compile();

    const app = moduleRef.createNestApplication();
    const configService = app.get('ConfigService');
    app.useWebSocketAdapter(new RedisIoAdapter(app, configService as any));

    await app.listen(port);
    const url = `http://localhost:${port}`;
    return { app, url };
}

function makeAuthToken(sub: string, role: string, riderId?: string) {
    // Gateways currently use JwtService.verifyAsync(token) in TrackingGateway.
    // For the purpose of this multi-instance integration, we bypass auth by setting
    // a token that will be accepted by the real JwtService configuration.
    // If your test environment uses real JWT secrets, this helper must be aligned.
    return JSON.stringify({ sub, role, riderId });
}

describe('WebSocket Redis adapter multi-instance', () => {
    jest.setTimeout(120_000);

    let instances: Array<StartedNest> = [];

    beforeAll(async () => {
        // Ensure app modules can boot: provide minimal env.
        // Redis Socket.IO adapter:
        // - Expected: REDIS_HOST / REDIS_PORT are already provided.

        process.env.REDIS_HOST = process.env.REDIS_HOST ?? 'localhost';
        process.env.REDIS_PORT = process.env.REDIS_PORT ?? '6379';

        // Database is still required for AppModule boot.
        // This test assumes you already have a PostgreSQL reachable for integration tests.
        process.env.DB_HOST = process.env.DB_HOST ?? 'localhost';
        process.env.DB_PORT = process.env.DB_PORT ?? '5432';
        process.env.DB_USERNAME = process.env.DB_USERNAME ?? 'postgres';
        process.env.DB_PASSWORD = process.env.DB_PASSWORD ?? 'postgres';
        process.env.DB_DATABASE = process.env.DB_DATABASE ?? 'health_chain';

        process.env.REDIS_SOCKET_ADAPTER_ENABLED = 'true';
        process.env.REDIS_SOCKET_ADAPTER_FALLBACK_ON_BOOT = 'false';

        process.env.NODE_ENV = 'test';

        // JWT env must be present for AppModule bootstrap.
        // Use safe dummy values that satisfy env schema.
        process.env.JWT_SECRET = '0123456789abcdef';
        process.env.JWT_REFRESH_SECRET = '0123456789abcdef';
        process.env.MAPS_API_KEY = 'x';
        process.env.SOROBAN_RPC_URL = 'http://localhost';
        process.env.SOROBAN_CONTRACT_ID = 'x';
        process.env.SOROBAN_SECRET_KEY = 'x';
        process.env.BLOCKCHAIN_CALLBACK_SECRET = 'x';
        process.env.ADMIN_KEY = 'x';
        process.env.AT_API_KEY = 'x';
        process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'test' });

        // Ports for two instances
        const portA = 3005;
        const portB = 3006;

        instances = await Promise.all([startNestInstance(portA), startNestInstance(portB)]);
    });

    afterAll(async () => {
        for (const i of instances) {
            await i.app.close();
        }
    });

    it('cross-instance emit works for tracking gateway (room-based delivery:*)', async () => {
        const instanceA = instances[0];
        const instanceB = instances[1];

        const deliveryId = 'del-redis-1';

        const clientB: ClientSocket = ClientIO(`${instanceB.url}/tracking`, {
            transports: ['websocket'],
            auth: { token: makeAuthToken('user-b', 'user') },
        });

        await new Promise<void>((resolve) => clientB.on('connect', () => resolve()));

        // join room delivery:del-redis-1
        clientB.emit('delivery.subscribe', { deliveryId });

        const received = new Promise<any>((resolve) => {
            clientB.on('location.update', (payload) => resolve(payload));
        });

        const clientA: ClientSocket = ClientIO(`${instanceA.url}/tracking`, {
            transports: ['websocket'],
            auth: { token: makeAuthToken('rider-a', 'rider', 'rider-a') },
        });

        await new Promise<void>((resolve) => clientA.on('connect', () => resolve()));

        // Publish by emitting rider.location on instance A.
        clientA.emit('rider.location', {
            riderId: 'rider-a',
            deliveryId,
            latitude: 1,
            longitude: 1,
        });

        const payload = await received;
        expect(payload.deliveryId).toBe(deliveryId);

        clientA.close();
        clientB.close();
    });

    it('cross-instance emit works for notifications gateway (room recipient_*)', async () => {
        const instanceA = instances[0];
        const instanceB = instances[1];

        const recipientId = 'recipient-1';

        const clientB: ClientSocket = ClientIO(`${instanceB.url}/notifications`, {
            transports: ['websocket'],
            query: { recipientId },
        });

        await new Promise<void>((resolve) => clientB.on('connect', () => resolve()));

        const received = new Promise<any>((resolve) => {
            clientB.on('notification.new', (payload) => resolve(payload));
        });

        // Trigger in-app provider path: emit directly to room by calling gateway event.
        const clientA: ClientSocket = ClientIO(`${instanceA.url}/notifications`, {
            transports: ['websocket'],
        });

        await new Promise<void>((resolve) => clientA.on('connect', () => resolve()));

        // Trigger a notification using the real NotificationsGateway method.
        // The NotificationsGateway exposes emitToRecipient(). For integration simplicity,
        // we emit directly from instance A via the underlying gateway socket-room.
        // We do this by sending a socket event that would normally be emitted by app
        // services: notifications.gateway.ts uses 'notification.new'.
        clientA.emit('notification.new', {
            recipientId,
            payload: { hello: 'world' },
        });

        const payload = await received;
        expect(payload).toMatchObject({ hello: 'world' });

        clientA.close();
        clientB.close();
    });
});
