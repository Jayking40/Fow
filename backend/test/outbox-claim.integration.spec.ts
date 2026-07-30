/**
 * Outbox SKIP LOCKED claim path — real Postgres.
 *
 * pg-mem does not implement FOR UPDATE SKIP LOCKED (it's exactly the kind of
 * primitive that diverges — see test/testcontainers/base.ts), so this suite
 * runs against a real Postgres container via Testcontainers. It exercises
 * OutboxService.claimPendingEvents directly (not the full Nest app) because
 * the property under test is a DB-concurrency guarantee: what matters is two
 * genuinely concurrent connections racing Postgres, which two OutboxService
 * instances sharing one DataSource's connection pool reproduce faithfully.
 */

import { randomUUID } from 'crypto';

import { DataSource, Repository } from 'typeorm';

import { OutboxDeadLetterEntity } from '../src/events/outbox-dead-letter.entity';
import {
  OutboxEventEntity,
  OutboxEventStatus,
  OutboxEventType,
} from '../src/events/outbox-event.entity';
import { OutboxService } from '../src/events/outbox.service';

import {
  createDataSource,
  startContainers,
  stopContainers,
} from './helpers/integration-test.helper';

jest.setTimeout(180_000);

let dataSource: DataSource;
let outboxRepo: Repository<OutboxEventEntity>;
let deadLetterRepo: Repository<OutboxDeadLetterEntity>;
let service: OutboxService;

beforeAll(async () => {
  await startContainers();
  dataSource = await createDataSource(true);
  outboxRepo = dataSource.getRepository(OutboxEventEntity);
  deadLetterRepo = dataSource.getRepository(OutboxDeadLetterEntity);
  service = new OutboxService(outboxRepo, deadLetterRepo);
});

afterAll(async () => {
  await stopContainers();
});

beforeEach(async () => {
  await dataSource.query(
    'TRUNCATE TABLE outbox_events, outbox_dead_letters RESTART IDENTITY CASCADE',
  );
});

interface SeedEvent {
  aggregateId: string | null;
  aggregateType: string | null;
  eventType: string;
  payload: Record<string, unknown>;
}

/**
 * Bulk-insert via a single INSERT ... SELECT FROM unnest(...) so all seeded
 * rows land in one statement — the bigserial `sequence` column is assigned
 * in the array's element order, which is what the ordering test relies on
 * to set up a known interleaving.
 */
async function seedEvents(events: SeedEvent[]): Promise<void> {
  if (!events.length) return;
  const aggregateIds = events.map((e) => e.aggregateId);
  const aggregateTypes = events.map((e) => e.aggregateType);
  const eventTypes = events.map((e) => e.eventType);
  const payloads = events.map((e) => JSON.stringify(e.payload));
  const dedupKeys = events.map(() => `seed:${randomUUID()}`);

  await dataSource.query(
    `
    INSERT INTO outbox_events (aggregate_id, aggregate_type, event_type, payload, dedup_key, status)
    SELECT a, t, e, p::jsonb, d, 'PENDING'::outbox_events_status_enum
    FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]) AS x(a, t, e, p, d)
    `,
    [aggregateIds, aggregateTypes, eventTypes, payloads, dedupKeys],
  );
}

/** Drains the outbox by repeatedly claiming + "delivering" (mark published). */
async function runConsumer(
  workerId: string,
  batchSize: number,
  claimedIds: Set<string>,
  onClaim?: (event: OutboxEventEntity) => Promise<void>,
  maxIdleIterations = 30,
): Promise<void> {
  let idleIterations = 0;
  while (idleIterations < maxIdleIterations) {
    const claimed = await service.claimPendingEvents(workerId, batchSize);
    if (claimed.length === 0) {
      idleIterations++;
      await new Promise((r) => setTimeout(r, 20));
      continue;
    }
    idleIterations = 0;
    await Promise.all(
      claimed.map(async (event) => {
        claimedIds.add(event.id);
        if (onClaim) {
          await onClaim(event);
        } else {
          await service.markPublished(event.id);
        }
      }),
    );
  }
}

