import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { BlockchainEvent } from '../soroban/entities/blockchain-event.entity';
import { SorobanService } from '../soroban/soroban.service';

import { ConfirmHandoffDto, RecordHandoffDto } from './dto/custody.dto';
import { CustodyHandoffEntity } from './entities/custody-handoff.entity';
import {
  CustodyActor,
  CustodyChainStatus,
  CustodyHandoffStatus,
} from './enums/custody.enum';

/** On-chain event topic emitted by the inventory contract on custody transfer. */
const CUSTODY_TRANSFER_EVENT_TYPE = 'custody_transferred';

@Injectable()
export class CustodyService {
  private readonly logger = new Logger(CustodyService.name);

  constructor(
    @InjectRepository(CustodyHandoffEntity)
    private readonly handoffRepo: Repository<CustodyHandoffEntity>,
    @InjectRepository(BlockchainEvent)
    private readonly blockchainEventRepo: Repository<BlockchainEvent>,
    private readonly sorobanService: SorobanService,
  ) {}

  async recordHandoff(dto: RecordHandoffDto): Promise<CustodyHandoffEntity> {
    // Initiate on-chain custody transfer. A failure here is recorded as an
    // explicit degraded state (chainStatus = FAILED) rather than being masked
    // as an ordinary pending handoff.
    let contractEventId: string | null = null;
    let chainStatus: CustodyChainStatus = CustodyChainStatus.NOT_SUBMITTED;
    let chainError: string | null = null;

    try {
      const result = await this.sorobanService.transferCustody({
        unitId: parseInt(dto.bloodUnitId, 10),
        fromAccount: dto.fromActorId,
        toAccount: dto.toActorId,
        condition: `${dto.fromActorType}→${dto.toActorType}`,
      });
      contractEventId = result.transactionHash;
      chainStatus = CustodyChainStatus.SUBMITTED;
    } catch (error) {
      chainStatus = CustodyChainStatus.FAILED;
      chainError = (error as Error).message ?? 'unknown on-chain error';
      this.logger.warn(
        `On-chain custody transfer failed for unit ${dto.bloodUnitId} ` +
          `(${dto.fromActorId} → ${dto.toActorId}): ${chainError}`,
      );
    }

    const handoff = this.handoffRepo.create({
      bloodUnitId: dto.bloodUnitId,
      orderId: dto.orderId ?? null,
      fromActorId: dto.fromActorId,
      fromActorType: dto.fromActorType,
      toActorId: dto.toActorId,
      toActorType: dto.toActorType,
      latitude: dto.latitude ?? null,
      longitude: dto.longitude ?? null,
      proofReference: dto.proofReference ?? null,
      contractEventId,
      chainStatus,
      chainError,
      status: CustodyHandoffStatus.PENDING,
    });

    const saved = await this.handoffRepo.save(handoff);

    // Opportunistically promote to VERIFIED if the indexer has already
    // recorded the matching on-chain event.
    if (saved.chainStatus === CustodyChainStatus.SUBMITTED) {
      await this.reconcileChainStatus(saved);
    }

    return saved;
  }

  async confirmHandoff(
    id: string,
    dto: ConfirmHandoffDto,
    callerActorId: string | undefined,
  ): Promise<CustodyHandoffEntity> {
    const handoff = await this.handoffRepo.findOne({ where: { id } });
    if (!handoff) throw new NotFoundException('Custody handoff not found');

    // Caller/actor verification — only the intended receiving actor may
    // confirm receipt of custody.
    if (!callerActorId || callerActorId !== handoff.toActorId) {
      throw new ForbiddenException(
        'Only the receiving actor may confirm this custody handoff',
      );
    }

    if (handoff.status !== CustodyHandoffStatus.PENDING) {
      throw new BadRequestException('Handoff is not in pending state');
    }

    if (handoff.chainStatus === CustodyChainStatus.FAILED) {
      throw new BadRequestException(
        'Cannot confirm: the on-chain custody transfer failed for this handoff',
      );
    }

    if (
      handoff.chainStatus === CustodyChainStatus.NOT_SUBMITTED ||
      !handoff.contractEventId
    ) {
      throw new BadRequestException(
        'Cannot confirm: no on-chain custody transfer was submitted for this handoff',
      );
    }

    // On-chain backing is verified against the indexer's event table, never
    // the client-supplied proof reference.
    const chainStatus = await this.reconcileChainStatus(handoff);
    if (chainStatus !== CustodyChainStatus.VERIFIED) {
      throw new BadRequestException(
        'Cannot confirm: the on-chain custody transfer has not been verified by the indexer yet',
      );
    }

    handoff.status = CustodyHandoffStatus.CONFIRMED;
    handoff.confirmedAt = new Date();
    if (dto.proofReference) handoff.proofReference = dto.proofReference;

    return this.handoffRepo.save(handoff);
  }

