#!/usr/bin/env bash
# scripts/deploy.sh — idempotent, topology-driven deployment orchestrator
#
# Replaces the old deploy-testnet.sh. Reads deploy/topology.toml plus a
# per-env override (deploy/<network>.toml), deploys every contract whose
# address is not yet recorded in deployments/<network>.json, wires cross-
# contract addresses, assigns roles, then writes the lockfile back.
#
# Usage:
#   NETWORK=local   ./scripts/deploy.sh
#   NETWORK=testnet DEPLOYER_SECRET_KEY=S... ./scripts/deploy.sh
#   NETWORK=mainnet DEPLOYER_SECRET_KEY=S... MAINNET_DEPLOY_CONFIRMED=yes \
#                   ./scripts/deploy.sh
#
# Required env vars:
#   NETWORK               — local | testnet | mainnet  (default: local)
#   DEPLOYER_SECRET_KEY   — Stellar secret key  (use HSM for mainnet)
#
# Optional env vars:
#   SKIP_BUILD            — 1  → skip cargo build
#   FORCE_REDEPLOY        — 1  → ignore lockfile, redeploy everything
#   MAINNET_DEPLOY_CONFIRMED — must equal "yes" for mainnet

set -euo pipefail
cd "$(dirname "$0")/.."

# ── Colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[1;33m'; BLU='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLU}[deploy]${NC} $*"; }
success() { echo -e "${GRN}[deploy]${NC} $*"; }
warn()    { echo -e "${YLW}[deploy]${NC} $*"; }
die()     { echo -e "${RED}[deploy] ERROR:${NC} $*" >&2; exit 1; }

# ── Dependency checks ─────────────────────────────────────────────────────────
command -v stellar   >/dev/null 2>&1 || die "stellar-cli not found: cargo install --locked stellar-cli"
command -v jq        >/dev/null 2>&1 || die "jq not found: https://stedolan.github.io/jq/"
command -v cargo     >/dev/null 2>&1 || die "cargo not found: https://rustup.rs/"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# ── Configuration ─────────────────────────────────────────────────────────────
NETWORK="${NETWORK:-local}"
LOCKFILE="deployments/${NETWORK}.json"
WASM_DIR="target/wasm32v1-none/release"
ENV_FILE="deploy/${NETWORK}.toml"

[[ -f "$ENV_FILE" ]] || die "No env override found at $ENV_FILE"

# ── Mainnet safety interlock ──────────────────────────────────────────────────
if [[ "$NETWORK" == "mainnet" ]]; then
  [[ "${MAINNET_DEPLOY_CONFIRMED:-}" == "yes" ]] \
    || die "Set MAINNET_DEPLOY_CONFIRMED=yes to proceed on mainnet"
  warn "*** MAINNET DEPLOY — proceeding in 5 seconds. Ctrl-C to abort. ***"
  sleep 5
fi

# ── Deployer identity ─────────────────────────────────────────────────────────
[[ -n "${DEPLOYER_SECRET_KEY:-}" ]] || die "DEPLOYER_SECRET_KEY is not set"

IDENTITY="lifebank-deployer-$$"
stellar keys add "$IDENTITY" --secret-key "$DEPLOYER_SECRET_KEY" 2>/dev/null || true
DEPLOYER_ADDRESS=$(stellar keys address "$IDENTITY")
info "Deployer: $DEPLOYER_ADDRESS"

cleanup() { stellar keys remove "$IDENTITY" 2>/dev/null || true; }
trap cleanup EXIT

# ── Network params (parsed from env TOML) ────────────────────────────────────
toml_val() {
  grep "^${1}" "$ENV_FILE" | head -1 | sed 's/.*= *"\(.*\)"/\1/'
}
RPC_URL=$(toml_val rpc_url)
NET_PASSPHRASE=$(toml_val network_passphrase)

[[ -n "$RPC_URL" ]]        || die "rpc_url not found in $ENV_FILE"
[[ -n "$NET_PASSPHRASE" ]] || die "network_passphrase not found in $ENV_FILE"

# ── Stellar CLI wrappers ──────────────────────────────────────────────────────
stellar_deploy() {
  # stellar_deploy <wasm> [-- constructor args...]
  local wasm="$1"; shift
  stellar contract deploy \
    --wasm "$wasm" \
    --source "$IDENTITY" \
    --rpc-url "$RPC_URL" \
    --network-passphrase "$NET_PASSPHRASE" \
    "$@"
}

stellar_invoke() {
  # stellar_invoke <contract-id> <fn> [args...]
  local cid="$1"; shift
  stellar contract invoke \
    --id "$cid" \
    --source "$IDENTITY" \
    --rpc-url "$RPC_URL" \
    --network-passphrase "$NET_PASSPHRASE" \
    -- "$@"
}

