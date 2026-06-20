#!/usr/bin/env bash
# Submit a REAL hashi::deposit::deposit request on Sui devnet using our
# HashiVault<hashi::btc::BTC> as the derivation_path. Hashi's contract
# accepts the request and emits DepositRequestedEvent. The committee won't
# actually approve a synthetic UTXO (no real Bitcoin tx behind it), but
# this proves the on-chain integration end-to-end: an arbitrary Sui address
# — including our object's UID — is a valid derivation path.
#
# Usage:
#   scripts/hashi-real-deposit-request.sh [BTC_VAULT_ID] [TXID_HEX] [VOUT] [AMOUNT]
#
# Defaults to the BTC-typed vault recorded in .env.hashi-real (or the one
# we created earlier) and a synthetic UTXO worth 0.01 BTC.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[[ -f "$ROOT/.env" ]]       && { set -a; . "$ROOT/.env"; set +a; }
[[ -f "$ROOT/.env.hashi" ]] && { set -a; . "$ROOT/.env.hashi"; set +a; }

: "${HASHI_PACKAGE_ID:?Set HASHI_PACKAGE_ID}"
: "${HASHI_OBJECT_ID:?Set HASHI_OBJECT_ID}"

VAULT="${1:-${HASHI_BTC_VAULT_ID:-0x816808e9ce5586771ac1125f3530bf62c3da5416ce58b11a373596e684c810db}}"
TXID="${2:-deadbeefcafebabe0000000000000000000000000000000000000000000000aa}"
VOUT="${3:-0}"
AMOUNT="${4:-1000000}"  # 0.01 BTC in sats; must be >= bitcoin_deposit_minimum

TXID_ADDR="0x${TXID}"

echo "Submitting Hashi deposit request:"
echo "  Hashi:           $HASHI_OBJECT_ID"
echo "  derivation_path: $VAULT (our HashiVault<BTC>)"
echo "  utxo:            txid=$TXID vout=$VOUT amount=$AMOUNT sats"

OUT=$(sui client ptb \
  --move-call "${HASHI_PACKAGE_ID}::utxo::utxo_id" "@${TXID_ADDR}" "${VOUT}u32" \
  --assign utxoid \
  --move-call "0x1::option::some<address>" "@${VAULT}" \
  --assign deriv \
  --move-call "${HASHI_PACKAGE_ID}::utxo::utxo" "utxoid" "${AMOUNT}u64" "deriv" \
  --assign utxoarg \
  --move-call "${HASHI_PACKAGE_ID}::deposit::deposit" "@${HASHI_OBJECT_ID}" "utxoarg" "@0x6" \
  --gas-budget 200000000 --json 2>/dev/null)

python3 - <<PYEOF "$OUT"
import json, sys
src = sys.argv[1]
i = src.find('{')
if i < 0:
    print('non-json output:', src[:300]); sys.exit(1)
d = json.loads(src[i:])
st = d.get('effects', {}).get('status', {})
print(f"\nstatus: {st.get('status')}")
if st.get('status') != 'success':
    print('error:', st.get('error', ''))
    sys.exit(2)
for ev in d.get('events', []):
    t = ev.get('type', '')
    if 'DepositRequestedEvent' in t:
        j = ev.get('parsedJson', {})
        print('  request_id:     ', j.get('request_id'))
        print('  derivation_path:', j.get('derivation_path'))
        print('  amount (sats):  ', j.get('amount'))
        print('  utxo txid+vout: ', j.get('utxo_id'))
        break
PYEOF
