#!/usr/bin/env bash
# Hashi devnet health check. Reports:
#   • signet TX confirmations (if BTC_DEPOSIT_TXID is set)
#   • Hashi shared-object version + epoch
#   • last DepositRequested / DepositApproved / DepositConfirmed timestamps
#     (guardian is "active" if approve/confirm events are within ~30 min)
#   • our DepositRequest state (if HASHI_REQUEST_ID is set)
#   • our HashiVault balance (if HASHI_BTC_VAULT_ID is set)
#
# Usage:
#   scripts/hashi-status.sh
#   HASHI_REQUEST_ID=0x9dee… scripts/hashi-status.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[[ -f "$ROOT/.env" ]]       && { set -a; . "$ROOT/.env"; set +a; }
[[ -f "$ROOT/.env.hashi" ]] && { set -a; . "$ROOT/.env.hashi"; set +a; }

RPC="${SUI_RPC_URL:-https://fullnode.devnet.sui.io:443}"
PKG="${HASHI_PACKAGE_ID:-0xe1ebbd3099c3d22b7e398fad14ef878ad0af2a5375f8ce7d04cbb7374b4efd27}"
HASHI="${HASHI_OBJECT_ID:-0xbd3d25013f0f63d19fc441139cc2ff35ad9bb448c507b47371cf8eeab9f8d611}"

DEFAULT_REQ_ID="0x9dee95c0deb1bbe1ac95a6fc1f4afb720435fe72dc082ff9e87a84a22e1697e7"
DEFAULT_TXID="cc6adff6a35b0b7d002a72214edf6c1d1a10eaa1629f6fefd8a0e62a1be035e8"
REQ_ID="${HASHI_REQUEST_ID:-$DEFAULT_REQ_ID}"
TXID="${BTC_DEPOSIT_TXID:-$DEFAULT_TXID}"
VAULT="${HASHI_BTC_VAULT_ID:-}"

now_ms=$(($(date +%s) * 1000))

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m" "$*"; }
yellow() { printf "\033[33m%s\033[0m" "$*"; }
red()    { printf "\033[31m%s\033[0m" "$*"; }

rpc() {
  curl -sS "$RPC" -H 'Content-Type: application/json' -d "$1"
}

bold "Signet TX ($TXID)"
TX_STATUS=$(curl -sS "https://mempool.space/signet/api/tx/$TXID/status" 2>/dev/null || echo '{}')
TIP=$(curl -sS "https://mempool.space/signet/api/blocks/tip/height" 2>/dev/null || echo "?")
echo "$TX_STATUS" | python3 -c "
import json, sys
s = json.load(sys.stdin)
tip = '$TIP'
if not s.get('confirmed', False):
    print('  in mempool, 0 confirmations')
else:
    bh = s['block_height']
    confs = int(tip) - int(bh) + 1 if tip != '?' else '?'
    print(f'  confirmed at block {bh}, {confs} confirmation(s)')
"
echo

bold "Hashi shared object"
rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"sui_getObject\",\"params\":[\"$HASHI\",{\"showContent\":true}]}" | python3 -c "
import json, sys
r = json.load(sys.stdin)['result']['data']
f = r['content']['fields']
print(f'  version           : {r[\"version\"]}')
print(f'  committee.epoch   : {f[\"committee_set\"][\"fields\"][\"epoch\"]}')
print(f'  num_consumed_presigs: {f.get(\"num_consumed_presigs\")}')
pending = f['committee_set']['fields'].get('pending_epoch_change')
print(f'  pending_epoch_chg : {pending}')
"
echo

bold "Recent module activity (last event of each type, age in minutes)"
NOW_MS=$now_ms
for kind in deposit::DepositRequestedEvent deposit::DepositApprovedEvent deposit::DepositConfirmedEvent withdraw::WithdrawalRequestedEvent withdraw::WithdrawalApprovedEvent withdraw::WithdrawalConfirmedEvent; do
  EVT="${PKG}::${kind}"
  resp=$(rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"suix_queryEvents\",\"params\":[{\"MoveEventType\":\"$EVT\"},null,1,true]}")
  python3 - <<EOF "$resp" "$kind" "$NOW_MS"
