import { createHash, randomUUID } from 'crypto';

import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { EntityManager, LessThan, Repository } from 'typeorm';

import {
  DeadLetterStatus,
  OutboxDeadLetterEntity,
} from './outbox-dead-letter.entity';
import {
  OutboxEventEntity,
  OutboxEventStatus,
  OutboxEventType,
} from './outbox-event.entity';

export interface PublishEventOptions {
  aggregateId?: string;
  aggregateType?: string;
  correlationId?: string;
  eventVersion?: number;
  /** Custom dedup key — defaults to SHA-256(aggregateId+eventType+correlationId) */
  dedupKey?: string;
}

const MAX_ATTEMPTS = 5;
const LEASE_TTL_MS = 30_000; // 30 s
const BASE_BACKOFF_MS = 2_000;

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    @InjectRepository(OutboxEventEntity)
    private readonly outboxRepo: Repository<OutboxEventEntity>,
    @InjectRepository(OutboxDeadLetterEntity)
    private readonly deadLetterRepo: Repository<OutboxDeadLetterEntity>,
  ) {}

  // ── Transactional write path ─────────────────────────────────────────

  /**
   * Insert an outbox entry in the same DB transaction as the caller's entity write.
   * Pass the EntityManager from the caller's transaction to guarantee atomicity.
   *
   * @example
   * await this.dataSource.transaction(async (em) => {
   *   await em.save(BloodRequestEntity, request);
   *   await outboxService.publishInTransaction(em, 'BLOOD_REQUEST_CREATED', payload, { aggregateId: request.id });
   * });
   */
  async publishInTransaction(
    em: EntityManager,
    eventType: OutboxEventType | string,
    payload: Record<string, unknown>,
    options: PublishEventOptions = {},
  ): Promise<OutboxEventEntity> {
    const dedupKey =
      options.dedupKey ??
      this.buildDedupKey(
        options.aggregateId ?? '',
        eventType,
        options.correlationId ?? '',
      );

    const event = em.create(OutboxEventEntity, {
      aggregateId: options.aggregateId ?? null,
      aggregateType: options.aggregateType ?? null,
      eventType,
      eventVersion: options.eventVersion ?? 1,
      correlationId: options.correlationId ?? null,
      payload,
      status: OutboxEventStatus.PENDING,
      dedupKey,
      leaseHolder: null,
      leaseExpiresAt: null,
      attemptCount: 0,
      nextAttemptAt: null,
      lastError: null,
      published: false,
      retryCount: 0,
      error: null,
      publishedAt: null,
    });

    return em.save(OutboxEventEntity, event);
  }

  /**
   * Standalone publish (outside a transaction) — use only when atomicity with
   * an entity write is not required (e.g. system-generated events).
   */
  async publishEvent(
    eventType: OutboxEventType | string,
    payload: Record<string, unknown>,
    aggregateId?: string,
    aggregateType?: string,
    correlationId?: string,
  ): Promise<OutboxEventEntity> {
    const dedupKey = this.buildDedupKey(
      aggregateId ?? '',
      eventType,
      correlationId ?? '',
    );
    const event = this.outboxRepo.create({
      aggregateId: aggregateId ?? null,
      aggregateType: aggregateType ?? null,
      eventType,
      eventVersion: 1,
      correlationId: correlationId ?? null,
      payload,
      status: OutboxEventStatus.PENDING,
      dedupKey,
      leaseHolder: null,
      leaseExpiresAt: null,
      attemptCount: 0,
      nextAttemptAt: null,
      lastError: null,
      published: false,
      retryCount: 0,
      error: null,
      publishedAt: null,
    });
    return this.outboxRepo.save(event);
  }

  // ── Lease-based polling ──────────────────────────────────────────────

  /**
   * Claim up to `limit` events by acquiring a lease, respecting:
   *  - PENDING events, or PROCESSING events whose lease has expired
   *    (crashed-worker recovery)
   *  - backoff (nextAttemptAt in the future is skipped)
   *  - attemptCount < MAX_ATTEMPTS
   *  - per-aggregate ordering: an event is only claimable if no earlier
   *    (lower `sequence`) event for the same aggregate is still
   *    PENDING/PROCESSING — this is what stops event N+1 from being
   *    dispatched while event N sits unacknowledged.
   *
   * Implemented as raw SQL rather than the query builder: the claim needs a
   * single atomic `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP
   * LOCKED) RETURNING *`, where the inner SELECT carries a correlated
   * NOT EXISTS anti-join for the per-aggregate check. TypeORM's
   * query-builder cannot express a correlated subquery combined with
   * FOR UPDATE SKIP LOCKED and RETURNING as one statement, and splitting it
   * into an UPDATE followed by a separate SELECT (the previous
   * implementation) reopens the exact race this rewrite closes: two
   * instances' UPDATEs can both match the same row-set before either one's
   * effects are visible to the other's WHERE clause.
   *
   * Query plan: the outer scan uses the partial index
   * `idx_outbox_claim_candidates (sequence) WHERE status = 'PENDING'`
   * (Bitmap/Index Scan, already sorted by sequence — no separate sort
   * node), with the expired-lease PROCESSING branch caught by
   * `idx_outbox_lease_expires`. For every candidate row the anti-join
   * probes `idx_outbox_aggregate_unresolved (aggregate_id, sequence) WHERE
   * status IN ('PENDING','PROCESSING')` — an index-only existence probe
   * bounded by `sequence < oe.sequence`, i.e. O(log n) per candidate rather
   * than a self-join over the whole table. FOR UPDATE SKIP LOCKED applies
   * only to `oe` (the outer table) — the NOT EXISTS subquery is read-only
   * and never blocks or gets skipped itself.
   */
  async claimPendingEvents(
    workerId: string,
    limit = 50,
  ): Promise<OutboxEventEntity[]> {
    const now = new Date();
    const leaseExpiry = new Date(now.getTime() + LEASE_TTL_MS);

    const rows = await this.outboxRepo.manager.query<Record<string, unknown>[]>(
      `
      UPDATE outbox_events
      SET status = $1::outbox_events_status_enum,
          lease_holder = $2::varchar,
          lease_expires_at = $3::timestamptz,
          updated_at = now()
      WHERE id IN (
        SELECT oe.id
        FROM outbox_events oe
        WHERE (
            oe.status = $4::outbox_events_status_enum
            OR (
              oe.status = $1::outbox_events_status_enum
              AND oe.lease_expires_at < $5::timestamptz
            )
          )
          AND (oe.next_attempt_at IS NULL OR oe.next_attempt_at <= $5::timestamptz)
          AND oe.attempt_count < $6::int
          AND NOT EXISTS (
            SELECT 1
            FROM outbox_events blocker
            WHERE blocker.aggregate_id = oe.aggregate_id
              AND blocker.status IN ($4::outbox_events_status_enum, $1::outbox_events_status_enum)
              AND blocker.sequence < oe.sequence
          )
        ORDER BY oe.sequence ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $7::int
      )
      RETURNING *
      `,
      [
        OutboxEventStatus.PROCESSING,
        workerId,
        leaseExpiry,
        OutboxEventStatus.PENDING,
        now,
        MAX_ATTEMPTS,
        limit,
      ],
    );

    return rows
      .map((row) => this.mapRawEventRow(row))
      .sort((a, b) => Number(a.sequence) - Number(b.sequence));
  }

  /**
   * Renew the lease for an event being processed (heartbeat).
   */
  async renewLease(eventId: string, workerId: string): Promise<void> {
    const leaseExpiry = new Date(Date.now() + LEASE_TTL_MS);
    await this.outboxRepo.update(
      { id: eventId, leaseHolder: workerId },
      { leaseExpiresAt: leaseExpiry },
    );
  }

  /**
   * Mark an event as successfully published.
   */
  async markPublished(eventId: string): Promise<void> {
    await this.outboxRepo.update(eventId, {
      status: OutboxEventStatus.PUBLISHED,
      published: true,
      publishedAt: new Date(),
      leaseHolder: null,
      leaseExpiresAt: null,
    });
  }

  /**
   * Record a delivery failure with exponential backoff.
   * If max attempts exceeded, move to dead-letter.
   */
  async recordFailure(eventId: string, error: string): Promise<void> {
    const event = await this.outboxRepo.findOne({ where: { id: eventId } });
    if (!event) return;

    const attemptCount = event.attemptCount + 1;

    if (attemptCount >= MAX_ATTEMPTS) {
      await this.moveToDeadLetter(event, error);
      return;
    }

    const backoffMs = BASE_BACKOFF_MS * Math.pow(2, attemptCount);
    const nextAttemptAt = new Date(Date.now() + backoffMs);

    await this.outboxRepo.update(eventId, {
      status: OutboxEventStatus.PENDING,
      attemptCount,
      lastError: error,
      error,
      retryCount: attemptCount,
      leaseHolder: null,
      leaseExpiresAt: null,
      nextAttemptAt,
    });

    this.logger.warn(
      `Outbox event ${eventId} failed (attempt ${attemptCount}/${MAX_ATTEMPTS}), retry at ${nextAttemptAt.toISOString()}`,
    );
  }

  // ── Dead-letter handling ─────────────────────────────────────────────

  private async moveToDeadLetter(
    event: OutboxEventEntity,
    lastError: string,
  ): Promise<void> {
    await this.deadLetterRepo.save(
      this.deadLetterRepo.create({
        outboxEventId: event.id,
        aggregateId: event.aggregateId,
        aggregateType: event.aggregateType,
        eventType: event.eventType,
        eventVersion: event.eventVersion,
        correlationId: event.correlationId,
        payload: event.payload,
        attemptCount: event.attemptCount + 1,
        lastError,
        status: DeadLetterStatus.PENDING,
        operatorNotes: null,
      }),
    );

    await this.outboxRepo.update(event.id, {
      status: OutboxEventStatus.DEAD_LETTERED,
      lastError,
      leaseHolder: null,
      leaseExpiresAt: null,
    });

    this.logger.error(
      `Outbox event ${event.id} (${event.eventType}) dead-lettered after ${event.attemptCount + 1} attempts`,
    );
  }

  async getDeadLetters(
    status?: DeadLetterStatus,
  ): Promise<OutboxDeadLetterEntity[]> {
    const where = status ? { status } : {};
    return this.deadLetterRepo.find({
      where,
      order: { deadLetteredAt: 'DESC' },
    });
  }

  /**
   * Operator: replay a dead-lettered event by re-inserting it as PENDING.
   */
  async replayDeadLetter(
    deadLetterId: string,
    operatorNotes?: string,
  ): Promise<OutboxEventEntity> {
    const dl = await this.deadLetterRepo.findOne({
      where: { id: deadLetterId },
    });
    if (!dl)
      throw new NotFoundException(`Dead-letter '${deadLetterId}' not found`);

    // A dead-letter is a single logical replay intent. Re-running this for an
    // already-replayed entry would double-enqueue the same event, so reject it
    // rather than minting a fresh event each call.
    if (dl.status === DeadLetterStatus.REPLAYED) {
      throw new ConflictException(
        `Dead-letter '${deadLetterId}' has already been replayed`,
      );
    }

    // Deterministic dedup key per dead-letter: a retried operator action or an
    // at-least-once delivery of the replay request collapses to one PENDING
    // event via the unique dedup-key index. Never embed `Date.now()`/random
    // values here — that defeats the outbox dedup guarantee.
    const newDedupKey = `replay:${deadLetterId}`;
    const replayed = await this.outboxRepo.save(
      this.outboxRepo.create({
        aggregateId: dl.aggregateId,
        aggregateType: dl.aggregateType,
        eventType: dl.eventType,
        eventVersion: dl.eventVersion,
        correlationId: dl.correlationId,
        payload: dl.payload,
        status: OutboxEventStatus.PENDING,
        dedupKey: newDedupKey,
        leaseHolder: null,
        leaseExpiresAt: null,
        attemptCount: 0,
        nextAttemptAt: null,
        lastError: null,
        published: false,
        retryCount: 0,
        error: null,
        publishedAt: null,
      }),
    );

    await this.deadLetterRepo.update(deadLetterId, {
      status: DeadLetterStatus.REPLAYED,
      operatorNotes: operatorNotes ?? null,
    });

    this.logger.log(
      `Dead-letter ${deadLetterId} replayed as outbox event ${replayed.id}`,
    );
    return replayed;
  }

  /**
   * Operator: discard a dead-lettered event (no further processing).
   */
  async discardDeadLetter(
    deadLetterId: string,
    operatorNotes?: string,
  ): Promise<OutboxDeadLetterEntity> {
    const dl = await this.deadLetterRepo.findOne({
      where: { id: deadLetterId },
    });
    if (!dl)
      throw new NotFoundException(`Dead-letter '${deadLetterId}' not found`);

    dl.status = DeadLetterStatus.DISCARDED;
    if (operatorNotes) dl.operatorNotes = operatorNotes;
    const saved = await this.deadLetterRepo.save(dl);
    this.logger.log(`Dead-letter ${deadLetterId} discarded by operator`);
    return saved;
  }

  // ── Legacy helpers (backward compat) ─────────────────────────────────

  async getUnpublishedEvents(limit = 100): Promise<OutboxEventEntity[]> {
    return this.outboxRepo.find({
      where: { published: false },
      order: { createdAt: 'ASC' },
      take: limit,
    });
  }

  async markAsPublished(eventId: string): Promise<void> {
    return this.markPublished(eventId);
  }

  async incrementRetryCount(eventId: string, error?: string): Promise<void> {
    await this.outboxRepo.increment({ id: eventId }, 'retryCount', 1);
    if (error) await this.outboxRepo.update(eventId, { error });
  }

  async deletePublishedEvents(olderThanDays = 7): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);
    const result = await this.outboxRepo.delete({
      published: true,
      publishedAt: LessThan(cutoff),
    });
    return result.affected ?? 0;
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  /**
   * `manager.query` returns raw driver rows (snake_case columns), not
   * entity instances — map the claim query's RETURNING * back to
   * OutboxEventEntity's camelCase shape so callers (OutboxProducer.deliver)
   * see the same fields they'd get from the repository API.
   */
  private mapRawEventRow(row: Record<string, unknown>): OutboxEventEntity {
    return {
      id: row.id,
      aggregateId: row.aggregate_id,
      aggregateType: row.aggregate_type,
      eventType: row.event_type,
      eventVersion: row.event_version,
      correlationId: row.correlation_id,
      payload: row.payload,
      status: row.status,
      dedupKey: row.dedup_key,
      leaseHolder: row.lease_holder,
      leaseExpiresAt: row.lease_expires_at,
      attemptCount: row.attempt_count,
      nextAttemptAt: row.next_attempt_at,
      lastError: row.last_error,
      publishedAt: row.published_at,
      published: row.published,
      retryCount: row.retry_count,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      sequence: row.sequence,
    } as unknown as OutboxEventEntity;
  }

  private buildDedupKey(
    aggregateId: string,
    eventType: string,
    correlationId: string,
  ): string {
    const raw = `${aggregateId}:${eventType}:${correlationId}:${randomUUID()}`;
    return createHash('sha256').update(raw).digest('hex').slice(0, 64);
  }
}
