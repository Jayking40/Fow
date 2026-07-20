import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLateSyncAndDispatchSyncLog1920000000000 implements MigrationInterface {
  name = 'AddLateSyncAndDispatchSyncLog1920000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "delivery_proofs"
        ADD COLUMN IF NOT EXISTS "late_sync" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "synced_at" timestamptz NULL
    `);

    await queryRunner.query(`
      CREATE TYPE "dispatch_sync_logs_action_type_enum" AS ENUM (
        'accept_assignment',
        'confirm_pickup',
        'confirm_dropoff',
        'capture_signature',
        'attach_photo_reference'
      )
    `);

    await queryRunner.query(`
      CREATE TYPE "dispatch_sync_logs_status_enum" AS ENUM (
        'processed',
        'duplicate',
        'conflict'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "dispatch_sync_logs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "idempotency_key" varchar(36) NOT NULL,
        "action_type" "dispatch_sync_logs_action_type_enum" NOT NULL,
        "assignment_id" varchar NOT NULL,
        "rider_id" varchar NOT NULL,
        "captured_at" timestamptz NOT NULL,
        "synced_at" timestamptz NOT NULL,
        "late_sync" boolean NOT NULL DEFAULT false,
        "status" "dispatch_sync_logs_status_enum" NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dispatch_sync_logs" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_dispatch_sync_logs_idempotency_key" UNIQUE ("idempotency_key")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "dispatch_sync_logs"`);
    await queryRunner.query(`DROP TYPE "dispatch_sync_logs_status_enum"`);
    await queryRunner.query(`DROP TYPE "dispatch_sync_logs_action_type_enum"`);
    await queryRunner.query(`
      ALTER TABLE "delivery_proofs"
        DROP COLUMN IF EXISTS "late_sync",
        DROP COLUMN IF EXISTS "synced_at"
    `);
  }
}
