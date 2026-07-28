/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { Test, TestingModule } from '@nestjs/testing';

import RedisMock from 'ioredis-mock';

import { RedisCircuitBreaker } from '../redis/redis-circuit-breaker';
import { REDIS_CLIENT } from '../redis/redis.constants';

import { RoomEventBusService } from './room-event-bus.service';

import type Redis from 'ioredis';

function makeServer() {
  return {
    to: jest.fn().mockReturnThis(),
    emit: jest.fn(),
  };
}

describe('RoomEventBusService', () => {
  let service: RoomEventBusService;
  let redis: Redis;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoomEventBusService,
        RedisCircuitBreaker,
        { provide: REDIS_CLIENT, useFactory: () => new RedisMock() },
      ],
    }).compile();

    service = module.get(RoomEventBusService);
    redis = module.get(REDIS_CLIENT);
  });

  afterEach(async () => {
    await (redis as unknown as { flushall: () => Promise<void> }).flushall();
  });

  it('assigns monotonically increasing sequence numbers per room', async () => {
    const server = makeServer() as any;

    const first = await service.publish(
      server,
      'delivery:1',
      'location.update',
      { a: 1 },
    );
    const second = await service.publish(
      server,
      'delivery:1',
      'location.update',
      { a: 2 },
    );

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
  });

  it('emits to the room with the envelope including seq/ts (additive, preserves original fields)', async () => {
    const server = makeServer() as any;

    await service.publish(server, 'delivery:1', 'location.update', {
      riderId: 'r1',
      latitude: 1,
    });

    expect(server.to).toHaveBeenCalledWith('delivery:1');
    expect(server.emit).toHaveBeenCalledWith(
      'location.update',
      expect.objectContaining({ riderId: 'r1', latitude: 1, seq: 1 }),
    );
  });

  it('replays every event missed since lastSeq, in order', async () => {
    const server = makeServer() as any;

    await service.publish(server, 'delivery:1', 'location.update', { n: 1 });
    await service.publish(server, 'delivery:1', 'location.update', { n: 2 });
    await service.publish(server, 'delivery:1', 'location.update', { n: 3 });

    const result = await service.replay('delivery:1', 1);

    expect(result.resyncRequired).toBe(false);
    if (!result.resyncRequired) {
      expect(result.events.map((e) => e.seq)).toEqual([2, 3]);
    }
  });

  it('reports no missed events when the client is already caught up', async () => {
    const server = makeServer() as any;
    await service.publish(server, 'delivery:1', 'location.update', { n: 1 });

    const result = await service.replay('delivery:1', 1);

    expect(result.resyncRequired).toBe(false);
    if (!result.resyncRequired) {
      expect(result.events).toEqual([]);
    }
  });

  it('requires a resync when the requested gap is wider than the buffer', async () => {
    const server = makeServer() as any;
    await service.publish(server, 'delivery:1', 'location.update', { n: 1 });
    await service.publish(server, 'delivery:1', 'location.update', { n: 2 });

    // Client claims to have seen seq 0 but the buffer's earliest entry is seq 1
    // and there's a gap (simulate by asking for something before what's retained).
    const result = await service.replay('delivery:1', -5);
    expect(result.resyncRequired).toBe(true);
  });

  it('requires a resync when the buffer expired but events were published beyond lastSeq', async () => {
    const server = makeServer() as any;
    await service.publish(server, 'delivery:expired-room', 'location.update', {
      n: 1,
    });
    await service.publish(server, 'delivery:expired-room', 'location.update', {
      n: 2,
    });

    // Simulate the stream buffer having expired (Redis TTL) while the
    // sequence counter survives — replay has nothing to read from but knows
    // more was published than the client has seen.
    await (redis as unknown as { del: (k: string) => Promise<void> }).del(
      'ws:stream:delivery:expired-room',
    );

    const result = await service.replay('delivery:expired-room', 0);
    expect(result.resyncRequired).toBe(true);
  });

  it('does not require resync for a room with no prior activity when client has seen nothing (lastSeq 0)', async () => {
    const result = await service.replay('delivery:never-published', 0);
    expect(result.resyncRequired).toBe(false);
  });
});
