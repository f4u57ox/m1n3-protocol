#!/usr/bin/env bash
# Bootstrap the Hashi side on Sui devnet:
#   1. Create a HashiVault<HBTC> (owned by the operator wallet)
#   2. Initialize HashiPoolConfig with the vault's address as derivation path
#
# Writes the resulting object IDs to .env.hashi for downstream scripts.
#
# Inputs (env or .env):
#   SUI_PACKAGE          — m1n3_v4 package ID
#   POOL_ADMIN_CAP       — owned PoolAdminCap ID
#   HBTC_COIN_TYPE       — fully-qualified Coin<HBTC> type (default: 0x2::sui::SUI for devnet demo)
#   BTC_DEPOSIT_ADDR_HEX — 32-byte P2TR Bitcoin address hex (no 0x prefix).
#                          For demo: deterministic placeholder derived from vault id.
set -euo pipefail

if [[ -f "$(dirname "$0")/../.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$(dirname "$0")/../.env"
  set +a
fi

: "${SUI_PACKAGE:?Set SUI_PACKAGE}"
: "${POOL_ADMIN_CAP:?Set POOL_ADMIN_CAP}"
HBTC_COIN_TYPE="${HBTC_COIN_TYPE:-0x2::sui::SUI}"

echo "Creating HashiVault<${HBTC_COIN_TYPE}>…"
VAULT_TX=$(sui client ptb \
  --move-call "${SUI_PACKAGE}::hashi_vault::create<${HBTC_COIN_TYPE}>" "@${POOL_ADMIN_CAP}" \
  --gas-budget 50000000 \
  --json)

VAULT_ID=$(echo "$VAULT_TX" | python3 -c "
import json,sys
d = json.load(sys.stdin)
for c in d.get('objectChanges', []):
    if c.get('type') == 'created' and 'HashiVault' in c.get('objectType',''):
        print(c['objectId']); break
")
if [[ -z "$VAULT_ID" ]]; then
  echo "Failed to extract HashiVault ID" >&2
  echo "$VAULT_TX" | python3 -m json.tool >&2
  exit 1
fi
echo "  vault: $VAULT_ID"

# Use the vault's address as the derivation path; the P2TR address derived
# from it is the destination for the pool's BTC payouts. For the devnet demo
# we use a deterministic placeholder; in production this comes from Hashi's
# off-chain key-derivation against the live MPC pubkey.
BTC_DEPOSIT_ADDR_HEX="${BTC_DEPOSIT_ADDR_HEX:-$(echo -n "$VAULT_ID" | sha256sum | awk '{print $1}')}"

echo "Initializing HashiPoolConfig (deriv=${VAULT_ID})…"
INIT_TX=$(sui client ptb \
  --move-call "${SUI_PACKAGE}::hashi_pool::initialize" "@${POOL_ADMIN_CAP}" "@${VAULT_ID}" "vector[${BTC_DEPOSIT_ADDR_HEX//,/}]" \
  --gas-budget 50000000 \
  --json 2>&1 || true)

# The above may need vector-of-bytes syntax — try fallback if the first form fails.
if echo "$INIT_TX" | grep -q '"status":"failure"\|Error'; then
  echo "  retrying with explicit vector<u8> bytes…"
  BYTES_LIST=$(python3 -c "h='${BTC_DEPOSIT_ADDR_HEX}'; print(','.join(str(int(h[i:i+2],16)) for i in range(0,len(h),2)))")
  INIT_TX=$(sui client ptb \
    --move-call "${SUI_PACKAGE}::hashi_pool::initialize" "@${POOL_ADMIN_CAP}" "@${VAULT_ID}" "vector[$BYTES_LIST]" \
    --gas-budget 50000000 \
    --json)
fi

CONFIG_ID=$(echo "$INIT_TX" | python3 -c "
import json,sys
d = json.load(sys.stdin)
for c in d.get('objectChanges', []):
    if c.get('type') == 'created' and 'HashiPoolConfig' in c.get('objectType',''):
        print(c['objectId']); break
")
if [[ -z "$CONFIG_ID" ]]; then
  echo "Failed to extract HashiPoolConfig ID" >&2
  echo "$INIT_TX" | python3 -m json.tool >&2
  exit 1
fi
echo "  config: $CONFIG_ID"

ENV_FILE="$(dirname "$0")/../.env.hashi"
{
  echo "HASHI_VAULT_ID=$VAULT_ID"
  echo "HASHI_POOL_CONFIG_ID=$CONFIG_ID"
  echo "HBTC_COIN_TYPE=$HBTC_COIN_TYPE"
  echo "BTC_DEPOSIT_ADDR_HEX=$BTC_DEPOSIT_ADDR_HEX"
} > "$ENV_FILE"
echo
echo "Wrote $ENV_FILE"
cat "$ENV_FILE"
