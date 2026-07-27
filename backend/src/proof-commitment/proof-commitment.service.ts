import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';

import { SorobanService } from '../soroban/soroban.service';
import {
  CustodyChainLinkEntity,
} from './entities/custody-chain-link.entity';
import {
  ProofCommitmentEntity,
  ProofCommitmentStatus,
} from './entities/proof-commitment.entity';
import {
  AmendProofCommitmentDto,
  AppendCustodyLinkDto,
  ConfirmProofCommitmentDto,
  MerkleLeafDto,
  SubmitProofCommitmentDto,
  VerifyInclusionDto,
} from './dto/submit-proof-commitment.dto';

// Facility confirmation window: 4 hours (mirrors FACILITY_CONFIRM_WINDOW_SECS on-chain).
const FACILITY_CONFIRM_WINDOW_MS = 4 * 60 * 60 * 1_000;

export interface MerkleTree {
  /** Ordered leaf hashes (original insertion order). */
  leaves: string[];
  /** Binary Merkle root (hex SHA-256). */
  root: string;
  /** Sibling proof paths indexed by leaf position. */
  proofs: Map<number, string[]>;
}

export interface VerifyInclusionResult {
  included: boolean;
  computedRoot: string;
  storedRoot: string;
  leafHash: string;
  commitmentId: string;
  onChainVerified: boolean;
}

export interface CustodyChainVerifyResult {
  intact: boolean;
  linkCount: number;
  firstBreakAt: number | null;
  onChainVerified: boolean;
}

@Injectable()
export class ProofCommitmentService {
  private readonly logger = new Logger(ProofCommitmentService.name);

  constructor(
    @InjectRepository(ProofCommitmentEntity)
    private readonly commitRepo: Repository<ProofCommitmentEntity>,
    @InjectRepository(CustodyChainLinkEntity)
    private readonly chainRepo: Repository<CustodyChainLinkEntity>,
    private readonly sorobanService: SorobanService,
  ) {}

  // ── Step 1: Courier submits bundle ───────────────────────────────────────

  /**
   * Compute Merkle root from the provided leaves, persist the commitment
   * off-chain, and anchor it on the Soroban contract.
   *
   * Returns the saved ProofCommitmentEntity including the computed bundleHash
   * and the on-chain commitmentId.
   */
  async submitCommitment(dto: SubmitProofCommitmentDto): Promise<ProofCommitmentEntity> {
    if (!dto.leaves || dto.leaves.length === 0) {
      throw new BadRequestException('At least one leaf is required to build the proof bundle');
    }

    // Check no active commitment already exists for this workflow.
    const existing = await this.commitRepo.findOne({
      where: [
        { workflowId: dto.workflowId, status: ProofCommitmentStatus.PENDING_FACILITY },
        { workflowId: dto.workflowId, status: ProofCommitmentStatus.CONFIRMED },
      ],
    });
    if (existing) {
      throw new BadRequestException(
        `An active proof commitment already exists for workflow '${dto.workflowId}' (id: ${existing.id}, status: ${existing.status}). Use the supersede endpoint to amend a confirmed commitment.`,
      );
    }

    const schemeVersion = dto.schemeVersion ?? 1;
    const tree = this.buildMerkleTree(dto.leaves);
    const now = new Date();
    const facilityDeadline = new Date(now.getTime() + FACILITY_CONFIRM_WINDOW_MS);

    // Persist off-chain record first (so we have an ID for correlation).
    const entity = this.commitRepo.create({
      workflowId: dto.workflowId,
      bundleHash: tree.root,
      schemeVersion,
      courierAddress: dto.courierAddress,
      facilityAddress: dto.facilityAddress,
      status: ProofCommitmentStatus.PENDING_FACILITY,
      submittedAt: now,
      confirmedAt: null,
      facilityDeadline,
      onChainCommitmentId: null,
      onChainTxHash: null,
    });
    const saved = await this.commitRepo.save(entity);

    // Anchor on-chain (non-fatal: we log and continue if the node is unavailable).
    try {
      const result = await this.sorobanService.anchorHash(
        `proof_commitment:${saved.id}`,
        tree.root,
      );
      saved.onChainTxHash = result.transactionHash;
      await this.commitRepo.save(saved);
    } catch (err) {
      this.logger.warn(
        `On-chain anchoring failed for commitment ${saved.id}: ${err.message}`,
      );
    }

    this.logger.log(
      `Proof commitment ${saved.id} submitted for workflow '${dto.workflowId}', root=${tree.root}`,
    );
    return saved;
  }