describe('OutboxService.claimPendingEvents — SKIP LOCKED claim path (real Postgres)', () => {
  it('two concurrent consumers over 1000 seeded events: every event dispatched exactly once', async () => {
    const TOTAL = 1000;
    await seedEvents(
      Array.from({ length: TOTAL }, (_, i) => ({
        aggregateId: null,
        aggregateType: null,
        eventType: OutboxEventType.NOTIFICATION_SENT,
        payload: { i },
      })),
    );

    const claimedByA = new Set<string>();
    const claimedByB = new Set<string>();

    await Promise.all([
      runConsumer('worker-A', 25, claimedByA),
      runConsumer('worker-B', 25, claimedByB),
    ]);

    const overlap = [...claimedByA].filter((id) => claimedByB.has(id));
    expect(overlap).toEqual([]);

    const allClaimed = new Set([...claimedByA, ...claimedByB]);
    expect(allClaimed.size).toBe(TOTAL);

    const stillPending = await outboxRepo.count({
      where: { status: OutboxEventStatus.PENDING },
    });
    expect(stillPending).toBe(0);

    const published = await outboxRepo.count({
      where: { status: OutboxEventStatus.PUBLISHED },
    });
    expect(published).toBe(TOTAL);
  });

  it('ordering: 3 aggregates x 10 interleaved events, two consumers — per-aggregate dispatch never overlaps and follows insertion order', async () => {
    const aggregates = ['agg-A', 'agg-B', 'agg-C'];
    const perAggregate = 10;

    // Round-robin interleave: A0,B0,C0,A1,B1,C1,...,A9,B9,C9
    const seeded: SeedEvent[] = [];
    for (let i = 0; i < perAggregate; i++) {
      for (const aggregateId of aggregates) {
        seeded.push({
          aggregateId,
          aggregateType: 'TestAggregate',
          eventType: OutboxEventType.NOTIFICATION_SENT,
          payload: { index: i },
        });
      }
    }
    await seedEvents(seeded);

    const intervals: Array<{
      aggregateId: string;
      index: number;
      claimedAt: number;
      releasedAt: number;
    }> = [];

    const claimedIds = new Set<string>();
    const onClaim = async (event: OutboxEventEntity) => {
      const claimedAt = Date.now();
      // Hold the "in-flight" window open long enough that, without the
      // per-aggregate anti-join, the other consumer's next poll would be
      // able to grab the next event for the same aggregate before this one
      // is acknowledged.
      await new Promise((r) => setTimeout(r, 50));
      await service.markPublished(event.id);
      intervals.push({
        aggregateId: event.aggregateId as string,
        index: (event.payload as { index: number }).index,
        claimedAt,
        releasedAt: Date.now(),
      });
    };

    await Promise.all([
      runConsumer('worker-A', 5, claimedIds, onClaim),
      runConsumer('worker-B', 5, claimedIds, onClaim),
    ]);

    expect(claimedIds.size).toBe(aggregates.length * perAggregate);

    for (const aggregateId of aggregates) {
      const forAggregate = intervals
        .filter((iv) => iv.aggregateId === aggregateId)
        .sort((a, b) => a.index - b.index);

      expect(forAggregate.map((iv) => iv.index)).toEqual(
        Array.from({ length: perAggregate }, (_, i) => i),
      );

      for (let i = 0; i < forAggregate.length - 1; i++) {
        // Event i must be fully released (published) before event i+1 is
        // claimed — no two events of the same aggregate are ever in flight
        // at once.
        expect(forAggregate[i].releasedAt).toBeLessThanOrEqual(
          forAggregate[i + 1].claimedAt,
        );
      }
    }
  });

  it('killed-worker recovery: a claimed-but-unacknowledged event is re-claimed after lease expiry', async () => {
    await seedEvents([
      {
        aggregateId: 'agg-crash',
        aggregateType: 'TestAggregate',
        eventType: OutboxEventType.NOTIFICATION_SENT,
        payload: { i: 0 },
      },
    ]);

    const firstClaim = await service.claimPendingEvents('crashed-worker', 10);
    expect(firstClaim).toHaveLength(1);
    const eventId = firstClaim[0].id;

    // Crash: the worker never calls markPublished/recordFailure. Backdate
    // the lease instead of waiting out LEASE_TTL_MS in real time.
    await dataSource.query(
      `UPDATE outbox_events SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`,
      [eventId],
    );

    const secondClaim = await service.claimPendingEvents('recovery-worker', 10);
    expect(secondClaim).toHaveLength(1);
    expect(secondClaim[0].id).toBe(eventId);
    expect(secondClaim[0].leaseHolder).toBe('recovery-worker');
    expect(secondClaim[0].status).toBe(OutboxEventStatus.PROCESSING);

    // While the lease is still held (unexpired) by recovery-worker, no one
    // else can claim it.
    const thirdClaim = await service.claimPendingEvents('another-worker', 10);
    expect(thirdClaim).toHaveLength(0);
  });

  it('existing DLQ/replay behavior is unchanged against real Postgres', async () => {
    const created = await service.publishEvent(
      OutboxEventType.NOTIFICATION_SENT,
      { hello: 'world' },
      'agg-dlq',
      'TestAggregate',
    );

    for (let attempt = 0; attempt < 5; attempt++) {
      await service.recordFailure(created.id, `synthetic failure ${attempt}`);
    }

    const dead = await outboxRepo.findOne({ where: { id: created.id } });
    expect(dead?.status).toBe(OutboxEventStatus.DEAD_LETTERED);

    const deadLetters = await service.getDeadLetters();
    const dl = deadLetters.find((d) => d.outboxEventId === created.id);
    expect(dl).toBeDefined();

    const replayed = await service.replayDeadLetter(dl!.id, 'fixed downstream');
    expect(replayed.status).toBe(OutboxEventStatus.PENDING);

    const claimed = await service.claimPendingEvents('replay-worker', 10);
    expect(claimed.map((e) => e.id)).toContain(replayed.id);
  });
});
