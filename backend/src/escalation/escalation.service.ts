import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository, IsNull } from 'typeorm';

import { EscalationAcknowledgedEvent } from '../events/escalation-acknowledged.event';
import { EscalationTriggeredEvent } from '../events/escalation-triggered.event';

import { EscalationEntity } from './entities/escalation.entity';
import { EscalationTier } from './enums/escalation-tier.enum';
import {
  EscalationPolicyService,
  EscalationInput,
} from './escalation-policy.service';

@Injectable()
export class EscalationService {
  private readonly logger = new Logger(EscalationService.name);

  constructor(
    @InjectRepository(EscalationEntity)
    private readonly repo: Repository<EscalationEntity>,
    private readonly policy: EscalationPolicyService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async evaluate(
    requestId: string,
    orderId: string | null,
    hospitalId: string,
    riderId: string | null,
    input: EscalationInput,
  ): Promise<EscalationEntity | null> {
    const tier = this.policy.evaluate(input);

    if (tier === EscalationTier.NONE) return null;

    const lastEscalation = await this.repo.findOne({
      where: { requestId },
      order: { createdAt: 'DESC' },
    });

    // Dedup: skip if same tier already emitted for this request and is unacknowledged
    if (
      lastEscalation &&
      lastEscalation.tier === tier &&
      lastEscalation.acknowledgedAt === null
    ) {
      this.logger.debug(
        `Skipping duplicate escalation tier=${tier} for request=${requestId}`,
      );
      return null;
    }

    const slaDeadlineMs = this.policy.slaDeadlineMs(tier);

    const escalation = this.repo.create({
      requestId,
      orderId,
      hospitalId,
      tier,
      slaDeadlineMs,
      riderId,
      acknowledgedAt: null,
      acknowledgedBy: null,
    });

    await this.repo.save(escalation);

    this.eventEmitter.emit(
      'escalation.triggered',
      new EscalationTriggeredEvent(
        requestId,
        orderId,
        tier,
        hospitalId,
        slaDeadlineMs,
        riderId,
      ),
    );

    this.logger.log(`Escalation tier=${tier} created for request=${requestId}`);
    return escalation;
  }

  async acknowledge(
    escalationId: string,
    userId: string,
  ): Promise<EscalationEntity> {
    const escalation = await this.repo.findOne({ where: { id: escalationId } });
    if (!escalation) throw new NotFoundException('Escalation not found');

    if (escalation.acknowledgedAt) return escalation; // already acked

    escalation.acknowledgedAt = new Date();
    escalation.acknowledgedBy = userId;
    await this.repo.save(escalation);

    // Clear dedup so future tier changes can re-escalate (now handled by acknowledgedAt field in DB)

    this.eventEmitter.emit(
      'escalation.acknowledged',
      new EscalationAcknowledgedEvent(escalationId, userId),
    );

    return escalation;
  }

  async findOpen(): Promise<EscalationEntity[]> {
    return this.repo.find({
      where: { acknowledgedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });
  }

  async findByRequest(requestId: string): Promise<EscalationEntity[]> {
    return this.repo.find({
      where: { requestId },
      order: { createdAt: 'DESC' },
    });
  }
}
