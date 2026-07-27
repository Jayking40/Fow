import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity';

/**
 * Mirrors the on-chain ProofCommitmentStatus enum.
 * Values are kept identical so round-trips are lossless.
 */
export enum ProofCommitmentStatus {
  /** Courier submitted; awaiting facility confirmation. */
  PENDING_FACILITY = 'pending_facility',
  /** Both parties attested — settlement-eligible. */
  CONFIRMED = 'confirmed',
  /** Superseded by a newer commitment (amendment). */
  SUPERSEDED = 'superseded',
  /** Under arbitration dispute. */
  DISPUTED = 'disputed',
}

/**
 * Off-chain mirror of a ProofCommitment stored on the HealthChain
 * Soroban contract.  The `bundleHash` is the Merkle root of the
 * full off-chain bundle; everything else is indexing / audit metadata.
 *
 * Amendment discipline: commitments are never deleted — they are
 * superseded in place by creating a new row and linking via
 * `supersededById`.
 */
@Entity('proof_commitments')
@Index(['workflowId'])
@Index(['status'])
@Index(['onChainCommitmentId'], { unique: true, where: '"on_chain_commitment_id" IS NOT NULL' })
export class ProofCommitmentEntity extends BaseEntity {
  /** The sequential ID returned by the contract (null until anchored). */
  @Column({ name: 'on_chain_commitment_id', type: 'bigint', nullable: true })
  onChainCommitmentId: number | null;

  /** Off-chain workflow / order reference (matches Soroban workflow_id). */
  @Column({ name: 'workflow_id', type: 'varchar', length: 128 })
  workflowId: string;

  /**
   * Merkle root of the off-chain bundle (hex SHA-256, 64 chars).
   * courier attestation ∥ facility signature ∥ QR custody scan chain
   * ∥ temperature summary hash ∥ GPS trail digest.
   */
  @Column({ name: 'bundle_hash', type: 'varchar', length: 64 })
  bundleHash: string;

  /** Scheme version used when building the Merkle tree. */
  @Column({ name: 'scheme_version', type: 'integer', default: 1 })
  schemeVersion: number;

  /** Stellar address of the courier who submitted the commitment. */
  @Column({ name: 'courier_address', type: 'varchar', length: 128 })
  courierAddress: string;

  /** Stellar address of the receiving facility. */
  @Column({ name: 'facility_address', type: 'varchar', length: 128 })
  facilityAddress: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: ProofCommitmentStatus,
    default: ProofCommitmentStatus.PENDING_FACILITY,
  })
  status: ProofCommitmentStatus;

  /** ISO timestamp when the courier submitted the commitment. */
  @Column({ name: 'submitted_at', type: 'timestamptz' })
  submittedAt: Date;

  /** ISO timestamp when the facility confirmed (null until confirmed). */
  @Column({ name: 'confirmed_at', type: 'timestamptz', nullable: true })
  confirmedAt: Date | null;

  /** Deadline by which the facility must confirm (4-hour window). */
  @Column({ name: 'facility_deadline', type: 'timestamptz' })
  facilityDeadline: Date;

  /** On-chain transaction hash anchoring the submission. */
  @Column({ name: 'on_chain_tx_hash', type: 'varchar', length: 128, nullable: true })
  onChainTxHash: string | null;

  // ── Amendment fields ────────────────────────────────────────────────────────

  /** ID of the ProofCommitmentEntity that supersedes this one. */
  @Column({ name: 'superseded_by_id', type: 'uuid', nullable: true })
  supersededById: string | null;

  /** Human-readable reason when this commitment was superseded. */
  @Column({ name: 'supersede_reason', type: 'text', nullable: true })
  supersedeReason: string | null;

  /** Arbiter address that approved the supersession. */
  @Column({ name: 'arbiter_address', type: 'varchar', length: 128, nullable: true })
  arbiterAddress: string | null;
}
