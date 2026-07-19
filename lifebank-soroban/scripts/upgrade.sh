#!/bin/bash
#
# upgrade.sh — operate the in-place WASM upgrade path added in #31.
#
# Standard contracts expose `upgrade(new_wasm_hash)` (admin-gated).
# Funds-holding contracts (payments, coordinator) are timelocked:
#   propose_upgrade → 48h delay → execute_upgrade.
# After any upgrade whose binary bumps TARGET_SCHEMA_VERSION, run `migrate`.
#
# Usage:
#   upgrade.sh install  <wasm-file>                          # upload WASM, print hash
#   upgrade.sh status   <contract-id>                        # version / schema / pending upgrade
#   upgrade.sh upgrade  <contract-id> <wasm-hash>            # immediate upgrade (non-timelocked contracts)
#   upgrade.sh propose  <contract-id> <wasm-hash>            # queue timelocked upgrade (payments/coordinator)
#   upgrade.sh execute  <contract-id>                        # execute once the timelock has elapsed
#   upgrade.sh cancel   <contract-id>                        # cancel a pending proposal
#   upgrade.sh migrate  <contract-id>                        # run post-upgrade storage migration
#   upgrade.sh rollback <contract-id> <previous-wasm-hash>   # re-upgrade to the previous hash
#
# Environment:
#   NETWORK   stellar network passphrase alias (default: testnet)
#   SOURCE    signing identity/key for stellar-cli   (default: default)
#
# See docs/upgrades/README.md for the full runbook.

set -euo pipefail

NETWORK="${NETWORK:-testnet}"
SOURCE="${SOURCE:-default}"

die() { echo "error: $*" >&2; exit 1; }

command -v stellar >/dev/null 2>&1 || die "stellar-cli not found (cargo install --locked stellar-cli)"

invoke() {
  local contract_id="$1"; shift
  stellar contract invoke \
    --id "$contract_id" \
    --source "$SOURCE" \
    --network "$NETWORK" \
    -- "$@"
}

cmd="${1:-}"; shift || true

case "$cmd" in
  install)
    wasm_file="${1:?usage: upgrade.sh install <wasm-file>}"
    [ -f "$wasm_file" ] || die "no such file: $wasm_file"
    echo "📦 Uploading $wasm_file to $NETWORK..."
    hash=$(stellar contract upload --source "$SOURCE" --network "$NETWORK" --wasm "$wasm_file")
    echo "✅ Installed. WASM hash: $hash"
    echo "   Record this hash — it is also the rollback target for the *next* upgrade."
    ;;

  status)
    contract_id="${1:?usage: upgrade.sh status <contract-id>}"
    echo "version:        $(invoke "$contract_id" version)"
    echo "schema_version: $(invoke "$contract_id" schema_version)"
    echo "pending:        $(invoke "$contract_id" get_pending_upgrade 2>/dev/null || echo 'n/a (not a timelocked contract)')"
    ;;

  upgrade)
    contract_id="${1:?usage: upgrade.sh upgrade <contract-id> <wasm-hash>}"
    wasm_hash="${2:?usage: upgrade.sh upgrade <contract-id> <wasm-hash>}"
    echo "⬆️  Upgrading $contract_id in place..."
    invoke "$contract_id" upgrade --new_wasm_hash "$wasm_hash"
    echo "✅ Upgraded. New version: $(invoke "$contract_id" version)"
    echo "   If the new binary bumps TARGET_SCHEMA_VERSION, now run: upgrade.sh migrate $contract_id"
    ;;

  propose)
    contract_id="${1:?usage: upgrade.sh propose <contract-id> <wasm-hash>}"
    wasm_hash="${2:?usage: upgrade.sh propose <contract-id> <wasm-hash>}"
    echo "🕒 Proposing timelocked upgrade for $contract_id..."
    executable_at=$(invoke "$contract_id" propose_upgrade --new_wasm_hash "$wasm_hash")
    echo "✅ Proposed. Executable at ledger timestamp: $executable_at"
    echo "   ($(date -u -d "@${executable_at//\"/}" 2>/dev/null || echo 'see timestamp above') UTC)"
    echo "   Then run: upgrade.sh execute $contract_id"
    ;;

  execute)
    contract_id="${1:?usage: upgrade.sh execute <contract-id>}"
    echo "⬆️  Executing pending upgrade for $contract_id..."
    invoke "$contract_id" execute_upgrade
    echo "✅ Executed. New version: $(invoke "$contract_id" version)"
    echo "   If the new binary bumps TARGET_SCHEMA_VERSION, now run: upgrade.sh migrate $contract_id"
    ;;

  cancel)
    contract_id="${1:?usage: upgrade.sh cancel <contract-id>}"
    invoke "$contract_id" cancel_upgrade
    echo "✅ Pending upgrade canceled."
    ;;

  migrate)
    contract_id="${1:?usage: upgrade.sh migrate <contract-id>}"
    echo "🔧 Running storage migration on $contract_id..."
    new_schema=$(invoke "$contract_id" migrate)
    echo "✅ Migrated. Schema version now: $new_schema"
    ;;

  rollback)
    contract_id="${1:?usage: upgrade.sh rollback <contract-id> <previous-wasm-hash>}"
    prev_hash="${2:?usage: upgrade.sh rollback <contract-id> <previous-wasm-hash>}"
    echo "⏪ Rolling back $contract_id to previous WASM $prev_hash..."
    # Rollback is just an upgrade to the previous hash. Timelocked contracts
    # go through propose/execute again — the delay is deliberate and applies
    # to rollbacks too (see runbook for the emergency-pause alternative).
    if invoke "$contract_id" get_pending_upgrade >/dev/null 2>&1; then
      invoke "$contract_id" propose_upgrade --new_wasm_hash "$prev_hash"
      echo "✅ Rollback proposed (timelocked contract). Execute after the delay:"
      echo "   upgrade.sh execute $contract_id"
    else
      invoke "$contract_id" upgrade --new_wasm_hash "$prev_hash"
      echo "✅ Rolled back. Version: $(invoke "$contract_id" version)"
    fi
    ;;

  *)
    grep '^#' "$0" | sed -n '2,26p' | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
