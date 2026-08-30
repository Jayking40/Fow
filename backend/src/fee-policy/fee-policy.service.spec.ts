import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { CreateFeePolicyDto, FeePreviewDto } from './dto/fee-policy.dto';
import {
  FeePolicyEntity,
  ServiceLevel,
  UrgencyTier,
} from './entities/fee-policy.entity';
import { FeePolicyService } from './fee-policy.service';

const mockRepo = () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn((v) => v),
  save: jest.fn((v) => Promise.resolve({ id: 'policy-1', ...v })),
  delete: jest.fn(),
});

const policyRow = (overrides: Partial<FeePolicyEntity> = {}): FeePolicyEntity =>
  ({
    id: 'policy-1',
    geographyCode: 'LAG',
    urgencyTier: UrgencyTier.STANDARD,
    minDistanceKm: 0,
    maxDistanceKm: 50,
    serviceLevel: ServiceLevel.BASIC,
    deliveryFeeRate: 10,
    platformFeePct: 50,
    performanceMultiplier: 2,
    fixedFee: 5,
    priority: 1,
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }) as FeePolicyEntity;

const previewDto = (overrides: Partial<FeePreviewDto> = {}): FeePreviewDto => ({
  geographyCode: 'LAG',
  urgencyTier: UrgencyTier.STANDARD,
  distanceKm: 3,
  serviceLevel: ServiceLevel.BASIC,
  quantity: 4,
  ...overrides,
});

describe('FeePolicyService', () => {
  let service: FeePolicyService;
  let repo: ReturnType<typeof mockRepo>;

  beforeEach(async () => {
    repo = mockRepo();
    const module = await Test.createTestingModule({
      providers: [
        FeePolicyService,
        { provide: getRepositoryToken(FeePolicyEntity), useValue: repo },
      ],
    }).compile();
    service = module.get(FeePolicyService);
  });

  describe('previewFees', () => {
    it('computes a deterministic breakdown from the applicable policy', async () => {
      repo.findOne.mockResolvedValue(policyRow());

      const breakdown = await service.previewFees(previewDto());

      // baseAmount = 4 * 100 = 400
      // deliveryFee = 400 * 10% = 40
      // platformFee = 40 * 50% = 20
      // performanceFee = 3km * 2 = 6
      expect(breakdown).toMatchObject({
        appliedPolicyId: 'policy-1',
        baseAmount: 400,
        deliveryFee: 40,
        platformFee: 20,
        performanceFee: 6,
        fixedFee: 5,
        totalFee: 66,
      });
    });

    it('returns a stable audit hash for identical inputs', async () => {
      repo.findOne.mockResolvedValue(policyRow());

      const first = await service.previewFees(previewDto());
      const second = await service.previewFees(previewDto());

      expect(first.auditHash).toEqual(second.auditHash);
    });

    it('throws BadRequestException when no policy matches', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(service.previewFees(previewDto())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('computeFeeWithSurge', () => {
    it('applies the surge multiplier to the platform fee only', async () => {
      repo.findOne.mockResolvedValue(policyRow());

      const breakdown = await service.computeFeeWithSurge(previewDto(), 2, 'O+');

      // platformFee 20 -> 40, delta 20 added to totalFee 66 -> 86
      expect(breakdown.platformFee).toBe(40);
      expect(breakdown.deliveryFee).toBe(40);
      expect(breakdown.performanceFee).toBe(6);
      expect(breakdown.totalFee).toBe(86);
    });

    it('is a no-op at multiplier 1', async () => {
      repo.findOne.mockResolvedValue(policyRow());

      const plain = await service.previewFees(previewDto());
      const surged = await service.computeFeeWithSurge(previewDto(), 1, 'O+');

      expect(surged.platformFee).toBe(plain.platformFee);
      expect(surged.totalFee).toBe(plain.totalFee);
    });

    it('throws BadRequestException when no policy matches', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(
        service.computeFeeWithSurge(previewDto(), 2, 'O+'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('CRUD', () => {
    it('create persists the new policy', async () => {
      const dto = { geographyCode: 'ABJ' } as unknown as CreateFeePolicyDto;
      await service.create(dto);
      expect(repo.create).toHaveBeenCalledWith(dto);
      expect(repo.save).toHaveBeenCalled();
    });

    it('findOne throws NotFoundException for an unknown id', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.findOne('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('remove throws NotFoundException when nothing was deleted', async () => {
      repo.delete.mockResolvedValue({ affected: 0 });
      await expect(service.remove('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
