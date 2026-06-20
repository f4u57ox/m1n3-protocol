#!/usr/bin/env bash
# End-to-end demo: drive a single round through the full Hashi reward pipeline
# on Sui devnet using the existing on-chain modules. Steps as in this file's
# original header (open → accumulate → finalize → record → register → mark
# approved/confirmed → vault receive → create batch → fund → claim).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[[ -f "$ROOT/.env" ]]       && { set -a; . "$ROOT/.env"; set +a; }
[[ -f "$ROOT/.env.hashi" ]] && { set -a; . "$ROOT/.env.hashi"; set +a; }

: "${SUI_PACKAGE:?}"
: "${POOL_OBJECT:?}"
: "${POOL_ADMIN_CAP:?}"
: "${HASHI_REWARD_REGISTRY:?}"
: "${HASHI_POOL_CONFIG_ID:?}"
: "${HASHI_VAULT_ID:?}"
HBTC_COIN_TYPE="${HBTC_COIN_TYPE:-0x2::sui::SUI}"

SENDER=$(sui client active-address 2>/dev/null | tail -1)
RPC=https://fullnode.devnet.sui.io:443
echo "Operator: $SENDER"
export SENDER SUI_PACKAGE RPC

ptb_call_json() {
  local OUT
  OUT=$(sui client ptb "$@" --gas-budget 200000000 --json)
  if echo "$OUT" | python3 -c "
import json,sys
d=json.load(sys.stdin); st=d.get('effects',{}).get('status',{}).get('status','?')
sys.exit(0 if st=='success' else 1)"; then
    echo "$OUT"
  else
    echo "PTB failed:" >&2
    echo "$OUT" | python3 -m json.tool >&2
    exit 1
  fi
}

# Extract first created object whose type contains $1.
extract_obj() {
  python3 -c "
import json,sys
needle = sys.argv[1]
d = json.load(sys.stdin)
for c in d.get('objectChanges', []):
    t = c.get('objectType','')
    if c.get('type') == 'created' and needle in t:
        print(c['objectId']); break
" "$1"
}

# Find an owned object of an exact type and round_id.
find_owned_for_round() {
  python3 - "$1" "$2" <<'PYEOF'
import json, os, sys, urllib.request
suffix, want = sys.argv[1], int(sys.argv[2])
sender = os.environ['SENDER']
pkg = os.environ['SUI_PACKAGE']
target_type = f'{pkg}{suffix}'
url = os.environ['RPC']
cursor = None
while True:
    params = [sender, {"options": {"showContent": True, "showType": True}}, cursor, 50]
    body = {"jsonrpc": "2.0", "id": 1, "method": "suix_getOwnedObjects", "params": params}
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json"})
    d = json.loads(urllib.request.urlopen(req).read())
    res = d.get('result', {}) or {}
    for o in res.get('data', []):
        info = o.get('data') or {}
        if info.get('type') != target_type:
            continue
        f = info.get('content', {}).get('fields', {})
        if int(f.get('round_id', -1)) == want:
            print(info['objectId']); sys.exit(0)
    if not res.get('hasNextPage'): break
    cursor = res.get('nextCursor')
PYEOF
}

# ─── 1. Current round + MinerRoundStats ────────────────────────────────────────
# If CLOSED_ROUND is set, drive the Hashi pipeline against an already-closed
# round (we'll skip open_accumulator/accumulate/finalize and use the existing
# RoundHistory). Otherwise operate on the current open round.
POOL_CURR=$(curl -s "$RPC" -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"sui_getObject\",\"params\":[\"$POOL_OBJECT\",{\"showContent\":true}]}" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['data']['content']['fields']['current_round'])")
ROUND="${CLOSED_ROUND:-$POOL_CURR}"
export ROUND
echo "Pool current_round: $POOL_CURR; operating on round: $ROUND"

MRS=$(find_owned_for_round "::miner::MinerRoundStats" "$ROUND" || true)
echo "MinerRoundStats: ${MRS:-<none — already accumulated>}"

