import type { Server } from 'socket.io';

/**
 * Global registry of active Socket.IO Server instances.
 *
 * Used by the tracking and notifications gateways and
 * the SocketIoHealthIndicator to report connection/room counts
 * without coupling to individual gateway modules.
 */
export class SocketServerRegistry {
    private static readonly servers = new Set<Server>();

    static register(server: Server): void {
        this.servers.add(server);
    }

    static unregister(server: Server): void {
        this.servers.delete(server);
    }

    static getAll(): ReadonlySet<Server> {
        return this.servers;
    }
}