  async getTimeline(bloodUnitId: string): Promise<CustodyHandoffEntity[]> {
    return this.handoffRepo.find({
      where: { bloodUnitId },
      order: { createdAt: 'ASC' },
    });
  }

  async getOrderTimeline(orderId: string): Promise<CustodyHandoffEntity[]> {
    return this.handoffRepo.find({
      where: { orderId },
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * Handoffs whose on-chain transfer failed or has been stuck awaiting indexer
   * confirmation — surfaced so degraded custody is visible, not masked.
   */
  async getDegradedHandoffs(): Promise<CustodyHandoffEntity[]> {
    return this.handoffRepo.find({
      where: [
        { chainStatus: CustodyChainStatus.FAILED },
        { chainStatus: CustodyChainStatus.SUBMITTED },
      ],
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * Checks that all required custody steps are confirmed AND on-chain verified
   * before delivery completion.
   * Required chain: blood_bank → rider → hospital (all CONFIRMED + VERIFIED).
   */
  async assertCustodyComplete(orderId: string): Promise<void> {
    const handoffs = await this.handoffRepo.find({ where: { orderId } });
    const verified = handoffs.filter(
      (h) =>
        h.status === CustodyHandoffStatus.CONFIRMED &&
        h.chainStatus === CustodyChainStatus.VERIFIED,
    );

    const hasBankToRider = verified.some(
      (h) =>
        h.fromActorType === CustodyActor.BLOOD_BANK &&
        h.toActorType === CustodyActor.RIDER,
    );
    const hasRiderToHospital = verified.some(
      (h) =>
        h.fromActorType === CustodyActor.RIDER &&
        h.toActorType === CustodyActor.HOSPITAL,
    );

    if (!hasBankToRider || !hasRiderToHospital) {
      throw new BadRequestException(
        'Delivery cannot be completed: missing on-chain-verified custody handoffs (blood_bank→rider and rider→hospital required)',
      );
    }
  }

  /**
   * Periodic reconciliation: compares handoffs still awaiting on-chain
   * confirmation against the indexer's recorded chain state.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async reconcileSubmittedHandoffs(): Promise<void> {
    const submitted = await this.handoffRepo.find({
      where: { chainStatus: CustodyChainStatus.SUBMITTED },
      take: 200,
    });
    if (submitted.length === 0) return;

    let verified = 0;
    for (const handoff of submitted) {
      const status = await this.reconcileChainStatus(handoff);
      if (status === CustodyChainStatus.VERIFIED) verified += 1;
    }

    this.logger.log(
      `Custody chain reconciliation: ${verified}/${submitted.length} submitted handoffs verified on-chain`,
    );
  }

  /**
   * Promote a handoff to VERIFIED when the indexer has recorded the matching
   * `custody_transferred` event for its transaction hash. Returns the resulting
   * chain status. Never trusts client-supplied data.
   */
  private async reconcileChainStatus(
    handoff: CustodyHandoffEntity,
  ): Promise<CustodyChainStatus> {
    if (handoff.chainStatus === CustodyChainStatus.VERIFIED) {
      return handoff.chainStatus;
    }
    if (!handoff.contractEventId) {
      return handoff.chainStatus;
    }

    const event = await this.blockchainEventRepo.findOne({
      where: {
        transactionHash: handoff.contractEventId,
        eventType: CUSTODY_TRANSFER_EVENT_TYPE,
      },
    });
    if (!event) {
      return handoff.chainStatus;
    }

    handoff.chainStatus = CustodyChainStatus.VERIFIED;
    handoff.chainVerifiedAt = new Date();
    handoff.chainError = null;
    await this.handoffRepo.save(handoff);
    this.logger.debug(
      `Custody handoff ${handoff.id} verified on-chain via tx ${handoff.contractEventId}`,
    );

    return handoff.chainStatus;
  }
}