# Look for an existing RoundHistory for $ROUND (frozen object via event).
HISTORY_ID=$(curl -s "$RPC" -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"suix_queryEvents\",\"params\":[{\"MoveEventType\":\"${SUI_PACKAGE}::pool::RoundClosed\"},null,20,true]}" \
  | python3 -c "
import json,sys,os
want=int(os.environ['ROUND'])
d=json.load(sys.stdin)
# RoundClosed doesn't carry the history id; query frozen objects via getOwnedObjects on 0x0 isn't supported
print('')")
# We'll get it by extracting from finalize_round tx if we run it; otherwise look in tx history.
SKIP_FINALIZE=""
if [[ "$ROUND" != "$POOL_CURR" ]]; then
  SKIP_FINALIZE="1"
  # The RoundHistory was created in a previous finalize_round call.
  # Pull it via sui_getCheckpoints / event filter on RoundClosed → the
  # corresponding transaction's objectChanges contains the frozen RoundHistory.
  HISTORY_ID=$(curl -s "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"suix_queryEvents\",\"params\":[{\"MoveEventType\":\"${SUI_PACKAGE}::pool::RoundClosed\"},null,20,true]}" \
    | python3 -c "
import json,sys,os,urllib.request
want=int(os.environ['ROUND']); url=os.environ['RPC']
d=json.load(sys.stdin)
for e in d.get('result',{}).get('data',[]):
    p=e.get('parsedJson',{})
    if int(p.get('round_id','-1'))==want:
        digest = e['id']['txDigest']
        body = {'jsonrpc':'2.0','id':1,'method':'sui_getTransactionBlock',
                'params':[digest,{'showObjectChanges':True}]}
        req = urllib.request.Request(url, json.dumps(body).encode(),
                                     {'Content-Type':'application/json'})
        r = json.loads(urllib.request.urlopen(req).read())
        for c in r['result'].get('objectChanges',[]):
            if c.get('type')=='created' and 'RoundHistory' in c.get('objectType',''):
                print(c['objectId']); sys.exit(0)")
fi
echo "RoundHistory: ${HISTORY_ID:-<will be created by finalize_round>}"

# ─── 2. Round close (open → accumulate → finalize) ─────────────────────────────
if [[ -n "$SKIP_FINALIZE" ]]; then
  echo "(round $ROUND already finalised; skipping open/accumulate/finalize)"
else
echo
# Is an accumulator already open from a prior partial run?
POOL_ACC_OPEN=$(curl -s "$RPC" -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"sui_getObject\",\"params\":[\"$POOL_OBJECT\",{\"showContent\":true}]}" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['data']['content']['fields']['accumulator_open'])")

if [[ "$POOL_ACC_OPEN" == "True" || "$POOL_ACC_OPEN" == "true" ]]; then
  echo "→ accumulator already open — looking up via RoundAccumulatorOpened event"
  ACC_ID=$(curl -s "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"suix_queryEvents\",\"params\":[{\"MoveEventType\":\"${SUI_PACKAGE}::pool::RoundAccumulatorOpened\"},null,5,true]}" \
    | python3 -c "
import json,sys,os
want=int(os.environ['ROUND'])
d=json.load(sys.stdin)
for e in d.get('result',{}).get('data',[]):
    p=e.get('parsedJson',{})
    if int(p.get('round_id','-1'))==want:
        print(p.get('accumulator_id')); break")
else
  echo "→ open_round_accumulator_from_claim (trustless)"
  # The trustless path requires a frozen BlockFoundClaim produced by submit_share.
  # Discover the most recent claim_id for $ROUND from the BlockFound event stream.
  CLAIM_ID=$(curl -s "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"suix_queryEvents\",\"params\":[{\"MoveEventType\":\"${SUI_PACKAGE}::pool::BlockFound\"},null,20,true]}" \
    | python3 -c "
import json,sys,os
want=int(os.environ['ROUND'])
for e in json.load(sys.stdin).get('result',{}).get('data',[]):
    p=e.get('parsedJson',{})
    if int(p.get('round_id','-1'))==want:
        print(p.get('claim_id')); break")
  [[ -z "$CLAIM_ID" ]] && { echo "No BlockFoundClaim for round $ROUND — produce a block-difficulty share first"; exit 1; }
  OPEN=$(ptb_call_json \
    --move-call "${SUI_PACKAGE}::pool::open_round_accumulator_from_claim" "@${POOL_OBJECT}" "@${CLAIM_ID}" "@0x6")
  ACC_ID=$(echo "$OPEN" | extract_obj "RoundAccumulator")
fi
[[ -z "$ACC_ID" ]] && { echo "Could not determine RoundAccumulator id"; exit 1; }
echo "  accumulator: $ACC_ID"

echo "→ accumulate_miner_stats (permissionless)"
ptb_call_json \
  --make-move-vec "<${SUI_PACKAGE}::miner::MinerRoundStats>" "[@${MRS}]" \
  --assign mrs_vec \
  --move-call "${SUI_PACKAGE}::pool::accumulate_miner_stats" "@${ACC_ID}" "mrs_vec" >/dev/null
echo "  accumulated"

echo "→ Waiting 6s for ACCUMULATION_WINDOW_MS…"
sleep 6

echo "→ finalize_round"
FIN=$(ptb_call_json --move-call "${SUI_PACKAGE}::pool::finalize_round" "@${POOL_OBJECT}" "@${ACC_ID}" "@0x6")
HISTORY_ID=$(echo "$FIN" | extract_obj "RoundHistory")
echo "  RoundHistory: $HISTORY_ID"
fi  # end SKIP_FINALIZE guard

# ─── 3. Hashi deposit (stub state machine) ─────────────────────────────────────
SYNTH_TXID_HEX="deadbeefcafebabe0000000000000000000000000000000000000000000000aa"
# PTB CLI mis-types `0x…` 32-byte literals as u256; express as a vector<u8>.
SYNTH_TXID_VEC="vector[$(python3 -c "print(','.join(str(int('${SYNTH_TXID_HEX}'[i:i+2],16)) for i in range(0,len('${SYNTH_TXID_HEX}'),2)))")]"
SUBSIDY=312500000
FEES=187500
TOTAL=$((SUBSIDY + FEES))

echo
# Detect whether the deposit pipeline has already been driven for this round.
EXISTING_REC=$(curl -s "$RPC" -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"sui_getObject\",\"params\":[\"$HASHI_POOL_CONFIG_ID\",{\"showContent\":true}]}" \
  | python3 -c "
import json,sys,os
want=int(os.environ['ROUND'])
fields=json.load(sys.stdin)['result']['data']['content']['fields']
idx_fields = fields.get('deposit_index',{}).get('fields',{})
# 'deposit_index' is a Table; we can't read its entries directly via getObject.
# Instead, fallback to event lookup below.
print('')" 2>/dev/null)

if [[ -z "$EXISTING_REC" ]]; then
  EXISTING_REC=$(curl -s "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"suix_queryEvents\",\"params\":[{\"MoveEventType\":\"${SUI_PACKAGE}::hashi_pool::BlockRewardRecorded\"},null,20,true]}" \
    | python3 -c "
import json,sys,os
want=int(os.environ['ROUND'])
for e in json.load(sys.stdin).get('result',{}).get('data',[]):
    p=e.get('parsedJson',{})
    if int(p.get('round_id','-1'))==want:
        print(p.get('record_id')); break")
fi

if [[ -n "$EXISTING_REC" ]]; then
  RECORD_ID=$EXISTING_REC
  STATUS=$(curl -s "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"sui_getObject\",\"params\":[\"$RECORD_ID\",{\"showContent\":true}]}" \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['data']['content']['fields'].get('status'))")
  echo "  found existing BlockDepositRecord: $RECORD_ID (status=$STATUS)"
else
  echo "→ hashi_pool::record_block_found (trustless: round_id from BlockFoundClaim)"
  # `record_block_found` is permissionless and reads round_id from the claim.
  # Reuse $CLAIM_ID discovered earlier (set in the open-accumulator branch).
  if [[ -z "${CLAIM_ID:-}" ]]; then
    CLAIM_ID=$(curl -s "$RPC" -H 'Content-Type: application/json' \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"suix_queryEvents\",\"params\":[{\"MoveEventType\":\"${SUI_PACKAGE}::pool::BlockFound\"},null,20,true]}" \
      | python3 -c "
import json,sys,os
want=int(os.environ['ROUND'])
for e in json.load(sys.stdin).get('result',{}).get('data',[]):
    p=e.get('parsedJson',{})
    if int(p.get('round_id','-1'))==want:
        print(p.get('claim_id')); break")
  fi
  RBF=$(ptb_call_json \
    --move-call "${SUI_PACKAGE}::hashi_pool::record_block_found" "@${HASHI_POOL_CONFIG_ID}" "@0x6" "@${CLAIM_ID}" "$SYNTH_TXID_VEC" 0u32 "${TOTAL}u64")
  RECORD_ID=$(echo "$RBF" | extract_obj "BlockDepositRecord")
  STATUS=0
  echo "  BlockDepositRecord: $RECORD_ID"
fi

# Drive the state machine forward only from the current status.
[[ "$STATUS" == "0" ]] && {
  echo "→ register_with_hashi"
  ptb_call_json --move-call "${SUI_PACKAGE}::hashi_pool::register_with_hashi" "@${POOL_ADMIN_CAP}" "@${HASHI_POOL_CONFIG_ID}" "@${RECORD_ID}" >/dev/null
  STATUS=1
}
[[ "$STATUS" == "1" ]] && {
  echo "→ set_hashi_request_id"
  ptb_call_json --move-call "${SUI_PACKAGE}::hashi_pool::set_hashi_request_id" "@${POOL_ADMIN_CAP}" "@${RECORD_ID}" "@0xfeedbeef" >/dev/null
  echo "→ mark_hashi_approved"
  ptb_call_json --move-call "${SUI_PACKAGE}::hashi_pool::mark_hashi_approved"  "@${POOL_ADMIN_CAP}" "@${RECORD_ID}" >/dev/null
  STATUS=2
}
[[ "$STATUS" == "2" ]] && {
  echo "→ mark_hashi_confirmed"
  ptb_call_json --move-call "${SUI_PACKAGE}::hashi_pool::mark_hashi_confirmed" "@${POOL_ADMIN_CAP}" "@${HASHI_POOL_CONFIG_ID}" "@${RECORD_ID}" "@0x6" >/dev/null
  STATUS=3
}
[[ "$STATUS" == "3" ]] && echo "  hashi deposit fully confirmed (status=3)"

# ─── 4. Fund vault, receive, create batch, fund batch ──────────────────────────
GAS_NEED=$((TOTAL + 200000000))
export GAS_NEED
GAS_COIN=$(sui client gas --json 2>/dev/null | python3 -c "
import json,sys,os
need = int(os.environ['GAS_NEED'])
raw = sys.stdin.read()
# Strip any leading telemetry log lines before the JSON.
i = raw.find('[')
data = json.loads(raw[i:] if i >= 0 else raw)
for g in data:
    if int(g.get('mistBalance','0')) > need:
        print(g['gasCoinId']); break
")
[[ -z "$GAS_COIN" ]] && { echo "No gas coin large enough"; exit 1; }
echo
echo "→ transfer ${TOTAL} SUI (stand-in hBTC) to vault"
ptb_call_json \
  --split-coins "@${GAS_COIN}" "[${TOTAL}]" \
  --assign hbtc_part \
  --transfer-objects "[hbtc_part]" "@${HASHI_VAULT_ID}" >/dev/null

# Find the Coin<SUI> object that the transfer-to-object created at the vault address.
RECV_ID=$(python3 - <<PYEOF
import json, urllib.request, os
vault = "${HASHI_VAULT_ID}"
url = os.environ['RPC']
body = {"jsonrpc": "2.0", "id": 1, "method": "suix_getOwnedObjects",
        "params": [vault, {"options": {"showType": True}}, None, 50]}
req = urllib.request.Request(url, json.dumps(body).encode(),
                             {"Content-Type": "application/json"})
d = json.loads(urllib.request.urlopen(req).read())
for o in d.get('result', {}).get('data', []):
    t = o.get('data', {}).get('type', '')
    if 'coin::Coin<' in t and 'sui::SUI' in t:
        print(o['data']['objectId']); break
PYEOF
)
[[ -z "$RECV_ID" ]] && { echo "No Coin<SUI> found at vault"; exit 1; }
echo "  vault holds Coin: $RECV_ID"

echo "→ hashi_vault::receive_hbtc"
ptb_call_json \
  --move-call "${SUI_PACKAGE}::hashi_vault::receive_hbtc<${HBTC_COIN_TYPE}>" "@${HASHI_VAULT_ID}" "@${RECV_ID}" >/dev/null

echo "→ open_and_fund_round_batch (trustless: one PTB, no admin cap)"
# Single trustless call: drains exactly record.amount_sats from the vault and
# creates a FUNDED batch with a fixed claim window. The deposit record must
# be CONFIRMED (status=3) for this to succeed.
CB=$(ptb_call_json \
  --move-call "${SUI_PACKAGE}::hashi_rewards::open_and_fund_round_batch<${HBTC_COIN_TYPE}>" "@${HASHI_REWARD_REGISTRY}" "@${HASHI_VAULT_ID}" "@${HISTORY_ID}" "@${RECORD_ID}" "@0x6")
BATCH_ID=$(echo "$CB" | extract_obj "HashiRewardBatch")
echo "  batch: $BATCH_ID"
echo "  funded"

# ─── 5. Claim ──────────────────────────────────────────────────────────────────
WORK_REC=$(find_owned_for_round "::pool::MinerWorkRecord" "$ROUND")
[[ -z "$WORK_REC" ]] && { echo "No MinerWorkRecord for round $ROUND" >&2; exit 1; }
echo "  MinerWorkRecord: $WORK_REC"

echo "→ claim_reward"
CLAIM=$(ptb_call_json \
  --move-call "${SUI_PACKAGE}::hashi_rewards::claim_reward<${HBTC_COIN_TYPE}>" "@${HASHI_REWARD_REGISTRY}" "@${BATCH_ID}" "@${WORK_REC}" "@${HISTORY_ID}" "@0x6")
PAYOUT=$(echo "$CLAIM" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for e in d.get('events', []):
    if 'HashiRewardClaimed' in e.get('type',''):
        print(e['parsedJson']['amount_sats']); break
")

echo
echo "✓ END-TO-END DEMO COMPLETE"
echo "  closed round:   $ROUND"
echo "  history:        $HISTORY_ID"
echo "  reward batch:   $BATCH_ID"
echo "  funded:         $TOTAL sats (subsidy=$SUBSIDY + fees=$FEES)"
echo "  payout:         ${PAYOUT:-?} sats to $SENDER"
