# Architecture Decision Records

Short documents capturing a significant architectural choice, the context that
forced it, and its consequences. Format: **Context → Decision → Consequences**,
with a status of `Proposed`, `Accepted`, `Superseded by ADR-XXXX`, or
`Deprecated`.

> The repository's `.gitignore` ignores non-`README.md` markdown, so — until a
> second ADR lands — records live as sections of this file. When ADR-0002 is
> written, split each ADR into `docs/adr/NNNN-slug/README.md` and leave this file
> as the index.

| ADR | Title | Status |
|-----|-------|--------|
| [0001](#adr-0001--canonical-soroban-contract-stack) | Canonical Soroban contract stack: modular `lifebank-soroban` workspace | Accepted (2026-08-30) |

---

# ADR-0001 — Canonical Soroban contract stack

- **Status:** Accepted
- **Date:** 2026-08-30
- **Deciders:** Smart-contracts working group
- **Issue:** [#44](https://github.com/Lifefllow-chain/Fow/issues/44)
- **Supersedes:** —

## Context

The repository has carried **two divergent Soroban contract stacks**:

| | Monolith | Modular workspace |
|---|---|---|
| Path | `contracts/` (now `legacy/contracts/`) | `lifebank-soroban/` |
| Crate(s) | `healthchain` — single `cdylib` | 10 contracts + `interfaces` crate |
| `lib.rs` size | ~7,345 lines | per-contract, largest ~1k lines |
| `soroban-sdk` | **22.0.0** | **23.5.0** |
| WASM target | `wasm32-unknown-unknown` | `wasm32v1-none` |
| CI | none | `.github/workflows/deploy-verify.yml` (tests, reproducible build, hash verification, upgrade rehearsal) |
| Upgradeability | none | in-place `upgrade()` on all contracts, 48h timelock on funds-holders |
| Deploy tooling | none | `deploy.sh`, per-network lockfiles under `deployments/` |

The two stacks overlap functionally (both model payments; the monolith's
registry vs. the workspace's `inventory` + `requests`) but differ in SDK major
version, generated types, storage layout, and event shapes. Consequences:

- Every issue filed "against the contracts" (#31–#43) had two possible targets.
- The backend indexer decoded events from **both** shapes.
- No document declared which stack was canonical, so contributions landed on
  either one.

This is an architectural fork that had to be closed before #31–#43 could be
executed cleanly.

## Decision

**The modular `lifebank-soroban` workspace (soroban-sdk 23) is the single
canonical contract stack.** The `healthchain` monolith is **deprecated** and has
been moved to `legacy/contracts/` (see *Consequences*).

### Rationale

1. **Smaller audit surface.** Ten ~200–1,000-line contracts are each auditable in
   isolation; a 7,345-line `lib.rs` is not.
2. **Bounded upgrade blast radius.** The workspace upgrades contracts
   individually (`upgrade()` / timelocked `propose_upgrade` on funds-holders — see
   `lifebank-soroban/docs/upgrades/`). A monolith upgrade re-deploys every
   feature at once.
3. **Current SDK.** soroban-sdk 23 is the supported line; the monolith is pinned
   to 22 and further pinned to `ed25519-dalek =2.2.0` / `curve25519-dalek =4.1.3`
   to keep `cargo test` compiling at all.
4. **Operational tooling already exists** only for the workspace: reproducible
   builds, per-network deployment lockfiles, WASM-hash verification in CI, and an
   upgrade-rehearsal job.
5. **Explicit contract boundaries.** The `interfaces` crate + coordinator give a
   documented cross-contract event and call surface; the monolith's boundaries
   were implicit.

### Monolith disposition

| Monolith area | Disposition |
|---|---|
| `payments.rs` (escrow, multisig, disputes, fees) | **Port** — reconcile against `lifebank-soroban/contracts/payments`; port missing variants (multisig approval matrix, high-value threshold, fee arithmetic edges). |
| Registry read/write model (`registry_read.rs` / `registry_write.rs`) | **Port** — map onto `inventory` (units, status lifecycle) + `requests` (request lifecycle). Preserve the read/write module split as a workspace convention. |
| `storage_lifecycle.rs` (TTL tiers, rent, archival restore) | **Port** — feeds #33; becomes shared storage-tier guidance + per-contract bump logic on sdk 23 TTL APIs. |
| `test_protocol_invariants.rs` | **Port** as workspace property tests (feeds #40). Per-test tracking in the migration doc. |
| `test_storage_layout.rs` | **Port** alongside `storage_lifecycle` work; some assertions retire because sdk-23 storage keys differ (tracked). |
| `fuzz/fuzz_custody_transfer.rs` | **Port** once a workspace chain-of-custody contract exists (currently a gap). |
| `fuzz/fuzz_target_1.rs` | **Retire** — empty stub (`fuzz_target!(|data: &[u8]| {})`), no coverage value. |
| `proof_delivery.rs` | **Port** — overlaps the delivery proof / compliance-attestation surface in `lifebank-soroban/contracts/delivery`. |
| Cold-chain custody trail (`transfer_custody`, custody events) | **Port** — no workspace equivalent yet; nearest domain is `temperature` (telemetry) + `delivery` (handoff). Backend boundary map flags this as `portPending`. |

Full capability inventory, SDK 22→23 semantics review, and per-test port
tracking: [`lifebank-soroban/docs/migration/`](../../lifebank-soroban/docs/migration/).

## Live-state attestation

> As of 2026-08-30, **no instance of the `healthchain` monolith has ever been
> deployed to any network** — local, testnet, or mainnet. The repository contains
> no deployment record, contract ID, or ledger snapshot for it, and it has no
> deploy script. The workspace's own deployment lockfiles
> (`lifebank-soroban/deployments/{local,testnet,mainnet}.json`) all carry
> `"deployed_at": null`.
>
> Therefore **no data migration, state export, freeze plan, or indexer cutover is
> required** for the monolith's retirement. If this changes before the ports land,
> this ADR must be amended with a migration plan (freeze via #37, event/ledger
> export, replay into workspace contracts, backend contract-ID + event-schema
> cutover) *before* any such deployment.
>
> — Smart-contracts working group

## Consequences

### Repository

- `contracts/` → **`legacy/contracts/`**. The crate stays compilable and its
  tests runnable (`cd legacy/contracts && cargo test`) so ported behaviour can be
  checked against the original. See `legacy/README.md`.
- **Final active commit** of the monolith on `refactor` before archival:
  `0d7a4b7657e276dde8f3b29442b91624672569c4`.
- No new features land in `legacy/`. Bug-fixes only if needed to keep the
  reference tests green during the port.

### CI / scripts

- CI is already single-stack: `deploy-verify.yml` only triggers on
  `lifebank-soroban/**`. A header comment now records that the monolith is
  deliberately excluded.
- `lifebank-soroban/scripts/{build-all,deploy-testnet,deploy}.sh` already target
  only the workspace. No monolith build/deploy script exists to remove.

### Backend

- `backend/src/blockchain/contracts/lifebank-contracts.ts` previously listed
  `custody.sourceOfTruth = 'contracts/src/lib.rs'`. It now points at the
  workspace `temperature` contract, exposes the still-monolith `transfer_custody`
  under `unportedMethods`, and carries `portPending: true` until the
  chain-of-custody port lands. The backend references exactly one stack.
- The contract-indexer schema registry (#85/#99) continues to accept both event
  shapes only for as long as the ports are in flight; a follow-up removes the
  monolith shapes once the migration doc is fully checked off.

### Tracking alignment for #31–#43

All open contract issues target the **`lifebank-soroban` workspace**. Any wording
implying `contracts/src/lib.rs` should be read as its workspace equivalent per
the disposition table above.

| Issue | Canonical target |
|---|---|
| #31 in-place upgradeability | `lifebank-soroban` — implemented, see `docs/upgrades/` |
| #32 event catalog / envelope | `lifebank-soroban/contracts/interfaces` |
| #33 storage lifecycle & TTL | port `storage_lifecycle.rs` → per-contract on sdk-23 TTL API |
| #34–#39 (protocol / ops) | `lifebank-soroban` workspace contracts |
| #37 pause / freeze | `lifebank-soroban/contracts/coordinator` pause flags |
| #40 property / invariant tests | port `test_protocol_invariants.rs` → workspace property tests |
| #41–#43 | `lifebank-soroban` workspace |

(#31, #37 already exist in the workspace; the rest are annotated on the issues
themselves referencing this ADR.)

## Acceptance criteria (issue #44)

- One canonical stack, recorded in this ADR; the other archived under `legacy/`
  with its tests kept runnable. **Done.**
- Every monolith-only invariant test and fuzz target has a recorded port target
  or retirement reason — see the migration doc. **Done.**
- Backend contract references and deploy scripts point at exactly one stack
  (`lifebank-soroban`). **Done.**
- SDK 22→23 migration notes for ported code — see the migration doc. **Done.**
- Live-state audit — no-live-state attestation above. **Done.**
