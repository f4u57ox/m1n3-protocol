#!/bin/bash
# Place a HashpowerBuyOrder<USDC> against the operator's most recent
# `Template`. The operator is BOTH the buyer (orderbook side) and the
# template registrar — this lets the running stratum-server's existing
# template registrations double as hashpower listings on the buyer-
# template lane introduced in the 2026-06-21 upgrade.
#
# Usage:
#   scripts/place-hashpower-order.sh mainnet [--price PER_DIFF] [--budget USDC] [--template-id ID]
#
# Examples:
#   # 17 µUSDC per diff-1 unit, fund with 10 USDC (= 10_000_000 µUSDC)
#   scripts/place-hashpower-order.sh mainnet --price 17 --budget 10000000
#
#   # Custom template id (override the auto-discovered most-recent one)
#   scripts/place-hashpower-order.sh mainnet --price 17 --budget 10000000 \
#       --template-id 0xabc…
#
# Defaults to picking the most recent `TemplateRegistered` event emitted
# by `SUI_PACKAGE::pool` where `owner = SUI_ADDRESS`. Requires the buyer
# (= SUI_ADDRESS = template.owner) to own the template per Move check
# in `place_hashpower_order`.

set -euo pipefail

NETWORK="${1:-mainnet}"
shift || true
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env.${NETWORK}"
if [ ! -f "$ENV_FILE" ]; then
  echo "no env file at $ENV_FILE — aborting" >&2; exit 1
fi
set -a
# shellcheck disable=SC1091
. "$ENV_FILE"
set +a

: "${SUI_PACKAGE:?SUI_PACKAGE missing from $ENV_FILE}"
: "${SUI_ADDRESS:?SUI_ADDRESS missing from $ENV_FILE}"
: "${USDC_TYPE:?USDC_TYPE missing from $ENV_FILE}"

PRICE_PER_DIFF=""
BUDGET=""
TEMPLATE_ID=""
IS_DYNAMIC="false"
QUOTE_TYPE="${USDC_TYPE:-}"  # default to USDC; override via --quote-type
SUI_BIN="${SUI_BIN:-/opt/homebrew/bin/sui}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --price) PRICE_PER_DIFF="$2"; shift 2;;
    --budget) BUDGET="$2"; shift 2;;
    --template-id) TEMPLATE_ID="$2"; shift 2;;
    --dynamic) IS_DYNAMIC="true"; shift;;
    --fixed) IS_DYNAMIC="false"; shift;;
    --quote-type) QUOTE_TYPE="$2"; shift 2;;
    --sui-bin) SUI_BIN="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 1;;
  esac
done

: "${QUOTE_TYPE:?--quote-type required (e.g. 0x2::sui::SUI)}"

: "${PRICE_PER_DIFF:?--price required (µUSDC per difficulty-1 unit)}"
: "${BUDGET:?--budget required (µUSDC initial funding for the order)}"

if [ -z "$TEMPLATE_ID" ]; then
  echo "==> discovering most-recent TemplateRegistered emitted by $SUI_ADDRESS"
  RPC="${SUI_RPC_URL:-https://fullnode.mainnet.sui.io:443}"
  # Sui event TYPES are addressed by the ORIGINAL publishing package id,
  # not the upgraded one. Prefer ORIGINAL_SUI_PACKAGE when set; fall
  # back to SUI_PACKAGE for first-publish networks.
  EVENT_PKG="${ORIGINAL_SUI_PACKAGE:-$SUI_PACKAGE}"
  EVENT_TYPE="${EVENT_PKG}::pool::TemplateRegistered"
  RESP=$(curl -s -X POST "$RPC" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"suix_queryEvents\",\"params\":[{\"MoveEventType\":\"$EVENT_TYPE\"},null,50,true]}")
  TEMPLATE_ID=$(printf '%s' "$RESP" \
    | python3 -c "
import sys, json
data = json.load(sys.stdin).get('result', {}).get('data', [])
me = '$SUI_ADDRESS'
for ev in data:
    pj = ev.get('parsedJson') or {}
    if pj.get('owner') == me:
        print(pj.get('template_id'))
        break
")
  if [ -z "$TEMPLATE_ID" ]; then
    echo "no Template registered by $SUI_ADDRESS found in the most recent 50 events" >&2
    echo "register one first via the running stratum-server, or pass --template-id explicitly" >&2
    exit 1
  fi
  echo "    template: $TEMPLATE_ID"
fi

# Locate a USDC coin object owned by SUI_ADDRESS that holds enough budget.
echo "==> locating USDC coin with balance >= $BUDGET µUSDC"
"$SUI_BIN" client gas --json >/dev/null  # warm up rpc / env

USDC_COIN_JSON=$("$SUI_BIN" client objects --json 2>/dev/null \
  | python3 -c "
import sys, json
need = int('$BUDGET')
coin_t = '$USDC_TYPE'
objs = json.load(sys.stdin)
candidates = []
for o in objs:
    d = o.get('data') or {}
    t = d.get('type') or ''
    if t == f'0x2::coin::Coin<{coin_t}>':
        bal = int((d.get('content', {}).get('fields', {}) or {}).get('balance') or 0)
        candidates.append((bal, d.get('objectId')))
candidates.sort(reverse=True)
for bal, oid in candidates:
    if bal >= need:
        print(json.dumps({'object_id': oid, 'balance': bal}))
        sys.exit(0)
print(json.dumps({'object_id': '', 'balance': 0}))
")
USDC_COIN_ID=$(printf '%s' "$USDC_COIN_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('object_id',''))")
if [ -z "$USDC_COIN_ID" ]; then
  echo "no USDC coin in $SUI_ADDRESS with balance >= $BUDGET µUSDC" >&2
  exit 1
fi
echo "    coin: $USDC_COIN_ID"

# Split the exact budget off the source coin, then place the order.
echo "==> placing order at $PRICE_PER_DIFF µUSDC per difficulty unit, budget $BUDGET µUSDC"
"$SUI_BIN" client ptb \
  --split-coins "@$USDC_COIN_ID" "[$BUDGET]" \
  --assign budget \
  --move-call "${SUI_PACKAGE}::pool::place_hashpower_order" \
    "<$USDC_TYPE>" \
    "@$TEMPLATE_ID" \
    "budget.0" \
    "$PRICE_PER_DIFF" \
    "none" \
    "$IS_DYNAMIC" \
  --gas-budget 50000000 \
  --json | tee /tmp/m1n3-buy-order.json | python3 -c "
import sys, json
r = json.load(sys.stdin)
ec = r.get('effects', {}).get('status', {}).get('status', '?')
print('status:', ec)
for oc in r.get('objectChanges', []) or []:
    t = oc.get('objectType', '')
    if 'HashpowerBuyOrder' in t:
        print('order_id:', oc.get('objectId'))
        print('order_type:', t)
"
echo "==> done. inspect /tmp/m1n3-buy-order.json for the full receipt."
