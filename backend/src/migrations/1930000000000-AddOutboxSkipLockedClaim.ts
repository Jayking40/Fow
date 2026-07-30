import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Brings the `outbox_events` table up to what OutboxEventEntity has declared
 * for some time (status/dedup/lease/attempt columns existed only via dev
 * `synchronize: true`, never via migration — so any environment that runs
 * migrations only, e.g. this integration test suite, was missing them
 * entirely) and adds what the new SKIP LOCKED claim query needs:
 *
 *  - a monotonic `sequence` column. The PK is a random uuid, so it cannot be
 *    used to recover insertion order; `created_at` (timestamptz) can collide
 *    across rows inserted in the same statement/millisecond, which the
 *    per-aggregate ordering guarantee cannot tolerate. `sequence` is a
 *    bigserial, so it strictly totally-orders every row by insertion order.
 *  - `idx_outbox_claim_candidates`: partial index on PENDING rows ordered by
 *    `sequence`, backing the outer claim scan.
 *  - `idx_outbox_aggregate_unresolved`: partial index on (aggregate_id,
 *    sequence) for rows still PENDING/PROCESSING, backing the per-aggregate
 *    "is there an earlier unresolved event for this aggregate" anti-join as
 *    an index range scan instead of a sequential scan.
 */
export class AddOutboxSkipLockedClaim1930000000000 implements MigrationInterface {
  name = 'AddOutboxSkipLockedClaim1930000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "outbox_events_status_enum" AS ENUM (
          'PENDING', 'PROCESSING', 'PUBLISHED', 'DEAD_LETTERED'
        );
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "outbox_events"
        ADD COLUMN IF NOT EXISTS "status" "outbox_events_status_enum" NOT NULL DEFAULT 'PENDING',
        ADD COLUMN IF NOT EXISTS "event_version" int NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS "correlation_id" varchar(128),
        ADD COLUMN IF NOT EXISTS "dedup_key" varchar(128),
        ADD COLUMN IF NOT EXISTS "lease_holder" varchar(128),
        ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamptz,
        ADD COLUMN IF NOT EXISTS "attempt_count" int NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamptz,
        ADD COLUMN IF NOT EXISTS "last_error" text,
        ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now(),
        ADD COLUMN IF NOT EXISTS "sequence" bigserial
    `);

    // Backfill status/attempt_count/last_error for any pre-existing legacy
    // rows so the new lease-based claim path sees a consistent state.
    await queryRunner.query(`
      UPDATE "outbox_events"
      SET
        "status" = CASE WHEN "published" THEN 'PUBLISHED' ELSE 'PENDING' END,
        "attempt_count" = "retry_count",
        "last_error" = "error"
      WHERE "dedup_key" IS NULL
    `);

    // dedup_key has no historical value for legacy rows — synthesize one from
    // the primary key so the unique index below can be created.
    await queryRunner.query(`
      UPDATE "outbox_events"
      SET "dedup_key" = 'legacy:' || "id"::text
      WHERE "dedup_key" IS NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "outbox_events"
        ALTER COLUMN "dedup_key" SET NOT NULL
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_outbox_dedup_key" ON "outbox_events" ("dedup_key")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_outbox_status_created" ON "outbox_events" ("status", "created_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_outbox_aggregate" ON "outbox_events" ("aggregate_id", "aggregate_type")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_outbox_correlation" ON "outbox_events" ("correlation_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_outbox_lease_expires" ON "outbox_events" ("lease_expires_at")
    `);

    // Claim-path indexes (see class doc comment above).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_outbox_claim_candidates"
        ON "outbox_events" ("sequence")
        WHERE "status" = 'PENDING'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_outbox_aggregate_unresolved"
        ON "outbox_events" ("aggregate_id", "sequence")
        WHERE "status" IN ('PENDING', 'PROCESSING')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_outbox_aggregate_unresolved"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_outbox_claim_candidates"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_outbox_lease_expires"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_outbox_correlation"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_outbox_aggregate"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_outbox_status_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_outbox_dedup_key"`);

    await queryRunner.query(`
      ALTER TABLE "outbox_events"
        DROP COLUMN IF EXISTS "sequence",
        DROP COLUMN IF EXISTS "updated_at",
        DROP COLUMN IF EXISTS "last_error",
        DROP COLUMN IF EXISTS "next_attempt_at",
        DROP COLUMN IF EXISTS "attempt_count",
        DROP COLUMN IF EXISTS "lease_expires_at",
        DROP COLUMN IF EXISTS "lease_holder",
        DROP COLUMN IF EXISTS "dedup_key",
        DROP COLUMN IF EXISTS "correlation_id",
        DROP COLUMN IF EXISTS "event_version",
        DROP COLUMN IF EXISTS "status"
    `);

    await queryRunner.query(`DROP TYPE IF EXISTS "outbox_events_status_enum"`);
  }
}