import json, sys
resp, kind, now_ms = sys.argv[1], sys.argv[2], int(sys.argv[3])
r = json.loads(resp).get('result',{}).get('data') or []
if not r:
    print(f'  {kind:42s} : (none)')
else:
    e = r[0]
    ts_str = e.get('timestampMs')
    if ts_str is None:
        pj = e.get('parsedJson') or {}
        ts_str = pj.get('timestamp_ms') or pj.get('approval_timestamp_ms') or '0'
    ts = int(ts_str)
    age_min = (now_ms - ts) / 60000 if ts else None
    age = f'{age_min:7.1f} min ago' if age_min is not None else '         ?'
    print(f'  {kind:42s} : {age}')
EOF
done
echo

bold "Guardian verdict"
LAST_APPROVE=$(rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"suix_queryEvents\",\"params\":[{\"MoveEventType\":\"${PKG}::deposit::DepositApprovedEvent\"},null,1,true]}" | python3 -c "
import json,sys
r=json.load(sys.stdin).get('result',{}).get('data') or []
if not r: print(0); exit()
e=r[0]
ts = e.get('timestampMs') or (e.get('parsedJson') or {}).get('approval_timestamp_ms') or 0
print(ts)
")
if [[ "$LAST_APPROVE" == "0" ]]; then
  printf "  "; red "no DepositApprovedEvent ever — guardian may have never run"; echo
else
  age_min=$(( (now_ms - LAST_APPROVE) / 60000 ))
  if   [[ $age_min -lt 30   ]]; then printf "  "; green  "active"; echo " (last approve $age_min min ago)"
  elif [[ $age_min -lt 240  ]]; then printf "  "; yellow "slow/batched"; echo " (last approve $age_min min ago)"
  else                              printf "  "; red    "quiet/down"; echo " (last approve $age_min min ago — > 4 h)"
  fi
fi
echo

if [[ -n "$REQ_ID" ]]; then
  bold "Our DepositRequest $REQ_ID"
  rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"sui_getObject\",\"params\":[\"$REQ_ID\",{\"showContent\":true}]}" | python3 -c "
import json, sys
r = json.load(sys.stdin).get('result',{}).get('data')
if not r:
    print('  (object not found — could already be confirmed and moved to processed bag, or not yet known to this RPC)')
else:
    f = r['content']['fields']
    print(f'  approval_cert       : {f.get(\"approval_cert\")}')
    print(f'  approval_timestamp  : {f.get(\"approval_timestamp_ms\")}')
    print(f'  utxo.amount         : {f[\"utxo\"][\"fields\"][\"amount\"]}')
    print(f'  utxo.derivation_path: {f[\"utxo\"][\"fields\"][\"derivation_path\"]}')
    print(f'  sender              : {f.get(\"sender\")}')
    state = 'CONFIRMED' if f.get('approval_cert') is not None and f.get('approval_timestamp_ms') is not None else 'REQUESTED (waiting on guardian)'
    print(f'  state               : {state}')
"
  echo
fi

if [[ -n "$VAULT" ]]; then
  bold "Our HashiVault $VAULT"
  rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"sui_getObject\",\"params\":[\"$VAULT\",{\"showContent\":true}]}" | python3 -c "
import json, sys
r = json.load(sys.stdin).get('result',{}).get('data')
if not r: print('  (not found)'); sys.exit(0)
f = r['content']['fields']
print(f'  hbtc balance         : {f.get(\"hbtc\")}')
print(f'  sui balance          : {f.get(\"sui\")}')
print(f'  total_received_hbtc  : {f.get(\"total_received_hbtc\")}')
print(f'  total_received_sui   : {f.get(\"total_received_sui\")}')
print(f'  total_withdrawn_hbtc : {f.get(\"total_withdrawn_hbtc\")}')
print(f'  total_withdrawn_sui  : {f.get(\"total_withdrawn_sui\")}')
"
fi
