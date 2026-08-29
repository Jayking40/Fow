import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { SorobanService } from '../blockchain/services/soroban.service';
import { SorobanTxJob } from '../blockchain/types/soroban-tx.types';
import { OrderEntity } from '../orders/entities/order.entity';

import { WorkflowOrchestrationService } from './workflow-orchestration.service';

describe('WorkflowOrchestrationService', () => {
  let service: WorkflowOrchestrationService;

  const submitTransaction = jest.fn<Promise<string>, [SorobanTxJob]>();
  const mockSoroban = { submitTransaction };
  const mockOrderRepo = { findOne: jest.fn() };
  const mockConfig = { get: jest.fn().mockReturnValue('COORDINATOR_CONTRACT') };

  const submittedJobs = (): SorobanTxJob[] =>
    submitTransaction.mock.calls.map((call) => call[0]);

  beforeEach(async () => {
    jest.clearAllMocks();
    submitTransaction.mockResolvedValue('job-1');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkflowOrchestrationService,
        { provide: SorobanService, useValue: mockSoroban },
        { provide: ConfigService, useValue: mockConfig },
        { provide: getRepositoryToken(OrderEntity), useValue: mockOrderRepo },
      ],
    }).compile();

    service = module.get(WorkflowOrchestrationService);
  });

  describe('rollback — idempotency key', () => {
    it('uses a deterministic key derived only from requestId', async () => {
      await service.rollback({ requestId: 'req-42' });

      expect(submitTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          contractMethod: 'rollback',
          idempotencyKey: 'rollback:req-42',
        }),
      );
    });

    it('produces the same key for two rapid rollback() calls for the same request', async () => {
      await service.rollback({ requestId: 'req-42' });
      await service.rollback({ requestId: 'req-42' });

      const jobs = submittedJobs();
      expect(jobs[1].idempotencyKey).toBe(jobs[0].idempotencyKey);
    });

    it('never embeds a timestamp or other always-unique value in the key', async () => {
      await service.rollback({ requestId: 'req-42' });

      // rollback:<requestId> — no trailing Date.now()/uuid segment.
      expect(submittedJobs()[0].idempotencyKey).toMatch(/^rollback:[^:]+$/);
    });

    it('is deduplicated by the submission pipeline on a retried call', async () => {
      submitTransaction
        .mockResolvedValueOnce('job-1')
        .mockRejectedValueOnce(
          new Error('Duplicate submission - idempotency key already exists'),
        );

      await expect(service.rollback({ requestId: 'req-42' })).resolves.toEqual({
        jobId: 'job-1',
      });
      await expect(service.rollback({ requestId: 'req-42' })).rejects.toThrow(
        /Duplicate submission/,
      );

      const keys = submittedJobs().map((job) => job.idempotencyKey);
      expect(new Set(keys).size).toBe(1);
    });

    it('follows the same <step>:<requestId> shape as allocate/delivery/settle', async () => {
      await service.rollback({ requestId: 'req-7' });

      expect(submittedJobs()[0].idempotencyKey).toBe('rollback:req-7');
    });
  });
});
