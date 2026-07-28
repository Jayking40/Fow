import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import Redis from 'ioredis';

import { REDIS_CLIENT } from '../redis/redis.constants';

/** TTL for a presence heartbeat before a rider is considered offline. */
const PRESENCE_TTL_SECONDS = 45;

function presenceKey(riderId: string): string {
  return `presence:rider:${riderId}`;
}

/**
 * Redis-backed rider presence with TTL heartbeats. Consumed by dispatch to
 * avoid assigning deliveries to riders whose socket has gone dark, without
 * requiring dispatch to know anything about socket.io itself.
 */
@Injectable()
export class PresenceService {
  private readonly logger = new Logger(PresenceService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async setOnline(riderId: string): Promise<void> {
    await this.heartbeat(riderId);
    this.eventEmitter.emit('rider.presence.changed', { riderId, online: true });
  }

  async heartbeat(riderId: string): Promise<void> {
    try {
      await this.redis.set(
        presenceKey(riderId),
        '1',
        'EX',
        PRESENCE_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn(
        `Presence heartbeat failed for rider=${riderId}: ${(error as Error).message}`,
      );
    }
  }

  async setOffline(riderId: string): Promise<void> {
    try {
      await this.redis.del(presenceKey(riderId));
    } catch (error) {
      this.logger.warn(
        `Presence clear failed for rider=${riderId}: ${(error as Error).message}`,
      );
    }
    this.eventEmitter.emit('rider.presence.changed', {
      riderId,
      online: false,
    });
  }

  /**
   * True only when a live heartbeat is on record for this rider. False
   * covers both "confirmed offline" and "never connected via WebSocket" —
   * callers should treat this as a positive signal to prefer, not a hard
   * exclusion filter, since most riders may not carry presence data yet.
   */
  async isOnline(riderId: string): Promise<boolean> {
    try {
      const value = await this.redis.get(presenceKey(riderId));
      return value !== null;
    } catch (error) {
      this.logger.warn(
        `Presence lookup failed for rider=${riderId}: ${(error as Error).message}`,
      );
      return false;
    }
  }
}
