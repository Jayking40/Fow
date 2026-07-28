import { Test, TestingModule } from '@nestjs/testing';

import RedisMock from 'ioredis-mock';

import { REDIS_CLIENT } from '../redis/redis.constants';

import { WsRateLimiterService } from './ws-rate-limiter.service';

describe('WsRateLimiterService', () => {
  let service: WsRateLimiterService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WsRateLimiterService,
        { provide: REDIS_CLIENT, useFactory: () => new RedisMock() },
      ],
    }).compile();

    service = module.get(WsRateLimiterService);
  });

  it('allows messages within the configured limit for a known event', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect(await service.allow('socket-1', 'rider.location')).toBe(true);
    }
  });

  it('rejects messages once the configured limit is exceeded', async () => {
    for (let i = 0; i < 5; i += 1) {
      await service.allow('socket-1', 'rider.location');
    }
    expect(await service.allow('socket-1', 'rider.location')).toBe(false);
  });

  it('tracks limits independently per socket', async () => {
    for (let i = 0; i < 5; i += 1) {
      await service.allow('socket-1', 'rider.location');
    }
    expect(await service.allow('socket-2', 'rider.location')).toBe(true);
  });

  it('tracks limits independently per event on the same socket', async () => {
    for (let i = 0; i < 5; i += 1) {
      await service.allow('socket-1', 'rider.location');
    }
    expect(await service.allow('socket-1', 'delivery.status')).toBe(true);
  });

  it('applies the default limit for unlisted events', async () => {
    for (let i = 0; i < 20; i += 1) {
      expect(await service.allow('socket-1', 'some.other.event')).toBe(true);
    }
    expect(await service.allow('socket-1', 'some.other.event')).toBe(false);
  });

  it('fails open if Redis throws', async () => {
    const brokenRedis = {
      incr: jest.fn().mockRejectedValue(new Error('down')),
      pexpire: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WsRateLimiterService,
        { provide: REDIS_CLIENT, useValue: brokenRedis },
      ],
    }).compile();

    const svc = module.get(WsRateLimiterService);
    expect(await svc.allow('socket-1', 'rider.location')).toBe(true);
  });
});
