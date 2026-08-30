import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { DataSource } from 'typeorm';

import { OrderEntity } from '../orders/entities/order.entity';

import { BlockchainEvent } from './entities/blockchain-event.entity';
import { BloodUnitTrail } from './entities/blood-unit-trail.entity';
import { IndexerStateEntity } from './entities/indexer-state.entity';
import { RawUnparsedEventEntity } from './entities/raw-unparsed-event.entity';
import { ReconciliationLogEntity } from './entities/reconciliation-log.entity';
import { ContractEventDecodeFailureReason } from './event-schema-version';
import { SorobanService } from './soroban.service';
import {
  CONTRACT_EVENT_QUARANTINED,
  SorobanIndexerService,
} from './soroban-indexer.service';

type RepoMock = Record<string, jest.Mock>;

function repoMock(): RepoMock {
  return {
    find: jest.fn(() => Promise.resolve([])),
    findOne: jest.fn(() => Promise.resolve(null)),
    create: jest.fn((e: Record<string, unknown>) => ({ ...e })),
    save: jest.fn((e: Record<string, unknown>) =>
      Promise.resolve({ id: 'row-1', ...e }),
    ),
  };
}

describe('SorobanIndexerService — schema-registry quarantine', () => {
  let service: SorobanIndexerService;
  let eventRepo: RepoMock;
  let unparsedRepo: RepoMock;
  let emitter: { emit: jest.Mock };

  beforeEach(async () => {
    eventRepo = repoMock();
    unparsedRepo = repoMock();
    emitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SorobanIndexerService,
        { provide: SorobanService, useValue: { getUnitTrail: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: DataSource, useValue: { transaction: jest.fn() } },
        { provide: EventEmitter2, useValue: emitter },
        { provide: getRepositoryToken(BloodUnitTrail), useValue: repoMock() },
        { provide: getRepositoryToken(BlockchainEvent), useValue: eventRepo },
        {
          provide: getRepositoryToken(IndexerStateEntity),
          useValue: repoMock(),
        },
        {
          provide: getRepositoryToken(ReconciliationLogEntity),
          useValue: repoMock(),
        },
        { provide: getRepositoryToken(OrderEntity), useValue: repoMock() },
        {
          provide: getRepositoryToken(RawUnparsedEventEntity),
          useValue: unparsedRepo,
        },
      ],
    }).compile();

    service = module.get(SorobanIndexerService);
  });

  it('quarantines an unknown event type instead of crashing ingestion', async () => {
    const badEvent = {
      id: 'evt-bad',
      eventType: 'mystery_event',
      transactionHash: 'tx-1',
      eventData: { schemaVersion: 1 },
      blockchainTimestamp: new Date(),
      processed: false,
    };
    eventRepo.find.mockResolvedValueOnce([badEvent]);

    await expect(service.indexEvents()).resolves.toBeUndefined();

    expect(unparsedRepo.save).toHaveBeenCalledTimes(1);
    expect(unparsedRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'soroban-indexer',
        eventType: 'mystery_event',
        reason: ContractEventDecodeFailureReason.UNREGISTERED_EVENT_TYPE,
        transactionHash: 'tx-1',
        resolved: false,
      }),
    );
    // event is still acknowledged so it is not retried forever
    expect(eventRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'evt-bad', processed: true }),
    );
  });

  it('emits an alert event when an undecodable event is quarantined', async () => {
    eventRepo.find.mockResolvedValueOnce([
      {
        id: 'evt-bad',
        eventType: 'blood_registered',
        transactionHash: 'tx-2',
        eventData: { schemaVersion: 999, unitId: 1 },
        blockchainTimestamp: new Date(),
        processed: false,
      },
    ]);

    await service.indexEvents();

    expect(emitter.emit).toHaveBeenCalledWith(
      CONTRACT_EVENT_QUARANTINED,
      expect.objectContaining({
        eventType: 'blood_registered',
        reason: ContractEventDecodeFailureReason.UNSUPPORTED_SCHEMA_VERSION,
      }),
    );
  });

  it('does not quarantine a well-formed registered event', async () => {
    eventRepo.find.mockResolvedValueOnce([
      {
        id: 'evt-ok',
        eventType: 'blood_registered',
        transactionHash: 'tx-3',
        eventData: { schemaVersion: 1, unitId: 7 },
        blockchainTimestamp: new Date(),
        processed: false,
      },
    ]);

    await service.indexEvents();

    expect(unparsedRepo.save).not.toHaveBeenCalled();
    expect(eventRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'evt-ok', processed: true }),
    );
  });

  it('lists unresolved quarantined events by default', async () => {
    await service.getUnparsedEvents();
    expect(unparsedRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { resolved: false },
        order: { createdAt: 'DESC' },
        take: 50,
      }),
    );
  });
});