stellar_read() {
  # stellar_read <contract-id> <fn> [args...] — no auth, no fee
  stellar contract invoke \
    --id "$1" \
    --source "$IDENTITY" \
    --rpc-url "$RPC_URL" \
    --network-passphrase "$NET_PASSPHRASE" \
    -- "${@:2}"
}

# ── Build ─────────────────────────────────────────────────────────────────────
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  info "Building contracts (wasm32v1-none, release)…"
  cargo build --release --target wasm32v1-none
  for wasm in "$WASM_DIR"/*_contract.wasm; do
    [[ -f "$wasm" ]] || continue
    stellar contract optimize --wasm "$wasm" 2>/dev/null || true
  done
  success "Build complete."
else
  warn "SKIP_BUILD=1 — skipping build step."
fi

# ── Lockfile ──────────────────────────────────────────────────────────────────
mkdir -p deployments
if [[ -f "$LOCKFILE" && "${FORCE_REDEPLOY:-0}" != "1" ]]; then
  info "Loaded lockfile: $LOCKFILE"
  LOCKDATA=$(cat "$LOCKFILE")
else
  info "Creating fresh lockfile for: $NETWORK"
  LOCKDATA=$(jq -n \
    --arg net "$NETWORK" \
    --arg ts  "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    '{ network: $net, deployed_at: $ts, contracts: {} }')
fi

lock_addr() { echo "$LOCKDATA" | jq -r ".contracts[\"$1\"].address // \"\""; }
lock_hash() { echo "$LOCKDATA" | jq -r ".contracts[\"$1\"].wasm_hash // \"\""; }

update_lock() {
  local name="$1" addr="$2" hash="$3"
  LOCKDATA=$(echo "$LOCKDATA" | jq \
    --arg n "$name" --arg a "$addr" --arg h "$hash" \
    '.contracts[$n] = { address: $a, wasm_hash: $h }')
  # Write to disk immediately so a partial run is recoverable
  echo "$LOCKDATA" | jq '.' > "$LOCKFILE"
}

# ── Helpers: WASM path resolution ────────────────────────────────────────────
wasm_path() {
  local name="$1"
  local opt="$WASM_DIR/${name}_contract.optimized.wasm"
  local raw="$WASM_DIR/${name}_contract.wasm"
  if [[ -f "$opt" ]]; then echo "$opt"
  elif [[ -f "$raw" ]]; then echo "$raw"
  else die "WASM not found for $name (tried $opt and $raw)"
  fi
}

# ── Contract deploy order ─────────────────────────────────────────────────────
DEPLOY_ORDER=(
  inventory
  requests
  payments
  temperature
  reputation
  identity
  delivery
  matching
  analytics
  coordinator
)

declare -A ADDR

# Pre-load addresses already in the lockfile so later contracts can reference
# earlier ones even on a re-run where those earlier ones were skipped.
for c in "${DEPLOY_ORDER[@]}"; do
  existing=$(lock_addr "$c")
  [[ -n "$existing" ]] && ADDR[$c]="$existing"
done

echo ""
info "=== Phase 1: Deploy contracts ==="

for contract in "${DEPLOY_ORDER[@]}"; do
  existing=$(lock_addr "$contract")
  if [[ -n "$existing" && "${FORCE_REDEPLOY:-0}" != "1" ]]; then
    ADDR[$contract]="$existing"
    success "  ✓ $contract — already deployed at $existing"
    continue
  fi

  wp=$(wasm_path "$contract")
  wasm_hash=$(sha256 "$wp")
  info "  → Deploying $contract (wasm hash: $wasm_hash)…"

  # Each contract's constructor args, matching __constructor signatures
  case "$contract" in
    inventory)
      cid=$(stellar_deploy "$wp" \
        -- --admin "$DEPLOYER_ADDRESS")
      ;;
    requests)
      cid=$(stellar_deploy "$wp" \
        -- --admin               "$DEPLOYER_ADDRESS" \
           --inventory_contract  "${ADDR[inventory]}")
      ;;
    payments)
      cid=$(stellar_deploy "$wp" \
        -- --admin             "$DEPLOYER_ADDRESS" \
           --requests_contract "${ADDR[requests]}")
      ;;
    temperature)
      cid=$(stellar_deploy "$wp" \
        -- --admin "$DEPLOYER_ADDRESS")
      ;;
    reputation)
      cid=$(stellar_deploy "$wp" \
        -- --admin "$DEPLOYER_ADDRESS")
      ;;
    identity)
      cid=$(stellar_deploy "$wp" \
        -- --admin "$DEPLOYER_ADDRESS")
      ;;
    delivery)
      cid=$(stellar_deploy "$wp" \
        -- --admin            "$DEPLOYER_ADDRESS" \
           --request_contract "${ADDR[requests]}")
      ;;
    matching)
      cid=$(stellar_deploy "$wp" \
        -- --admin              "$DEPLOYER_ADDRESS" \
           --inventory_contract "${ADDR[inventory]}" \
           --requests_contract  "${ADDR[requests]}")
      ;;
    analytics)
      cid=$(stellar_deploy "$wp" \
        -- --admin               "$DEPLOYER_ADDRESS" \
           --inventory_contract  "${ADDR[inventory]}" \
           --requests_contract   "${ADDR[requests]}" \
           --payments_contract   "${ADDR[payments]}" \
           --reputation_contract "${ADDR[reputation]}")
      ;;
    coordinator)
      cid=$(stellar_deploy "$wp" \
        -- --admin              "$DEPLOYER_ADDRESS" \
           --request_contract   "${ADDR[requests]}" \
           --inventory_contract "${ADDR[inventory]}" \
           --payment_contract   "${ADDR[payments]}")
      ;;
    *)
      die "Unknown contract: $contract"
      ;;
  esac

  ADDR[$contract]="$cid"
  update_lock "$contract" "$cid" "$wasm_hash"
  success "  ✓ $contract → $cid"
done

echo ""
info "=== Phase 2: Late-bound wiring ==="

# Wire coordinator address into temperature contract
info "  → temperature.set_coordinator(${ADDR[coordinator]})"
stellar_invoke "${ADDR[temperature]}" set_coordinator \
  --admin       "$DEPLOYER_ADDRESS" \
  --coordinator "${ADDR[coordinator]}"
success "  ✓ temperature ← coordinator wired"

echo ""
info "=== Phase 3: Role assignments ==="

# Load env-specific roles from the override TOML.
# Roles that require external addresses use environment variables.
assign_role_if_set() {
  local contract="$1" fn="$2" arg_name="$3" env_var="$4"
  local addr="${!env_var:-}"
  if [[ -n "$addr" ]]; then
    info "  → $contract.$fn($arg_name=$addr)"
    stellar_invoke "${ADDR[$contract]}" "$fn" --"$arg_name" "$addr"
    success "  ✓ $contract.$fn done"
  else
    warn "  ⚠  $env_var not set — skipping $contract.$fn"
  fi
}

assign_role_if_set inventory authorize_blood_bank bank_id   BLOOD_BANK_ADDRESS
assign_role_if_set requests  authorize_hospital   hospital  HOSPITAL_ADDRESS

echo ""
info "=== Phase 4: Initial configuration ==="

# Dispute timeout for payments contract (read from env TOML, default 7 days)
dispute_timeout=$(grep 'dispute_timeout_secs' "$ENV_FILE" 2>/dev/null \
  | head -1 | grep -oE '[0-9]+' || echo "604800")
info "  → payments.set_dispute_timeout($dispute_timeout)"
stellar_invoke "${ADDR[payments]}" set_dispute_timeout \
  --admin        "$DEPLOYER_ADDRESS" \
  --timeout_secs "$dispute_timeout"
success "  ✓ dispute timeout set to ${dispute_timeout}s"

echo ""
info "=== Phase 5: Verify deployment ==="

all_ok=true
for contract in "${DEPLOY_ORDER[@]}"; do
  ver=$(stellar_read "${ADDR[$contract]}" version 2>/dev/null || echo "ERROR")
  if [[ "$ver" == "ERROR" ]]; then
    warn "  ✗ $contract.version() failed"
    all_ok=false
  else
    success "  ✓ $contract @ ${ADDR[$contract]} — version=$ver"
  fi
done

$all_ok || die "One or more contracts failed version check"

echo ""
info "=== Phase 6: Write final lockfile ==="

# Stamp completed_at and deployer into the lockfile
LOCKDATA=$(echo "$LOCKDATA" | jq \
  --arg ts "$( date -u +"%Y-%m-%dT%H:%M:%SZ")" \
  --arg dep "$DEPLOYER_ADDRESS" \
  '.completed_at = $ts | .deployer = $dep')
echo "$LOCKDATA" | jq '.' > "$LOCKFILE"

success "Lockfile written: $LOCKFILE"

echo ""
echo -e "${GRN}══════════════════════════════════════════════════════${NC}"
echo -e "${GRN}  Lifebank deployment complete — network: $NETWORK${NC}"
echo -e "${GRN}══════════════════════════════════════════════════════${NC}"
echo ""
echo "  Coordinator : ${ADDR[coordinator]}"
echo "  Payments    : ${ADDR[payments]}"
echo "  Inventory   : ${ADDR[inventory]}"
echo "  Requests    : ${ADDR[requests]}"
echo "  Temperature : ${ADDR[temperature]}"
echo "  Delivery    : ${ADDR[delivery]}"
echo "  Matching    : ${ADDR[matching]}"
echo "  Analytics   : ${ADDR[analytics]}"
echo "  Identity    : ${ADDR[identity]}"
echo "  Reputation  : ${ADDR[reputation]}"
echo ""
echo "Lockfile: $LOCKFILE"
echo ""
echo "Next steps:"
echo "  Smoke test : NETWORK=$NETWORK ./scripts/smoke-test.sh"
echo "  Upgrade    : ./scripts/upgrade.sh status <contract-id>"
