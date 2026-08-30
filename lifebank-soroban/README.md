# lifebank-soroban

**The canonical Soroban contract stack for this repository.**
Per [ADR-0001](../docs/adr/README.md), this modular
workspace (soroban-sdk 23) is the single source of truth for on-chain logic. The
former `healthchain` monolith is deprecated and archived under
[`legacy/contracts/`](../legacy/contracts).

## Structure

```text
lifebank-soroban/
├── contracts/
│   ├── interfaces/     # shared event envelope + cross-contract types
│   ├── coordinator/    # workflow orchestration, pause flags, timelocked upgrades
│   ├── inventory/      # blood unit registry & status lifecycle
│   ├── requests/       # blood request lifecycle
│   ├── matching/       # request ↔ inventory matching
│   ├── payments/       # escrow, disputes, pledges, vesting
│   ├── delivery/       # delivery proof & compliance attestation
│   ├── temperature/    # cold-chain telemetry & excursion reporting
│   ├── identity/       # organisation verification & attestation
│   ├── reputation/     # participant reputation
│   └── analytics/      # aggregate on-chain metrics
├── deploy/             # per-network deploy topology (*.toml)
├── deployments/        # per-network deployment lockfiles (contract IDs + WASM hashes)
├── docs/
│   ├── upgrades/       # contract upgrade runbook
│   └── migration/      # monolith → workspace port tracking (ADR-0001)
└── scripts/            # build, deploy, upgrade, smoke-test
```

Each contract has its own `Cargo.toml` and relies on the top-level workspace
`Cargo.toml` for shared dependencies.

## Build

```bash
cargo test --all                       # unit + property tests
cargo build --release --target wasm32v1-none
bash scripts/build-all.sh              # + wasm-opt
```

## Deploy

```bash
bash scripts/deploy-testnet.sh
```

Deployment writes a lockfile to `deployments/<network>.json`; CI
(`.github/workflows/deploy-verify.yml`) verifies built WASM hashes against it for
every network with a non-null `deployed_at`.

## Upgrades

All contracts upgrade in place (same contract ID, storage preserved). Payments
and coordinator require a 48h timelock. See [`docs/upgrades/`](docs/upgrades/).

## Migration from the monolith

The disposition of every monolith capability, invariant test, and fuzz target is
tracked in [`docs/migration/`](docs/migration/) against ADR-0001.
