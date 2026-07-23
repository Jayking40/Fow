import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity';

/**
 * Mirrors a CustodyChainLink on the HealthChain Soroban contract.
 *
 * Each row represents one custodian handoff in a workflow's hash-linked
 * custody chain.  The chain is reconstructable from `index` ordering and
 * gap-checkable from `prevLinkHash` linkage.
 *
 * Gaps and re-writes are detectable: every verifier recomputes
 *   linkHash = SHA256(index ∥ workflowId ∥ prevLinkHash ∥ fromActor ∥ toActor ∥ handoffAt)
 * and checks the chain is unbroken.
 */
@Entity('custody_chain_links')
@Index(['workflowId', 'linkIndex'], { unique: true })
@Index(['workflowId'])
export class CustodyChainLinkEntity extends BaseEntity {
  /** Workflow this link belongs to. */
  @Column({ name: 'workflow_id', type: 'varchar', length: 128 })
  workflowId: string;

  /** Sequential 0-based position in the custody chain for this workflow. */
  @Column({ name: 'link_index', type: 'integer' })
  linkIndex: number;

  /**
   * SHA-256 hex hash of the previous link.
   * 64 zero-chars for the genesis link (index 0).
   */
  @Column({ name: 'prev_link_hash', type: 'varchar', length: 64 })
  prevLinkHash: string;

  /** SHA-256 hex hash of this link's canonical payload. */
  @Column({ name: 'link_hash', type: 'varchar', length: 64 })
  linkHash: string;

  /** Stellar address / actor ID handing off. */
  @Column({ name: 'from_actor', type: 'varchar', length: 128 })
  fromActor: string;

  /** Stellar address / actor ID receiving. */
  @Column({ name: 'to_actor', type: 'varchar', length: 128 })
  toActor: string;

  /** When the handoff occurred (mirrors Soroban ledger timestamp). */
  @Column({ name: 'handoff_at', type: 'timestamptz' })
  handoffAt: Date;

  /** On-chain transaction hash that anchored this link. */
  @Column({ name: 'on_chain_tx_hash', type: 'varchar', length: 128, nullable: true })
  onChainTxHash: string | null;
}
