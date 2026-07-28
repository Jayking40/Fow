import { Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';

import { Server, Socket } from 'socket.io';

import { JwtKeyService } from '../../auth/jwt-key.service';
import { RoomAuthorizationService } from '../../websockets/room-authorization.service';
import { RoomEventBusService } from '../../websockets/room-event-bus.service';
import {
  createWsAuthMiddleware,
  type WsAuthenticatedUser,
} from '../../websockets/ws-jwt-auth';

@WebSocketGateway({
  namespace: '/notifications',
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
})
export class NotificationsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(NotificationsGateway.name);

  constructor(
    private readonly jwtKeyService: JwtKeyService,
    private readonly roomAuthorizationService: RoomAuthorizationService,
    private readonly roomEventBus: RoomEventBusService,
  ) {}

  afterInit(server: Server): void {
    // Reject the handshake before 'connection' fires for unauthenticated sockets —
    // previously this namespace trusted a client-supplied recipientId with no auth
    // at all, letting any socket read anyone else's notifications.
    server.use(createWsAuthMiddleware(this.jwtKeyService));
    this.logger.log('NotificationsGateway WebSocket server initialized');
  }

  handleConnection(client: Socket): void {
    const user = (client.data as Record<string, unknown>).user as
      | WsAuthenticatedUser
      | undefined;

    if (!user) {
      // Safety net: the handshake middleware should already have refused
      // unauthenticated sockets before this handler runs.
      client.disconnect(true);
      return;
    }

    const requestedRecipientId =
      (client.handshake.query?.recipientId as string | undefined) ??
      user.userId;
    const room = `recipient:${requestedRecipientId}`;

    const decision = this.roomAuthorizationService.evaluate(user, room, 0);
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
      client.disconnect(true);
      return;
    }

    client.join(room);
    this.logger.log(`Client ${client.id} connected and joined room ${room}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`WebSocket client disconnected: ${client.id}`);
  }

  /**
   * Listen to Order status updates and notify recipient.
   */
  @OnEvent('order.status.updated')
  handleOrderStatusUpdated(payload: { orderId: string; newStatus: string }) {
    this.logger.log(
      `WS Notification [Order]: ${payload.orderId} -> ${payload.newStatus}`,
    );
    this.server.emit('blood-request.status-changed', {
      type: 'ORDER',
      id: payload.orderId,
      newStatus: payload.newStatus,
      timestamp: new Date(),
    });
  }

  /**
   * Listen to BloodRequest status updates and notify recipient.
   */
  @OnEvent('blood-request.status.updated')
  handleBloodRequestStatusUpdated(payload: {
    requestId: string;
    newStatus: string;
  }) {
    this.logger.log(
      `WS Notification [BloodRequest]: ${payload.requestId} -> ${payload.newStatus}`,
    );
    this.server.emit('blood-request.status-changed', {
      type: 'BLOOD_REQUEST',
      id: payload.requestId,
      newStatus: payload.newStatus,
      timestamp: new Date(),
    });
  }

  async emitToRecipient(
    recipientId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const room = `recipient:${recipientId}`;
    await this.roomEventBus.publish(
      this.server,
      room,
      'notification.new',
      payload,
    );
    this.logger.log(`Emitted notification.new to ${room}`);
  }
}
