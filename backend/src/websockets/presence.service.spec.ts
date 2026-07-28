import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';

import RedisMock from 'ioredis-mock';

import { REDIS_CLIENT } from '../redis/redis.constants';

import { PresenceService } from './presence.service';

describe('PresenceService', () => {
  let service: PresenceService;
  let eventEmitter: EventEmitter2;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PresenceService,
        EventEmitter2,
        { provide: REDIS_CLIENT, useFactory: () => new RedisMock() },
      ],
    }).compile();

    service = module.get(PresenceService);
    eventEmitter = module.get(EventEmitter2);
  });

  it('reports a rider offline (unknown) before any heartbeat', async () => {
    expect(await service.isOnline('rider-1')).toBe(false);
  });

  it('reports a rider online after setOnline', async () => {
    await service.setOnline('rider-1');
    expect(await service.isOnline('rider-1')).toBe(true);
  });

  it('emits rider.presence.changed on setOnline/setOffline', async () => {
    const spy = jest.fn();
    eventEmitter.on('rider.presence.changed', spy);

    await service.setOnline('rider-1');
    expect(spy).toHaveBeenCalledWith({ riderId: 'rider-1', online: true });

    await service.setOffline('rider-1');
    expect(spy).toHaveBeenCalledWith({ riderId: 'rider-1', online: false });
  });

  it('reports offline again after setOffline', async () => {
    await service.setOnline('rider-1');
    await service.setOffline('rider-1');
    expect(await service.isOnline('rider-1')).toBe(false);
  });

  it('does not throw when Redis is unavailable', async () => {
    const brokenRedis = {
      set: jest.fn().mockRejectedValue(new Error('down')),
      get: jest.fn().mockRejectedValue(new Error('down')),
      del: jest.fn().mockRejectedValue(new Error('down')),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PresenceService,
        EventEmitter2,
        { provide: REDIS_CLIENT, useValue: brokenRedis },
      ],
    }).compile();

    const svc = module.get(PresenceService);
    await expect(svc.setOnline('rider-1')).resolves.toBeUndefined();
    expect(await svc.isOnline('rider-1')).toBe(false);
  });
});
