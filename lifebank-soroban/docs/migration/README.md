# Monolith → workspace migration

Working reference for retiring the `healthchain` monolith (`legacy/contracts/`)
in favour of this workspace, per
[ADR-0001](../../../docs/adr/README.md#adr-0001--canonical-soroban-contract-stack).

Source under review: `legacy/contracts/` @ commit
`0d7a4b7657e276dde8f3b29442b91624672569c4`.

This document is deleted once every row in
[§3 Test & fuzz port tracking](#3-test--fuzz-port-tracking) is `Done` or
`Retired` and the backend indexer drops the monolith event shapes.

Contents:

1. [Capability gap analysis & port list](#1-capability-gap-analysis--port-list)
2. [soroban-sdk 22 → 23 migration notes](#2-soroban-sdk-22--23-migration-notes)
3. [Test & fuzz port tracking](#3-test--fuzz-port-tracking)

---

## 1. Capability gap analysis & port list

"Port" = behaviour must be reproduced; "Have" = workspace already covers it;
"Retire" = intentionally dropped, reason recorded.

### 1.1 Organisation registry & lifecycle

Monolith: `register_blood_bank`, `register_hospital`, `register_organization`,
`activate_/deactivate_blood_bank`, `activate_/deactivate_hospital`,
`verify_/unverify_organization`, `get_*_state`, `nominate_super_admin` /
`accept_super_admin` / `cancel_nomination` (two-step admin handover).

| Item | Workspace home | Status |
|---|---|---|
| Blood-bank / hospital / org registration + activation state machine | `contracts/identity` | **Port** — map `LifecycleState` onto identity's verification states. |
| Two-step super-admin handover | every contract's `admin` + `set_guardian` | **Port** — add nominate/accept to a shared admin helper. |
| `get_metadata` / `is_feature_supported` / `version` | `version()` + `schema_version()` on all 10 contracts | **Have** (per-contract, not a global feature map). |

### 1.2 Blood unit registry (read/write split)

Monolith: `registry_read.rs` (pure reads) + `registry_write.rs` (all
`storage.set`), plus `register_blood`, `batch_register_blood`, `add_blood_unit`,
`allocate_blood`, `batch_allocate_blood`, `cancel_allocation`, `withdraw_blood`,
`quarantine_blood`, `finalize_quarantine`, `expire_unit`,
`check_and_expire_batch`, and queries `query_by_status`, `query_by_hospital`,
`query_by_blood_type`, `get_units_by_bank`, `get_units_by_donor`,
`check_availability`.

| Item | Workspace home | Status |
|---|---|---|
| Unit registration, status lifecycle, expiry | `contracts/inventory` | **Port** — reconcile status enum + `check_and_expire_batch` batch path. |
| Quarantine (`quarantine_blood` / `finalize_quarantine` / `QuarantineReason`) | `contracts/inventory` | **Port** — quarantine states + reason codes are monolith-only. |
| Allocation / cancel-allocation | `contracts/matching` + `contracts/coordinator` (`allocate_units`) | **Port** — verify cancel path + batch allocation. |
| Paginated queries by status / hospital / blood-type / bank / donor | `inventory` query surface | **Port** — with sdk-23 pagination (`PAGE_SIZE` pattern as in `temperature`). |
| `registry_read` / `registry_write` module split | new workspace convention | **Port the pattern** — keep read-only vs. state-mutating modules separate. |

### 1.3 Custody / transfer / cold chain

Monolith: `initiate_transfer` → `confirm_transfer` / `cancel_transfer`,
`confirm_delivery`, `compute_event_id`, `get_custody_event`, `get_custody_trail`,
`get_custody_trail_metadata`, `migrate_trail_index`, `get_transfer_history`, plus
hash-linked chain: `append_custody_link`, `get_custody_chain`,
`verify_custody_chain`.

| Item | Workspace home | Status |
|---|---|---|
| Chain-of-custody transfer state machine + event trail | **no workspace contract** — nearest: `delivery` + `temperature` | **Port — gap.** Needs a dedicated custody surface or a `delivery` extension. Blocks the `fuzz_custody_transfer` port. |
| Hash-linked custody chain (`append_custody_link` / `verify_custody_chain`) | overlaps backend `proof-commitment` custody-chain-link | **Port** — align on-chain link hashing with `delivery` proof requirements. |
| `migrate_trail_index` (storage index backfill) | — | **Retire** — one-off monolith storage migration; meaningless in a fresh workspace deployment. |

### 1.4 Payments / escrow / disputes

Monolith `payments.rs` + `create_payment`, `set_escrow_conditions`,
`configure_multisig`, `propose_release` (threshold voting via `MultiSigConfig` /
`PendingApproval`), `raise_dispute`, `resolve_dispute`,
`process_expired_disputes`, `set_dispute_timeout`, `get_payment_stats`;
`FeeStructure::calculate_net_amount`, `HIGH_VALUE_THRESHOLD`,
`Payment::can_transition_to`.

| Item | Workspace home | Status |
|---|---|---|
| Payment creation, escrow create/release/refund, status matrix | `contracts/payments` (`create_payment`, `create_escrow`, `release_escrow`, `refund_escrow`, `update_status`) | **Have** — verify transition matrix matches `Payment::can_transition_to`. |
| Disputes: raise / resolve / timeout / expiry sweep | `contracts/payments` (`record_dispute`, `resolve_dispute`, `set_dispute_timeout`, `process_expired_disputes`) | **Have** — verify `DisputeReason` / evidence-digest / `evidence_ref_chunks` parity. |
| Multi-sig threshold release (`configure_multisig`, `propose_release`, `PendingApproval` voting) | — | **Port — gap.** Workspace has pause-flags + guardian but no N-of-M release voting. |
| `FeeStructure` net-amount arithmetic + `HIGH_VALUE_THRESHOLD` routing | — | **Port — gap.** Port fail-safe arithmetic (invariant `property_fee_and_multisig_arithmetic_fail_safely`). |
| `get_payment_stats` / statistics | `payments` `get_payment_statistics`, `get_payment_timeline` | **Have.** |
| Pledges / vesting | `payments` (`create_pledge`, `create_vesting`, `claim_vested`) | **Have** — workspace-only, no monolith equivalent. |

### 1.5 Requests

Monolith: `create_request`, `update_request_status`, `approve_request`,
`cancel_request`, `fulfill_request`, plus `RequestStatus` transitions and the
approval-overflow guard.

| Item | Workspace home | Status |
|---|---|---|
| Request lifecycle create → approve → fulfil → cancel | `contracts/requests` + `coordinator` | **Port** — transitions + the approval-quantity overflow guard (invariant `property_request_approval_overflow_fails_before_state_mutation`). |

### 1.6 Storage lifecycle / TTL (`storage_lifecycle.rs`) — feeds #33

Monolith: storage-tier table (instance vs. persistent), `bump_persistent`,
`bump_rent_for_unit`, `bump_all_registries`, `bump_registry_ttl`; archival:
`is_eligible_for_archival`, `archive_unit_history`, `archive_custody_events`,
`get_archived_*_summary`, `is_*_archived`, + entrypoints `archive_history` /
`archive_custody` / `get_history_summary` / `get_custody_summary`.

| Item | Workspace home | Status |
|---|---|---|
| Storage-tier classification table | `lifebank-soroban/docs/storage-layout.txt` + per-contract `storage.rs` | **Port** — fold tier rationale into a shared doc. |
| TTL bump helpers | per-contract, on **sdk-23 TTL API** (see §2) | **Port** — re-derive TTL constants for the target network. |
| Archival + summary-on-archive (history & custody events) | `inventory` / custody contract | **Port** — terminal-status eligibility + summary snapshot semantics. |

### 1.7 Proof commitments (`proof_delivery.rs` + entrypoints)

Monolith: `register_proof_scheme` / `deactivate_proof_scheme` /
`get_proof_scheme`, `submit_proof_commitment`, `confirm_proof_commitment`,
`verify_inclusion` (Merkle), `get_proof_commitment`,
`get_workflow_proof_history`, `supersede_proof_commitment`.

| Item | Workspace home | Status |
|---|---|---|
| Delivery proof / compliance attestation | `contracts/delivery` (`record_compliance_attestation`, `get_compliance_attestation`, `get_proof_requirements`) | **Port** — reconcile versioned proof-scheme registry + Merkle `verify_inclusion` against delivery's attestation model. |
| Proof supersede / workflow proof history | `delivery` | **Port.** |

### 1.8 Health records

| Item | Status |
|---|---|
| `store_record`, `get_record`, `verify_access` | **Retire** — stubs (`verify_access` returns `false` unconditionally, `get_record` ignores `env`). Not wired to any workflow. Re-open as a fresh issue if wanted. |

### 1.9 Recommended port order

1. §1.2 registry (inventory/requests) + §1.6 storage/TTL — unblocks #33.
2. §1.5 requests transitions + §1.4 multisig/fee gaps.
3. §1.3 custody contract — unblocks the custody fuzz target.
4. §1.7 proof commitments.
5. §1.1 admin handover + org lifecycle.
6. Port §3 invariants incrementally as each domain lands (#40).

---

## 2. soroban-sdk 22 → 23 migration notes

The monolith is `soroban-sdk = "22.0.0"`; this workspace is `soroban-sdk = "23"`
(`23.5.0` in `Cargo.lock`). When porting a module, walk this checklist. Items
marked **[confirmed]** are differences already visible in-tree; items marked
**[review]** must be checked against the
[SDK 23 changelog](https://github.com/stellar/rs-soroban-sdk/blob/main/CHANGELOG.md)
for the specific APIs the module touches.

### 2.1 Build / toolchain

| | Monolith (22) | Workspace (23) |
|---|---|---|
| WASM target | `wasm32-unknown-unknown` | `wasm32v1-none` **[confirmed]** (`deploy-verify.yml`; note `scripts/build-all.sh` still names the old triple) |
| Rust toolchain | unpinned | pinned `1.81.0` **[confirmed]** |
| stellar-cli | n/a | `21.4.0` pinned |
| Dependency pins | `ed25519-dalek =2.2.0`, `curve25519-dalek =4.1.3` hand-pinned in `Cargo.toml` to keep `cargo test` compiling **[confirmed]** | not needed |

**Action when porting:** drop the `ed25519-dalek` / `curve25519-dalek` pins and
the accompanying `Cargo.toml` comment; build for `wasm32v1-none`; do not copy the
monolith's `[profile.release]` (the workspace root already defines it).

### 2.2 Contract registration & constructors

- Monolith init is a plain `initialize(env, admin)` entrypoint, called after
  `env.register(HealthChainContract, ())` in tests.
- Workspace contracts use an atomic **`__constructor`** (deploy + init in one
  transaction) *and* keep a legacy `initialize` guarded by an
  `AlreadyInitialized` check. Port both.
- **[review]** test helpers — the workspace registers with constructor args
  (`env.register(Contract, (admin,))`); the monolith passes `()`.

### 2.3 Authorization

- `Address::require_auth()` / `require_auth_for_args()` — API stable across 22/23.
- **[review]** `env.authorize_as_current_contract(...)` auth-entry types and the
  `__check_auth` custom-account signature changed shape across SDK majors. The
  monolith does not use custom accounts, but any ported cross-contract call that
  re-authorizes (custody → coordinator, temperature → coordinator) must be
  re-checked against SDK 23's `InvokerContractAuthEntry`.
- Workspace pattern: `#[contractclient]` trait + typed client for cross-contract
  calls (see `temperature`'s `CoordinatorContractClient`). Port monolith
  cross-contract calls to this pattern rather than raw `env.invoke_contract`.

### 2.4 Storage & TTL

- `storage().instance() / .persistent() / .temporary()` and
  `extend_ttl(key, threshold, extend_to)` — API stable across 22/23; the
  monolith's `bump_persistent` / `extend_ttl` calls port almost verbatim.
- **[review]** default TTL / archival ledger constants and the `max_entry_ttl`
  network setting differ between the protocol versions bundled with each SDK.
  Re-derive `MIN_TTL_LEDGERS` / `EXTENDED_TTL_LEDGERS` for the target network.
- **[review]** the monolith stores large `Map<...>` registries under single keys
  (`BLOOD_UNITS`); the workspace convention is per-entity keys in a `storage`
  module. This is a **layout change, not an SDK change** — do not port the
  monolith's storage keys; use each contract's existing `storage.rs`.
- `test_storage_layout.rs` assertions are tied to the monolith key names and
  mostly **retire** on port; keep only the tier-classification intent.

### 2.5 Events

- `env.events().publish((topics...), data)` — API stable.
- The workspace wraps every event in a versioned envelope (`interfaces` crate,
  `schema_version` per event name — see `docs/upgrades/` and #32/#85). Ported
  events must emit through that envelope, **not** the monolith's ad-hoc `publish`
  tuples. This is also why the backend indexer's monolith event decoders are
  dropped once the port completes.

### 2.6 Errors

- `#[contracterror]` `#[repr(u32)]` enums — stable. The monolith's single `Error`
  enum + `payments::PaymentError` split into **per-contract** error enums in the
  workspace (`ContractError`, `CoordinatorError`, …). Map monolith error variants
  to the destination contract's enum.

### 2.7 Numeric / arithmetic

- `overflow-checks = true` is set in both release profiles. The monolith's
  fail-safe arithmetic invariants port unchanged in intent; re-express with the
  workspace's `checked_*` helpers where present.

---

## 3. Test & fuzz port tracking

Every monolith-only invariant test and fuzz target must reach **Done** (ported
equivalent merged) or **Retired** (reason recorded). Legend: **TODO** (not
started) · **Done** · **Retired**. Property-test port is issue
[#40](https://github.com/Lifefllow-chain/Fow/issues/40).

### 3.1 `src/test_protocol_invariants.rs` — 10 property tests

| Test | Intent | Target | Status |
|---|---|---|---|
| `property_request_quantities_are_never_negative_and_invalid_ranges_fail` | request quantity bounds; invalid ranges rejected pre-mutation | `requests` | TODO |
| `property_expired_units_cannot_be_allocated_or_transferred` | expiry gate on allocate/transfer | `inventory` + `matching` | TODO |
| `property_duplicate_and_invalid_request_transitions_fail_deterministically` | request status matrix total & deterministic | `requests` | TODO |
| `property_request_approval_overflow_fails_before_state_mutation` | approved-qty overflow checked before write | `requests` / `coordinator` | TODO |
| `property_delivered_unit_cannot_be_concurrently_quarantined_by_duplicate_action` | terminal `Delivered` blocks quarantine; idempotent | `inventory` | TODO |
| `property_custody_transfer_requires_authorized_current_custodian` | only current custodian can hand off | custody contract (§1.3 gap) | TODO — blocked on custody contract |
| `property_completed_payments_are_terminal_and_cannot_reenter_escrow` | completed payment cannot re-enter escrow | `payments` | TODO — likely covered by `payments` status matrix; confirm & mark Done |
| `property_payment_transition_matrix_rejects_arbitrary_invalid_sequences` | payment status matrix rejects arbitrary invalid sequences | `payments` | TODO |
| `property_fee_and_multisig_arithmetic_fail_safely_for_arbitrary_edges` | fee + N-of-M arithmetic fail-safe on edge values | `payments` (§1.4 gap) | TODO — blocked on multisig port |
| `property_invalid_custody_and_quarantine_sequences_leave_single_status` | a unit never ends in two statuses after invalid sequences | `inventory` + custody contract | TODO |

### 3.2 `src/test_storage_layout.rs` — 9 tests

| Test | Disposition |
|---|---|
| `test_register_unit_creates_blood_unit_in_persistent_storage` | **Port** → `inventory` storage test (persistent tier). |
| `test_register_unit_creates_bank_units_index_in_persistent_storage` | **Port** → `inventory` bank index. |
| `test_register_unit_creates_donor_units_index_in_persistent_storage` | **Port** → `inventory` donor index. |
| `test_initialize_creates_admin_in_instance_storage` | **Port** → generic admin-in-instance assertion. |
| `test_update_status_modifies_existing_entry_no_new_key` | **Port** → `inventory` update-in-place. |
| `test_expire_unit_updates_status_field_no_deletion` | **Port** → `inventory` expiry keeps entry. |
| `test_register_two_units_same_bank_creates_two_entries` | **Port** → `inventory`. |
| `test_storage_symbol_keys_match_compatibility_contract` | **Retire** — asserts monolith `symbol_short!` keys; workspace uses per-contract `DataKey` enums. |
| `test_storage_layout_fingerprint_regression_guard` | **Retire** — fingerprint over the monolith's combined layout; replaced by per-contract `schema_version()` + upgrade rehearsal in CI. |

### 3.3 `src/test_payments.rs` — 33 tests

Ported wholesale alongside §1.4. **Status: TODO.**

- **Port → `payments` unit tests:** all `payment_*`, `dispute_*`, `escrow_*`,
  `fee_*`, `terminal_states_are_enforced`, `auto_refund_after_timeout`,
  `no_refund_before_deadline`, `manual_resolution_prevents_refund`,
  `non_disputed_payments_are_ignored`, `escrow_conditions_*`.
- **Port — blocked on multisig gap (§1.4):**
  `multisig_config_validates_threshold_and_signers`,
  `pending_approval_rejects_duplicate_votes`,
  `low_value_release_keeps_single_admin_flow`,
  `high_value_release_requires_threshold_votes_and_prevents_duplicates`,
  `configure_multisig_is_admin_only_and_persists_storage`.

### 3.4 Fuzz targets

| Target | Disposition | Status |
|---|---|---|
| `fuzz/fuzz_targets/fuzz_custody_transfer.rs` | **Port** — re-target at the workspace custody contract once it exists (§1.3). Covers `InitiateTransfer` / `ConfirmTransfer` / `CancelTransfer` / `AdvanceTime` sequences against unit-condition and caller-role variation. | TODO — blocked on custody contract |
| `fuzz/fuzz_targets/fuzz_target_1.rs` | **Retired** — body is `fuzz_target!(\|data: &[u8]\| {})`, an empty stub with zero coverage value. No workspace equivalent needed. | Retired |
