#!/usr/bin/env bash
# Enroll the per-round HashShare TreasuryCap shared objects into the
# HashShareRegistry. Run once per deploy, after `sui client publish`.
#
# Each hs_NNN.move module shares its `TreasuryCap<HS_NNN>` during init.
# The registry needs to know about each one so `bind_slot_to_round` can
# pop them in order as miners arrive in new rounds.
#
# Usage:
#   scripts/register-hashshare-slots.sh
#
# Reads SUI_PACKAGE and HASHSHARE_REGISTRY_ID from .env. Reads the per-slot
# TreasuryCap IDs from env vars HS_000_CAP_ID … HS_007_CAP_ID.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[[ -f "$ROOT/.env" ]] && { set -a; . "$ROOT/.env"; set +a; }

: "${SUI_PACKAGE:?Set SUI_PACKAGE in .env}"
: "${HASHSHARE_REGISTRY_ID:?Set HASHSHARE_REGISTRY_ID in .env}"

declare -a SLOTS=(
  "HS000:${HS_000_CAP_ID:-}"
  "HS001:${HS_001_CAP_ID:-}"
  "HS002:${HS_002_CAP_ID:-}"
  "HS003:${HS_003_CAP_ID:-}"
  "HS004:${HS_004_CAP_ID:-}"
  "HS005:${HS_005_CAP_ID:-}"
  "HS006:${HS_006_CAP_ID:-}"
  "HS007:${HS_007_CAP_ID:-}"
)

bold(){ printf "\033[1m%s\033[0m\n" "$*"; }

for entry in "${SLOTS[@]}"; do
  LABEL="${entry%%:*}"
  CAP_ID="${entry##*:}"
  [[ -z "$CAP_ID" ]] && { echo "skip $LABEL (no cap id set)"; continue; }

  bold "Registering $LABEL -> $CAP_ID"
  LABEL_BYTES=$(python3 -c "
s='$LABEL'
print(','.join(f'{ord(c)}u8' for c in s))
")
  sui client ptb \
    --move-call "${SUI_PACKAGE}::hash_share_registry::register_slot" \
      "@${HASHSHARE_REGISTRY_ID}" "@${CAP_ID}" "vector[${LABEL_BYTES}]" \
    --gas-budget 50000000 --json 2>&1 \
    | python3 -c "
import json, sys
src = sys.stdin.read()
i = src.find('{')
if i < 0:
    print('  non-json:', src[:200])
    sys.exit(1)
d = json.loads(src[i:])
st = d.get('effects',{}).get('status',{})
print('  status :', st.get('status'), st.get('error',''))
"
done

bold "Done."
