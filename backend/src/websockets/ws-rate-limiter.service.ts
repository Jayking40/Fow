import { Inject, Injectable, Logger } from '@nestjs/common';

import Redis from 'ioredis';

import {
  DEFAULT_WS_EVENT_RATE_LIMIT,
  WS_EVENT_RATE_LIMITS,
  WS_RATE_LIMIT_WINDOW_MS,
} from '../config/ws-limits.config';
import { REDIS_CLIENT } from '../redis/redis.constants';

/**
 * Inbound abuse control for socket.io message handlers. Uses a Redis counter
 * per (socketId, event) so the limit holds even when a client's messages
 * land on different instances behind a load balancer without sticky
 * sessions. Fails open (allows the message) if Redis is unreachable, since
 * an outage should not itself become a denial-of-service vector.
 */
@Injectable()
export class WsRateLimiterService {
  private readonly logger = new Logger(WsRateLimiterService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async allow(socketId: string, event: string): Promise<boolean> {
    const { limit } =
      WS_EVENT_RATE_LIMITS[event] ?? DEFAULT_WS_EVENT_RATE_LIMIT;
    const key = `ws:rl:${socketId}:${event}`;

    try {
      const count = await this.redis.incr(key);
      if (count === 1) {
        await this.redis.pexpire(key, WS_RATE_LIMIT_WINDOW_MS);
      }
      return count <= limit;
    } catch (error) {
      this.logger.warn(
        `Rate limiter Redis error for ${key}, failing open: ${(error as Error).message}`,
      );
      return true;
    }
  }
}
