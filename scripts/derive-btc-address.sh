#!/usr/bin/env bash
# Compute the real Bitcoin P2TR deposit address for our HashiVault on the
# live Hashi devnet (signet). Reads the on-chain Hashi shared object to
# fetch `mpc_public_key` and `guardian_btc_public_key`, then runs the
# byte-exact derive_verifying_key + tr() descriptor builder from
# `hashi-derive`. Writes the resulting address back into .env.hashi.
#
# Usage:
#   scripts/derive-btc-address.sh [VAULT_ID]
#
# Defaults to HASHI_BTC_VAULT_ID / HASHI_VAULT_ID from .env.hashi.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[[ -f "$ROOT/.env" ]]       && { set -a; . "$ROOT/.env"; set +a; }
[[ -f "$ROOT/.env.hashi" ]] && { set -a; . "$ROOT/.env.hashi"; set +a; }

: "${HASHI_OBJECT_ID:?Set HASHI_OBJECT_ID in .env.hashi}"

VAULT="${1:-${HASHI_BTC_VAULT_ID:-${HASHI_VAULT_ID:-}}}"
[[ -z "$VAULT" ]] && { echo "Need a vault ID (arg or HASHI_BTC_VAULT_ID)"; exit 1; }

echo "Reading Hashi shared object $HASHI_OBJECT_ID..."

# `sui client object` skips Move struct fields; go straight to JSON-RPC.
RPC_URL="${SUI_RPC_URL:-https://fullnode.devnet.sui.io:443}"
RESP=$(curl -sS "$RPC_URL" -H 'Content-Type: application/json' -d "$(cat <<EOF
{"jsonrpc":"2.0","id":1,"method":"sui_getObject","params":[
 "$HASHI_OBJECT_ID",
 {"showContent":true,"showType":true}
]}
EOF
)")

MASTER_G=$(echo "$RESP" | python3 -c '
import json, sys
r = json.load(sys.stdin)
f = r["result"]["data"]["content"]["fields"]
# committee_set.mpc_public_key is a vector<u8> shown as a flat list.
mk = f["committee_set"]["fields"]["mpc_public_key"]
print(bytes(mk).hex())
')

GUARDIAN=$(echo "$RESP" | python3 -c '
import json, sys
r = json.load(sys.stdin)
f = r["result"]["data"]["content"]["fields"]
# guardian_btc_public_key is a Bytes-variant entry in the config VecMap; each
# entry is wrapped as a vec_map::Entry, so key/value live under .fields.
for e in f["config"]["fields"]["config"]["fields"]["contents"]:
    ef = e.get("fields", e)
    if ef.get("key") == "guardian_btc_public_key":
        print(bytes(ef["value"]["fields"]["pos0"]).hex())
        break
')

echo "  master_g     : $MASTER_G"
echo "  guardian_btc : $GUARDIAN"
echo "  vault (path) : $VAULT"
echo

OUT=$(cargo run --quiet -p hashi-derive -- \
  --sui-addr   "$VAULT" \
  --master-g   "$MASTER_G" \
  --guardian-btc "$GUARDIAN" \
  --network signet)

echo "$OUT"

ADDR=$(echo "$OUT" | awk -F': ' '/^BTC \(Signet\)/{print $2}' | tr -d ' ')
# The on-chain witness program is the *output key*, not the internal `h`.
# The helper prints both — pick "output key (WP)".
WITPROG=$(echo "$OUT" | awk -F': ' '/^output key \(WP\)/{print $2}' | tr -d ' ')
[[ -z "$ADDR" || -z "$WITPROG" ]] && { echo "could not parse helper output"; exit 1; }

# Persist into .env.hashi (idempotent replace).
ENV_FILE="$ROOT/.env.hashi"
TMP=$(mktemp)
grep -vE '^(BTC_DEPOSIT_ADDR|BTC_DEPOSIT_WITNESS_PROGRAM)=' "$ENV_FILE" 2>/dev/null > "$TMP" || true
echo "BTC_DEPOSIT_ADDR=$ADDR" >> "$TMP"
echo "BTC_DEPOSIT_WITNESS_PROGRAM=$WITPROG" >> "$TMP"
mv "$TMP" "$ENV_FILE"

echo
echo "Wrote BTC_DEPOSIT_ADDR=$ADDR"
echo "      BTC_DEPOSIT_WITNESS_PROGRAM=$WITPROG"
echo "to .env.hashi"
echo
BYTES_DEC=$(python3 -c "
h = '$WITPROG'
print(','.join(f'{int(h[i:i+2],16)}u8' for i in range(0,len(h),2)))
")
echo "Push to chain (requires POOL_ADMIN_CAP + HASHI_POOL_CONFIG_ID + SUI_PACKAGE):"
echo "  sui client ptb \\"
echo "    --move-call \$SUI_PACKAGE::hashi_pool::update_btc_address \\"
echo "      @\$POOL_ADMIN_CAP @\$HASHI_POOL_CONFIG_ID 'vector[$BYTES_DEC]' \\"
echo "    --gas-budget 50000000"
