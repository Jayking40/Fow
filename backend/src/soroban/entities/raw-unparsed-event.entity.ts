import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';

import { ContractEventDecodeFailureReason } from '../event-schema-version';

/**
 * Quarantine table for contract events the indexer could not decode
 * (unknown topic, unsupported schema version, or failed payload validation).
 * Events land here instead of being dropped so they can be inspected and
 * replayed once the schema registry is extended.
 */
@Entity('raw_unparsed_events')
@Index(['reason'])
@Index(['resolved'])
@Index(['eventType'])
export class RawUnparsedEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Component that failed to decode the event, e.g. 'soroban-indexer'. */
  @Column({ name: 'source', type: 'varchar', length: 100 })
  source: string;

  /** Resolved event type, or null when the envelope itself was malformed. */
  @Column({ name: 'event_type', type: 'varchar', length: 100, nullable: true })
  eventType: string | null;

  /** Parsed schema version, when one could be resolved. */
  @Column({ name: 'schema_version', type: 'int', nullable: true })
  schemaVersion: number | null;

  @Column({ name: 'reason', type: 'varchar', length: 50 })
  reason: ContractEventDecodeFailureReason;

  /** Human-readable explanation of why decoding failed. */
  @Column({ name: 'detail', type: 'text' })
  detail: string;

  /** Originating transaction hash, when available. */
  @Column({
    name: 'transaction_hash',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  transactionHash: string | null;

  /** Full raw event as received, for later replay. */
  @Column({ name: 'raw_event', type: 'jsonb' })
  rawEvent: Record<string, unknown>;

  /** Set once an operator has replayed or discarded the quarantined event. */
  @Column({ name: 'resolved', type: 'boolean', default: false })
  resolved: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
