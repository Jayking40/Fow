#!/bin/bash
#
# test-upgrade-rehearsal.sh — build the real contract WASMs, then run the
# feature-gated upgrade rehearsal suite: deploy → populate in-flight state
# (open escrow / allocated workflow) → propose → timelock → execute the WASM
# swap → migrate guard → assert every in-flight flow completes correctly.

set -euo pipefail
cd "$(dirname "$0")/.."

echo "🔨 Building WASM artifacts (wasm32v1-none)..."
cargo build --release --target wasm32v1-none -p payment-contract -p coordinator-contract

echo "🎭 Running upgrade rehearsal tests..."
cargo test -p payment-contract -p coordinator-contract --features upgrade-rehearsal upgrade_rehearsal

echo "✅ Upgrade rehearsal passed."
