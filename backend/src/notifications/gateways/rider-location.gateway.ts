import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';

import { Socket, Server } from 'socket.io';

import { JwtKeyService } from '../../auth/jwt-key.service';
import { RedisLocationRepository } from '../../redis/redis-location.repository';
import { calculateDistance } from '../../tracking/geofence.util';
import { RoomAuthorizationService } from '../../websockets/room-authorization.service';
import { RoomEventBusService } from '../../websockets/room-event-bus.service';
import {
  createWsAuthMiddleware,
  type WsAuthenticatedUser,
} from '../../websockets/ws-jwt-auth';
import { WsRateLimiterService } from '../../websockets/ws-rate-limiter.service';

@WebSocketGateway({ cors: { origin: '*' } })
export class RiderLocationGateway implements OnGatewayInit {
  @WebSocketServer() server: Server;
  private readonly DEVIATION_THRESHOLD = 2.0;
  private readonly logger = new Logger(RiderLocationGateway.name);

  constructor(
    private readonly redisRepo: RedisLocationRepository,
    private readonly eventEmitter: EventEmitter2,
    private readonly jwtKeyService: JwtKeyService,
    private readonly roomAuthorizationService: RoomAuthorizationService,
    private readonly roomEventBus: RoomEventBusService,
    private readonly rateLimiter: WsRateLimiterService,
  ) {}

  afterInit(server: Server): void {
    // This gateway previously had no authentication at all — any socket
    // could join an order:<id> room and publish fake rider locations.
    server.use(createWsAuthMiddleware(this.jwtKeyService));
  }

  private getUser(client: Socket): WsAuthenticatedUser | undefined {
    return (client.data as Record<string, unknown>).user as
      | WsAuthenticatedUser
      | undefined;
  }

  @SubscribeMessage('rider.location.update')
  async handleLocationUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      riderId: string;
      lat: number;
      lng: number;
      orderId: string;
    },
  ) {
    const user = this.getUser(client);
    if (!user) return;

    const withinBudget = await this.rateLimiter.allow(
      client.id,
      'rider.location.update',
    );
    if (!withinBudget) {
      client.emit('error', {
        reason: 'Rate limit exceeded for rider.location.update',
      });
      return;
    }

    const { riderId, lat, lng, orderId } = data;

    await this.redisRepo.updateLocation(riderId, lat, lng);

    const room = `order:${orderId}`;
    await this.roomEventBus.publish(this.server, room, 'order.rider.location', {
      lat,
      lng,
    });
    ////////////////////////////////////////////////////////////////////
    // 3. Geofence Check (Simplified example against a fixed route point)
    // In a real app, you'd fetch the 'expectedRoutePoint' from a DB
    const expectedRoutePoint = { lat: 6.5244, lng: 3.3792 };
    /////////////////////////////////////////////////////////////////////////
    const distance = calculateDistance(
      lat,
      lng,
      expectedRoutePoint.lat,
      expectedRoutePoint.lng,
    );

    if (distance > this.DEVIATION_THRESHOLD) {
      this.triggerDeviationAlert(riderId, distance);
    }
  }

  private triggerDeviationAlert(riderId: string, distance: number) {
    const alertData = { riderId, deviation: distance, timestamp: new Date() };
    this.server.emit('RiderDeviationEvent', alertData); // Notify Admins
    this.logger.warn(`ALERT: Rider ${riderId} deviated by ${distance}km`);
  }

  @SubscribeMessage('hospital.subscribe')
  async handleJoinOrder(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { orderId: string },
  ) {
    const user = this.getUser(client);
    if (!user) return;

    const room = `order:${data.orderId}`;
    const decision = await this.roomAuthorizationService.assertCanJoin(
      user,
      room,
      client.rooms.size,
      client.id,
    );

    if (!decision.allowed) {
      client.emit('error', {
        reason: decision.reason ?? 'Not authorized to join room',
      });
      return;
    }

    client.join(room);
  }
}
