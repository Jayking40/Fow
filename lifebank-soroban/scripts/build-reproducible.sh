#!/usr/bin/env bash
# scripts/build-reproducible.sh
#
# Builds all contracts inside the pinned Docker build container defined in
# Dockerfile.build, then computes SHA-256 hashes of the resulting WASMs.
#
# The output hashes can be compared against deployments/<network>.json to
# prove that what is on-chain matches the audited source.
#
# Usage:
#   ./scripts/build-reproducible.sh
#   ./scripts/build-reproducible.sh --verify testnet   # compare vs lockfile
#
# Requirements: Docker

set -euo pipefail
cd "$(dirname "$0")/.."

RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[1;33m'; BLU='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLU}[build]${NC} $*"; }
success() { echo -e "${GRN}[build]${NC} $*"; }
warn()    { echo -e "${YLW}[build]${NC} $*"; }
die()     { echo -e "${RED}[build] ERROR:${NC} $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker not found"

VERIFY_NETWORK="${2:-}"
IMAGE_TAG="lifebank-builder:$(git rev-parse --short HEAD 2>/dev/null || echo 'local')"

info "Building Docker image: $IMAGE_TAG"
docker build -f Dockerfile.build -t "$IMAGE_TAG" .

info "Extracting WASMs into target/wasm32v1-none/release/ …"
mkdir -p target/wasm32v1-none/release
docker run --rm \
  -v "$(pwd)/target:/workspace/target" \
  "$IMAGE_TAG"

WASM_DIR="target/wasm32v1-none/release"

# ── Print hash table ──────────────────────────────────────────────────────────
echo ""
echo "=== Built WASM SHA-256 hashes ==="
declare -A BUILT_HASHES

for wasm in "$WASM_DIR"/*_contract.wasm "$WASM_DIR"/*_contract.optimized.wasm; do
  [[ -f "$wasm" ]] || continue
  h=$(sha256sum "$wasm" 2>/dev/null | awk '{print $1}' \
      || shasum -a 256 "$wasm" | awk '{print $1}')
  name=$(basename "$wasm")
  BUILT_HASHES[$name]="$h"
  echo "  $h  $name"
done

# ── Optional: verify against lockfile ────────────────────────────────────────
if [[ -n "$VERIFY_NETWORK" ]]; then
  LOCKFILE="deployments/${VERIFY_NETWORK}.json"
  [[ -f "$LOCKFILE" ]] || die "Lockfile not found: $LOCKFILE"

  echo ""
  info "Verifying hashes against $LOCKFILE …"
  command -v jq >/dev/null 2>&1 || die "jq required for verification"

  all_ok=true
  while IFS= read -r line; do
    contract=$(echo "$line" | jq -r '.key')
    locked_hash=$(echo "$line" | jq -r '.value.wasm_hash')

    # Map contract name to wasm file name
    wasm_name="${contract}_contract.optimized.wasm"
    [[ -f "$WASM_DIR/$wasm_name" ]] || wasm_name="${contract}_contract.wasm"

    built_hash="${BUILT_HASHES[$wasm_name]:-}"

    if [[ -z "$built_hash" ]]; then
      warn "  ⚠  $contract — no built WASM found ($wasm_name)"
      all_ok=false
    elif [[ "$built_hash" == "$locked_hash" ]]; then
      success "  ✓ $contract — hash matches lockfile"
    else
      echo -e "${RED}  ✗ $contract — HASH MISMATCH${NC}"
      echo "    lockfile : $locked_hash"
      echo "    built    : $built_hash"
      all_ok=false
    fi
  done < <(jq -c '.contracts | to_entries[]' "$LOCKFILE")

  echo ""
  if $all_ok; then
    success "All WASM hashes verified against $LOCKFILE"
  else
    die "Hash verification FAILED — built artifacts do not match lockfile"
  fi
fi
