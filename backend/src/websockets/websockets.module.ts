import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AuditLogModule } from '../common/audit/audit-log.module';
import { RedisCircuitBreaker } from '../redis/redis-circuit-breaker';
import { RedisModule } from '../redis/redis.module';

import { BackpressureQueueService } from './backpressure-queue.service';
import { PresenceService } from './presence.service';
import { RoomAuthorizationService } from './room-authorization.service';
import { RoomEventBusService } from './room-event-bus.service';
import { WsRateLimiterService } from './ws-rate-limiter.service';

/**
 * Shared WebSocket scaling infrastructure (issue #26): handshake auth, room
 * authorization + audit, sequenced replay, backpressure, and presence.
 * Imported by any module that hosts a gateway (TrackingModule,
 * NotificationsModule) or that needs to consume presence (DispatchModule).
 */
@Module({
  imports: [AuthModule, RedisModule, AuditLogModule],
  providers: [
    RedisCircuitBreaker,
    RoomAuthorizationService,
    RoomEventBusService,
    BackpressureQueueService,
    WsRateLimiterService,
    PresenceService,
  ],
  exports: [
    AuthModule,
    RoomAuthorizationService,
    RoomEventBusService,
    BackpressureQueueService,
    WsRateLimiterService,
    PresenceService,
  ],
})
export class WebsocketsModule {}
