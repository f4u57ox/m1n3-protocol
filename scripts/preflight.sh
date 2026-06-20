#!/bin/bash
# Local readiness check for running m1n3 with a LAN ASIC miner.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

value_missing() {
  local name="$1"
  local value="${!name:-}"
  [ -z "$value" ] || [[ "$value" == \<* ]]
}

check_var() {
  local name="$1"
  if value_missing "$name"; then
    printf 'missing  %s\n' "$name"
    return 1
  fi
  printf 'ok       %s\n' "$name"
}

lan_ip() {
  local ip
  ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
  if [ -z "$ip" ]; then
    ip="$(ipconfig getifaddr en1 2>/dev/null || true)"
  fi
  if [ -z "$ip" ]; then
    ip="$(ifconfig 2>/dev/null | awk '/inet / && $2 != "127.0.0.1" { print $2; exit }')"
  fi
  printf '%s' "${ip:-127.0.0.1}"
}

port_status() {
  local port="$1"
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    printf 'listening'
  else
    printf 'free'
  fi
}

echo "m1n3 preflight"
echo

ip="$(lan_ip)"
stratum_port="${STRATUM_PORT:-3333}"
sidecar_port="${LISTEN_PORT:-3334}"
metrics_port="${METRICS_PORT:-9091}"

echo "LAN endpoints"
printf '  Stratum server: %s:%s (%s)\n' "$ip" "$stratum_port" "$(port_status "$stratum_port")"
printf '  Miner sidecar:  %s:%s (%s)\n' "$ip" "$sidecar_port" "$(port_status "$sidecar_port")"
printf '  Metrics:        http://%s:%s/metrics (%s)\n' "$ip" "$metrics_port" "$(port_status "$metrics_port")"
echo

echo "Avalon configuration for on-chain shares"
printf '  Pool URL/Host:  %s\n' "$ip"
printf '  Pool Port:      %s\n' "$sidecar_port"
echo '  Username:       <miner_sui_address>.avalon'
echo '  Password:       x'
echo

echo "Required configuration"
missing=0
for name in BITCOIN_RPC_URL SUI_PACKAGE POOL_OBJECT; do
  check_var "$name" || missing=1
done
echo
echo "Optional configuration"
for name in POOL_ADMIN_CAP DEDUP_REGISTRY POOL_ADDRESS; do
  if value_missing "$name"; then
    printf 'optional %s\n' "$name"
  else
    printf 'ok       %s\n' "$name"
  fi
done
echo

if [ -n "${BITCOIN_RPC_URL:-}" ] && command -v curl >/dev/null 2>&1; then
  if curl --silent --max-time 3 \
    --header 'content-type: text/plain;' \
    --data-binary '{"jsonrpc":"1.0","id":"m1n3","method":"getblockchaininfo","params":[]}' \
    "$BITCOIN_RPC_URL" >/dev/null; then
    echo "ok       Bitcoin RPC reachable"
  else
    echo "warning  Bitcoin RPC not reachable from BITCOIN_RPC_URL"
  fi
fi

if [ "$missing" -ne 0 ]; then
  echo
  echo "Fill .env before starting Stratum/sidecar."
  exit 1
fi

echo
echo "Ready to start:"
echo "  scripts/start-stratum.sh"
echo "  scripts/start-sidecar.sh"
