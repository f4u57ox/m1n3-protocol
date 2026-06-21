#!/usr/bin/env bash
# Post-publish bring-up: register all 8 HashShare slots with the new
# `HashShareRegistry` and create the `MarketFeePool<USDC>` shared object.
#
# Run AFTER deploy-mainnet.sh succeeds. Reads .env.mainnet.
#
# Why this is a separate PTB: register_slot is called once per slot, and
# create_fee_pool only happens once per quote type. Bundling them in one
# tx is the cheapest path (registry mutation + 8 dynamic-field inserts +
# one shared-object create).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.mainnet"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found — run deploy-mainnet.sh first" >&2
  exit 1
fi
set -a; . "$ENV_FILE"; set +a

active_env=$(sui client active-env 2>&1 | tr -d '[:space:]')
if [[ "$active_env" != "mainnet" ]]; then
  echo "error: sui client active-env is '$active_env', not 'mainnet'." >&2
  exit 1
fi

if [[ -z "${SUI_PACKAGE:-}" || -z "${POOL_ADMIN_CAP:-}" || -z "${HASHSHARE_REGISTRY_ID:-}" ]]; then
  echo "error: missing required env vars in $ENV_FILE" >&2
  exit 1
fi

echo "==> Registering 8 HashShare slots + creating MarketFeePool<USDC>..."

# Build a single PTB:
#   - hash_share_registry::register_slot(registry, cap_id_as_address, label)  × 8
#       (no type param — `cap_id` is just an address; the registry stores
#       caps by address and the off-chain consumer matches the type tag of
#       the cap object separately)
#   - hash_share_market::create_fee_pool<USDC>(ctx)
PTB_ARGS=()
for i in 0 1 2 3 4 5 6 7; do
  slot="00$i"
  cap_var="HS_${slot}_CAP_ID"
  cap_val="${!cap_var:-}"
  if [[ -z "$cap_val" ]]; then
    echo "error: $cap_var not set in $ENV_FILE" >&2
    exit 1
  fi
  # label is a vector<u8> — pass the UTF-8 bytes of "HS_NNN" via the
  # array syntax the CLI uses for typed vector<u8>.
  label="HS_${slot}"
  label_bytes=$(printf '%s' "$label" | od -An -tu1 | tr -s ' ' ',' | sed 's/^,//' | sed 's/,$//')
  PTB_ARGS+=(--move-call "${SUI_PACKAGE}::hash_share_registry::register_slot" "@${HASHSHARE_REGISTRY_ID}" "@${cap_val}" "vector[${label_bytes}]")
done
PTB_ARGS+=(--move-call "${SUI_PACKAGE}::hash_share_market::create_fee_pool<${USDC_TYPE}>")

OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT
sui client ptb "${PTB_ARGS[@]}" --gas-budget 300000000 > "$OUT" 2>&1 || {
  echo "error: register PTB failed" >&2
  tail -50 "$OUT" >&2
  exit 1
}

# Find the new MarketFeePool<USDC> object id.
FEE_POOL=$(awk '
  /ObjectID:/ { for (i=1; i<=NF; i++) if ($i ~ /^0x/) id=$i }
  /ObjectType:/ { for (i=1; i<=NF; i++) if ($i ~ /::hash_share_market::MarketFeePool/) print id }
' "$OUT" | head -1)

if [[ -z "$FEE_POOL" ]]; then
  echo "warning: MarketFeePool<USDC> id not found in tx effects; check manually:" >&2
  grep -E "Status|Digest|Error" "$OUT" >&2
else
  echo "==> MarketFeePool<USDC> = $FEE_POOL"
  # Splice into .env.mainnet.
  python3 -c "
import re
with open('$ENV_FILE') as f: s = f.read()
s = re.sub(r'^MARKET_FEE_POOL_USDC=.*$', 'MARKET_FEE_POOL_USDC=$FEE_POOL', s, flags=re.M)
open('$ENV_FILE','w').write(s)
"
fi

echo "==> Done. Next: scripts/create-deepbook-pool-mainnet.sh (needs 500 DEEP)."
