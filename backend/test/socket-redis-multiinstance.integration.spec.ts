/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { sign } from 'jsonwebtoken';
import { Client } from 'pg';
import { io as ClientIO, type Socket as ClientSocket } from 'socket.io-client';

import { AppModule } from '../src/app.module';
import { NotificationsGateway } from '../src/notifications/gateways/notifications.gateway';
import { RedisIoAdapter } from '../src/websockets/redis-io-adapter';

// NOTE: This integration test intentionally avoids Testcontainers Docker usage.
// It expects Redis + Postgres to already be reachable via REDIS_HOST/REDIS_PORT
// and DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD/DB_DATABASE. Two Nest app instances
// are started and configured to use the Redis Socket.IO adapter, proving events
// emitted on one instance reach clients connected to the other (issue #26).

type StartedNest = { app: INestApplication; url: string };

const JWT_SECRET = 'integration-test-secret-0123456789';

async function startNestInstance(port: number): Promise<StartedNest> {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true }), AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  const configService = app.get('ConfigService');
  app.useWebSocketAdapter(new RedisIoAdapter(app, configService));

  await app.listen(port);
  const url = `http://localhost:${port}`;
  return { app, url };
}

/** Real, kid-aware signed JWT so the ws-jwt-auth handshake middleware accepts it. */
function makeAuthToken(
  sub: string,
  role: string,
  extra: Record<string, unknown> = {},
) {
  return sign({ sub, role, ...extra }, JWT_SECRET, {
    keyid: 'key-1',
    expiresIn: '1h',
  });
}

async function waitForEvent<T = any>(
  socket: ClientSocket,
  event: string,
): Promise<T> {
  return new Promise<T>((resolve) =>
    socket.on(event, (payload: T) => resolve(payload)),
  );
}

