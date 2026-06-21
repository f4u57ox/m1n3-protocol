"use client";

import { formatAmount } from "@/lib/otc-ticket";
import { activeOtcAssets } from "@/lib/confidential-constants";
import { SUI_NETWORK } from "@/lib/constants";
import type { EscrowState } from "@/hooks/useOtcEscrow";

function lookupAsset(coinType: string) {
  return activeOtcAssets().find((a) => a.coinType === coinType) ?? null;
}

type Props = {
  escrow: EscrowState;
  digest: string;
};

export function OtcSettlement({ escrow, digest }: Props) {
  const sellerMeta = lookupAsset(escrow.deliverableType);
  const payMeta = lookupAsset(escrow.payType);
  const explorerUrl = `https://suiscan.xyz/${SUI_NETWORK}/tx/${digest}`;
  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Settled</h2>
        <p className="text-xs text-muted-foreground mt-1">
          The escrow has been closed and the deliverable is now in the
          buyer&apos;s wallet. The pay leg landed in the seller&apos;s
          wallet atomically — either both happened or neither did.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <p className="text-xs text-muted-foreground">Seller received</p>
          <p className="font-mono">
            {formatAmount(escrow.payAmount, payMeta?.decimals ?? 0)}{" "}
            {payMeta?.symbol ?? "pay"}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Buyer received</p>
          <p className="font-mono">
            {formatAmount(
              escrow.deliverableAmount,
              sellerMeta?.decimals ?? 0,
            )}{" "}
            {sellerMeta?.symbol ?? "deliverable"}
          </p>
        </div>
        <div className="col-span-2">
          <p className="text-xs text-muted-foreground">Tx digest</p>
          <a
            href={explorerUrl}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-xs break-all underline"
          >
            {digest}
          </a>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Next: the buyer can now optionally wrap the received{" "}
        {sellerMeta?.symbol ?? "deliverable"} into a confidential{" "}
        <code>TokenAccount</code> via{" "}
        <code>MystenLabs/confidential-transfers</code> so subsequent
        holdings + transfers stay opaque to chain observers. See{" "}
        <code>docs/otc.md</code> for the full m1n3 + Hashi + confidential
        loop.
      </p>
    </div>
  );
}
