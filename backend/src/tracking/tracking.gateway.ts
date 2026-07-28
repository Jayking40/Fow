import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';

import { decode } from 'jsonwebtoken';
import { Server, Socket } from 'socket.io';

import { JwtKeyService } from '../auth/jwt-key.service';
import { BackpressureQueueService } from '../websockets/backpressure-queue.service';
import { RoomAuthorizationService } from '../websockets/room-authorization.service';
import { RoomEventBusService } from '../websockets/room-event-bus.service';
import { WsRateLimiterService } from '../websockets/ws-rate-limiter.service';

import { LocationCoalescerService } from './location-coalescer.service';

const VALID_DELIVERY_STATUSES = new Set([
  'pending',
  'assigned',
  'in_transit',
  'delivered',
  'cancelled',
]);

const LAT_MIN = -90;
const LAT_MAX = 90;
const LON_MIN = -180;
const LON_MAX = 180;

interface ClientContext {
  userId: string;
  role: string;
  riderId?: string;
  orgId: string | null;
  rooms: Set<string>;
}

interface JwtHandshakePayload {
  sub?: string;
  userId?: string;
  role?: string;
  riderId?: string;
  orgId?: string;
}

interface LocationUpdatePayload {
  riderId: string;
  deliveryId: string;
  latitude: number;
  longitude: number;
  timestamp?: string;
  speed?: number;
  heading?: number;
}

interface DeliveryStatusPayload {
  deliveryId: string;
  status: string;
  riderId?: string;
  timestamp?: string;
}

interface ETAPayload {
  deliveryId: string;
  estimatedMinutes: number;
  distanceKm?: number;
  timestamp?: string;
}