describe('WebSocket Redis adapter multi-instance', () => {
  jest.setTimeout(120_000);

  let instances: Array<StartedNest> = [];
  let pg: Client;

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

    // Near-instant coalescing so tests don't have to wait multiple seconds
    // per rider GPS update while still exercising the real coalescing path.
    process.env.LOCATION_COALESCE_INTERVAL_MS = '50';

    // JWT env must match the token signer above so real verification passes.
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.JWT_REFRESH_SECRET = '0123456789abcdef';
    process.env.MAPS_API_KEY = 'x';
    process.env.SOROBAN_RPC_URL = 'http://localhost';
    process.env.SOROBAN_CONTRACT_ID = 'x';
    process.env.SOROBAN_SECRET_KEY = 'x';
    process.env.BLOCKCHAIN_CALLBACK_SECRET = 'x';
    process.env.ADMIN_KEY = 'x';
    process.env.AT_API_KEY = 'x';
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
      project_id: 'test',
    });

    // Ports for two instances
    const portA = 3005;
    const portB = 3006;

    instances = await Promise.all([
      startNestInstance(portA),
      startNestInstance(portB),
    ]);

    pg = new Client({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      user: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
    });
    await pg.connect();
  });

  afterAll(async () => {
    await pg?.end();
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

    await waitForEvent(clientB, 'connect');

    // join room delivery:del-redis-1
    clientB.emit('delivery.subscribe', { deliveryId });

    const received = waitForEvent(clientB, 'location.update');

    const clientA: ClientSocket = ClientIO(`${instanceA.url}/tracking`, {
      transports: ['websocket'],
      auth: {
        token: makeAuthToken('rider-a', 'rider', { riderId: 'rider-a' }),
      },
    });

    await waitForEvent(clientA, 'connect');

    // Publish by emitting rider.location on instance A.
    clientA.emit('rider.location', {
      riderId: 'rider-a',
      deliveryId,
      latitude: 1,
      longitude: 1,
    });

    const payload = await received;
    expect(payload.deliveryId).toBe(deliveryId);
    expect(payload.seq).toBeGreaterThan(0);

    clientA.close();
    clientB.close();
  });

  it('a client that reconnects after missing events recovers every one via lastSeq replay', async () => {
    const instanceA = instances[0];
    const instanceB = instances[1];
    const deliveryId = 'del-redis-replay';

    const clientB1: ClientSocket = ClientIO(`${instanceB.url}/tracking`, {
      transports: ['websocket'],
      auth: { token: makeAuthToken('user-replay', 'user') },
    });
    await waitForEvent(clientB1, 'connect');

    clientB1.emit('delivery.subscribe', { deliveryId });
    await waitForEvent(clientB1, 'delivery.subscribed');

    const clientA: ClientSocket = ClientIO(`${instanceA.url}/tracking`, {
      transports: ['websocket'],
      auth: {
        token: makeAuthToken('rider-replay', 'rider', {
          riderId: 'rider-replay',
        }),
      },
    });
    await waitForEvent(clientA, 'connect');

    // First update: clientB1 is listening and receives it live.
    const firstSeen = waitForEvent<any>(clientB1, 'location.update');
    clientA.emit('rider.location', {
      riderId: 'rider-replay',
      deliveryId,
      latitude: 1,
      longitude: 1,
    });
    const first = await firstSeen;
    const lastSeq: number = first.seq;

    // clientB "goes offline" — disconnect without unsubscribing.
    clientB1.close();

    // Two more updates are published while nobody is listening.
    clientA.emit('rider.location', {
      riderId: 'rider-replay',
      deliveryId,
      latitude: 2,
      longitude: 2,
    });
    await new Promise((r) => setTimeout(r, 150));
    clientA.emit('rider.location', {
      riderId: 'rider-replay',
      deliveryId,
      latitude: 3,
      longitude: 3,
    });
    await new Promise((r) => setTimeout(r, 150));

    // Reconnect and replay from lastSeq.
    const clientB2: ClientSocket = ClientIO(`${instanceB.url}/tracking`, {
      transports: ['websocket'],
      auth: { token: makeAuthToken('user-replay', 'user') },
    });
    await waitForEvent(clientB2, 'connect');

    const replayed: any[] = [];
    clientB2.on('location.update', (payload) => replayed.push(payload));

    clientB2.emit('delivery.subscribe', { deliveryId, lastSeq });
    await waitForEvent(clientB2, 'delivery.subscribed');

    // Give the replay a moment to arrive.
    await new Promise((r) => setTimeout(r, 300));

    expect(replayed.length).toBeGreaterThanOrEqual(2);
    expect(replayed.every((e) => e.seq > lastSeq)).toBe(true);
    const seqs = replayed.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

    clientA.close();
    clientB2.close();
  });

  it('cross-instance emit works for notifications gateway (recipient:* room)', async () => {
    const instanceA = instances[0];
    const instanceB = instances[1];

    const recipientId = 'recipient-1';

    const clientB: ClientSocket = ClientIO(`${instanceB.url}/notifications`, {
      transports: ['websocket'],
      auth: { token: makeAuthToken(recipientId, 'user') },
    });

    await waitForEvent(clientB, 'connect');

    const received = waitForEvent(clientB, 'notification.new');

    // Trigger the real production path: NotificationsGateway.emitToRecipient,
    // resolved from instance A's own DI container.
    const gatewayA = instanceA.app.get(NotificationsGateway);
    await gatewayA.emitToRecipient(recipientId, { hello: 'world' });

    const payload = await received;
    expect(payload).toMatchObject({ hello: 'world' });

    clientB.close();
  });

  it('rejects an unauthorized recipient room join and writes an audit record', async () => {
    const instanceB = instances[1];

    const clientB: ClientSocket = ClientIO(`${instanceB.url}/notifications`, {
      transports: ['websocket'],
      // user-a authenticates but tries to read user-b's notifications.
      auth: { token: makeAuthToken('user-a', 'user') },
      query: { recipientId: 'user-b' },
    });

    const disconnected = new Promise<void>((resolve) =>
      clientB.on('disconnect', () => resolve()),
    );
    await disconnected;

    const { rows } = await pg.query(
      `select * from audit_logs where action = 'ws.room.join.denied' and actor_id = $1 order by "timestamp" desc limit 1`,
      ['user-a'],
    );

    expect(rows.length).toBe(1);
    expect(rows[0].resource_id).toBe('recipient:user-b');
  });
});
