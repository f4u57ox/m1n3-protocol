#!/bin/bash
# m1n3 Miner Sidecar — trustless Stratum v1 proxy with direct Sui submission.
#
# Usage:  scripts/start-sidecar.sh [mainnet|testnet|devnet]
#
# Network defaults to `devnet` (back-compat). Sources `.env.<network>`
# (e.g. `.env.mainnet`) when present, otherwise falls back to `.env`.
# Required env vars after sourcing: SUI_PACKAGE, POOL_OBJECT.
# Optional: STRATUM_HOST, LISTEN_PORT, SUI_KEYSTORE, SUI_RPC_URL,
# DEDUP_REGISTRY, MINER_ROUND_REGISTRY.

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

: "${SUI_PACKAGE:?Set SUI_PACKAGE}"
: "${POOL_OBJECT:?Set POOL_OBJECT}"

CMD=(
  cargo run --locked --release -p miner-sidecar --
  --stratum-host "${STRATUM_HOST:-127.0.0.1:3333}"
  --listen-port "${LISTEN_PORT:-3334}"
  --sui-keystore "${SUI_KEYSTORE:-$HOME/.sui/sui_config/sui.keystore}"
  --sui-rpc "${SUI_RPC_URL:-https://fullnode.devnet.sui.io:443}"
  --sui-package "$SUI_PACKAGE"
  --pool-object "$POOL_OBJECT"
  --dedup-registry "${DEDUP_REGISTRY:-}"
  --batch-size "${BATCH_SIZE:-16}"
  --batch-timeout-ms "${BATCH_TIMEOUT_MS:-5000}"
)
# The trustless-cleanup refactor made MinerRoundRegistry mandatory in
# submit_share. Without this the sidecar accepts shares but every batch
# submit fails with `miner_round_registry_id required`.
if [ -n "${MINER_ROUND_REGISTRY:-}" ]; then
  CMD+=(--miner-round-registry "$MINER_ROUND_REGISTRY")
fi
# Wiring HashShare mint: without --hashshare-registry, submit_share
# doesn't mint Coin<HS_NNN> to the miner. The slot_watcher subscribes
# to SlotBoundToRound events so the mint hot-swaps as new rounds get
# bound, no restart needed.
if [ -n "${HASHSHARE_REGISTRY_ID:-}" ]; then
  CMD+=(--hashshare-registry "$HASHSHARE_REGISTRY_ID")
fi
# Quote-coin type for the (now generic) hash_share_market. SUI on
# testnet/devnet (default); USDC on mainnet via $USDC_TYPE.
if [ -n "${USDC_TYPE:-}" ]; then
  CMD+=(--quote-coin-type "$USDC_TYPE")
fi
# Auto-sell + auto-fill flags. All are optional — when absent the
# corresponding mode is disabled.
if [ -n "${MARKET_FEE_POOL_USDC:-}${MARKET_FEE_POOL:-}" ]; then
  CMD+=(--market-fee-pool "${MARKET_FEE_POOL_USDC:-${MARKET_FEE_POOL}}")
fi
# Buyer-template lane: when set, every share batch drains a
# HashpowerBuyOrder via submit_share_for_pay<QuoteT>. Skips HashShare
# mint + auto-sell + auto-fill. Pair with --quote-coin-type matching the
# order's QuoteT generic.
if [ -n "${HASHPOWER_BUY_ORDER_ID:-}" ]; then
  CMD+=(--hashpower-buy-order-id "$HASHPOWER_BUY_ORDER_ID")
fi
if [ -n "${AUTO_SELL_PEG:-}" ]; then
  CMD+=(--auto-sell-peg "$AUTO_SELL_PEG")
fi
if [ -n "${AUTO_SELL_OFFSET_BPS:-}" ]; then
  CMD+=(--auto-sell-offset-bps "$AUTO_SELL_OFFSET_BPS")
fi
if [ -n "${AUTO_SELL_FALLBACK_MIST:-}" ]; then
  CMD+=(--auto-sell-fallback-mist "$AUTO_SELL_FALLBACK_MIST")
fi
if [ -n "${AUTO_FILL_BID_FLOOR_MIST:-}" ]; then
  CMD+=(--auto-fill-bid-floor-mist "$AUTO_FILL_BID_FLOOR_MIST")
fi
# Dynamic auto-sell floor — off-chain feeder against BTC price + on-chain
# difficulty. When AUTO_PRICE_FEEDER is set the env-supplied
# AUTO_SELL_FALLBACK_MIST becomes a hard floor below the dynamic value.
if [ "${AUTO_PRICE_FEEDER:-0}" = "1" ]; then
  CMD+=(--auto-price-feeder)
  if [ -n "${AUTO_PRICE_API_URL:-}" ]; then
    CMD+=(--auto-price-api-url "$AUTO_PRICE_API_URL")
  fi
  if [ -n "${AUTO_PRICE_REFRESH_SECS:-}" ]; then
    CMD+=(--auto-price-refresh-secs "$AUTO_PRICE_REFRESH_SECS")
  fi
  if [ -n "${AUTO_PRICE_MULTIPLIER_BPS:-}" ]; then
    CMD+=(--auto-price-multiplier-bps "$AUTO_PRICE_MULTIPLIER_BPS")
  fi
fi
# Note: miner-sidecar reads load_keystore (active_address from
# client.yaml). To pin the signer, run `sui client switch --address
# <alias>` before launching. Adding a --sui-address arg to the sidecar
# is a planned follow-up but not yet wired through MinerClient.
exec "${CMD[@]}"
