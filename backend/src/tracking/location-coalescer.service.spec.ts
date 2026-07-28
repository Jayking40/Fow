/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';

import { RoomEventBusService } from '../websockets/room-event-bus.service';

import { LocationCoalescerService } from './location-coalescer.service';

describe('LocationCoalescerService', () => {
  let service: LocationCoalescerService;
  let roomEventBus: { publish: jest.Mock };

  beforeEach(async () => {
    jest.useFakeTimers();
    roomEventBus = { publish: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LocationCoalescerService,
        { provide: RoomEventBusService, useValue: roomEventBus },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, def: number) =>
              key === 'LOCATION_COALESCE_INTERVAL_MS' ? 100 : def,
          },
        },
      ],
    }).compile();

    service = module.get(LocationCoalescerService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not publish immediately on record', () => {
    const server = {} as any;
    service.record(server, 'delivery:1', 'rider-1', { lat: 1 });
    expect(roomEventBus.publish).not.toHaveBeenCalled();
  });

  it('flushes the latest position for a rider on the next tick', () => {
    const server = {} as any;
    service.record(server, 'delivery:1', 'rider-1', { lat: 1 });
    service.record(server, 'delivery:1', 'rider-1', { lat: 2 });

    jest.advanceTimersByTime(100);

    expect(roomEventBus.publish).toHaveBeenCalledTimes(1);
    expect(roomEventBus.publish).toHaveBeenCalledWith(
      server,
      'delivery:1',
      'location.update',
      { lat: 2 },
    );
  });

  it('flushes each rider in a room independently (latest-wins per rider)', () => {
    const server = {} as any;
    service.record(server, 'delivery:1', 'rider-1', {
      riderId: 'rider-1',
      lat: 1,
    });
    service.record(server, 'delivery:1', 'rider-2', {
      riderId: 'rider-2',
      lat: 5,
    });

    jest.advanceTimersByTime(100);

    expect(roomEventBus.publish).toHaveBeenCalledTimes(2);
  });

  it('stops ticking once a room has no pending updates', () => {
    const server = {} as any;
    service.record(server, 'delivery:1', 'rider-1', { lat: 1 });

    jest.advanceTimersByTime(100);
    expect(roomEventBus.publish).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(300);
    // No new records since the last flush — interval should have torn itself down.
    expect(roomEventBus.publish).toHaveBeenCalledTimes(1);
  });

  it('resumes coalescing when new updates arrive for a previously idle room', () => {
    const server = {} as any;
    service.record(server, 'delivery:1', 'rider-1', { lat: 1 });
    jest.advanceTimersByTime(100);
    expect(roomEventBus.publish).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(100);
    service.record(server, 'delivery:1', 'rider-1', { lat: 2 });
    jest.advanceTimersByTime(100);

    expect(roomEventBus.publish).toHaveBeenCalledTimes(2);
  });
});
