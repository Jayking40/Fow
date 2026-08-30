import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { OrderEntity } from '../orders/entities/order.entity';
import { OrderFeeService } from '../orders/services/order-fee.service';

import {
  FeePolicyEntity,
  ServiceLevel,
  UrgencyTier,
} from './entities/fee-policy.entity';
import { FeePolicyService } from './fee-policy.service';

/**
 * End-to-end coverage for the consolidated fee-policy module: an order flows
 * through its real consumer (`OrderFeeService`) into the real `FeePolicyService`
 * computation and back onto the persisted order. Only the repositories are
 * mocked. Guards against a future re-split where a consumer silently binds to a
 * second `FeePolicyService`.
 */
describe('fee-policy (end-to-end via OrderFeeService)', () => {
  let orderFeeService: OrderFeeService;
  const savedOrders: OrderEntity[] = [];

  const policyRepo = {
    findOne: jest.fn().mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111',
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
    } as FeePolicyEntity),
  };

  const orderRepo = {
    save: jest.fn((order: OrderEntity) => {
      savedOrders.push(order);
      return Promise.resolve(order);
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    savedOrders.length = 0;

    const module = await Test.createTestingModule({
      providers: [
        OrderFeeService,
        FeePolicyService,
        { provide: getRepositoryToken(OrderEntity), useValue: orderRepo },
        { provide: getRepositoryToken(FeePolicyEntity), useValue: policyRepo },
      ],
    }).compile();

    orderFeeService = module.get(OrderFeeService);
  });

  it('computes and persists a real fee breakdown for an order', async () => {
    const order = { id: 'order-1', quantity: 4 } as OrderEntity;

    await orderFeeService.computeAndPersist(order);

    // quantity 4 -> baseAmount 400; deliveryFee 40; platformFee 20;
    // distance 10km * multiplier 2 -> performanceFee 20; total 80
    expect(order.feeBreakdown).toMatchObject({
      baseAmount: 400,
      deliveryFee: 40,
      platformFee: 20,
      performanceFee: 20,
      totalFee: 80,
      appliedPolicyId: '11111111-1111-1111-1111-111111111111',
    });
    expect(order.appliedPolicyId).toBe('11111111-1111-1111-1111-111111111111');
    expect(orderRepo.save).toHaveBeenCalledWith(order);
    expect(savedOrders).toHaveLength(1);
  });

  it('preview returns the same breakdown without persisting', async () => {
    const order = { id: 'order-2', quantity: 4 } as OrderEntity;

    const breakdown = await orderFeeService.preview(order);

    expect(breakdown.totalFee).toBe(80);
    expect(orderRepo.save).not.toHaveBeenCalled();
  });
});
