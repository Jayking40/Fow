/**
 * @file proof-commitment.service.spec.ts
 *
 * Unit tests for ProofCommitmentService and MerkleVerifier.
 * Covers every acceptance criterion from the feature spec:
 *
 *  AC1 — No delivery can reach settlement with only one party's auth.
 *  AC2 — A tampered bundle document fails verify_inclusion.
 *  AC3 — The full custody chain is reconstructable and gap-checkable.
 *
 * Additional coverage:
 *  - Duplicate active commitment guard.
 *  - Supersede-only amendment: history retained, old not deleted.
 *  - Facility-window expiry blocks confirmation.
 *  - Non-confirmed commitment cannot be superseded.
 *  - MerkleVerifier: tree shape, sibling proofs, root stability.
 *  - MerkleVerifier: verifyLeafAgainstRoot with correct and tampered leaf.
 *  - CustodyChain: broken-link detection (wrong prev, wrong hash).
 */

import * as crypto from 'crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { MerkleVerifier } from './merkle-verifier';
import { ProofCommitmentService } from './proof-commitment.service';
import {
  ProofCommitmentStatus,
} from './entities/proof-commitment.entity';
import {
  MerkleLeafDto,
} from './dto/submit-proof-commitment.dto';

// ── Helpers ────────────────────────────────────────────────────────────────────

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

const COURIER = 'GCOURIER_ADDR';
const FACILITY = 'GFACILITY_ADDR';
const WORKFLOW = 'wf-test-001';
const ZERO_HASH = '0'.repeat(64);

/** Canonical 5-leaf bundle used across most tests. */
const BUNDLE_LEAVES: MerkleLeafDto[] = [
  { label: 'courier_attestation', hash: sha256('courier data') },
  { label: 'facility_signature',  hash: sha256('facility sig') },
  { label: 'qr_custody_chain',    hash: sha256('qr scans') },
  { label: 'temperature_summary', hash: sha256('temp log') },
  { label: 'gps_trail',           hash: sha256('gps digest') },
];

// ── Minimal service harness (no NestJS DI, no DB, pure unit) ─────────────────
//
// We test the pure-function layer of ProofCommitmentService directly by
// instantiating it with repository mocks. The mock repositories satisfy the
// Repository interface with an in-memory array store.

type Stored<T> = T & { id: string; createdAt: Date; updatedAt: Date };