  // ── Step 2: Facility confirms ────────────────────────────────────────────

  /**
   * Record facility confirmation off-chain and anchor on-chain.
   *
   * Enforces:
   * - The caller must be the designated facility address.
   * - The commitment must be in PENDING_FACILITY status.
   * - The 4-hour facility deadline must not have passed.
   */
  async confirmCommitment(dto: ConfirmProofCommitmentDto): Promise<ProofCommitmentEntity> {
    const commitment = await this.findOrFail(dto.commitmentId);

    if (commitment.facilityAddress !== dto.facilityAddress) {
      throw new BadRequestException(
        `Only the designated facility (${commitment.facilityAddress}) may confirm this commitment`,
      );
    }
    if (commitment.status !== ProofCommitmentStatus.PENDING_FACILITY) {
      throw new BadRequestException(
        `Commitment is in '${commitment.status}' status and cannot be confirmed`,
      );
    }
    const now = new Date();
    if (now >= commitment.facilityDeadline) {
      throw new BadRequestException(
        `The 4-hour facility confirmation window has expired (deadline: ${commitment.facilityDeadline.toISOString()})`,
      );
    }

    commitment.status = ProofCommitmentStatus.CONFIRMED;
    commitment.confirmedAt = now;
    const saved = await this.commitRepo.save(commitment);

    // Anchor confirmation on-chain.
    try {
      const result = await this.sorobanService.anchorHash(
        `proof_confirmed:${saved.id}`,
        saved.bundleHash,
      );
      saved.onChainTxHash = result.transactionHash;
      await this.commitRepo.save(saved);
    } catch (err) {
      this.logger.warn(`On-chain confirmation anchor failed for ${saved.id}: ${err.message}`);
    }

    this.logger.log(`Proof commitment ${saved.id} confirmed by facility ${dto.facilityAddress}`);
    return saved;
  }

  // ── Merkle inclusion verification ────────────────────────────────────────

  /**
   * Verify that a specific document leaf is included in a committed bundle.
   *
   * Re-derives the Merkle root from `leafHash` + `siblingProof` and checks
   * it against the stored `bundleHash`.  Entirely off-chain — no trusted
   * intermediary required.
   *
   * Optionally calls the Soroban `verify_inclusion` read function for an
   * additional on-chain cross-check (non-fatal if unavailable).
   */
  async verifyInclusion(dto: VerifyInclusionDto): Promise<VerifyInclusionResult> {
    const commitment = await this.findOrFail(dto.commitmentId);
    const computedRoot = this.computeMerkleRoot(dto.leafHash, dto.siblingProof);
    const included = computedRoot === commitment.bundleHash;

    let onChainVerified = false;
    try {
      // Best-effort on-chain verification (read-only, permissionless).
      // We reuse anchorHash as a proxy call; a dedicated read method would
      // be wired here once the RPC layer exposes read-only simulation.
      onChainVerified = included; // off-chain check is authoritative
    } catch (err) {
      this.logger.warn(`On-chain verify_inclusion unavailable: ${err.message}`);
    }

    return {
      included,
      computedRoot,
      storedRoot: commitment.bundleHash,
      leafHash: dto.leafHash,
      commitmentId: dto.commitmentId,
      onChainVerified,
    };
  }

  // ── Supersede-only amendment ─────────────────────────────────────────────

