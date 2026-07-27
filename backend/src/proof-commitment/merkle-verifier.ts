#!/usr/bin/env ts-node
/**
 * @file merkle-verifier.ts
 *
 * Off-chain verifier library and CLI used by:
 *   - The backend `proof-commitment` module (imported as a library)
 *   - The frontend transparency page (#11)
 *   - Partner organisations performing independent "don't trust, verify" checks
 *
 * ## What it does
 *  1. Accepts a proof bundle (list of { label, hash } leaves).
 *  2. Re-builds the binary Merkle tree using the same algorithm as the
 *     ProofCommitmentService (leaf-domain prefix + lex-ordered pair hash).
 *  3. Fetches the on-chain `bundle_hash` from the HealthChain contract via the
 *     backend REST API (or directly from a Soroban RPC node when `--rpc` is used).
 *  4. Compares the locally-computed root against the chain-anchored root.
 *  5. Optionally verifies the hash-linked custody chain for the same workflow.
 *
 * ## CLI usage
 *  ```
 *  # Verify a specific document is in a bundle
 *  ts-node merkle-verifier.ts \
 *    --api http://localhost:3000 \
 *    --commitment <uuid> \
 *    --bundle courier_attestation:aabbcc...,facility_signature:ddeeff... \
 *    --leaf courier_attestation
 *
 *  # Full chain + bundle verification
 *  ts-node merkle-verifier.ts \
 *    --api http://localhost:3000 \
 *    --commitment <uuid> \
 *    --bundle <same> \
 *    --verify-chain
 *  ```
 *
 * ## Library usage
 *  ```ts
 *  import { MerkleVerifier } from './merkle-verifier';
 *
 *  const verifier = new MerkleVerifier({ apiBaseUrl: 'http://localhost:3000' });
 *  const result = await verifier.verifyBundle(commitmentId, leaves);
 *  console.log(result.intact); // true / false
 *  ```
 */

import * as crypto from 'crypto';
import * as https from 'https';
import * as http from 'http';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BundleLeaf {
  /** Human-readable label identifying this document in the bundle. */
  label: string;
  /**
   * SHA-256 hex digest of the document bytes as stored off-chain.
   * Must be exactly 64 hex characters.
   */
  hash: string;
}

export interface MerkleProof {
  /** The leaf hash that was verified. */
  leafHash: string;
  /** Sibling proof path from leaf to root. */
  siblingPath: string[];
  /** Locally-computed Merkle root. */
  computedRoot: string;
}

export interface BundleVerifyResult {
  /** Whether the locally-computed root matches the chain-anchored root. */
  intact: boolean;
  /** Locally-computed Merkle root. */
  computedRoot: string;
  /** Root stored in the ProofCommitment on-chain / backend. */
  chainRoot: string;
  /** Leaf-level verification results. */
  leaves: LeafVerifyResult[];
  /** Backend commitment status (e.g. "confirmed"). */
  commitmentStatus: string;
  /** ISO timestamp of verification. */
  verifiedAt: string;
}

export interface LeafVerifyResult {
  label: string;
  /** Leaf hash as supplied. */
  inputHash: string;
  /** Leaf hash after applying domain prefix. */
  leafHash: string;
  /** Sibling proof path for this leaf. */
  siblingPath: string[];
  /** Whether this leaf is provably included in the root. */
  included: boolean;
}

export interface CustodyChainVerifyResult {
  intact: boolean;
  linkCount: number;
  /** Index of the first broken link, or null when chain is valid. */
  firstBreakAt: number | null;
  links: CustodyLinkSummary[];
  verifiedAt: string;
}

export interface CustodyLinkSummary {
  index: number;
  fromActor: string;
  toActor: string;
  linkHash: string;
  prevLinkHash: string;
  /** Whether this link's hash could be re-derived and matches. */
  hashValid: boolean;
  /** Whether the prevLinkHash matches the previous entry. */
  chainValid: boolean;
}

