import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Socket } from 'socket.io';

/** Max envelopes buffered per socket before dropping the oldest. */
export const DEFAULT_QUEUE_CAP = 100;
/** Flush cadence — how often each socket's queue is drained. */
export const DEFAULT_FLUSH_INTERVAL_MS = 50;

interface QueuedItem {
  event: string;
  payload: Record<string, unknown>;
}

interface SocketQueue {
  items: QueuedItem[];
  droppedSinceLastFlush: number;
  timer: ReturnType<typeof setInterval>;
}

/**
 * Bounded per-socket outbound queue. A stalled/slow client (mobile app gone
 * to sleep, dead connection not yet reaped) must not accumulate unbounded
 * memory server-side: once the queue is full, the oldest buffered message is
 * dropped and the next flushed message carries a `_dropped` marker so the
 * client knows to resync instead of silently missing data.
 */
@Injectable()
export class BackpressureQueueService {
  private readonly logger = new Logger(BackpressureQueueService.name);
  private readonly queues = new Map<string, SocketQueue>();
  private readonly cap: number;
  private readonly flushIntervalMs: number;

  constructor(configService: ConfigService) {
    this.cap = configService.get<number>(
      'WS_OUTBOUND_QUEUE_CAP',
      DEFAULT_QUEUE_CAP,
    );
    this.flushIntervalMs = configService.get<number>(
      'WS_OUTBOUND_FLUSH_INTERVAL_MS',
      DEFAULT_FLUSH_INTERVAL_MS,
    );
  }

  /** Enqueues an emit for `socket`, creating its flush loop on first use. */
  enqueue(
    socket: Socket,
    event: string,
    payload: Record<string, unknown>,
  ): void {
    let queue = this.queues.get(socket.id);
    if (!queue) {
      queue = {
        items: [],
        droppedSinceLastFlush: 0,
        timer: setInterval(
          () => this.flush(socket.id, socket),
          this.flushIntervalMs,
        ),
      };
      this.queues.set(socket.id, queue);
    }

    if (queue.items.length >= this.cap) {
      queue.items.shift();
      queue.droppedSinceLastFlush += 1;
    }
    queue.items.push({ event, payload });
  }

  /** Current buffered depth for a socket — used by tests/metrics. */
  getQueueDepth(socketId: string): number {
    return this.queues.get(socketId)?.items.length ?? 0;
  }

  /** Must be called on socket disconnect to stop the flush interval. */
  release(socketId: string): void {
    const queue = this.queues.get(socketId);
    if (!queue) return;
    clearInterval(queue.timer);
    this.queues.delete(socketId);
  }

  private flush(socketId: string, socket: Socket): void {
    const queue = this.queues.get(socketId);
    if (!queue || queue.items.length === 0) return;

    const item = queue.items.shift();
    if (!item) return;

    const dropped = queue.droppedSinceLastFlush;
    queue.droppedSinceLastFlush = 0;

    const outgoing =
      dropped > 0 ? { ...item.payload, _dropped: dropped } : item.payload;

    if (!socket.connected) {
      this.release(socketId);
      return;
    }

    try {
      socket.emit(item.event, outgoing);
    } catch (error) {
      this.logger.warn(
        `Failed to flush queued emit for socket=${socketId}: ${(error as Error).message}`,
      );
    }
  }
}
