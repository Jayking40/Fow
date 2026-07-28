import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { RoomEventBusService } from '../websockets/room-event-bus.service';

import type { Server } from 'socket.io';

const DEFAULT_COALESCE_INTERVAL_MS = 2000;

interface RoomCoalesceState {
  server: Server;
  pending: Map<string, Record<string, unknown>>;
  timer: ReturnType<typeof setInterval>;
}

/**
 * Coalesces high-frequency rider GPS updates (1Hz per rider) down to a
 * configurable per-room cadence before broadcast, latest-update-wins. Cuts
 * bandwidth and Redis fan-out for busy delivery rooms with many watchers.
 */
@Injectable()
export class LocationCoalescerService {
  private readonly intervalMs: number;
  private readonly rooms = new Map<string, RoomCoalesceState>();

  constructor(
    configService: ConfigService,
    private readonly roomEventBus: RoomEventBusService,
  ) {
    this.intervalMs = configService.get<number>(
      'LOCATION_COALESCE_INTERVAL_MS',
      DEFAULT_COALESCE_INTERVAL_MS,
    );
  }

  /** Records the latest position for `riderId` in `room`; flushed on the next tick. */
  record(
    server: Server,
    room: string,
    riderId: string,
    payload: Record<string, unknown>,
  ): void {
    let state = this.rooms.get(room);
    if (!state) {
      state = {
        server,
        pending: new Map(),
        timer: setInterval(() => this.flush(room), this.intervalMs),
      };
      this.rooms.set(room, state);
    }
    state.server = server;
    state.pending.set(riderId, payload);
  }

  private flush(room: string): void {
    const state = this.rooms.get(room);
    if (!state) return;

    if (state.pending.size === 0) {
      clearInterval(state.timer);
      this.rooms.delete(room);
      return;
    }

    const updates = Array.from(state.pending.entries());
    state.pending.clear();

    for (const [, payload] of updates) {
      void this.roomEventBus.publish(
        state.server,
        room,
        'location.update',
        payload,
      );
    }
  }
}