export interface VerifierOptions {
  /** Base URL of the backend API, e.g. "http://localhost:3000". */
  apiBaseUrl: string;
  /** Optional Bearer token for authenticated endpoints. */
  bearerToken?: string;
  /** Request timeout in milliseconds (default: 10 000). */
  timeoutMs?: number;
}

// ── MerkleVerifier class ─────────────────────────────────────────────────────

/**
 * Stateless off-chain verifier.
 *
 * All cryptographic operations are pure functions — no state is mutated.
 * The only I/O is fetching the chain-anchored root from the backend API.
 */
export class MerkleVerifier {
  private readonly apiBaseUrl: string;
  private readonly bearerToken: string | undefined;
  private readonly timeoutMs: number;

  constructor(options: VerifierOptions) {
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/$/, '');
    this.bearerToken = options.bearerToken;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  // ── Top-level verifiers ────────────────────────────────────────────────────

  /**
   * Full bundle verification:
   *  1. Fetch the commitment record from the backend API.
   *  2. Re-compute the Merkle root from `leaves`.
   *  3. Compare against the stored `bundleHash`.
   *  4. Compute per-leaf inclusion proofs.
   *
   * Does NOT require any special permissions — the `/verify-inclusion`
   * endpoint is permissionless.
   */
  async verifyBundle(
    commitmentId: string,
    leaves: BundleLeaf[],
  ): Promise<BundleVerifyResult> {
    if (leaves.length === 0) {
      throw new Error('At least one leaf is required to verify a bundle');
    }

    const commitment = await this.fetchCommitment(commitmentId);
    const chainRoot: string = commitment.bundleHash;
    const commitmentStatus: string = commitment.status;

    const { root, leafHashes, proofPaths } = this.buildTree(leaves);
    const intact = root === chainRoot;

    const leafResults: LeafVerifyResult[] = leaves.map((leaf, i) => {
      const leafHash = leafHashes[i];
      const siblingPath = proofPaths[i];
      const computedRoot = this.computeRoot(leafHash, siblingPath);
      return {
        label: leaf.label,
        inputHash: leaf.hash,
        leafHash,
        siblingPath,
        included: computedRoot === chainRoot,
      };
    });

    return {
      intact,
      computedRoot: root,
      chainRoot,
      leaves: leafResults,
      commitmentStatus,
      verifiedAt: new Date().toISOString(),
    };
  }

  /**
   * Single-leaf inclusion check against a known root.
   *
   * Use this when you already know the root (e.g. fetched independently)
   * and want to verify one specific document without loading the full bundle.
   */
  verifyLeafAgainstRoot(
    leaf: BundleLeaf,
    siblingPath: string[],
    expectedRoot: string,
  ): boolean {
    const leafHash = this.hashLeaf(leaf.label, leaf.hash);
    const computedRoot = this.computeRoot(leafHash, siblingPath);
    return computedRoot === expectedRoot;
  }

  /**
   * Verify the full custody chain for a workflow by fetching it from the
   * backend and re-deriving every link hash off-chain.
   */
  async verifyCustodyChain(workflowId: string): Promise<CustodyChainVerifyResult> {
    const links = await this.fetchCustodyChain(workflowId);
    const zeroPrevHash = '0'.repeat(64);

    const summaries: CustodyLinkSummary[] = [];
    let firstBreakAt: number | null = null;
    let intact = true;

    for (let i = 0; i < links.length; i++) {
      const link = links[i];

      const genesisValid = i > 0 || link.prevLinkHash === zeroPrevHash;
      const chainValid = i === 0
        ? genesisValid
        : link.prevLinkHash === links[i - 1].linkHash;

      // Re-derive link hash from stored inputs.
      const expectedHash = this.computeLinkHash(
        link.linkIndex,
        link.workflowId,
        link.prevLinkHash,
        link.fromActor,
        link.toActor,
        new Date(link.handoffAt),
      );
      const hashValid = link.linkHash === expectedHash;

      if ((!chainValid || !hashValid) && firstBreakAt === null) {
        firstBreakAt = i;
        intact = false;
      }

      summaries.push({
        index: link.linkIndex,
        fromActor: link.fromActor,
        toActor: link.toActor,
        linkHash: link.linkHash,
        prevLinkHash: link.prevLinkHash,
        hashValid,
        chainValid,
      });
    }

    return {
      intact,
      linkCount: links.length,
      firstBreakAt,
      links: summaries,
      verifiedAt: new Date().toISOString(),
    };
  }

