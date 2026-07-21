import { Injectable } from '@nestjs/common';
import {
    HealthCheckError,
    HealthIndicator,
    HealthIndicatorResult,
} from '@nestjs/terminus';

import type { Server } from 'socket.io';
import { SocketServerRegistry } from '../../websockets/socket-server-registry';

/**
 * Health indicator that reports Socket.IO runtime stats.
 *
 * Uses the global {@link SocketServerRegistry} to discover active
 * Socket.IO Server instances, avoiding tight coupling with gateway modules.
 */
@Injectable()
export class SocketIoHealthIndicator extends HealthIndicator {
    async isHealthy(key: string): Promise<HealthIndicatorResult> {
        try {
            const servers: Server[] = Array.from(SocketServerRegistry.getAll());

            const totalSockets = servers.reduce((sum: number, s: Server) => {
                return sum + ((s.engine as any)?.sockets?.size ?? 0);
            }, 0);

            const totalRooms = servers.reduce((sum: number, s: Server) => {
                const srv = s as Record<string, any>;
                const ns = srv.nsps as Record<string, any> | undefined;
                if (!ns) { return sum; }
                let roomCount = 0;
                for (const name of Object.keys(ns)) {
                    const adapter = ns[name]?.adapter;
                    if (adapter?.rooms && typeof adapter.rooms.size === 'number') {
                        roomCount += adapter.rooms.size;
                    }
                }
                return sum + roomCount;
            }, 0);

            const healthy = servers.length > 0;

            return this.getStatus(key, healthy, {
                totalSockets: totalSockets,
                totalRooms: totalRooms,
                instanceCount: servers.length,
                healthy,
            });
        } catch (err: unknown) {
            throw new HealthCheckError(
                'Socket.IO stats check failed',
                this.getStatus(key, false, { message: 'down' }),
            );
        }
    }
}