@WebSocketGateway({
  namespace: '/tracking',
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    methods: ['GET', 'POST'],
    credentials: true,
  },
})
export class TrackingGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(TrackingGateway.name);
  private readonly heartbeatInterval = 30_000;
  private readonly connectedClients = new Map<string, ClientContext>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly jwtKeyService: JwtKeyService,
    private readonly roomAuthorizationService: RoomAuthorizationService,
    private readonly roomEventBus: RoomEventBusService,
    private readonly backpressureQueue: BackpressureQueueService,
    private readonly rateLimiter: WsRateLimiterService,
    private readonly locationCoalescer: LocationCoalescerService,
  ) {}

  afterInit(): void {
    this.logger.log('TrackingGateway WebSocket server initialised');
  }

  async handleConnection(client: Socket): Promise<void> {
    const token = (client.handshake.auth?.token ??
      client.handshake.query?.token) as string | undefined;

    if (!token) {
      this.logger.warn(`Tracking WS rejected: no token (socket=${client.id})`);
      client.emit('error', { reason: 'Authentication token required' });
      client.disconnect(true);
      return;
    }

    try {
      // Key-rotation aware verification, mirroring JwtStrategy (HTTP): resolve
      // the signing secret from the token's `kid` header before verifying.
      const decoded = decode(token, { complete: true });
      const kid =
        (decoded?.header as unknown as Record<string, string>)?.kid ?? 'key-1';
      const secret = this.jwtKeyService.resolveSecret(kid);

      const rawPayload: unknown = secret
        ? await this.jwtService.verifyAsync(token, { secret })
        : await this.jwtService.verifyAsync(token);
      const payload = rawPayload as JwtHandshakePayload;

      const userId = payload.sub ?? payload.userId ?? '';
      const role = payload.role ?? 'user';
      const riderId = payload.riderId;
      const orgId = payload.orgId ?? null;

      this.connectedClients.set(client.id, {
        userId,
        role,
        riderId,
        orgId,
        rooms: new Set(),
      });

      const interval = setInterval(() => {
        if (client.connected)
          client.emit('heartbeat', { timestamp: new Date().toISOString() });
      }, this.heartbeatInterval);

      client.on('disconnect', () => {
        clearInterval(interval);
        this.connectedClients.delete(client.id);
        this.backpressureQueue.release(client.id);
      });

      client.emit('connected', {
        message: 'Successfully connected to tracking service',
        userId,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(
        `Tracking WS connected: ${client.id} (user=${userId} role=${role})`,
      );
    } catch (error) {
      this.logger.warn(
        `Tracking WS rejected: invalid token (socket=${client.id}): ${(error as Error).message}`,
      );
      client.emit('error', { reason: 'Invalid or expired token' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    this.connectedClients.delete(client.id);
    this.backpressureQueue.release(client.id);
    this.logger.log(`Tracking WS disconnected: ${client.id}`);
  }

  // ---------------------------------------------------------------------------
  // Authorization helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns true if the authenticated client is allowed to subscribe to a delivery room.
   * Admins and dispatchers can subscribe to any delivery.
   * Riders can only subscribe to their own deliveries.
   * Regular users are allowed to subscribe (read-only consumers).
   */
  private canSubscribe(ctx: ClientContext): boolean {
    return ['admin', 'super_admin', 'dispatcher', 'rider', 'user'].includes(
      ctx.role,
    );
  }

  /**
   * Returns true if the client is allowed to PUBLISH events for a delivery.
   * Only the assigned rider (riderId claim matches) or admins/dispatchers may publish.
   */
  private canPublish(
    ctx: ClientContext,
    deliveryRiderId: string | undefined,
  ): boolean {
    if (['admin', 'super_admin', 'dispatcher'].includes(ctx.role)) return true;
    if (ctx.role === 'rider' && ctx.riderId && ctx.riderId === deliveryRiderId)
      return true;
    return false;
  }

  private getContext(client: Socket): ClientContext | null {
    return this.connectedClients.get(client.id) ?? null;
  }

  private rejectUnauthorized(
    client: Socket,
    action: string,
    deliveryId: string,
  ): void {
    this.logger.warn(
      `Unauthorized ${action} attempt: socket=${client.id} deliveryId=${deliveryId}`,
    );
    client.emit('error', {
      reason: `Not authorized to ${action} for delivery ${deliveryId}`,
    });
  }

  // ---------------------------------------------------------------------------
  // Subscribe / Unsubscribe
  // ---------------------------------------------------------------------------

  @SubscribeMessage('delivery.subscribe')
  async handleDeliverySubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { deliveryId: string; lastSeq?: number },
  ): Promise<void> {
    if (!data?.deliveryId) {
      client.emit('error', { message: 'Missing deliveryId' });
      return;
    }

    const ctx = this.getContext(client);
    if (!ctx) {
      client.emit('error', { reason: 'Client not authenticated' });
      return;
    }

    if (!this.canSubscribe(ctx)) {
      this.rejectUnauthorized(client, 'subscribe', data.deliveryId);
      return;
    }

    const room = `delivery:${data.deliveryId}`;
    const user = { userId: ctx.userId, role: ctx.role, orgId: ctx.orgId };

    const decision = this.roomAuthorizationService.evaluate(
      user,
      room,
      ctx.rooms.size,
    );
    if (!decision.allowed) {
      void this.roomAuthorizationService.auditDenied(
        user,
        room,
        client.id,
        decision.reason,
      );
      client.emit('error', {
        reason: decision.reason ?? 'Not authorized to join room',
      });
      return;
    }

    client.join(room);
    ctx.rooms.add(room);

    this.logger.debug(
      `Client ${client.id} (user=${ctx.userId}) joined ${room}`,
    );
    client.emit('delivery.subscribed', {
      deliveryId: data.deliveryId,
      timestamp: new Date().toISOString(),
    });

    if (typeof data.lastSeq === 'number') {
      const result = await this.roomEventBus.replay(room, data.lastSeq);
      if (result.resyncRequired) {
        client.emit('resync.required', {
          room,
          reason: 'Missed-event buffer exceeded',
        });
      } else {
        for (const envelope of result.events) {
          const eventName = (envelope as Record<string, unknown>)
            .__event as string;
          client.emit(eventName ?? 'location.update', envelope);
        }
      }
    }
  }

  @SubscribeMessage('delivery.unsubscribe')
  handleDeliveryUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { deliveryId: string },
  ) {
    if (!data?.deliveryId) {
      client.emit('error', { message: 'Missing deliveryId' });
      return;
    }

    const ctx = this.getContext(client);
    if (!ctx) {
      client.emit('error', { reason: 'Client not authenticated' });
      return;
    }

    const room = `delivery:${data.deliveryId}`;
    client.leave(room);
    ctx.rooms.delete(room);

    client.emit('delivery.unsubscribed', {
      deliveryId: data.deliveryId,
      timestamp: new Date().toISOString(),
    });
  }

  // ---------------------------------------------------------------------------
  // Publish events — delivery-level authorization + schema validation
  // ---------------------------------------------------------------------------

  @SubscribeMessage('rider.location')
  async handleRiderLocation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: LocationUpdatePayload,
  ): Promise<void> {
    if (!data?.deliveryId || !data?.riderId) return;

    const ctx = this.getContext(client);
    if (!ctx) return;

    // Only the rider assigned to this delivery (or admin/dispatcher) may publish location
    if (!this.canPublish(ctx, data.riderId)) {
      this.rejectUnauthorized(client, 'publish location', data.deliveryId);
      return;
    }

    // Coordinate range validation
    if (
      typeof data.latitude !== 'number' ||
      typeof data.longitude !== 'number' ||
      data.latitude < LAT_MIN ||
      data.latitude > LAT_MAX ||
      data.longitude < LON_MIN ||
      data.longitude > LON_MAX
    ) {
      client.emit('error', { reason: 'Invalid coordinates' });
      return;
    }

    const withinBudget = await this.rateLimiter.allow(
      client.id,
      'rider.location',
    );
    if (!withinBudget) {
      client.emit('error', {
        reason: 'Rate limit exceeded for rider.location',
      });
      return;
    }

    const room = `delivery:${data.deliveryId}`;
    // GPS is coalesced server-side (latest-wins per rider) before broadcast —
    // see LocationCoalescerService for the flush cadence.
    this.locationCoalescer.record(this.server, room, data.riderId, {
      riderId: data.riderId,
      deliveryId: data.deliveryId,
      latitude: data.latitude,
      longitude: data.longitude,
      speed: data.speed ?? null,
      heading: data.heading ?? null,
      timestamp: data.timestamp ?? new Date().toISOString(),
    });
  }

  @SubscribeMessage('delivery.status')
  async handleDeliveryStatus(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: DeliveryStatusPayload,
  ): Promise<void> {
    if (!data?.deliveryId || !data?.status) return;

    const ctx = this.getContext(client);
    if (!ctx) return;

    if (!this.canPublish(ctx, data.riderId)) {
      this.rejectUnauthorized(client, 'publish status', data.deliveryId);
      return;
    }

    // Status enum validation
    if (!VALID_DELIVERY_STATUSES.has(data.status)) {
      client.emit('error', { reason: `Invalid status value: ${data.status}` });
      return;
    }

    const withinBudget = await this.rateLimiter.allow(
      client.id,
      'delivery.status',
    );
    if (!withinBudget) {
      client.emit('error', {
        reason: 'Rate limit exceeded for delivery.status',
      });
      return;
    }

    const room = `delivery:${data.deliveryId}`;
    await this.roomEventBus.publish(
      this.server,
      room,
      'delivery.status.updated',
      {
        deliveryId: data.deliveryId,
        status: data.status,
        riderId: data.riderId ?? null,
        timestamp: data.timestamp ?? new Date().toISOString(),
      },
    );

    this.logger.log(
      `Delivery ${data.deliveryId} status → ${data.status} by user=${ctx.userId}`,
    );
  }

  @SubscribeMessage('delivery.eta')
  async handleETABroadcast(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: ETAPayload,
  ): Promise<void> {
    if (!data?.deliveryId) return;

    const ctx = this.getContext(client);
    if (!ctx) return;

    if (!this.canPublish(ctx, undefined)) {
      this.rejectUnauthorized(client, 'publish ETA', data.deliveryId);
      return;
    }

    if (
      typeof data.estimatedMinutes !== 'number' ||
      data.estimatedMinutes < 0
    ) {
      client.emit('error', { reason: 'Invalid estimatedMinutes' });
      return;
    }

    const room = `delivery:${data.deliveryId}`;
    await this.roomEventBus.publish(this.server, room, 'delivery.eta.updated', {
      deliveryId: data.deliveryId,
      estimatedMinutes: data.estimatedMinutes,
      distanceKm: data.distanceKm ?? null,
      timestamp: data.timestamp ?? new Date().toISOString(),
    });
  }

  // ---------------------------------------------------------------------------
  // Server-side emit helpers (called by services)
  // ---------------------------------------------------------------------------

  async emitLocationUpdate(payload: LocationUpdatePayload): Promise<void> {
    const room = `delivery:${payload.deliveryId}`;
    await this.roomEventBus.publish(this.server, room, 'location.update', {
      ...payload,
      timestamp: payload.timestamp ?? new Date().toISOString(),
    });
  }

  async emitDeliveryStatusUpdate(
    payload: DeliveryStatusPayload,
  ): Promise<void> {
    const room = `delivery:${payload.deliveryId}`;
    await this.roomEventBus.publish(
      this.server,
      room,
      'delivery.status.updated',
      {
        ...payload,
        timestamp: payload.timestamp ?? new Date().toISOString(),
      },
    );
  }

  async emitETAUpdate(payload: ETAPayload): Promise<void> {
    const room = `delivery:${payload.deliveryId}`;
    await this.roomEventBus.publish(this.server, room, 'delivery.eta.updated', {
      ...payload,
      timestamp: payload.timestamp ?? new Date().toISOString(),
    });
  }
}