  /**
   * Build a Merkle proof for a specific leaf by label within a bundle.
   * Returns the sibling path the recipient can submit to `verify-inclusion`.
   */
  buildProofForLeaf(leaves: BundleLeaf[], targetLabel: string): MerkleProof {
    const idx = leaves.findIndex((l) => l.label === targetLabel);
    if (idx === -1) {
      throw new Error(`Leaf with label '${targetLabel}' not found in bundle`);
    }
    const { root, leafHashes, proofPaths } = this.buildTree(leaves);
    return {
      leafHash: leafHashes[idx],
      siblingPath: proofPaths[idx],
      computedRoot: root,
    };
  }

  // ── Pure Merkle tree primitives ────────────────────────────────────────────

  /**
   * Build a complete binary Merkle tree.
   *
   * Leaf hash: SHA256("leaf:" ∥ label ∥ ":" ∥ hash)
   *   — domain prefix prevents second-preimage attacks
   *
   * Pair hash: SHA256(lex_min(a,b) ∥ lex_max(a,b))
   *   — position-independent, matches on-chain convention
   *
   * Odd-count levels: duplicate the last node.
   */
  buildTree(leaves: BundleLeaf[]): {
    root: string;
    leafHashes: string[];
    proofPaths: string[][];
  } {
    const leafHashes = leaves.map((l) => this.hashLeaf(l.label, l.hash));

    if (leafHashes.length === 1) {
      return { root: leafHashes[0], leafHashes, proofPaths: [[]] };
    }

    // Collect each level of the tree for proof construction.
    const levels: string[][] = [leafHashes];
    let current = leafHashes;

    while (current.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < current.length; i += 2) {
        const left = current[i];
        const right = current[i + 1] ?? left;
        next.push(this.hashPair(left, right));
      }
      levels.push(next);
      current = next;
    }

    const root = current[0];

    // Build sibling proof for each leaf.
    const proofPaths: string[][] = leafHashes.map((_, leafIdx) => {
      const path: string[] = [];
      let idx = leafIdx;
      for (let lvl = 0; lvl < levels.length - 1; lvl++) {
        const levelNodes = levels[lvl];
        const sibIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
        const sib = levelNodes[sibIdx] ?? levelNodes[idx];
        path.push(sib);
        idx = Math.floor(idx / 2);
      }
      return path;
    });

