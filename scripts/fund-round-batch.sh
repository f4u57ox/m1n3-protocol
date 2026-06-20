#!/usr/bin/env bash
# TRUSTLESS reward funding: drives the trustless single-PTB path
# `hashi_rewards::open_and_fund_round_batch<BTC>` end-to-end. No PoolAdminCap
# required — anyone with gas can run this. Funds flow:
#
#     Hashi confirm_deposit          (committee mints BTC into accumulator
#                                     at vault's UID address)
#         ↓
#     hashi_vault::claim_accumulated_hbtc<BTC>   (anyone — drains accumulator
#                                                 → vault.hbtc)
#         ↓
#     hashi_rewards::open_and_fund_round_batch<BTC>   (anyone — drains vault.hbtc
#                                                      → batch.balance, asserts
#                                                      round binding + CONFIRMED)
#         ↓
#     each miner: hashi_rewards::claim_reward<BTC>    (proportional payout)
#
# Aborts if:
#   • BlockDepositRecord.status != CONFIRMED (Hashi hasn't credited yet)
#   • record.round_id != round_history.round_id (round mismatch)
#   • vault.hbtc is zero after the accumulator drain
#
# Usage:
#   scripts/fund-round-batch.sh --round-id N \
#                               [--accumulator-amount AMOUNT]   # only if accumulator still pending
#                               [--dry-run]
#
# Reads BlockDepositRecord ID from on-chain `HashiPoolConfig.deposit_index[N]`
# and RoundHistory ID by walking the RoundClosed event's tx.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[[ -f "$ROOT/.env" ]]       && { set -a; . "$ROOT/.env"; set +a; }
[[ -f "$ROOT/.env.hashi" ]] && { set -a; . "$ROOT/.env.hashi"; set +a; }

ROUND_ID=""
ACCUM_AMOUNT=""
DRY_RUN=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --round-id)           ROUND_ID="$2"; shift 2;;
    --accumulator-amount) ACCUM_AMOUNT="$2"; shift 2;;
    --dry-run)            DRY_RUN=1; shift;;
    -h|--help) sed -n '/^# /,/^$/p' "$0" | sed 's/^# //'; exit 0;;
    *) echo "unknown arg: $1"; exit 1;;
  esac
done

: "${ROUND_ID:?--round-id is required}"
: "${SUI_PACKAGE:?Set SUI_PACKAGE in .env}"
: "${HASHI_REWARD_REGISTRY_ID:?Set HASHI_REWARD_REGISTRY_ID in .env}"
: "${HASHI_BTC_VAULT_ID:?Set HASHI_BTC_VAULT_ID in .env.hashi}"
: "${HASHI_BTC_COIN_TYPE:?Set HASHI_BTC_COIN_TYPE in .env.hashi}"
: "${HASHI_POOL_CONFIG_ID:?Set HASHI_POOL_CONFIG_ID in .env.hashi}"

RPC="${SUI_RPC_URL:-https://fullnode.devnet.sui.io:443}"
bold(){ printf "\033[1m%s\033[0m\n" "$*"; }

