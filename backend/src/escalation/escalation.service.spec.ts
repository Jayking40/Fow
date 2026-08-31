import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { EscalationEntity } from './entities/escalation.entity';
import { EscalationTier } from './enums/escalation-tier.enum';
import {
  EscalationPolicyService,
  EscalationInput,
} from './escalation-policy.service';
import { EscalationService } from './escalation.service';

describe('EscalationService', () => {
  let service1: EscalationService;
  let service2: EscalationService;
  let repo: jest.Mocked<Repository<EscalationEntity>>;

  let mockDb: EscalationEntity | null = null;

  beforeEach(async () => {
    mockDb = null;
    repo = {
      create: jest
        .fn()
        .mockImplementation(
          (dto: Partial<EscalationEntity>) => dto as EscalationEntity,
        ),
      save: jest.fn().mockImplementation((dto: EscalationEntity) => {
        mockDb = dto;
        return Promise.resolve(dto);
      }),
      findOne: jest.fn().mockImplementation(() => Promise.resolve(mockDb)),
      find: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<Repository<EscalationEntity>>;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      providers: [
        EscalationService,
        { provide: getRepositoryToken(EscalationEntity), useValue: repo },
        {
          provide: EscalationPolicyService,
          useValue: {
            evaluate: () => EscalationTier.TIER_1,
            slaDeadlineMs: () => 1000,
          },
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service1 = moduleFixture.get<EscalationService>(EscalationService);

    const moduleFixture2: TestingModule = await Test.createTestingModule({
      providers: [
        EscalationService,
        { provide: getRepositoryToken(EscalationEntity), useValue: repo },
        {
          provide: EscalationPolicyService,
          useValue: {
            evaluate: () => EscalationTier.TIER_1,
            slaDeadlineMs: () => 1000,
          },
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service2 = moduleFixture2.get<EscalationService>(EscalationService);
  });

  it('should prevent duplicate escalations across multiple instances', async () => {
    // Both instances call evaluate (sequentially, simulating different webhook deliveries to different pods)
    const req = 'req-1';
    const mockInput = {} as unknown as EscalationInput;
    await service1.evaluate(req, null, 'hosp-1', null, mockInput);
    await service2.evaluate(req, null, 'hosp-1', null, mockInput);

    expect(repo.save.mock.calls.length).toBe(1);
  });

  it('should survive process restarts (simulate by instantiating a new service)', async () => {
    const req = 'req-restart';
    const mockInput = {} as unknown as EscalationInput;

    // Simulate first instance evaluating
    await service1.evaluate(req, null, 'hosp-1', null, mockInput);
    expect(repo.save.mock.calls.length).toBe(1);

    // Simulate instance restart: original service is destroyed, new one is created.
    // In-memory state would be lost, but DB state persists (mockDb is still holding the saved entity).

    await service2.evaluate(req, null, 'hosp-1', null, mockInput);

    // Save should NOT be called again, proving dedup survived restart via DB
    expect(repo.save.mock.calls.length).toBe(1);
  });
});
