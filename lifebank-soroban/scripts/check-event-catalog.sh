#!/usr/bin/env bash
# Diffs EVENTS.md (the documented event catalog) against the event names
# actually emitted by each contract's src/events.rs. Fails if either side has
# an event the other doesn't know about — a missing/undocumented event.
#
# Usage: scripts/check-event-catalog.sh   (run from lifebank-soroban/)
set -euo pipefail

cd "$(dirname "$0")/.."

CATALOG="EVENTS.md"
FAILED=0

if [ ! -f "$CATALOG" ]; then
  echo "::error::$CATALOG not found"
  exit 1
fi

# Domain -> contract directory name (directory == domain for every contract
# in this workspace). Keep in sync with contracts/*. Plain array instead of
# an associative one so this also runs under bash 3.2 (macOS default).
DOMAINS=(analytics coordinator delivery identity inventory matching payments reputation requests temperature)

# Extract the event names documented under "## <domain> (" in EVENTS.md:
# markdown table rows of the form "| `event_name` | ..."
catalog_events_for() {
  local domain="$1"
  awk -v domain="$domain" '
    BEGIN { in_section = 0 }
    $0 ~ "^## " domain " \\(" { in_section = 1; next }
    in_section && /^## / { in_section = 0 }
    in_section && /^\| `/ {
      line = $0
      sub(/^\| `/, "", line)
      sub(/`.*/, "", line)
      print line
    }
  ' "$CATALOG" | sort -u
}

# Extract event names actually passed to Symbol::new(env, "...") or
# symbol_short!("...") inside events.rs, excluding the contract's own
# domain symbol (defined once in `fn domain(...)`).
emitted_events_for() {
  local events_file="$1"
  [ -f "$events_file" ] || return 0
  awk '
    /fn domain\(/ { in_domain_fn = 1 }
    in_domain_fn && /^}/ { in_domain_fn = 0; next }
    in_domain_fn { next }
    { print }
  ' "$events_file" \
    | grep -oE '(Symbol::new\(env, *"[^"]+"\)|symbol_short!\("[^"]+"\))' \
    | sed -E 's/Symbol::new\(env, *"([^"]+)"\)/\1/; s/symbol_short!\("([^"]+)"\)/\1/' \
    | sort -u
}

for domain in "${DOMAINS[@]}"; do
  dir="contracts/$domain"
  events_file="$dir/src/events.rs"

  documented=$(catalog_events_for "$domain")
  emitted=$(emitted_events_for "$events_file")

  missing_from_code=$(comm -23 <(echo "$documented") <(echo "$emitted") | sed '/^$/d')
  missing_from_catalog=$(comm -13 <(echo "$documented") <(echo "$emitted") | sed '/^$/d')

  if [ -n "$missing_from_code" ]; then
    echo "::error::[$domain] documented in EVENTS.md but not found in $events_file: $missing_from_code"
    FAILED=1
  fi
  if [ -n "$missing_from_catalog" ]; then
    echo "::error::[$domain] emitted by $events_file but missing from EVENTS.md: $missing_from_catalog"
    FAILED=1
  fi
done

if [ "$FAILED" -ne 0 ]; then
  echo "Event catalog check FAILED: EVENTS.md and the emitted events have drifted."
  exit 1
fi

echo "Event catalog check passed: EVENTS.md matches emitted events for all contracts."