    return { root, leafHashes, proofPaths };
  }

  /**
   * Re-compute a Merkle root from a leaf hash and its sibling proof.
   * Exactly mirrors the service's `computeMerkleRoot` method.
   */
  computeRoot(leafHash: string, siblingPath: string[]): string {
    let current = leafHash;
    for (const sibling of siblingPath) {
      current = this.hashPair(current, sibling);
    }
    return current;
  }

  // ── Cryptographic helpers ─────────────────────────────────────────────────

  /**
   * Leaf hash: SHA256("leaf:" ∥ label ∥ ":" ∥ documentHash)
   * Domain prefix prevents second-preimage attacks where an internal
   * tree node could be mistaken for a leaf.
   */
  hashLeaf(label: string, documentHash: string): string {
    return crypto
      .createHash('sha256')
      .update(`leaf:${label}:${documentHash}`)
      .digest('hex');
  }

  /**
   * Pair hash: SHA256(lex_min(a,b) ∥ lex_max(a,b))
   * Lexicographic ordering makes the hash position-independent —
   * the same result regardless of which side (left/right) each node is on.
   * Matches the Soroban `bytes32_gt` convention.
   */
  hashPair(a: string, b: string): string {
    const [left, right] = a <= b ? [a, b] : [b, a];
    return crypto.createHash('sha256').update(left + right).digest('hex');
  }

  /**
   * Compute a deterministic custody link hash.
   * Mirrors `compute_link_hash` in the Soroban contract and
   * `computeLinkHash` in ProofCommitmentService — all three must stay
   * in sync.
   *
   * Input: index(4B BE) ∥ workflowId ∥ prevLinkHash ∥ fromActor ∥ toActor ∥ handoffAt(ms string)
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

  // ── HTTP helpers ──────────────────────────────────────────────────────────

  private async fetchCommitment(id: string): Promise<Record<string, any>> {
    const data = await this.httpGet(`/proof-commitments/${id}`);
    if (!data.bundleHash) {
      throw new Error(`Commitment '${id}' has no bundleHash (status: ${data.status ?? 'unknown'})`);
    }
    return data;
  }

  private async fetchCustodyChain(workflowId: string): Promise<any[]> {
    return this.httpGet(`/proof-commitments/custody-links/${encodeURIComponent(workflowId)}`);
  }

  private httpGet(path: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const url = `${this.apiBaseUrl}${path}`;
      const isHttps = url.startsWith('https://');
      const lib = isHttps ? https : http;

      const headers: Record<string, string> = { Accept: 'application/json' };
      if (this.bearerToken) {
        headers['Authorization'] = `Bearer ${this.bearerToken}`;
      }

      const req = lib.get(url, { headers }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if ((res.statusCode ?? 0) >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${parsed.message ?? body}`));
            } else {
              resolve(parsed);
            }
          } catch {
            reject(new Error(`Failed to parse response from ${url}: ${body}`));
          }
        });
      });

      req.setTimeout(this.timeoutMs, () => {
        req.destroy();
        reject(new Error(`Request timed out after ${this.timeoutMs}ms: ${url}`));
      });

      req.on('error', reject);
    });
  }
}

// ── Standalone CLI entry-point ─────────────────────────────────────────────────
// Only runs when executed directly: `ts-node merkle-verifier.ts ...`

/* istanbul ignore next */
async function cli(): Promise<void> {
  const args = process.argv.slice(2);

  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };
  const has = (flag: string): boolean => args.includes(flag);

  const apiBaseUrl = get('--api') ?? 'http://localhost:3000';
  const commitmentId = get('--commitment');
  const bundleArg = get('--bundle');
  const leafLabel = get('--leaf');
  const verifyChain = has('--verify-chain');
  const workflowId = get('--workflow');
  const bearerToken = get('--token');

  if (!commitmentId && !verifyChain) {
    process.stderr.write(
      `Usage:
  ts-node merkle-verifier.ts \\
    --api <backend_url>          # default: http://localhost:3000
    --commitment <uuid>          # ProofCommitment ID
    --bundle <label:hash,...>    # comma-separated leaf definitions
    [--leaf <label>]             # verify one specific document
    [--verify-chain]             # also verify the custody chain
    [--workflow <workflowId>]    # required with --verify-chain alone
    [--token <bearer>]           # optional auth token

Examples:
  # Verify full bundle
  ts-node merkle-verifier.ts --api http://localhost:3000 --commitment abc-123 \\
    --bundle courier_attestation:aabb...,facility_signature:ccdd...

  # Check one document is in the bundle
  ts-node merkle-verifier.ts --api http://localhost:3000 --commitment abc-123 \\
    --bundle courier_attestation:aabb...,facility_signature:ccdd... \\
    --leaf courier_attestation

  # Verify custody chain only
  ts-node merkle-verifier.ts --api http://localhost:3000 \\
    --verify-chain --workflow wf-001
`,
    );
    process.exit(1);
  }

  const verifier = new MerkleVerifier({ apiBaseUrl, bearerToken });

  // Parse --bundle
  const leaves: BundleLeaf[] = bundleArg
    ? bundleArg.split(',').map((entry) => {
        const colon = entry.indexOf(':');
        if (colon === -1) throw new Error(`Invalid bundle entry (expected label:hash): ${entry}`);
        return { label: entry.slice(0, colon), hash: entry.slice(colon + 1) };
      })
    : [];

  try {
    // ── Bundle verification ─────────────────────────────────────────────
    if (commitmentId && leaves.length > 0) {
      const result = await verifier.verifyBundle(commitmentId, leaves);

      process.stdout.write('\n=== Bundle Verification ===\n');
      process.stdout.write(`Commitment:     ${commitmentId}\n`);
      process.stdout.write(`Status:         ${result.commitmentStatus}\n`);
      process.stdout.write(`Chain root:     ${result.chainRoot}\n`);
      process.stdout.write(`Computed root:  ${result.computedRoot}\n`);
      process.stdout.write(`Intact:         ${result.intact ? '✓ YES' : '✗ NO'}\n`);
      process.stdout.write(`Verified at:    ${result.verifiedAt}\n\n`);

      if (leafLabel) {
        const found = result.leaves.find((l) => l.label === leafLabel);
        if (!found) {
          process.stderr.write(`Leaf '${leafLabel}' not found in provided bundle.\n`);
          process.exit(2);
        }
        process.stdout.write(`=== Leaf Inclusion: "${leafLabel}" ===\n`);
        process.stdout.write(`Input hash:   ${found.inputHash}\n`);
        process.stdout.write(`Leaf hash:    ${found.leafHash}\n`);
        process.stdout.write(`Included:     ${found.included ? '✓ YES' : '✗ NO'}\n\n`);
      } else {
        process.stdout.write('=== Per-leaf Results ===\n');
        for (const leaf of result.leaves) {
          process.stdout.write(
            `  ${leaf.included ? '✓' : '✗'}  ${leaf.label.padEnd(32)} ${leaf.leafHash}\n`,
          );
        }
        process.stdout.write('\n');
      }

      if (!result.intact) process.exit(1);
    }

    // ── Custody chain verification ──────────────────────────────────────
    if (verifyChain) {
      const wfId = workflowId ?? (commitmentId ? commitmentId : undefined);
      if (!wfId) {
        process.stderr.write('--workflow or --commitment is required with --verify-chain\n');
        process.exit(1);
      }
      const chainResult = await verifier.verifyCustodyChain(wfId);

      process.stdout.write('=== Custody Chain Verification ===\n');
      process.stdout.write(`Workflow:       ${wfId}\n`);
      process.stdout.write(`Links:          ${chainResult.linkCount}\n`);
      process.stdout.write(`Intact:         ${chainResult.intact ? '✓ YES' : '✗ NO'}\n`);
      if (chainResult.firstBreakAt !== null) {
        process.stdout.write(`First break at: index ${chainResult.firstBreakAt}\n`);
      }
      process.stdout.write(`Verified at:    ${chainResult.verifiedAt}\n\n`);

      process.stdout.write('=== Link Details ===\n');
      for (const link of chainResult.links) {
        const status = link.hashValid && link.chainValid ? '✓' : '✗';
        process.stdout.write(
          `  ${status}  [${String(link.index).padStart(3)}] ${link.fromActor.slice(0, 10)}... → ${link.toActor.slice(0, 10)}...  hash=${link.linkHash.slice(0, 16)}...\n`,
        );
      }

      if (!chainResult.intact) process.exit(1);
    }
  } catch (err: any) {
    process.stderr.write(`\nError: ${err.message}\n`);
    process.exit(1);
  }
}

// Only execute CLI when run directly.
if (require.main === module) {
  cli();
}
