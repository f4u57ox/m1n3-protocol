#!/bin/bash
# m1n3 Miner Sidecar — example startup script
# Required env vars: SUI_PACKAGE, POOL_OBJECT
# Optional: STRATUM_HOST, LISTEN_PORT, SUI_KEYSTORE, SUI_RPC_URL, DEDUP_REGISTRY

set -euo pipefail

if [ -f "$(dirname "$0")/../.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$(dirname "$0")/../.env"
  set +a
fi

: "${SUI_PACKAGE:?Set SUI_PACKAGE}"
: "${POOL_OBJECT:?Set POOL_OBJECT}"

exec cargo run --locked --release -p miner-sidecar -- \
  --stratum-host "${STRATUM_HOST:-127.0.0.1:3333}" \
  --listen-port "${LISTEN_PORT:-3334}" \
  --sui-keystore "${SUI_KEYSTORE:-$HOME/.sui/sui_config/sui.keystore}" \
  --sui-rpc "${SUI_RPC_URL:-https://fullnode.devnet.sui.io:443}" \
  --sui-package "$SUI_PACKAGE" \
  --pool-object "$POOL_OBJECT" \
  --dedup-registry "${DEDUP_REGISTRY:-}" \
  --batch-size "${BATCH_SIZE:-16}" \
  --batch-timeout-ms "${BATCH_TIMEOUT_MS:-5000}"