bold "Resolve RoundHistory(round=$ROUND_ID)"
ROUND_HISTORY_ID=$(curl -sS "$RPC" -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"suix_queryEvents\",\"params\":[{\"MoveEventType\":\"${SUI_PACKAGE}::pool::RoundClosed\"},null,100,true]}" \
  | python3 -c "
import json, sys, urllib.request
RPC = '$RPC'
WANT = '$ROUND_ID'
r = json.load(sys.stdin)
for e in r['result']['data']:
    f = e.get('parsedJson') or {}
    if str(f.get('round_id')) != WANT: continue
    digest = e['id']['txDigest']
    req = {'jsonrpc':'2.0','id':1,'method':'sui_getTransactionBlock','params':[digest,{'showObjectChanges':True}]}
    tx = json.loads(urllib.request.urlopen(urllib.request.Request(RPC, data=json.dumps(req).encode(), headers={'Content-Type':'application/json'})).read())
    for c in tx.get('result',{}).get('objectChanges',[]):
        if c.get('type')=='created' and 'pool::RoundHistory' in c.get('objectType',''):
            print(c['objectId']); sys.exit(0)
sys.exit(1)
" 2>/dev/null || true)
[[ -z "$ROUND_HISTORY_ID" ]] && { echo "could not find RoundHistory for round $ROUND_ID"; exit 1; }
echo "  $ROUND_HISTORY_ID"

bold "Resolve BlockDepositRecord(round=$ROUND_ID) from HashiPoolConfig.deposit_index"
DEPOSIT_RECORD_ID=$(curl -sS "$RPC" -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"sui_getDynamicFieldObject\",\"params\":[\"$HASHI_POOL_CONFIG_ID\",{\"type\":\"u64\",\"value\":\"$ROUND_ID\"}]}" \
  | python3 -c "
import json, sys
r = json.load(sys.stdin)
d = r.get('result',{}).get('data')
if not d: sys.exit(1)
# Table dynamic field wraps the value; pull it from name path.
print(d['content']['fields']['value'])
" 2>/dev/null || true)
if [[ -z "$DEPOSIT_RECORD_ID" ]]; then
  echo "  (table lookup failed; pass DEPOSIT_RECORD_ID env explicitly)"
  : "${DEPOSIT_RECORD_ID:?Set DEPOSIT_RECORD_ID for round $ROUND_ID}"
fi
echo "  $DEPOSIT_RECORD_ID"

bold "Verify BlockDepositRecord is CONFIRMED"
STATUS=$(curl -sS "$RPC" -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"sui_getObject\",\"params\":[\"$DEPOSIT_RECORD_ID\",{\"showContent\":true}]}" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['data']['content']['fields']['status'])")
echo "  status = $STATUS (need 3 = DEP_CONFIRMED)"
if [[ "$STATUS" != "3" ]]; then
  echo "  aborting — Hashi hasn't confirmed this deposit yet"
  exit 2
fi

if [[ -n "$ACCUM_AMOUNT" ]]; then
  bold "Drain accumulator into vault.hbtc ($ACCUM_AMOUNT sats)"
  if [[ -n "$DRY_RUN" ]]; then
    echo "  [dry-run] sui client ptb --move-call ${SUI_PACKAGE}::hashi_vault::claim_accumulated_hbtc<${HASHI_BTC_COIN_TYPE}> @${HASHI_BTC_VAULT_ID} ${ACCUM_AMOUNT}u64"
  else
    sui client ptb \
      --move-call "${SUI_PACKAGE}::hashi_vault::claim_accumulated_hbtc<${HASHI_BTC_COIN_TYPE}>" "@${HASHI_BTC_VAULT_ID}" "${ACCUM_AMOUNT}u64" \
      --gas-budget 100000000 --json 2>&1 | tail -3
  fi
fi

bold "open_and_fund_round_batch (single trustless PTB)"
CMD="sui client ptb \
  --move-call ${SUI_PACKAGE}::hashi_rewards::open_and_fund_round_batch<${HASHI_BTC_COIN_TYPE}> \
    @${HASHI_REWARD_REGISTRY_ID} @${HASHI_BTC_VAULT_ID} @${ROUND_HISTORY_ID} @${DEPOSIT_RECORD_ID} @0x6 \
  --gas-budget 200000000 --json"

if [[ -n "$DRY_RUN" ]]; then
  echo "  [dry-run] $CMD"
  exit 0
fi

OUT=$(eval $CMD 2>&1)
echo "$OUT" | python3 -c "
import json, sys
src = sys.stdin.read()
i = src.find('{')
d = json.loads(src[i:])
st = d.get('effects',{}).get('status',{})
print('  status              :', st.get('status'), st.get('error',''))
for ev in d.get('events',[]):
    t = ev.get('type','')
    if 'HashiBatchFunded' in t:
        pj = ev['parsedJson']
        print(f'  funded batch        : {pj.get(\"batch_id\")}')
        print(f'  round_id            : {pj.get(\"round_id\")}')
        print(f'  total_sats          : {pj.get(\"total_sats\")}')
        print(f'  claim_deadline_ms   : {pj.get(\"claim_deadline_ms\")}')
"

bold "Done. Miners holding MinerWorkRecord(round=$ROUND_ID) can now call:"
echo "  hashi_rewards::claim_reward<${HASHI_BTC_COIN_TYPE}>(registry, batch, work_record, round_history, clock)"
