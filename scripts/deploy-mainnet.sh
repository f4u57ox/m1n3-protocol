#!/usr/bin/env bash
# Mainnet bring-up for m1n3_v4.
#
# Sequence:
#   1. Verify wallet inventory (SUI for gas).
#   2. `sui client publish` of `contracts/` against mainnet.
#   3. Extract the new package id + all created object ids into `.env.mainnet`.
#   4. Single PTB to register HS_000..HS_007 with the new HashShareRegistry
#      AND create a `MarketFeePool<USDC>` for the in-house market.
#
# Pre-conditions:
#   - `sui client switch --address m1n3-mainnet` already run (or the new
#     deploy address is the active one).
#   - `sui client switch --env mainnet`.
#   - Wallet holds >= 5 SUI for gas.
#
# Anti-foot-gun: this script REFUSES to run if the active env is not
# `mainnet`. The publish is irreversible at the protocol level, so we
# guard the env switch upstream.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS_DIR="$ROOT_DIR/contracts"
ENV_FILE="$ROOT_DIR/.env.mainnet"

USDC_TYPE="0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC"

active_env=$(sui client active-env 2>&1 | tr -d '[:space:]')
if [[ "$active_env" != "mainnet" ]]; then
  echo "error: sui client active-env is '$active_env', not 'mainnet'." >&2
  echo "       Run: sui client switch --env mainnet" >&2
  exit 1
fi

active_addr=$(sui client active-address 2>&1 | tr -d '[:space:]')
sui_balance=$(sui client gas --json 2>/dev/null | python3 -c '
import json, sys
gs = json.load(sys.stdin)
total = sum(int(g["mistBalance"]) for g in gs)
print(total)
' 2>/dev/null || echo 0)
sui_balance_human=$(python3 -c "print(${sui_balance}/1e9)")

echo "==> Active mainnet wallet:  $active_addr"
echo "==> SUI balance:            $sui_balance_human SUI"
if (( sui_balance < 5000000000 )); then
  echo "error: insufficient SUI for mainnet publish (need >= 5)" >&2
  exit 1
fi

# ── Step 1: publish ────────────────────────────────────────────────────────
echo
echo "==> Publishing m1n3_v4 to mainnet..."
PUBLISH_LOG=$(mktemp)
trap 'rm -f "$PUBLISH_LOG"' EXIT
sui client publish \
  --gas-budget 3000000000 \
  --build-env mainnet \
  "$CONTRACTS_DIR" \
  > "$PUBLISH_LOG" 2>&1 || {
    echo "error: publish failed" >&2
    tail -50 "$PUBLISH_LOG" >&2
    exit 1
  }

# Extract the new package id from the publish output.
PKG=$(grep -oE 'PackageID: 0x[0-9a-fA-F]{64}' "$PUBLISH_LOG" | head -1 | awk '{print $2}')
if [[ -z "$PKG" ]]; then
  echo "error: couldn't extract PackageID from publish log" >&2
  tail -50 "$PUBLISH_LOG" >&2
  exit 1
fi
echo "==> Published m1n3_v4 at: $PKG"

# ── Step 2: extract object IDs ────────────────────────────────────────────
extract() {
  # Pair every ObjectID with the immediately-following ObjectType, then
  # grep for the type we want. Same trick we used for devnet.
  awk '
    /ObjectID:/ { for (i=1; i<=NF; i++) if ($i ~ /^0x/) id=$i }
    /ObjectType:/ { for (i=1; i<=NF; i++) if ($i ~ /::/) print id, $i }
  ' "$PUBLISH_LOG" | grep -E "$1" | head -1 | awk '{print $1}'
}

POOL_OBJECT=$(extract "::pool::Pool$")
POOL_ADMIN_CAP=$(extract "::pool::PoolAdminCap")
DEDUP_REGISTRY=$(extract "::share_dedup::ShareDedupRegistry")
HASHI_REWARD_REGISTRY=$(extract "::hashi_rewards::HashiRewardRegistry")
HASHSHARE_REGISTRY=$(extract "::hash_share_registry::HashShareRegistry")
MINER_ROUND_REGISTRY=$(extract "::miner::MinerRoundRegistry")
UPGRADE_CAP=$(extract "0x2::package::UpgradeCap")
DUSDC_CAP=$(extract "TreasuryCap<.*::dusdc::DUSDC>")

# All 8 HS TreasuryCaps.
HS_CAPS=()
for i in 0 1 2 3 4 5 6 7; do
  slot="00$i"
  cap=$(extract "TreasuryCap<.*::hs_${slot}::HS_${slot}>")
  HS_CAPS+=("HS_${slot}_CAP_ID=$cap")
done

# ── Step 3: write .env.mainnet ────────────────────────────────────────────
{
  echo "# ─── MAINNET publish $(date -u +%Y-%m-%d) ─────────────────────────────"
  echo "# Fresh publish (not an upgrade). The previous mainnet record at"
  echo "# 0x8377b3f15… is orphaned — that version was SUI-quoted and pre-"
  echo "# Hashi-mainnet which never landed."
  echo "SUI_NETWORK=mainnet"
  echo "SUI_RPC_URL=https://fullnode.mainnet.sui.io:443"
  echo
  echo "SUI_PACKAGE=$PKG"
  echo "POOL_OBJECT=$POOL_OBJECT"
  echo "POOL_ADMIN_CAP=$POOL_ADMIN_CAP"
  echo "DEDUP_REGISTRY=$DEDUP_REGISTRY"
  echo "HASHI_REWARD_REGISTRY=$HASHI_REWARD_REGISTRY"
  echo "HASHSHARE_REGISTRY_ID=$HASHSHARE_REGISTRY"
  echo "MINER_ROUND_REGISTRY=$MINER_ROUND_REGISTRY"
  echo "UPGRADE_CAP=$UPGRADE_CAP"
  echo
  echo "# Native USDC — the in-house hash_share_market's quote asset on mainnet."
  echo "USDC_TYPE=$USDC_TYPE"
  echo
  echo "# Demo DUSDC (still part of the package — used by /otc only)."
  echo "DUSDC_CAP_ID=$DUSDC_CAP"
  echo "DUSDC_COIN_TYPE=${PKG}::dusdc::DUSDC"
  echo
  echo "# HashShare TreasuryCaps"
  for line in "${HS_CAPS[@]}"; do echo "$line"; done
  echo
  echo "# Filled in by scripts/register-mainnet-slots.sh (slot registration"
  echo "# + create_fee_pool<USDC> in one PTB)."
  echo "MARKET_FEE_POOL_USDC="
  echo
  echo "# Filled in by scripts/create-deepbook-pool-mainnet.sh once DEEP is"
  echo "# in the wallet."
  echo "DEEPBOOK_POOL_HS000_USDC="
} > "$ENV_FILE"
chmod 0644 "$ENV_FILE"

echo
echo "==> Captured object IDs in $ENV_FILE"
grep -E "^[A-Z_]+=" "$ENV_FILE" | grep -v "=$" | head -20
echo
echo "==> Next: run scripts/register-mainnet-slots.sh to bind HS slots +"
echo "    create MarketFeePool<USDC>."
