import { Inject, Injectable, Logger } from '@nestjs/common';

import Redis from 'ioredis';

import { RedisCircuitBreaker } from '../redis/redis-circuit-breaker';
import { REDIS_CLIENT } from '../redis/redis.constants';

import type { Server } from 'socket.io';

/** How long a room's replay buffer is retained, in milliseconds. */
const STREAM_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
/** Approximate cap on buffered entries per room (bounds memory on hot rooms). */
const STREAM_MAXLEN = 2000;

export interface SequencedEnvelope {
  seq: number;
  ts: string;
  [key: string]: unknown;
}

export type ReplayResult =
  | { resyncRequired: false; events: SequencedEnvelope[] }
  | { resyncRequired: true };

function streamKey(room: string): string {
  return `ws:stream:${room}`;
}

function seqKey(room: string): string {
  return `ws:seq:${room}`;
}

/**
 * Sequences and buffers WebSocket room events in Redis Streams so a
 * reconnecting client can replay everything it missed (or be told to
 * resync via REST when the gap has fallen outside the buffer window).
 */
@Injectable()
export class RoomEventBusService {
  private readonly logger = new Logger(RoomEventBusService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly circuitBreaker: RedisCircuitBreaker,
  ) {}

  /**
   * Assigns the next sequence number for `room`, buffers the envelope in a
   * Redis Stream, and fans it out via `server.to(room).emit(event, envelope)`.
   * Degrades to a best-effort emit (seq=0) if Redis is unavailable — the
   * event still reaches connected clients, it just can't be replayed later.
   */
  async publish(
    server: Server,
    room: string,
    event: string,
    payload: Record<string, unknown>,
  ): Promise<SequencedEnvelope> {
    const envelope = await this.circuitBreaker.execute(
      async () => {
        const seq = await this.redis.incr(seqKey(room));
        const ts = new Date().toISOString();
        const built: SequencedEnvelope = { ...payload, seq, ts };

        const key = streamKey(room);
        await this.redis.xadd(
          key,
          'MAXLEN',
          '~',
          STREAM_MAXLEN,
          '*',
          'seq',
          String(seq),
          'event',
          event,
          'data',
          JSON.stringify(built),
        );
        await this.redis.pexpire(key, STREAM_WINDOW_MS);

        return built;
      },
      () => ({ ...payload, seq: 0, ts: new Date().toISOString() }),
    );

    server.to(room).emit(event, envelope);
    return envelope;
  }

  /**
   * Returns every buffered event for `room` with seq > lastSeq, in order.
   * If the room has no buffer, or the oldest buffered entry is already past
   * `lastSeq + 1` (the gap exceeds the retained window), the caller must
   * instruct the client to resync via REST instead of replaying.
   */
  async replay(room: string, lastSeq: number): Promise<ReplayResult> {
    return this.circuitBreaker.execute(
      async () => {
        const key = streamKey(room);
        const entries = await this.redis.xrange(key, '-', '+');

        if (entries.length === 0) {
          // No buffer: either nothing has ever been published, or the window
          // expired. Compare against the current sequence counter — if the
          // client is already caught up there's nothing to replay, otherwise
          // events fell outside the retained window and a resync is needed.
          const current = Number((await this.redis.get(seqKey(room))) ?? 0);
          if (current <= lastSeq) {
            return { resyncRequired: false, events: [] } as const;
          }
          this.logger.warn(
            `Replay buffer expired for room=${room} lastSeq=${lastSeq} current=${current}; instructing resync`,
          );
          return { resyncRequired: true } as const;
        }

        const parsed = entries.map(([, fields]) => {
          const dataIdx = fields.indexOf('data');
          return JSON.parse(fields[dataIdx + 1]) as SequencedEnvelope;
        });

        const oldestSeq = parsed[0].seq;
        if (oldestSeq > lastSeq + 1) {
          this.logger.warn(
            `Replay gap too wide for room=${room}: oldestBuffered=${oldestSeq} lastSeq=${lastSeq}; instructing resync`,
          );
          return { resyncRequired: true } as const;
        }

        const missed = parsed.filter((e) => e.seq > lastSeq);
        return { resyncRequired: false, events: missed } as const;
      },
      () => ({ resyncRequired: true }) as const,
    );
  }
}
