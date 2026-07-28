/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';

import {
  BackpressureQueueService,
  DEFAULT_QUEUE_CAP,
} from './backpressure-queue.service';

function makeSocket(id = 'socket-1') {
  return {
    id,
    connected: true,
    emit: jest.fn(),
  };
}

describe('BackpressureQueueService', () => {
  let service: BackpressureQueueService;

  beforeEach(async () => {
    jest.useFakeTimers();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BackpressureQueueService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, defaultValue: number) => {
              if (key === 'WS_OUTBOUND_QUEUE_CAP') return 5;
              if (key === 'WS_OUTBOUND_FLUSH_INTERVAL_MS') return 10;
              return defaultValue;
            },
          },
        },
      ],
    }).compile();

    service = module.get(BackpressureQueueService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('flushes queued emits to the socket on the flush interval', () => {
    const socket = makeSocket() as any;
    service.enqueue(socket, 'location.update', { n: 1 });

    jest.advanceTimersByTime(10);

    expect(socket.emit).toHaveBeenCalledWith('location.update', { n: 1 });
  });

  it('drops the oldest item and flags the next flush when over capacity (memory stays flat)', () => {
    const socket = makeSocket() as any;

    // Cap is 5; enqueue 10 without letting the interval drain anything.
    for (let i = 0; i < 10; i += 1) {
      service.enqueue(socket, 'location.update', { n: i });
    }

    expect(service.getQueueDepth(socket.id)).toBe(5);
  });

  it('marks the first flushed item after a drop with _dropped', () => {
    const socket = makeSocket() as any;

    for (let i = 0; i < 10; i += 1) {
      service.enqueue(socket, 'location.update', { n: i });
    }

    jest.advanceTimersByTime(10);

    expect(socket.emit).toHaveBeenCalledWith(
      'location.update',
      expect.objectContaining({ _dropped: 5 }),
    );
  });

  it('releases the interval and stops flushing after disconnect', () => {
    const socket = makeSocket() as any;
    service.enqueue(socket, 'location.update', { n: 1 });
    service.release(socket.id);

    jest.advanceTimersByTime(50);

    expect(socket.emit).not.toHaveBeenCalled();
    expect(service.getQueueDepth(socket.id)).toBe(0);
  });

  it('releases automatically once it detects a disconnected socket during flush', () => {
    const socket = makeSocket() as any;
    service.enqueue(socket, 'location.update', { n: 1 });
    socket.connected = false;

    jest.advanceTimersByTime(10);

    expect(socket.emit).not.toHaveBeenCalled();
    expect(service.getQueueDepth(socket.id)).toBe(0);
  });

  it('defaults the cap when config values are absent', async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BackpressureQueueService,
        {
          provide: ConfigService,
          useValue: { get: (_key: string, def: number) => def },
        },
      ],
    }).compile();

    const svc = module.get(BackpressureQueueService);
    const socket = makeSocket('socket-2') as any;

    for (let i = 0; i < DEFAULT_QUEUE_CAP + 10; i += 1) {
      svc.enqueue(socket, 'e', { i });
    }

    expect(svc.getQueueDepth(socket.id)).toBe(DEFAULT_QUEUE_CAP);
    svc.release(socket.id);
  });
});