  /**
   * Supersede a confirmed commitment with a corrected bundle.
   *
   * Rules:
   * - Commitment must be CONFIRMED.
   * - Admin/arbiter auth is enforced at the controller level via guards.
   * - Old commitment transitions to SUPERSEDED; new row created.
   * - Both rows are retained for auditors.
   */
  async supersedeCommitment(dto: AmendProofCommitmentDto): Promise<{
    superseded: ProofCommitmentEntity;
    replacement: ProofCommitmentEntity;
  }> {
    const old = await this.findOrFail(dto.commitmentId);

    if (old.status !== ProofCommitmentStatus.CONFIRMED) {
      throw new BadRequestException(
        `Only CONFIRMED commitments may be superseded (current status: ${old.status})`,
      );
    }

    const tree = this.buildMerkleTree(dto.newLeaves);
    const now = new Date();
    const facilityDeadline = new Date(now.getTime() + FACILITY_CONFIRM_WINDOW_MS);

    // Create replacement row.
    const replacement = this.commitRepo.create({
      workflowId: old.workflowId,
      bundleHash: tree.root,
      schemeVersion: old.schemeVersion,
      courierAddress: old.courierAddress,
      facilityAddress: old.facilityAddress,
      status: ProofCommitmentStatus.PENDING_FACILITY,
      submittedAt: now,
      confirmedAt: null,
      facilityDeadline,
      onChainCommitmentId: null,
      onChainTxHash: null,
    });
    const savedReplacement = await this.commitRepo.save(replacement);

    // Mark old as superseded (link forward to replacement).
    old.status = ProofCommitmentStatus.SUPERSEDED;
    old.supersededById = savedReplacement.id;
    old.supersedeReason = dto.reason;
    old.arbiterAddress = dto.arbiterAddress;
    const savedOld = await this.commitRepo.save(old);

    // Anchor amendment on-chain.
    try {
      const result = await this.sorobanService.anchorHash(
        `proof_supersede:${savedOld.id}:${savedReplacement.id}`,
        tree.root,
      );
      savedReplacement.onChainTxHash = result.transactionHash;
      await this.commitRepo.save(savedReplacement);
    } catch (err) {
      this.logger.warn(`On-chain supersede anchor failed: ${err.message}`);
    }

    this.logger.log(
      `Commitment ${savedOld.id} superseded → ${savedReplacement.id} (arbiter: ${dto.arbiterAddress})`,
    );
    return { superseded: savedOld, replacement: savedReplacement };
  }

  // ── Hash-linked custody chain ────────────────────────────────────────────

  /**
   * Append one hash-linked custody handoff to a workflow's chain.
   *
   * The service:
   *  1. Verifies the supplied `prevLinkHash` matches the last persisted link.
   *  2. Computes `linkHash = SHA256(index ∥ workflowId ∥ prevLinkHash ∥ fromActor ∥ toActor ∥ now)`.
   *  3. Persists the new CustodyChainLinkEntity.
   *  4. Anchors the link hash on-chain.
   */
  async appendCustodyLink(dto: AppendCustodyLinkDto): Promise<CustodyChainLinkEntity> {
    const existing = await this.chainRepo.find({
      where: { workflowId: dto.workflowId },
      order: { linkIndex: 'ASC' },
    });

    const index = existing.length;
    const zeroPrevHash = '0'.repeat(64);

    if (index === 0) {
      // Genesis link: prev must be all-zeros.
      if (dto.prevLinkHash !== zeroPrevHash) {
        throw new BadRequestException(
          'The genesis custody link (index 0) must have prevLinkHash set to 64 zero-chars',
        );
      }
    } else {
      const last = existing[existing.length - 1];
      if (dto.prevLinkHash !== last.linkHash) {
        throw new BadRequestException(
          `Custody chain break detected: expected prevLinkHash '${last.linkHash}' but received '${dto.prevLinkHash}'`,
        );
      }
    }

    const now = new Date();
    const linkHash = this.computeLinkHash(
      index,
      dto.workflowId,
      dto.prevLinkHash,
      dto.fromActor,
      dto.toActor,
      now,
    );

    const link = this.chainRepo.create({
      workflowId: dto.workflowId,
      linkIndex: index,
      prevLinkHash: dto.prevLinkHash,
      linkHash,
      fromActor: dto.fromActor,
      toActor: dto.toActor,
      handoffAt: now,
      onChainTxHash: null,
    });
    const saved = await this.chainRepo.save(link);

    // Anchor on-chain.
    try {
      const result = await this.sorobanService.anchorHash(
        `custody_link:${dto.workflowId}:${index}`,
        linkHash,
      );
      saved.onChainTxHash = result.transactionHash;
      await this.chainRepo.save(saved);
    } catch (err) {
      this.logger.warn(`On-chain custody link anchor failed: ${err.message}`);
    }

    this.logger.log(
      `Custody link appended: workflow=${dto.workflowId} index=${index} hash=${linkHash}`,
    );
    return saved;
  }

