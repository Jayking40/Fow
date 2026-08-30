import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { BlockchainEvent } from '../soroban/entities/blockchain-event.entity';
import { SorobanService } from '../soroban/soroban.service';

import { CustodyService } from './custody.service';
import { ConfirmHandoffDto, RecordHandoffDto } from './dto/custody.dto';
import { CustodyHandoffEntity } from './entities/custody-handoff.entity';
import {
  CustodyActor,
  CustodyChainStatus,
  CustodyHandoffStatus,
} from './enums/custody.enum';

const mockRepo = () => ({
  create: jest.fn((d: Record<string, unknown>) => ({ ...d, id: 'h-1' })),
  save: jest.fn((e: Record<string, unknown>) => Promise.resolve(e)),
  findOne: jest.fn(),
  find: jest.fn(() => Promise.resolve([])),
});

const mockEventRepo = () => ({
  findOne: jest.fn(() => Promise.resolve(null)),
});

const mockSoroban = () => ({
  transferCustody: jest.fn(() =>
    Promise.resolve({ transactionHash: 'tx-abc' }),
  ),
});

const RECEIVER_ID = 'rider-1';

describe('CustodyService', () => {
  let service: CustodyService;
  let repo: ReturnType<typeof mockRepo>;
  let eventRepo: ReturnType<typeof mockEventRepo>;
  let soroban: ReturnType<typeof mockSoroban>;

  const build = async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustodyService,
        { provide: getRepositoryToken(CustodyHandoffEntity), useValue: repo },
        { provide: getRepositoryToken(BlockchainEvent), useValue: eventRepo },
        { provide: SorobanService, useValue: soroban },
      ],
    }).compile();
    return module.get(CustodyService);
  };

  beforeEach(async () => {
    repo = mockRepo();
    eventRepo = mockEventRepo();
    soroban = mockSoroban();
    service = await build();
  });

  const baseDto: RecordHandoffDto = {
    bloodUnitId: '42',
    orderId: 'order-1',
    fromActorId: 'bank-1',
    fromActorType: CustodyActor.BLOOD_BANK,
    toActorId: RECEIVER_ID,
    toActorType: CustodyActor.RIDER,
    latitude: 6.5,
    longitude: 3.3,
  };

  describe('recordHandoff', () => {
    it('persists a SUBMITTED handoff with the contract event id on chain success', async () => {
      await service.recordHandoff(baseDto);
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          bloodUnitId: '42',
          contractEventId: 'tx-abc',
          chainStatus: CustodyChainStatus.SUBMITTED,
          chainError: null,
          status: CustodyHandoffStatus.PENDING,
        }),
      );
    });

    it('promotes to VERIFIED when the indexer already recorded the event', async () => {
      eventRepo.findOne.mockResolvedValue({ id: 'evt-1' });
      const result = await service.recordHandoff(baseDto);
      expect(result.chainStatus).toBe(CustodyChainStatus.VERIFIED);
      expect(result.chainVerifiedAt).toBeInstanceOf(Date);
    });

    it('flags on-chain failure explicitly as FAILED instead of masking it', async () => {
      soroban.transferCustody = jest.fn(() =>
        Promise.reject(new Error('rpc down')),
      );
      service = await build();

      await service.recordHandoff(baseDto);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          contractEventId: null,
          chainStatus: CustodyChainStatus.FAILED,
          chainError: 'rpc down',
          status: CustodyHandoffStatus.PENDING,
        }),
      );
    });
  });

  describe('confirmHandoff', () => {
    const pending = () => ({
      id: 'h-1',
      status: CustodyHandoffStatus.PENDING,
      chainStatus: CustodyChainStatus.SUBMITTED,
      contractEventId: 'tx-abc',
      toActorId: RECEIVER_ID,
    });

    it('rejects confirmation from an actor other than the receiver', async () => {
      repo.findOne.mockResolvedValue(pending());
      await expect(
        service.confirmHandoff('h-1', {}, 'someone-else'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects confirmation when no caller identity is supplied', async () => {
      repo.findOne.mockResolvedValue(pending());
      await expect(
        service.confirmHandoff('h-1', {}, undefined),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects confirmation when the on-chain transfer failed', async () => {
      repo.findOne.mockResolvedValue({
        ...pending(),
        chainStatus: CustodyChainStatus.FAILED,
        contractEventId: null,
      });
      await expect(
        service.confirmHandoff('h-1', {}, RECEIVER_ID),
      ).rejects.toThrow(/on-chain custody transfer failed/i);
    });

    it('rejects confirmation when the indexer has not verified the transfer', async () => {
      repo.findOne.mockResolvedValue(pending());
      eventRepo.findOne.mockResolvedValue(null);
      await expect(
        service.confirmHandoff('h-1', {}, RECEIVER_ID),
      ).rejects.toThrow(/not been verified by the indexer/i);
    });

    it('confirms once the receiver calls and the transfer is indexer-verified', async () => {
      repo.findOne.mockResolvedValue(pending());
      eventRepo.findOne.mockResolvedValue({ id: 'evt-1' });
      repo.save.mockImplementation((e: CustodyHandoffEntity) =>
        Promise.resolve(e),
      );

      const dto: ConfirmHandoffDto = { proofReference: 'ipfs://abc' };
      const result = await service.confirmHandoff('h-1', dto, RECEIVER_ID);

      expect(result.status).toBe(CustodyHandoffStatus.CONFIRMED);
      expect(result.chainStatus).toBe(CustodyChainStatus.VERIFIED);
      expect(result.confirmedAt).toBeInstanceOf(Date);
    });

    it('throws if handoff not found', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        service.confirmHandoff('bad-id', {}, RECEIVER_ID),
      ).rejects.toThrow('not found');
    });

    it('throws if already confirmed', async () => {
      repo.findOne.mockResolvedValue({
        ...pending(),
        status: CustodyHandoffStatus.CONFIRMED,
      });
      await expect(
        service.confirmHandoff('h-1', {}, RECEIVER_ID),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('assertCustodyComplete', () => {
    const bankToRider = {
      status: CustodyHandoffStatus.CONFIRMED,
      chainStatus: CustodyChainStatus.VERIFIED,
      fromActorType: CustodyActor.BLOOD_BANK,
      toActorType: CustodyActor.RIDER,
    };
    const riderToHospital = {
      status: CustodyHandoffStatus.CONFIRMED,
      chainStatus: CustodyChainStatus.VERIFIED,
      fromActorType: CustodyActor.RIDER,
      toActorType: CustodyActor.HOSPITAL,
    };

    it('passes when both handoffs are confirmed and on-chain verified', async () => {
      repo.find.mockResolvedValue([bankToRider, riderToHospital]);
      await expect(
        service.assertCustodyComplete('order-1'),
      ).resolves.toBeUndefined();
    });

    it('throws when a required handoff is confirmed but not on-chain verified', async () => {
      repo.find.mockResolvedValue([
        bankToRider,
        { ...riderToHospital, chainStatus: CustodyChainStatus.SUBMITTED },
      ]);
      await expect(service.assertCustodyComplete('order-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws when bank→rider handoff missing', async () => {
      repo.find.mockResolvedValue([riderToHospital]);
      await expect(service.assertCustodyComplete('order-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('reconcileSubmittedHandoffs', () => {
    it('verifies submitted handoffs that now have an indexed event', async () => {
      repo.find.mockResolvedValue([
        {
          id: 'h-1',
          chainStatus: CustodyChainStatus.SUBMITTED,
          contractEventId: 'tx-abc',
        },
      ]);
      eventRepo.findOne.mockResolvedValue({ id: 'evt-1' });

      await service.reconcileSubmittedHandoffs();

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'h-1',
          chainStatus: CustodyChainStatus.VERIFIED,
        }),
      );
    });
  });

  describe('getDegradedHandoffs', () => {
    it('queries failed and still-submitted handoffs', async () => {
      await service.getDegradedHandoffs();
      expect(repo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: [
            { chainStatus: CustodyChainStatus.FAILED },
            { chainStatus: CustodyChainStatus.SUBMITTED },
          ],
        }),
      );
    });
  });
});
