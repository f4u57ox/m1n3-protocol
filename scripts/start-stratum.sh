#!/bin/bash
# m1n3 Stratum Server.
#
# Usage:  scripts/start-stratum.sh [mainnet|testnet|devnet]
#
# Network defaults to `devnet` (back-compat). Sources `.env.<network>`
# (e.g. `.env.mainnet`) when present, otherwise falls back to `.env`.
# Required env vars after sourcing: BITCOIN_RPC_URL, SUI_PACKAGE,
# POOL_OBJECT. Optional: POOL_ADMIN_CAP, POOL_ADDRESS, DEDUP_REGISTRY,
# SUI_ADDRESS, MINER_KEYPAIR.
#
# Note on mainnet:
#  - There is no Hashi-derived BTC payout address (Hashi is devnet-only).
#    POOL_ADDRESS must be a regular BTC mainnet scriptPubKey hex of an
#    address the operator controls, OR left empty if you're only
#    demonstrating the template-registration surface without an ASIC.
#  - The `claim_reward<BTC>` settlement path won't terminate on mainnet
#    (no `HashiVault<BTC>`), so the shares accumulate but no BTC payout
#    fires. See `docs/otc.md` for the chosen mainnet shape.

set -euo pipefail

NETWORK="${1:-devnet}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env.${NETWORK}"
if [ ! -f "$ENV_FILE" ]; then
  ENV_FILE="$ROOT/.env"
fi

if [ -f "$ENV_FILE" ]; then
  echo "==> sourcing $ENV_FILE"
  set -a
  # shellcheck disable=SC1091
  . "$ENV_FILE"
  set +a
fi

: "${BITCOIN_RPC_URL:?Set BITCOIN_RPC_URL (e.g. http://<rpc-user>:<rpc-password>@127.0.0.1:8332)}"
: "${SUI_PACKAGE:?Set SUI_PACKAGE}"
: "${POOL_OBJECT:?Set POOL_OBJECT}"

CMD=(
  cargo run --locked --release -p stratum-server --
  --sui-package "$SUI_PACKAGE"
  --pool-object "$POOL_OBJECT"
  --pool-admin-cap "${POOL_ADMIN_CAP:-}"
  --pool-address "${POOL_ADDRESS:-}"
  --sui-rpc-url "${SUI_RPC_URL:-https://fullnode.devnet.sui.io:443}"
  --sui-keystore "${SUI_KEYSTORE:-$HOME/.sui/sui_config/sui.keystore}"
  --bitcoin-rpc "${BITCOIN_RPC_URL}"
  --port "${STRATUM_PORT:-3333}"
  --metrics-port "${METRICS_PORT:-9091}"
  --initial-difficulty "${INITIAL_DIFFICULTY:-10000}"
  --target-shares-per-min "${TARGET_SHARES_PER_MIN:-10}"
)
# Buyer-template lane: when set, the stratum pins this Template id as
# the only job source. Skips bitcoind polling + operator-side template
# registration. Pair with HASHPOWER_BUY_ORDER_ID on the sidecar.
if [ -n "${OVERRIDE_TEMPLATE_ID:-}" ]; then
  CMD+=(--override-template-id "$OVERRIDE_TEMPLATE_ID")
fi
# The PoolAdminCap is owned by a specific Sui address on each network.
# If SUI_ADDRESS is set in the env file (it is on mainnet), pin the
# signer explicitly — otherwise stratum picks the first key in the
# keystore which may not own the cap.
if [ -n "${SUI_ADDRESS:-}" ]; then
  CMD+=(--sui-address "$SUI_ADDRESS")
fi
exec "${CMD[@]}"
