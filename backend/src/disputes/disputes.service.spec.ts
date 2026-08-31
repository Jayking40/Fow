import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { SorobanService } from '../blockchain/services/soroban.service';

import { DisputesService } from './disputes.service';
import { DisputeNoteEntity } from './entities/dispute-note.entity';
import { DisputeEntity } from './entities/dispute.entity';
import {
  DisputeStatus,
  DisputeSeverity,
  DisputeReasonTaxonomy,
  DisputeOutcome,
} from './enums/dispute.enum';

describe('DisputesService', () => {
  let service: DisputesService;
  let disputeRepo: {
    create: jest.Mock;
    save: jest.Mock;
    remove: jest.Mock;
    findOne: jest.Mock;
  };
  let sorobanService: {
    submitTransaction: jest.Mock;
  };

  beforeEach(async () => {
    disputeRepo = {
      create: jest
        .fn()
        .mockImplementation((dto: Partial<DisputeEntity>) => dto),
      save: jest
        .fn()
        .mockImplementation((entity: Partial<DisputeEntity>) =>
          Promise.resolve({ ...entity, id: 'test-id' }),
        ),
      remove: jest.fn().mockResolvedValue(true),
      findOne: jest.fn(),
    };

    sorobanService = {
      submitTransaction: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DisputesService,
        {
          provide: getRepositoryToken(DisputeEntity),
          useValue: disputeRepo,
        },
        {
          provide: getRepositoryToken(DisputeNoteEntity),
          useValue: {},
        },
        {
          provide: SorobanService,
          useValue: sorobanService,
        },
      ],
    }).compile();

    service = module.get<DisputesService>(DisputesService);
  });

  describe('open()', () => {
    it('should fail and remove off-chain entity if on-chain call fails', async () => {
      sorobanService.submitTransaction.mockRejectedValue(
        new Error('Blockchain timeout'),
      );

      await expect(
        service.open(
          {
            orderId: 'order-1',
            paymentId: '123',
            reason: DisputeReasonTaxonomy.FAILED_DELIVERY,
            severity: DisputeSeverity.HIGH,
          },
          'user-1',
        ),
      ).rejects.toThrow(BadRequestException);

      expect(disputeRepo.save).toHaveBeenCalledTimes(1);
      expect(sorobanService.submitTransaction).toHaveBeenCalled();
      // Should remove the saved entity so we don't have dangling off-chain state
      expect(disputeRepo.remove).toHaveBeenCalled();
    });

    it('should succeed and save contractDisputeId if on-chain call succeeds', async () => {
      sorobanService.submitTransaction.mockResolvedValue('job-123');

      const result = await service.open(
        {
          orderId: 'order-1',
          paymentId: '123',
          reason: DisputeReasonTaxonomy.FAILED_DELIVERY,
          severity: DisputeSeverity.HIGH,
        },
        'user-1',
      );

      expect(result.contractDisputeId).toBe('job-123');
      expect(disputeRepo.save).toHaveBeenCalledTimes(2);
      expect(sorobanService.submitTransaction).toHaveBeenCalled();
    });
  });

  describe('resolve()', () => {
    it('should set status to RESOLUTION_PENDING if paymentId exists', async () => {
      disputeRepo.findOne.mockResolvedValue({
        id: 'dispute-1',
        paymentId: '123',
        status: DisputeStatus.UNDER_REVIEW,
      });
      sorobanService.submitTransaction.mockResolvedValue('job-456');

      const result = await service.resolve('dispute-1', {
        resolutionNotes: 'Refunded',
        outcome: DisputeOutcome.PAYER_WIN,
        resolvedBy: 'operator-1',
      });

      expect(result.status).toBe(DisputeStatus.RESOLUTION_PENDING);
      expect(sorobanService.submitTransaction).toHaveBeenCalled();
      expect(disputeRepo.save).toHaveBeenCalled();
    });

    it('should set status to RESOLVED if paymentId does not exist', async () => {
      disputeRepo.findOne.mockResolvedValue({
        id: 'dispute-1',
        status: DisputeStatus.UNDER_REVIEW,
      });

      const result = await service.resolve('dispute-1', {
        resolutionNotes: 'No payment',
        outcome: DisputeOutcome.DISMISSED,
        resolvedBy: 'operator-1',
      });

      expect(result.status).toBe(DisputeStatus.RESOLVED);
      expect(sorobanService.submitTransaction).not.toHaveBeenCalled();
      expect(disputeRepo.save).toHaveBeenCalled();
    });
  });
});
