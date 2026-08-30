# `legacy/`

Archived code that is no longer part of the active build. Nothing here is
deployed, referenced by CI, or eligible for new feature work.

## `legacy/contracts/` — the `healthchain` monolith

The original single-crate Soroban contract (`contracts/src/lib.rs`, soroban-sdk
22). Superseded by the modular [`lifebank-soroban`](../lifebank-soroban) workspace
per [ADR-0001](../docs/adr/README.md).

Kept in-tree — rather than deleted — for one reason: its protocol-invariant tests
(`src/test_protocol_invariants.rs`) and fuzz targets (`fuzz/`) are the reference
specification for behaviour that is still being ported to the workspace. The
crate therefore stays compilable and its tests runnable:

```bash
cd legacy/contracts && cargo test
```

- **Not built by CI.** `.github/workflows/deploy-verify.yml` only watches
  `lifebank-soroban/**`.
- **Not deployed.** No deploy script targets this crate, and no instance has ever
  held live state (see the ADR's signed live-state attestation).
- **Final active commit** is recorded in ADR-0001.

Port status for every monolith-only capability, invariant test, and fuzz target
is tracked in
[`lifebank-soroban/docs/migration/`](../lifebank-soroban/docs/migration/).
