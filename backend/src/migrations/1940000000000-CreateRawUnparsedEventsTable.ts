import { MigrationInterface, QueryRunner } from 'typeorm'; // eslint-disable-line import/named

export class CreateRawUnparsedEventsTable1940000000000 implements MigrationInterface {
  name = 'CreateRawUnparsedEventsTable1940000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "raw_unparsed_events" (
        "id"               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        "source"           VARCHAR(100) NOT NULL,
        "event_type"       VARCHAR(100),
        "schema_version"   INT,
        "reason"           VARCHAR(50)  NOT NULL,
        "detail"           TEXT         NOT NULL,
        "transaction_hash" VARCHAR(255),
        "raw_event"        JSONB        NOT NULL DEFAULT '{}',
        "resolved"         BOOLEAN      NOT NULL DEFAULT false,
        "created_at"       TIMESTAMPTZ  NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_raw_unparsed_events_reason"     ON "raw_unparsed_events" ("reason")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_raw_unparsed_events_resolved"   ON "raw_unparsed_events" ("resolved")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_raw_unparsed_events_event_type" ON "raw_unparsed_events" ("event_type")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "raw_unparsed_events"`);
  }
}