function uuid(): string {
  return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

function makeRepo<T extends { id?: string }>() {
  const store: Stored<T>[] = [];

  return {
    _store: store,
    create(partial: Partial<T>): T {
      return { ...partial } as T;
    },
    async save(entity: T): Promise<Stored<T>> {
      const existing = store.find((e) => e.id === (entity as any).id);
      if (existing) {
        Object.assign(existing, entity);
        return existing;
      }
      const row: Stored<T> = { ...entity, id: uuid(), createdAt: new Date(), updatedAt: new Date() } as Stored<T>;
      store.push(row);
      return row;
    },
    async findOne(opts: { where: Partial<T> | Partial<T>[] }): Promise<Stored<T> | null> {
      const conditions = Array.isArray(opts.where) ? opts.where : [opts.where];
      return (
        store.find((row) =>
          conditions.some((cond) =>
            Object.entries(cond as object).every(([k, v]) => (row as any)[k] === v),
          ),
        ) ?? null
      );
    },
    async find(opts: { where?: Partial<T>; order?: Record<string, string> }): Promise<Stored<T>[]> {
      let result = store.filter((row) =>
        Object.entries((opts.where as object) ?? {}).every(([k, v]) => (row as any)[k] === v),
      );
      if (opts.order) {
        const [key, dir] = Object.entries(opts.order)[0];
        result = result.sort((a, b) => {
          const av = (a as any)[key];
          const bv = (b as any)[key];
          return dir === 'ASC' ? (av > bv ? 1 : -1) : av < bv ? 1 : -1;
        });
      }
      return result;
    },
  };
}

/** Minimal SorobanService stub — anchorHash always resolves immediately. */
const sorobanStub = {
  anchorHash: async (_label: string, _hash: string) => ({ transactionHash: 'tx_' + _label }),
};

function makeService() {
  const commitRepo = makeRepo<any>();
  const chainRepo  = makeRepo<any>();
  // Cast to Repository<any> — only the methods above are called.
  const svc = new ProofCommitmentService(
    commitRepo as any,
    chainRepo as any,
    sorobanStub as any,
  );
  return { svc, commitRepo, chainRepo };
}

// ═══════════════════════════════════════════════════════════════════════════
// MERKLE VERIFIER — pure unit tests (zero I/O)
// ═══════════════════════════════════════════════════════════════════════════

describe('MerkleVerifier (pure)', () => {
  const verifier = new MerkleVerifier({ apiBaseUrl: 'http://localhost:3000' });

  describe('hashLeaf', () => {
    it('applies domain prefix: SHA256("leaf:label:hash")', () => {
      const label = 'courier_attestation';
      const hash  = sha256('payload');
      const got   = verifier.hashLeaf(label, hash);
      const want  = sha256(`leaf:${label}:${hash}`);
      expect(got).toBe(want);
    });

    it('is stable: same inputs → same output', () => {
      const a = verifier.hashLeaf('a', 'b');
      const b = verifier.hashLeaf('a', 'b');
      expect(a).toBe(b);
    });

    it('different label → different hash', () => {
      const h = sha256('same payload');
      expect(verifier.hashLeaf('label_a', h)).not.toBe(verifier.hashLeaf('label_b', h));
    });
  });

  describe('hashPair (lex-ordered)', () => {
    it('is commutative: hashPair(a,b) === hashPair(b,a)', () => {
      const a = sha256('alpha');
      const b = sha256('beta');
      expect(verifier.hashPair(a, b)).toBe(verifier.hashPair(b, a));
    });
  });

  describe('buildTree', () => {
    it('single leaf → root equals leaf hash', () => {
      const leaf = [{ label: 'only', hash: sha256('only doc') }];
      const { root, leafHashes, proofPaths } = verifier.buildTree(leaf);
      expect(root).toBe(leafHashes[0]);
      expect(proofPaths[0]).toEqual([]);
    });

    it('two leaves → root is hashPair of the two leaf hashes', () => {
      const leaves = [
        { label: 'a', hash: sha256('a doc') },
        { label: 'b', hash: sha256('b doc') },
      ];
      const { root, leafHashes } = verifier.buildTree(leaves);
      const expected = verifier.hashPair(leafHashes[0], leafHashes[1]);
      expect(root).toBe(expected);
    });

    it('5-leaf bundle: root is deterministic across calls', () => {
      const t1 = verifier.buildTree(BUNDLE_LEAVES);
      const t2 = verifier.buildTree(BUNDLE_LEAVES);
      expect(t1.root).toBe(t2.root);
    });

    it('changing one leaf changes the root', () => {
      const t1 = verifier.buildTree(BUNDLE_LEAVES);
      const modified = BUNDLE_LEAVES.map((l, i) =>
        i === 0 ? { ...l, hash: sha256('TAMPERED') } : l,
      );
      const t2 = verifier.buildTree(modified);
      expect(t1.root).not.toBe(t2.root);
    });

    it('every leaf is provably included via its sibling path', () => {
      const { root, leafHashes, proofPaths } = verifier.buildTree(BUNDLE_LEAVES);
      for (let i = 0; i < BUNDLE_LEAVES.length; i++) {
        const computed = verifier.computeRoot(leafHashes[i], proofPaths[i]);
        expect(computed).toBe(root);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MerkleVerifier.verifyLeafAgainstRoot
// ═══════════════════════════════════════════════════════════════════════════

describe('MerkleVerifier.verifyLeafAgainstRoot', () => {
  const verifier = new MerkleVerifier({ apiBaseUrl: 'http://localhost:3000' });

  it('AC2 — correct leaf + valid proof → true', () => {
    const { root, proofPaths } = verifier.buildTree(BUNDLE_LEAVES);
    const targetLeaf = BUNDLE_LEAVES[2]; // qr_custody_chain
    const siblingPath = proofPaths[2];
    const result = verifier.verifyLeafAgainstRoot(targetLeaf, siblingPath, root);
    expect(result).toBe(true);
  });

  it('AC2 — tampered document hash → false', () => {
    const { root, proofPaths } = verifier.buildTree(BUNDLE_LEAVES);
    const tampered = { label: BUNDLE_LEAVES[2].label, hash: sha256('TAMPERED PAYLOAD') };
    const siblingPath = proofPaths[2];
    const result = verifier.verifyLeafAgainstRoot(tampered, siblingPath, root);
    expect(result).toBe(false);
  });

  it('AC2 — tampered sibling in proof path → false', () => {
    const { root, proofPaths } = verifier.buildTree(BUNDLE_LEAVES);
    const targetLeaf = BUNDLE_LEAVES[0];
    const corruptedPath = proofPaths[0].map((sib, i) =>
      i === 0 ? sha256('evil sibling') : sib,
    );
    const result = verifier.verifyLeafAgainstRoot(targetLeaf, corruptedPath, root);
    expect(result).toBe(false);
  });

  it('AC2 — correct leaf but wrong root → false', () => {
    const { proofPaths } = verifier.buildTree(BUNDLE_LEAVES);
    const targetLeaf  = BUNDLE_LEAVES[0];
    const siblingPath = proofPaths[0];
    const wrongRoot   = sha256('completely wrong root');
    const result = verifier.verifyLeafAgainstRoot(targetLeaf, siblingPath, wrongRoot);
    expect(result).toBe(false);
  });

  it('single-leaf bundle: empty proof + leaf hash == root', () => {
    const singleLeaf = [{ label: 'only', hash: sha256('single') }];
    const { root } = verifier.buildTree(singleLeaf);
    const result = verifier.verifyLeafAgainstRoot(singleLeaf[0], [], root);
    expect(result).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ProofCommitmentService — dual-attestation flow
// ═══════════════════════════════════════════════════════════════════════════

describe('ProofCommitmentService.submitCommitment', () => {
  it('happy path — creates entity with correct bundleHash and status', async () => {
    const { svc } = makeService();
    const result = await svc.submitCommitment({
      workflowId: WORKFLOW,
      leaves: BUNDLE_LEAVES,
      courierAddress: COURIER,
      facilityAddress: FACILITY,
    });

    // Root must match what buildMerkleTree computes.
    const tree = svc.buildMerkleTree(BUNDLE_LEAVES);
    expect(result.bundleHash).toBe(tree.root);
    expect(result.status).toBe(ProofCommitmentStatus.PENDING_FACILITY);
    expect(result.courierAddress).toBe(COURIER);
    expect(result.facilityAddress).toBe(FACILITY);
    expect(result.confirmedAt).toBeNull();
  });

  it('AC1 (guard) — duplicate active commitment is rejected', async () => {
    const { svc } = makeService();
    await svc.submitCommitment({
      workflowId: WORKFLOW,
      leaves: BUNDLE_LEAVES,
      courierAddress: COURIER,
      facilityAddress: FACILITY,
    });

    // Second submission with the same workflowId while first is PendingFacility.
    await expect(
      svc.submitCommitment({
        workflowId: WORKFLOW,
        leaves: BUNDLE_LEAVES,
        courierAddress: COURIER,
        facilityAddress: FACILITY,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('empty leaves list is rejected', async () => {
    const { svc } = makeService();
    await expect(
      svc.submitCommitment({
        workflowId: WORKFLOW,
        leaves: [],
        courierAddress: COURIER,
        facilityAddress: FACILITY,
      }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('ProofCommitmentService.confirmCommitment', () => {
  it('AC1 — wrong facility address is rejected', async () => {
    const { svc } = makeService();
    const saved = await svc.submitCommitment({
      workflowId: WORKFLOW, leaves: BUNDLE_LEAVES,
      courierAddress: COURIER, facilityAddress: FACILITY,
    });

    // Courier tries to act as facility.
    await expect(
      svc.confirmCommitment({ commitmentId: saved.id, facilityAddress: COURIER }),
    ).rejects.toThrow(BadRequestException);
  });

  it('AC1 — random address cannot confirm', async () => {
    const { svc } = makeService();
    const saved = await svc.submitCommitment({
      workflowId: WORKFLOW, leaves: BUNDLE_LEAVES,
      courierAddress: COURIER, facilityAddress: FACILITY,
    });

    await expect(
      svc.confirmCommitment({ commitmentId: saved.id, facilityAddress: 'GROGUE' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('AC1 — correct facility confirms successfully', async () => {
    const { svc } = makeService();
    const saved = await svc.submitCommitment({
      workflowId: WORKFLOW, leaves: BUNDLE_LEAVES,
      courierAddress: COURIER, facilityAddress: FACILITY,
    });
    const confirmed = await svc.confirmCommitment({
      commitmentId: saved.id, facilityAddress: FACILITY,
    });
    expect(confirmed.status).toBe(ProofCommitmentStatus.CONFIRMED);
    expect(confirmed.confirmedAt).toBeTruthy();
  });

  it('already-confirmed commitment rejects double-confirm', async () => {
    const { svc } = makeService();
    const saved = await svc.submitCommitment({
      workflowId: WORKFLOW, leaves: BUNDLE_LEAVES,
      courierAddress: COURIER, facilityAddress: FACILITY,
    });
    await svc.confirmCommitment({ commitmentId: saved.id, facilityAddress: FACILITY });
    await expect(
      svc.confirmCommitment({ commitmentId: saved.id, facilityAddress: FACILITY }),
    ).rejects.toThrow(BadRequestException);
  });

  it('expired facility window is rejected', async () => {
    const { svc, commitRepo } = makeService();
    const saved = await svc.submitCommitment({
      workflowId: WORKFLOW, leaves: BUNDLE_LEAVES,
      courierAddress: COURIER, facilityAddress: FACILITY,
    });

    // Move facilityDeadline into the past.
    const row = commitRepo._store.find((r: any) => r.id === saved.id)!;
    row.facilityDeadline = new Date(Date.now() - 1_000);

    await expect(
      svc.confirmCommitment({ commitmentId: saved.id, facilityAddress: FACILITY }),
    ).rejects.toThrow(BadRequestException);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ProofCommitmentService.verifyInclusion
// ═══════════════════════════════════════════════════════════════════════════

describe('ProofCommitmentService.verifyInclusion', () => {
  async function setup() {
    const { svc } = makeService();
    const saved = await svc.submitCommitment({
      workflowId: WORKFLOW, leaves: BUNDLE_LEAVES,
      courierAddress: COURIER, facilityAddress: FACILITY,
    });
    await svc.confirmCommitment({ commitmentId: saved.id, facilityAddress: FACILITY });
    return { svc, commitmentId: saved.id };
  }

  it('AC2 — correct leaf + valid sibling proof → included: true', async () => {
    const { svc, commitmentId } = await setup();
    const tree = svc.buildMerkleTree(BUNDLE_LEAVES);
    // Verify each leaf individually.
    for (let i = 0; i < BUNDLE_LEAVES.length; i++) {
      const leafHash    = tree.leaves[i];
      const siblingPath = tree.proofs.get(i)!;
      const result = await svc.verifyInclusion({
        commitmentId, leafHash, siblingProof: siblingPath,
      });
      expect(result.included).toBe(true);
      expect(result.computedRoot).toBe(result.storedRoot);
    }
  });

  it('AC2 — tampered leaf hash → included: false', async () => {
    const { svc, commitmentId } = await setup();
    const tree = svc.buildMerkleTree(BUNDLE_LEAVES);
    const tampered   = sha256('TAMPERED DOCUMENT BYTES');
    const siblingPath = tree.proofs.get(0)!;
    const result = await svc.verifyInclusion({
      commitmentId, leafHash: tampered, siblingProof: siblingPath,
    });
    expect(result.included).toBe(false);
    expect(result.computedRoot).not.toBe(result.storedRoot);
  });

  it('AC2 — tampered sibling in proof path → included: false', async () => {
    const { svc, commitmentId } = await setup();
    const tree = svc.buildMerkleTree(BUNDLE_LEAVES);
    const leafHash       = tree.leaves[0];
    const corruptedProof = tree.proofs.get(0)!.map((s, i) =>
      i === 0 ? sha256('evil sibling') : s,
    );
    const result = await svc.verifyInclusion({
      commitmentId, leafHash, siblingProof: corruptedProof,
    });
    expect(result.included).toBe(false);
  });

  it('unknown commitmentId → NotFoundException', async () => {
    const { svc } = await setup();
    await expect(
      svc.verifyInclusion({ commitmentId: 'nonexistent-id', leafHash: sha256('x'), siblingProof: [] }),
    ).rejects.toThrow(NotFoundException);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ProofCommitmentService.supersedeCommitment — amendment discipline
// ═══════════════════════════════════════════════════════════════════════════

describe('ProofCommitmentService.supersedeCommitment', () => {
  const NEW_LEAVES: MerkleLeafDto[] = [
    { label: 'courier_attestation', hash: sha256('corrected courier data') },
    { label: 'facility_signature',  hash: sha256('corrected facility sig') },
    { label: 'temperature_summary', hash: sha256('corrected temp log') },
  ];

  async function confirmedCommitment() {
    const { svc, commitRepo } = makeService();
    const saved = await svc.submitCommitment({
      workflowId: WORKFLOW, leaves: BUNDLE_LEAVES,
      courierAddress: COURIER, facilityAddress: FACILITY,
    });
    await svc.confirmCommitment({ commitmentId: saved.id, facilityAddress: FACILITY });
    return { svc, commitRepo, commitmentId: saved.id };
  }

  it('old commitment transitions to SUPERSEDED, new is PENDING_FACILITY', async () => {
    const { svc, commitmentId } = await confirmedCommitment();
    const { superseded, replacement } = await svc.supersedeCommitment({
      commitmentId, newLeaves: NEW_LEAVES,
      reason: 'temperature_correction', arbiterAddress: 'GADMIN',
    });

    expect(superseded.status).toBe(ProofCommitmentStatus.SUPERSEDED);
    expect(superseded.supersededById).toBe(replacement.id);
    expect(superseded.supersedeReason).toBe('temperature_correction');
    expect(superseded.arbiterAddress).toBe('GADMIN');

    expect(replacement.status).toBe(ProofCommitmentStatus.PENDING_FACILITY);
    const newTree = svc.buildMerkleTree(NEW_LEAVES);
    expect(replacement.bundleHash).toBe(newTree.root);
  });

  it('old record is NOT deleted — still queryable', async () => {
    const { svc, commitmentId } = await confirmedCommitment();
    await svc.supersedeCommitment({
      commitmentId, newLeaves: NEW_LEAVES,
      reason: 'correction', arbiterAddress: 'GADMIN',
    });
    // Original commitment must still be fetchable.
    const old = await svc.getCommitment(commitmentId);
    expect(old).toBeTruthy();
    expect(old.status).toBe(ProofCommitmentStatus.SUPERSEDED);
  });

  it('non-CONFIRMED commitment cannot be superseded', async () => {
    const { svc } = makeService();
    const saved = await svc.submitCommitment({
      workflowId: WORKFLOW, leaves: BUNDLE_LEAVES,
      courierAddress: COURIER, facilityAddress: FACILITY,
    });
    // Still PENDING_FACILITY — supersede must fail.
    await expect(
      svc.supersedeCommitment({
        commitmentId: saved.id, newLeaves: NEW_LEAVES,
        reason: 'attempt', arbiterAddress: 'GADMIN',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('new bundle hash differs from old bundle hash', async () => {
    const { svc, commitmentId } = await confirmedCommitment();
    const oldCommitment = await svc.getCommitment(commitmentId);
    const { replacement } = await svc.supersedeCommitment({
      commitmentId, newLeaves: NEW_LEAVES,
      reason: 'correction', arbiterAddress: 'GADMIN',
    });
    expect(replacement.bundleHash).not.toBe(oldCommitment.bundleHash);
  });

  it('workflow history contains both old and new commitment IDs', async () => {
    const { svc, commitmentId } = await confirmedCommitment();
    const { replacement } = await svc.supersedeCommitment({
      commitmentId, newLeaves: NEW_LEAVES,
      reason: 'correction', arbiterAddress: 'GADMIN',
    });
    const history = await svc.getWorkflowHistory(WORKFLOW);
    const ids = history.map((c) => c.id);
    expect(ids).toContain(commitmentId);
    expect(ids).toContain(replacement.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ProofCommitmentService — hash-linked custody chain
// ═══════════════════════════════════════════════════════════════════════════

describe('ProofCommitmentService.appendCustodyLink', () => {
  const BANK   = 'GBLOODBANK';
  const RIDER  = 'GRIDER';

  it('AC3 — 3-link chain appends correctly and verifies intact', async () => {
    const { svc } = makeService();

    // Link 0: BANK → COURIER (genesis)
    const link0 = await svc.appendCustodyLink({
      workflowId: WORKFLOW, fromActor: BANK, toActor: COURIER, prevLinkHash: ZERO_HASH,
    });
    expect(link0.linkIndex).toBe(0);
    expect(link0.prevLinkHash).toBe(ZERO_HASH);

    // Link 1: COURIER → RIDER
    const link1 = await svc.appendCustodyLink({
      workflowId: WORKFLOW, fromActor: COURIER, toActor: RIDER, prevLinkHash: link0.linkHash,
    });
    expect(link1.linkIndex).toBe(1);
    expect(link1.prevLinkHash).toBe(link0.linkHash);

    // Link 2: RIDER → FACILITY
    const link2 = await svc.appendCustodyLink({
      workflowId: WORKFLOW, fromActor: RIDER, toActor: FACILITY, prevLinkHash: link1.linkHash,
    });
    expect(link2.linkIndex).toBe(2);

    // Verify chain integrity
    const result = await svc.verifyCustodyChain(WORKFLOW);
    expect(result.intact).toBe(true);
    expect(result.linkCount).toBe(3);
    expect(result.firstBreakAt).toBeNull();
  });

  it('AC3 — genesis link must have ZERO_HASH as prevLinkHash', async () => {
    const { svc } = makeService();
    const non_zero = sha256('not zero');
    await expect(
      svc.appendCustodyLink({
        workflowId: WORKFLOW, fromActor: COURIER, toActor: FACILITY, prevLinkHash: non_zero,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('AC3 — wrong prevLinkHash breaks the chain (rejected)', async () => {
    const { svc } = makeService();
    await svc.appendCustodyLink({
      workflowId: WORKFLOW, fromActor: BANK, toActor: COURIER, prevLinkHash: ZERO_HASH,
    });
    const wrong = sha256('wrong hash');
    await expect(
      svc.appendCustodyLink({
        workflowId: WORKFLOW, fromActor: COURIER, toActor: FACILITY, prevLinkHash: wrong,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('AC3 — empty chain verifies as intact', async () => {
    const { svc } = makeService();
    const result = await svc.verifyCustodyChain('non-existent-workflow');
    expect(result.intact).toBe(true);
    expect(result.linkCount).toBe(0);
  });
});

describe('ProofCommitmentService.verifyCustodyChain — tampered stored data', () => {
  it('AC3 — tampered linkHash in DB is detected', async () => {
    const { svc, chainRepo } = makeService();

    const link0 = await svc.appendCustodyLink({
      workflowId: WORKFLOW, fromActor: 'GBANK', toActor: COURIER, prevLinkHash: ZERO_HASH,
    });
    await svc.appendCustodyLink({
      workflowId: WORKFLOW, fromActor: COURIER, toActor: FACILITY, prevLinkHash: link0.linkHash,
    });

    // Silently corrupt the first stored link's linkHash (simulates DB tamper).
    const row = chainRepo._store.find(
      (r: any) => r.workflowId === WORKFLOW && r.linkIndex === 0,
    )!;
    row.linkHash = sha256('tampered link hash');

    const result = await svc.verifyCustodyChain(WORKFLOW);
    expect(result.intact).toBe(false);
    expect(result.firstBreakAt).toBe(0);
  });

  it('AC3 — tampered prevLinkHash on link 1 is detected', async () => {
    const { svc, chainRepo } = makeService();

    const link0 = await svc.appendCustodyLink({
      workflowId: WORKFLOW, fromActor: 'GBANK', toActor: COURIER, prevLinkHash: ZERO_HASH,
    });
    await svc.appendCustodyLink({
      workflowId: WORKFLOW, fromActor: COURIER, toActor: FACILITY, prevLinkHash: link0.linkHash,
    });

    // Corrupt the prevLinkHash of link 1 to simulate a gap insertion attack.
    const row = chainRepo._store.find(
      (r: any) => r.workflowId === WORKFLOW && r.linkIndex === 1,
    )!;
    row.prevLinkHash = sha256('injected gap');

    const result = await svc.verifyCustodyChain(WORKFLOW);
    expect(result.intact).toBe(false);
    // Break is at index 1 (prevLinkHash mismatch OR re-derived hash mismatch).
    expect(result.firstBreakAt).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// computeLinkHash — cross-implementation consistency
// ═══════════════════════════════════════════════════════════════════════════

describe('computeLinkHash consistency', () => {
  it('service and MerkleVerifier produce identical link hashes', () => {
    const { svc } = makeService();
    const verifier = new MerkleVerifier({ apiBaseUrl: 'http://localhost:3000' });

    const now = new Date('2025-01-01T12:00:00Z');
    const svcHash = svc.computeLinkHash(0, WORKFLOW, ZERO_HASH, COURIER, FACILITY, now);
    const cliHash = verifier.computeLinkHash(0, WORKFLOW, ZERO_HASH, COURIER, FACILITY, now);

    expect(svcHash).toBe(cliHash);
  });

  it('different index → different hash', () => {
    const { svc } = makeService();
    const now = new Date();
    const h0 = svc.computeLinkHash(0, WORKFLOW, ZERO_HASH, COURIER, FACILITY, now);
    const h1 = svc.computeLinkHash(1, WORKFLOW, ZERO_HASH, COURIER, FACILITY, now);
    expect(h0).not.toBe(h1);
  });

  it('different workflowId → different hash', () => {
    const { svc } = makeService();
    const now = new Date();
    const h0 = svc.computeLinkHash(0, 'workflow-A', ZERO_HASH, COURIER, FACILITY, now);
    const h1 = svc.computeLinkHash(0, 'workflow-B', ZERO_HASH, COURIER, FACILITY, now);
    expect(h0).not.toBe(h1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MerkleVerifier.verifyCustodyChain — offline (pure, no HTTP)
// Tests the re-derive-from-stored-inputs path.
// ═══════════════════════════════════════════════════════════════════════════

describe('MerkleVerifier.verifyCustodyChain (offline re-derive)', () => {
  const verifier = new MerkleVerifier({ apiBaseUrl: 'http://localhost:3000' });

  function buildChainData() {
    const now = new Date('2025-06-01T10:00:00Z');
    const links: any[] = [];
    const zeroPrev = ZERO_HASH;

    // Build 3 links purely in memory to test the re-derive logic.
    let prevHash = zeroPrev;
    const actors = [
      { from: 'GBANK', to: COURIER },
      { from: COURIER, to: 'GRIDER' },
      { from: 'GRIDER', to: FACILITY },
    ];
    for (let i = 0; i < actors.length; i++) {
      const handoffAt = new Date(now.getTime() + i * 60_000);
      const linkHash = verifier.computeLinkHash(
        i, WORKFLOW, prevHash, actors[i].from, actors[i].to, handoffAt,
      );
      links.push({
        linkIndex: i,
        workflowId: WORKFLOW,
        prevLinkHash: prevHash,
        linkHash,
        fromActor: actors[i].from,
        toActor: actors[i].to,
        handoffAt: handoffAt.toISOString(),
      });
      prevHash = linkHash;
    }
    return links;
  }

  it('intact 3-link chain passes re-derive check', async () => {
    // Monkey-patch fetchCustodyChain to return our in-memory data.
    const links = buildChainData();
    (verifier as any).fetchCustodyChain = async () => links;

    const result = await verifier.verifyCustodyChain(WORKFLOW);
    expect(result.intact).toBe(true);
    expect(result.linkCount).toBe(3);
    expect(result.firstBreakAt).toBeNull();
    expect(result.links.every((l) => l.hashValid && l.chainValid)).toBe(true);
  });

  it('tampered linkHash at index 1 is detected', async () => {
    const links = buildChainData();
    links[1].linkHash = sha256('tampered');
    (verifier as any).fetchCustodyChain = async () => links;

    const result = await verifier.verifyCustodyChain(WORKFLOW);
    expect(result.intact).toBe(false);
    expect(result.firstBreakAt).not.toBeNull();
  });

  it('broken prevLinkHash at index 2 is detected', async () => {
    const links = buildChainData();
    links[2].prevLinkHash = sha256('gap injected');
    (verifier as any).fetchCustodyChain = async () => links;

    const result = await verifier.verifyCustodyChain(WORKFLOW);
    expect(result.intact).toBe(false);
  });
});