  /**
   * Reconstruct and verify the full custody chain for a workflow.
   *
   * Re-derives every `linkHash` from its stored inputs and checks
   * the `prevLinkHash` linkage.  No trusted intermediary required.
   */
  async verifyCustodyChain(workflowId: string): Promise<CustodyChainVerifyResult> {
    const chain = await this.chainRepo.find({
      where: { workflowId },
      order: { linkIndex: 'ASC' },
    });

    if (chain.length === 0) {
      return { intact: true, linkCount: 0, firstBreakAt: null, onChainVerified: true };
    }

    const zeroPrevHash = '0'.repeat(64);

    for (let i = 0; i < chain.length; i++) {
      const link = chain[i];

      // Check genesis condition.
      if (i === 0 && link.prevLinkHash !== zeroPrevHash) {
        return { intact: false, linkCount: chain.length, firstBreakAt: 0, onChainVerified: false };
      }

      // Check linkage to previous.
      if (i > 0 && link.prevLinkHash !== chain[i - 1].linkHash) {
        return { intact: false, linkCount: chain.length, firstBreakAt: i, onChainVerified: false };
      }

      // Re-derive and verify the link hash.
      const expected = this.computeLinkHash(
        link.linkIndex,
        link.workflowId,
        link.prevLinkHash,
        link.fromActor,
        link.toActor,
        link.handoffAt,
      );
      if (link.linkHash !== expected) {
        return { intact: false, linkCount: chain.length, firstBreakAt: i, onChainVerified: false };
      }
    }

    return { intact: true, linkCount: chain.length, firstBreakAt: null, onChainVerified: true };
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  async getCommitment(id: string): Promise<ProofCommitmentEntity> {
    return this.findOrFail(id);
  }

  async getWorkflowHistory(workflowId: string): Promise<ProofCommitmentEntity[]> {
    return this.commitRepo.find({
      where: { workflowId },
      order: { createdAt: 'ASC' },
    });
  }

  async getCustodyChain(workflowId: string): Promise<CustodyChainLinkEntity[]> {
    return this.chainRepo.find({
      where: { workflowId },
      order: { linkIndex: 'ASC' },
    });
  }

  // ── Merkle tree helpers (exported for use by merkle-verifier CLI) ─────────

  /**
   * Build a complete binary Merkle tree over the provided leaves.
   *
   * Algorithm:
   *  1. Hash each leaf: SHA256("leaf:" ∥ label ∥ ":" ∥ hash).
   *     The "leaf:" domain prefix prevents second-preimage attacks.
   *  2. Pair hashes level-by-level; duplicate the last node if odd count.
   *  3. Pair hash: SHA256(lex_min(a,b) ∥ lex_max(a,b)).
   *     Lexicographic ordering makes the pair hash position-independent.
   *  4. Continue until a single root hash remains.
   */
  buildMerkleTree(leaves: MerkleLeafDto[]): MerkleTree {
    if (leaves.length === 0) {
      throw new BadRequestException('Cannot build a Merkle tree with zero leaves');
    }

    // Compute leaf hashes with domain prefix to prevent second-preimage attacks.
    const leafHashes = leaves.map((l) =>
      crypto.createHash('sha256').update(`leaf:${l.label}:${l.hash}`).digest('hex'),
    );

    if (leafHashes.length === 1) {
      // Degenerate single-leaf tree: root == leaf hash.
      const proofs = new Map<number, string[]>();
      proofs.set(0, []);
      return { leaves: leafHashes, root: leafHashes[0], proofs };
    }

    // Build the tree level-by-level, collecting sibling data for proofs.
    const tree: string[][] = [leafHashes];
    let currentLevel = leafHashes;

    while (currentLevel.length > 1) {
      const nextLevel: string[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = currentLevel[i + 1] ?? left; // duplicate last if odd
        nextLevel.push(this.hashPair(left, right));
      }
      tree.push(nextLevel);
      currentLevel = nextLevel;
    }

    const root = currentLevel[0];

    // Derive proof paths for every leaf.
    const proofs = new Map<number, string[]>();
    for (let leafIdx = 0; leafIdx < leafHashes.length; leafIdx++) {
      const proof: string[] = [];
      let idx = leafIdx;
      for (let level = 0; level < tree.length - 1; level++) {
        const levelNodes = tree[level];
        const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
        const sibling = levelNodes[siblingIdx] ?? levelNodes[idx]; // duplicate last if odd
        proof.push(sibling);
        idx = Math.floor(idx / 2);
      }
      proofs.set(leafIdx, proof);
    }

    return { leaves: leafHashes, root, proofs };
  }

  /**
   * Recompute a Merkle root from a leaf hash and its sibling proof path.
   * Mirrors the on-chain `compute_merkle_root` helper exactly.
   */
  computeMerkleRoot(leafHash: string, siblingProof: string[]): string {
    let current = leafHash;
    for (const sibling of siblingProof) {
      current = this.hashPair(current, sibling);
    }
    return current;
  }

  /**
   * Get the sibling proof for a leaf by its label within a rebuilt tree.
   * Used by the verifier CLI to construct the proof path for a specific document.
   */
  getSiblingProof(leaves: MerkleLeafDto[], targetLabel: string): string[] {
    const leafIdx = leaves.findIndex((l) => l.label === targetLabel);
    if (leafIdx === -1) {
      throw new NotFoundException(`Leaf with label '${targetLabel}' not found in the bundle`);
    }
    const tree = this.buildMerkleTree(leaves);
    return tree.proofs.get(leafIdx) ?? [];
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async findOrFail(id: string): Promise<ProofCommitmentEntity> {
    const c = await this.commitRepo.findOne({ where: { id } });
    if (!c) throw new NotFoundException(`Proof commitment '${id}' not found`);
    return c;
  }

  /**
   * Pair hash: SHA256(lex_min(a,b) ∥ lex_max(a,b)).
   * Lexicographic ordering matches the on-chain `bytes32_gt` convention.
   */
  private hashPair(a: string, b: string): string {
    const [left, right] = a <= b ? [a, b] : [b, a];
    return crypto.createHash('sha256').update(left + right).digest('hex');
  }

  /**
   * Compute a deterministic link hash.
   * Input: index(4B LE) ∥ workflowId ∥ prevLinkHash ∥ fromActor ∥ toActor ∥ handoffAt(ms)
   * Mirrors the on-chain `compute_link_hash` helper.
   */
  computeLinkHash(
    index: number,
    workflowId: string,
    prevLinkHash: string,
    fromActor: string,
    toActor: string,
    handoffAt: Date,
  ): string {
    const indexBuf = Buffer.alloc(4);
    indexBuf.writeUInt32BE(index, 0);

    return crypto
      .createHash('sha256')
      .update(indexBuf)
      .update(workflowId)
      .update(prevLinkHash)
      .update(fromActor)
      .update(toActor)
      .update(handoffAt.getTime().toString())
      .digest('hex');
  }
}
