import { INestApplication, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { ServerOptions } from 'socket.io';
import type { Server } from 'socket.io';
import Redis from 'ioredis';

import { ConfigService } from '@nestjs/config';
import { SocketServerRegistry } from './socket-server-registry';

/**
 * Socket.IO IoAdapter backed by Redis pub/sub.
 *
 * - Uses separate ioredis pub/sub clients.
 * - Gracefully degrades to in-memory adapter if Redis is unavailable at boot,
 *   when REDIS_SOCKET_ADAPTER_FALLBACK_ON_BOOT=true.
 * - Registers the created server in SocketServerRegistry for health checks.
 */
export class RedisIoAdapter extends IoAdapter {
    private readonly logger = new Logger(RedisIoAdapter.name);

    constructor(
        private readonly app: INestApplication,
        private readonly configService: ConfigService,
    ) {
        super(app);
    }

    async createIOServer(port: number, options?: ServerOptions): Promise<Server> {
        const server = await super.createIOServer(port, options);

        // Register for health indicator visibility
        SocketServerRegistry.register(server);

        const enabled = this.configService.get<boolean>(
            'REDIS_SOCKET_ADAPTER_ENABLED',
            true,
        );

        if (!enabled) {
            this.logger.log(
                'Redis Socket.IO adapter disabled (in-memory adapter will be used).',
            );
            return server;
        }

        const fallback = this.configService.get(
            'REDIS_SOCKET_ADAPTER_FALLBACK_ON_BOOT',
            true,
        );

        const redisUrl: string | undefined = this.configService.get('REDIS_URL');
        const redisHost: string = this.configService.get('REDIS_HOST') ?? 'localhost';
        const redisPort: number = this.configService.get('REDIS_PORT') ?? 6379;
        const redisPassword: string | undefined = this.configService.get('REDIS_PASSWORD');

        const makeRedis = () => {
            if (redisUrl) {
                return new Redis(redisUrl, {
                    lazyConnect: true,
                    maxRetriesPerRequest: 1,
                });
            }

            return new Redis({
                host: redisHost,
                port: redisPort,
                password: redisPassword,
                lazyConnect: true,
                maxRetriesPerRequest: 1,
            } as any);
        };

        const pubClient = makeRedis();
        const subClient = makeRedis();

        try {
            // Force initial connections so we can fail fast at boot.
            await pubClient.connect();
            await subClient.connect();

            await pubClient.ping();
            await subClient.ping();

            server.adapter(createAdapter(pubClient, subClient));

            this.logger.log('Redis Socket.IO adapter enabled');

            // Adapter will keep the connections.
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.error(
                `Failed to initialise Redis Socket.IO adapter: ${message}`,
            );

            // Best-effort cleanup; if we later fall back to in-memory adapter
            // we don't want hanging connections.
            try {
                await pubClient.quit();
            } catch {
                // ignore
            }
            try {
                await subClient.quit();
            } catch {
                // ignore
            }

            if (fallback) {
                this.logger.warn(
                    'Falling back to in-memory Socket.IO adapter due to Redis-down-at-boot flag.',
                );
                return server;
            }

            throw err;
        }

        return server;
    }
}
