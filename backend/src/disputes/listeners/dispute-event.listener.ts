import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { ContractEventIndexerService } from '../../contract-event-indexer/contract-event-indexer.service';
import {
  ContractDomain,
  ContractEventEntity,
} from '../../contract-event-indexer/entities/contract-event.entity';
import { IndexerCursorEntity } from '../../contract-event-indexer/entities/indexer-cursor.entity';
import { ReconciliationMismatchEntity } from '../../reconciliation/entities/reconciliation-mismatch.entity';
import {
  ExceptionCategory,
  MismatchResolution,
  MismatchSeverity,
  MismatchType,
} from '../../reconciliation/enums/reconciliation.enum';
import { DisputeEntity } from '../entities/dispute.entity';
import { DisputeStatus } from '../enums/dispute.enum';

@Injectable()
export class DisputeEventListener {
  private readonly logger = new Logger(DisputeEventListener.name);
  private isProcessing = false;

  constructor(
    private readonly indexerService: ContractEventIndexerService,
    @InjectRepository(DisputeEntity)
    private readonly disputeRepo: Repository<DisputeEntity>,
    @InjectRepository(ReconciliationMismatchEntity)
    private readonly mismatchRepo: Repository<ReconciliationMismatchEntity>,
    @InjectRepository(IndexerCursorEntity)
    private readonly cursorRepo: Repository<IndexerCursorEntity>,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async processDisputeEvents() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const projectionName = 'dispute_reconciliation';
      const domain = ContractDomain.PAYMENT;

      const cursor = await this.cursorRepo.findOne({
        where: { domain, projectionName },
      });
      const fromLedger = cursor ? cursor.lastLedger : 0;

      // Fetch events from the contract-event-indexer
      const events = await this.indexerService.findAll({
        domain,
        page: 1,
        pageSize: 100,
      });

      let maxLedger = fromLedger;

      for (const event of events.data) {
        if (event.ledgerSequence <= fromLedger) continue;

        if (event.eventType === 'disputed' || event.eventType === 'resolved') {
          await this.reconcileDisputeEvent(event);
        }

        if (event.ledgerSequence > maxLedger) {
          maxLedger = event.ledgerSequence;
        }
      }

      if (maxLedger > fromLedger) {
        await this.indexerService.advanceProjectionCursor(
          domain,
          maxLedger,
          projectionName,
        );
      }
    } catch (err) {
      this.logger.error(
        `Failed to process dispute events: ${(err as Error).message}`,
      );
    } finally {
      this.isProcessing = false;
    }
  }

  private async reconcileDisputeEvent(event: ContractEventEntity) {
    const paymentId = event.payload?.paymentId as number | string | undefined;
    if (!paymentId) return;

    // Find the dispute associated with this paymentId
    const dispute = await this.disputeRepo.findOne({
      where: { paymentId: String(paymentId) },
    });
    if (!dispute) return;

    const onChainStatus =
      event.eventType === 'disputed'
        ? DisputeStatus.OPEN
        : DisputeStatus.RESOLVED;

    if (
      dispute.status !== onChainStatus &&
      dispute.status !== DisputeStatus.RESOLUTION_PENDING
    ) {
      // Flag drift
      const mismatch = this.mismatchRepo.create({
        runId: 'dispute-event-listener', // Indicates real-time detection
        referenceId: dispute.id,
        referenceType: 'dispute',
        type: MismatchType.STATUS,
        severity: MismatchSeverity.HIGH,
        onChainValue: { status: onChainStatus },
        offChainValue: { status: dispute.status },
        exceptionCategory: ExceptionCategory.STATUS_DIVERGENCE,
        matchScore: 1,
        remediationHint:
          'Dispute status changed on-chain without backend synchronization',
        resolution: MismatchResolution.PENDING,
      });

      await this.mismatchRepo.save(mismatch);
      this.logger.warn(
        `Dispute drift detected for dispute ${dispute.id}: off-chain=${dispute.status}, on-chain=${onChainStatus}`,
      );
    } else if (
      dispute.status === DisputeStatus.RESOLUTION_PENDING &&
      onChainStatus === DisputeStatus.RESOLVED
    ) {
      // Reconcile pending resolution
      dispute.status = DisputeStatus.RESOLVED;
      await this.disputeRepo.save(dispute);
      this.logger.log(`Dispute ${dispute.id} resolution confirmed on-chain.`);
    }
  }
}
