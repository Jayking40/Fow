import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * A single leaf entry that will be included in the Merkle tree.
 * Off-chain callers build the full leaf list; the service computes
 * the Merkle root and submits `bundleHash` on-chain.
 */
export class MerkleLeafDto {
  /** Canonical label for this document (e.g. "courier_attestation", "facility_signature"). */
  @IsString()
  label: string;

  /**
   * SHA-256 hex digest of the document bytes.
   * Must be exactly 64 hex characters.
   */
  @IsString()
  @Length(64, 64)
  hash: string;
}

/**
 * Submitted by the courier to anchor a delivery bundle on-chain.
 *
 * The service:
 *  1. Validates each leaf hash is a 64-char hex string.
 *  2. Builds a binary Merkle tree over the sorted leaf hashes.
 *  3. Calls `submit_proof_commitment` on the Soroban contract.
 *  4. Persists a ProofCommitmentEntity row for off-chain indexing.
 */
export class SubmitProofCommitmentDto {
  /** Off-chain workflow / order identifier. */
  @IsString()
  workflowId: string;

  /**
   * Ordered list of leaves that make up the proof bundle Merkle tree.
   * Recommended set (in order):
   *   courier_attestation, facility_signature, qr_custody_chain,
   *   temperature_summary, gps_trail
   */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MerkleLeafDto)
  leaves: MerkleLeafDto[];

  /** Merkle proof scheme version to register against on-chain. Defaults to 1. */
  @IsOptional()
  @IsInt()
  @Min(1)
  schemeVersion?: number;

  /** Stellar address of the courier submitting the commitment. */
  @IsString()
  courierAddress: string;

  /** Stellar address of the receiving facility. */
  @IsString()
  facilityAddress: string;
}

/**
 * Sent by the facility to confirm a pending proof commitment.
 */
export class ConfirmProofCommitmentDto {
  /** Database UUID of the ProofCommitmentEntity to confirm. */
  @IsString()
  commitmentId: string;

  /** Stellar address of the facility confirming delivery. */
  @IsString()
  facilityAddress: string;
}

/**
 * Payload for verifying that a specific document is included in a
 * committed bundle without trusting the backend.
 */
export class VerifyInclusionDto {
  /** Database UUID of the ProofCommitmentEntity. */
  @IsString()
  commitmentId: string;

  /**
   * SHA-256 hex digest of the document whose inclusion you want to verify.
   * Must be a leaf hash that was included when the bundle was built.
   */
  @IsString()
  @Length(64, 64)
  leafHash: string;

  /**
   * Ordered Merkle sibling proof path from leaf to root.
   * Each element is a 64-char SHA-256 hex string.
   * Supply an empty array for a single-leaf (root == leaf) tree.
   */
  @IsArray()
  @IsString({ each: true })
  @Length(64, 64, { each: true })
  siblingProof: string[];
}

/**
 * Submitted by an arbiter (admin) to supersede a confirmed commitment
 * with a corrected one.  Both old and new records are retained.
 */
export class AmendProofCommitmentDto {
  /** Database UUID of the confirmed ProofCommitmentEntity to supersede. */
  @IsString()
  commitmentId: string;

  /**
   * New leaf set for the replacement bundle.
   * Merkle root is recomputed by the service.
   */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MerkleLeafDto)
  newLeaves: MerkleLeafDto[];

  /** Human-readable reason for the amendment. */
  @IsString()
  reason: string;

  /** Stellar address of the admin / arbiter approving the amendment. */
  @IsString()
  arbiterAddress: string;
}

/**
 * Appends one hash-linked custody handoff to a workflow's on-chain chain.
 */
export class AppendCustodyLinkDto {
  /** Workflow this handoff belongs to. */
  @IsString()
  workflowId: string;

  /** Stellar address handing off custody. */
  @IsString()
  fromActor: string;

  /** Stellar address receiving custody. */
  @IsString()
  toActor: string;

  /**
   * SHA-256 hex hash of the previous link.
   * Pass 64 zero-chars ("000...0") for the genesis (index 0) link.
   */
  @IsString()
  @Length(64, 64)
  prevLinkHash: string;
}
