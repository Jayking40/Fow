import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { EntityManager } from 'typeorm';

import {
  DeadLetterStatus,
  OutboxDeadLetterEntity,
} from './outbox-dead-letter.entity';
import {
  OutboxEventEntity,
  OutboxEventStatus,
  OutboxEventType,
} from './outbox-event.entity';
import { OutboxService } from './outbox.service';

function makeOutboxEvent(
  overrides: Partial<OutboxEventEntity> = {},
): OutboxEventEntity {
  return {
    id: 'evt-1',
    aggregateId: 'req-1',
    aggregateType: 'BloodRequest',
    eventType: OutboxEventType.BLOOD_REQUEST_CREATED,
    eventVersion: 1,
    correlationId: 'corr-1',
    payload: { requestId: 'req-1' },
    status: OutboxEventStatus.PENDING,
    dedupKey: 'dedup-key-1',
    leaseHolder: null,
    leaseExpiresAt: null,
    attemptCount: 0,
    nextAttemptAt: null,
    lastError: null,
    published: false,
    retryCount: 0,
    error: null,
    publishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as OutboxEventEntity;
}

describe('OutboxService', () => {
  let service: OutboxService;
  let outboxRepo: Record<string, jest.Mock> & { manager: { query: jest.Mock } };
  let deadLetterRepo: Record<string, jest.Mock>;

  beforeEach(async () => {
    outboxRepo = {
      create: jest.fn((dto: Record<string, unknown>) => ({
        id: 'evt-1',
        ...dto,
      })),
      save: jest.fn((e: Record<string, unknown>) =>
        Promise.resolve({ id: 'evt-1', ...e }),
      ),
      findOne: jest.fn(() => Promise.resolve(makeOutboxEvent())),
      find: jest.fn(() => Promise.resolve([])),
      update: jest.fn(() => Promise.resolve({ affected: 1 })),
      increment: jest.fn(() => Promise.resolve(undefined)),
      delete: jest.fn(() => Promise.resolve({ affected: 0 })),
      manager: {
        query: jest.fn(() => Promise.resolve([])),
      },
    };

    deadLetterRepo = {
      create: jest.fn((dto: Record<string, unknown>) => ({
        id: 'dl-1',
        ...dto,
      })),
      save: jest.fn((e: Record<string, unknown>) =>
        Promise.resolve({ id: 'dl-1', ...e }),
      ),
      findOne: jest.fn(() => Promise.resolve(null)),
      find: jest.fn(() => Promise.resolve([])),
      update: jest.fn(() => Promise.resolve({ affected: 1 })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutboxService,
        {
          provide: getRepositoryToken(OutboxEventEntity),
          useValue: outboxRepo,
        },
        {
          provide: getRepositoryToken(OutboxDeadLetterEntity),
          useValue: deadLetterRepo,
        },
      ],
    }).compile();

    service = module.get(OutboxService);
  });

  describe('publishEvent — standalone', () => {
    it('creates an outbox entry with PENDING status', async () => {
      const result = await service.publishEvent(
        OutboxEventType.BLOOD_REQUEST_CREATED,
        { requestId: 'req-1' },
        'req-1',
        'BloodRequest',
        'corr-1',
      );
      expect(outboxRepo.save).toHaveBeenCalled();
      expect(result.status).toBe(OutboxEventStatus.PENDING);
    });

    it('generates a dedup key', async () => {
      await service.publishEvent(OutboxEventType.BLOOD_REQUEST_CREATED, {});
      const calls = outboxRepo.create.mock.calls as Array<
        [{ dedupKey: string }]
      >;
      const createCall = calls[0][0];
      expect(createCall.dedupKey).toBeDefined();
      expect(createCall.dedupKey.length).toBeGreaterThan(0);
    });
  });

  describe('publishInTransaction — atomicity', () => {
    it('uses the provided EntityManager to insert in the same transaction', async () => {
      const em = {
        create: jest.fn((_: unknown, dto: Record<string, unknown>) => ({
          id: 'evt-tx',
          ...dto,
        })),
        save: jest.fn((_: unknown, e: Record<string, unknown>) =>
          Promise.resolve({ id: 'evt-tx', ...e }),
        ),
      };
      const result = await service.publishInTransaction(
        em as unknown as EntityManager,
        OutboxEventType.BLOOD_REQUEST_CREATED,
        { requestId: 'req-1' },
        { aggregateId: 'req-1', correlationId: 'corr-1' },
      );
      expect(em.save).toHaveBeenCalled();
      expect(result.status).toBe(OutboxEventStatus.PENDING);
    });
  });

  describe('claimPendingEvents — lease-based polling', () => {
    it('runs a single atomic UPDATE ... RETURNING and maps rows back to entity shape', async () => {
      outboxRepo.manager.query.mockResolvedValue([
        {
          id: 'evt-1',
          aggregate_id: 'req-1',
          aggregate_type: 'BloodRequest',
          event_type: OutboxEventType.BLOOD_REQUEST_CREATED,
          event_version: 1,
          correlation_id: 'corr-1',
          payload: { requestId: 'req-1' },
          status: OutboxEventStatus.PROCESSING,
          dedup_key: 'dedup-key-1',
          lease_holder: 'worker-1',
          lease_expires_at: new Date(),
          attempt_count: 0,
          next_attempt_at: null,
          last_error: null,
          published_at: null,
          published: false,
          retry_count: 0,
          error: null,
          created_at: new Date(),
          updated_at: new Date(),
          sequence: '1',
        },
      ]);

      const events = await service.claimPendingEvents('worker-1', 10);

      expect(outboxRepo.manager.query).toHaveBeenCalledTimes(1);
      const [sql] = outboxRepo.manager.query.mock.calls[0] as [string];
      expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
      expect(sql).toMatch(/RETURNING \*/);

      expect(events).toHaveLength(1);
      expect(events[0].id).toBe('evt-1');
      expect(events[0].aggregateId).toBe('req-1');
      expect(events[0].eventType).toBe(OutboxEventType.BLOOD_REQUEST_CREATED);
      expect(events[0].leaseHolder).toBe('worker-1');
    });

    it('returns an empty array when nothing is claimable', async () => {
      outboxRepo.manager.query.mockResolvedValue([]);
      const events = await service.claimPendingEvents('worker-1', 10);
      expect(events).toEqual([]);
    });
  });

  describe('markPublished', () => {
    it('sets status to PUBLISHED and published=true', async () => {
      await service.markPublished('evt-1');
      expect(outboxRepo.update).toHaveBeenCalledWith(
        'evt-1',
        expect.objectContaining({
          status: OutboxEventStatus.PUBLISHED,
          published: true,
        }),
      );
    });
  });

  describe('recordFailure — backoff and dead-letter', () => {
    it('schedules retry with exponential backoff on first failure', async () => {
      outboxRepo.findOne.mockResolvedValue(
        makeOutboxEvent({ attemptCount: 0 }),
      );
      await service.recordFailure('evt-1', 'timeout');
      expect(outboxRepo.update).toHaveBeenCalledWith(
        'evt-1',
        expect.objectContaining({
          status: OutboxEventStatus.PENDING,
          attemptCount: 1,
        }),
      );
    });

    it('moves to dead-letter when max attempts exceeded', async () => {
      outboxRepo.findOne.mockResolvedValue(
        makeOutboxEvent({ attemptCount: 4 }),
      );
      await service.recordFailure('evt-1', 'persistent error');
      expect(deadLetterRepo.save).toHaveBeenCalled();
      expect(outboxRepo.update).toHaveBeenCalledWith(
        'evt-1',
        expect.objectContaining({ status: OutboxEventStatus.DEAD_LETTERED }),
      );
    });
  });

  describe('dead-letter replay and discard', () => {
    const dl = {
      id: 'dl-1',
      outboxEventId: 'evt-1',
      aggregateId: 'req-1',
      aggregateType: 'BloodRequest',
      eventType: OutboxEventType.BLOOD_REQUEST_CREATED,
      eventVersion: 1,
      correlationId: 'corr-1',
      payload: { requestId: 'req-1' },
      attemptCount: 5,
      lastError: 'timeout',
      status: DeadLetterStatus.PENDING,
      operatorNotes: null,
    };

    it('replays a dead-letter as a new PENDING outbox event', async () => {
      deadLetterRepo.findOne.mockResolvedValue(dl);
      const result = await service.replayDeadLetter('dl-1', 'Fixed downstream');
      expect(outboxRepo.save).toHaveBeenCalled();
      expect(result.status).toBe(OutboxEventStatus.PENDING);
      expect(deadLetterRepo.update).toHaveBeenCalledWith(
        'dl-1',
        expect.objectContaining({ status: DeadLetterStatus.REPLAYED }),
      );
    });

    it('uses a deterministic dedup key (no timestamp) for the replayed event', async () => {
      deadLetterRepo.findOne.mockResolvedValue(dl);
      await service.replayDeadLetter('dl-1');
      const calls = outboxRepo.create.mock.calls as Array<
        [{ dedupKey: string }]
      >;
      expect(calls[0][0].dedupKey).toBe('replay:dl-1');
    });

    it('produces the same dedup key across repeated replay attempts', async () => {
      deadLetterRepo.findOne.mockResolvedValue(dl);
      await service.replayDeadLetter('dl-1');
      await service.replayDeadLetter('dl-1');
      const calls = outboxRepo.create.mock.calls as Array<
        [{ dedupKey: string }]
      >;
      expect(calls[1][0].dedupKey).toBe(calls[0][0].dedupKey);
    });

    it('rejects replaying a dead-letter that was already replayed', async () => {
      deadLetterRepo.findOne.mockResolvedValue({
        ...dl,
        status: DeadLetterStatus.REPLAYED,
      });
      await expect(service.replayDeadLetter('dl-1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('discards a dead-letter event', async () => {
      deadLetterRepo.findOne.mockResolvedValue({ ...dl });
      deadLetterRepo.save.mockResolvedValue({
        ...dl,
        status: DeadLetterStatus.DISCARDED,
      });
      const result = await service.discardDeadLetter('dl-1', 'Stale event');
      expect(result.status).toBe(DeadLetterStatus.DISCARDED);
    });

    it('throws NotFoundException when dead-letter does not exist', async () => {
      deadLetterRepo.findOne.mockResolvedValue(null);
      await expect(service.replayDeadLetter('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
