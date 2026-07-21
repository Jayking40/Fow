import {
  Injectable,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { OrderStatus } from '../orders/enums/order-status.enum';
import { OrderEntity } from '../orders/entities/order.entity';
import { DeliveryProofEntity } from '../delivery-proof/entities/delivery-proof.entity';
import {
  DispatchSyncLogEntity,
  SyncActionType,
  SyncLogStatus,
} from './entities/dispatch-sync-log.entity';

/** Gap in minutes beyond which a synced action is considered late */
const LATE_SYNC_THRESHOLD_MINUTES = 5;

/** TTL for dispatch sync idempotency keys: 72 hours in seconds */
export const DISPATCH_SYNC_IDEMPOTENCY_TTL = 72 * 60 * 60;

export interface SyncActionDto {
  assignmentId: string;
  riderId: string;
  actionType: SyncActionType;
  capturedAt: string;
  payload?: Record<string, unknown>;
}

export interface SyncResult {
  idempotencyKey: string;
  actionType: SyncActionType;
  lateSync: boolean;
  syncedAt: string;
  status: SyncLogStatus;
}

@Injectable()
export class DispatchSyncService {
  private readonly logger = new Logger(DispatchSyncService.name);

  constructor(
    @InjectRepository(OrderEntity)
    private readonly orderRepo: Repository<OrderEntity>,
    @InjectRepository(DeliveryProofEntity)
    private readonly proofRepo: Repository<DeliveryProofEntity>,
    @InjectRepository(DispatchSyncLogEntity)
    private readonly syncLogRepo: Repository<DispatchSyncLogEntity>,
  ) {}

  /**
   * Returns true when the gap between capturedAt and receivedAt exceeds 5 minutes.
   * Requirement 4.2
   */
  computeLateSync(capturedAt: string, receivedAt: Date): boolean {
    const capturedMs = new Date(capturedAt).getTime();
    const receivedMs = receivedAt.getTime();
    const gapMinutes = (receivedMs - capturedMs) / (1000 * 60);
    return gapMinutes > LATE_SYNC_THRESHOLD_MINUTES;
  }

  /**
   * Returns true when the order is in a terminal state.
   * Requirement 8.2
   */
  isTerminalState(orderStatus: OrderStatus): boolean {
    return (
      orderStatus === OrderStatus.DELIVERED ||
      orderStatus === OrderStatus.CANCELLED
    );
  }

  /**
   * Orchestrates idempotency check, terminal-state guard, state transition,
   * late-sync flag, and sync log write.
   * Requirements 3.2, 3.3, 4.2, 8.1, 8.2
   */
  async applyAction(dto: SyncActionDto, idempotencyKey: string): Promise<SyncResult> {
    const receivedAt = new Date();

    // Idempotency: return cached result if key already processed
    const existing = await this.syncLogRepo.findOne({
      where: { idempotencyKey },
    });

    if (existing) {
      this.logger.log(`Duplicate sync action detected: ${idempotencyKey}`);
      return {
        idempotencyKey,
        actionType: existing.actionType,
        lateSync: existing.lateSync,
        syncedAt: existing.syncedAt.toISOString(),
        status: SyncLogStatus.DUPLICATE,
      };
    }

    // Terminal-state guard
    const order = await this.orderRepo.findOne({
      where: { id: dto.assignmentId },
    });

    if (order && this.isTerminalState(order.status as OrderStatus)) {
      throw new ConflictException({
        message: 'Order is in a terminal state and cannot be updated',
        currentState: order.status,
        assignmentId: dto.assignmentId,
      });
    }

    const lateSync = this.computeLateSync(dto.capturedAt, receivedAt);

    // Update delivery proof late_sync flag if applicable
    if (lateSync) {
      const proof = await this.proofRepo.findOne({
        where: { orderId: dto.assignmentId },
      });
      if (proof) {
        proof.lateSync = true;
        proof.syncedAt = receivedAt;
        await this.proofRepo.save(proof);
      }
    }

    // Write sync log
    const log = this.syncLogRepo.create({
      idempotencyKey,
      actionType: dto.actionType,
      assignmentId: dto.assignmentId,
      riderId: dto.riderId,
      capturedAt: new Date(dto.capturedAt),
      syncedAt: receivedAt,
      lateSync,
      status: SyncLogStatus.PROCESSED,
    });

    await this.syncLogRepo.save(log);

    return {
      idempotencyKey,
      actionType: dto.actionType,
      lateSync,
      syncedAt: receivedAt.toISOString(),
      status: SyncLogStatus.PROCESSED,
    };
  }
}
