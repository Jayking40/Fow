import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds explicit on-chain verification state to `custody_handoffs`.
 *
 * Previously an on-chain `transferCustody` failure was swallowed and the row
 * persisted with `contract_event_id = NULL`, indistinguishable from a healthy
 * pending handoff. `chain_status` now records the real state and `chain_error`
 * captures the failure reason, so degraded handoffs are visible and custody
 * completion can be restricted to indexer-verified transfers.
 */
export class AddCustodyChainVerification1950000000000 implements MigrationInterface {
  name = 'AddCustodyChainVerification1950000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "custody_chain_status" AS ENUM (
          'not_submitted', 'submitted', 'verified', 'failed'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "custody_handoffs"
        ADD COLUMN IF NOT EXISTS "chain_status" "custody_chain_status"
          NOT NULL DEFAULT 'not_submitted',
        ADD COLUMN IF NOT EXISTS "chain_error" VARCHAR,
        ADD COLUMN IF NOT EXISTS "chain_verified_at" TIMESTAMPTZ
    `);

    // Backfill: rows that already carry a contract event id were on-chain
    // successes under the old code path.
    await queryRunner.query(`
      UPDATE "custody_handoffs"
      SET "chain_status" = 'submitted'
      WHERE "contract_event_id" IS NOT NULL AND "chain_status" = 'not_submitted'
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_CUSTODY_CHAIN_STATUS"
        ON "custody_handoffs" ("chain_status")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_CUSTODY_CHAIN_STATUS"`);
    await queryRunner.query(`
      ALTER TABLE "custody_handoffs"
        DROP COLUMN IF EXISTS "chain_verified_at",
        DROP COLUMN IF EXISTS "chain_error",
        DROP COLUMN IF EXISTS "chain_status"
    `);
    await queryRunner.query(`DROP TYPE IF EXISTS "custody_chain_status"`);
  }
}
