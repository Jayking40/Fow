# Contract Upgrade Runbook

Every workspace contract can now be upgraded **in place** — same contract ID,
storage preserved — via `env.deployer().update_current_contract_wasm()`
(#31). This runbook covers the standard procedure, the timelocked procedure
for funds-holding contracts, storage migrations, and rollback.

## Concepts

| Entry point | Contracts | Gate |
|---|---|---|
| `version()` | all 10 | none (read-only) |
| `schema_version()` | all 10 | none (read-only) |
| `upgrade(new_wasm_hash)` | 8 domain contracts | admin auth |
| `propose_upgrade` / `execute_upgrade` / `cancel_upgrade` / `get_pending_upgrade` | **payments**, **coordinator** | admin auth + 48h timelock |
| `migrate()` | all 10 | admin auth + double-run guard |

- **`CONTRACT_VERSION`** — code version compiled into the binary. Bump on
  every release. The coordinator refuses workflow steps when any domain
  contract reports a version outside
  `MIN_SUPPORTED_DOMAIN_VERSION..=MAX_SUPPORTED_DOMAIN_VERSION`
  (error `IncompatibleContractVersion = 854`), so a partially-upgraded
  system **fails closed** instead of mis-executing.
- **`TARGET_SCHEMA_VERSION`** — storage schema the binary writes. Bump only
  together with a version-gated transformation in `migrate()`.
- **Invariant:** new code must be able to read *every prior* schema version
  until `migrate()` has completed. Absence of a stored schema version means
  schema 1. `migrate()` refuses to run twice
  (`MigrationAlreadyApplied`).

## Standard upgrade (non-funds contracts)

```bash
cd lifebank-soroban

# 1. Build + upload the new binary
cargo build --release --target wasm32v1-none -p inventory-contract
NETWORK=testnet SOURCE=deployer \
  scripts/upgrade.sh install target/wasm32v1-none/release/inventory_contract.wasm
# → prints WASM hash H_new. Record the *current* hash first as H_prev (rollback target).

# 2. Upgrade in place
scripts/upgrade.sh upgrade <CONTRACT_ID> <H_new>

# 3. Migrate storage if TARGET_SCHEMA_VERSION was bumped
scripts/upgrade.sh migrate <CONTRACT_ID>

# 4. Verify
scripts/upgrade.sh status <CONTRACT_ID>
```

## Timelocked upgrade (payments, coordinator)

These contracts hold or orchestrate escrowed donor funds, so the binary can
never be swapped instantly: `propose_upgrade` queues the hash, and
`execute_upgrade` only succeeds after `UPGRADE_TIMELOCK_SECS` (48 h).
Attempts before then fail with `TimelockNotElapsed`; a second proposal while
one is queued fails with `UpgradeAlreadyPending`.

```bash
scripts/upgrade.sh propose <CONTRACT_ID> <H_new>   # prints executable-at timestamp
# ... 48h window: announce, review, monitor ...
scripts/upgrade.sh execute <CONTRACT_ID>
scripts/upgrade.sh migrate <CONTRACT_ID>           # only if schema bumped
scripts/upgrade.sh status  <CONTRACT_ID>
```

To abort during the window: `scripts/upgrade.sh cancel <CONTRACT_ID>`.

## Coordinated multi-contract upgrades

When a release changes cross-contract interfaces:

1. Bump `CONTRACT_VERSION` in each changed domain contract **and** widen the
   coordinator's supported range (`MIN/MAX_SUPPORTED_DOMAIN_VERSION`) in the
   same release.
2. Upgrade the **coordinator last**. Its version gate makes workflow steps
   fail closed while domain contracts are mid-upgrade.
3. After all executes + migrates, run `scripts/upgrade.sh status` on every
   contract and confirm `version`/`schema_version` match the release matrix.

## Rollback

Rollback is an upgrade to the previous WASM hash (which stays installed on
the network — always record it before upgrading):

```bash
scripts/upgrade.sh rollback <CONTRACT_ID> <H_prev>
```

- Non-timelocked contracts roll back immediately.
- Payments/coordinator rollbacks go through propose → 48h → execute **by
  design**. If funds are at immediate risk, `pause` the contract first
  (circuit breaker) and let the timelock run with the contract frozen.
- **Do not** roll back across a completed `migrate()` unless the old binary
  can read the new schema; if it cannot, ship a fixed-forward binary instead.

## Rehearsal

`scripts/test-upgrade-rehearsal.sh` builds the real WASMs and runs the
feature-gated rehearsal suite: it populates in-flight state (an open escrow
holding tokens; an allocated workflow with reserved units and a locked
payment), performs propose → timelock → execute against the actual compiled
binary, verifies the migrate double-run guard, and asserts every in-flight
flow settles correctly on the new binary. Run it before any production
upgrade and in CI.
