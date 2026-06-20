#!/bin/bash
# m1n3 Stratum Server — devnet example
# Copy to .env or export variables before running.
# Required env vars: BITCOIN_RPC_URL, SUI_PACKAGE, POOL_OBJECT
# Optional: POOL_ADMIN_CAP, POOL_ADDRESS

set -euo pipefail

if [ -f "$(dirname "$0")/../.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$(dirname "$0")/../.env"
  set +a
fi

: "${BITCOIN_RPC_URL:?Set BITCOIN_RPC_URL (e.g. http://<rpc-user>:<rpc-password>@127.0.0.1:8332)}"
: "${SUI_PACKAGE:?Set SUI_PACKAGE}"
: "${POOL_OBJECT:?Set POOL_OBJECT}"

exec cargo run --locked --release -p stratum-server -- \
  --sui-package "$SUI_PACKAGE" \
  --pool-object "$POOL_OBJECT" \
  --pool-admin-cap "${POOL_ADMIN_CAP:-}" \
  --pool-address "${POOL_ADDRESS:-}" \
  --sui-rpc-url "${SUI_RPC_URL:-https://fullnode.devnet.sui.io:443}" \
  --sui-keystore "${SUI_KEYSTORE:-$HOME/.sui/sui_config/sui.keystore}" \
  --port "${STRATUM_PORT:-3333}" \
  --metrics-port "${METRICS_PORT:-9091}" \
  --initial-difficulty "${INITIAL_DIFFICULTY:-10000}" \
  --target-shares-per-min "${TARGET_SHARES_PER_MIN:-10}"
