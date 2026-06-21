"use client";

import { useState } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit";
import { formatAmount } from "@/lib/otc-ticket";
import {
  useCancelEscrow,
  useEscrow,
  useSettleEscrow,
  useDusdcFaucet,
  type EscrowState,
} from "@/hooks/useOtcEscrow";
import { activeOtcAssets } from "@/lib/confidential-constants";

function lookupAsset(coinType: string) {
  return activeOtcAssets().find((a) => a.coinType === coinType) ?? null;
}

type Props = {
  escrowId: string;
  onSettled: (escrow: EscrowState, digest: string) => void;
};

/**
 * Buyer + seller landing page for a shared escrow URL. The page reads
 * the on-chain `Escrow` object, shows the trade terms, and lets the
 * matched buyer sign settle (or the seller cancel).
 */
export function OtcCounterSign({ escrowId, onSettled }: Props) {
  const account = useCurrentAccount();
  const { data: escrow, isLoading, error: loadError } = useEscrow(escrowId);
  const settleEscrow = useSettleEscrow();
  const cancelEscrow = useCancelEscrow();
  const dusdcFaucet = useDusdcFaucet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="rounded-lg border border-border bg-card p-6">
        <p className="text-sm text-muted-foreground">Resolving escrow…</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="rounded-lg border border-border bg-card p-6">
        <p className="text-sm text-red-500 break-all">
          {loadError instanceof Error ? loadError.message : String(loadError)}
        </p>
      </div>
    );
  }

  if (!escrow) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 space-y-2">
        <p className="text-sm font-semibold">Escrow not found</p>
        <p className="text-xs text-muted-foreground">
          This usually means the trade has already been{" "}
          <strong>settled</strong> (the buyer signed) or{" "}
          <strong>cancelled</strong> (the seller withdrew). The link is
          single-use.
        </p>
      </div>
    );
  }

  const sellerMeta = lookupAsset(escrow.deliverableType);
  const payMeta = lookupAsset(escrow.payType);
  const wallet = account?.address ?? null;
  const isBuyer = wallet?.toLowerCase() === escrow.buyer.toLowerCase();
  const isSeller = wallet?.toLowerCase() === escrow.seller.toLowerCase();

  async function onSettle() {
    if (!wallet) return;
    setBusy(true);
    setError(null);
    try {
      if (!escrow) throw new Error("escrow gone");
      const r = await settleEscrow({ escrow, buyerAddress: wallet });
      onSettled(escrow, r.digest);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onCancel() {
    if (!wallet) return;
    setBusy(true);
    setError(null);
    try {
      if (!escrow) throw new Error("escrow gone");
      await cancelEscrow({ escrow, sellerAddress: wallet });
      // Refresh — the escrow disappears (object deleted).
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onFaucet() {
    setBusy(true);
    setError(null);
    try {
      await dusdcFaucet();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <h2 className="text-lg font-semibold">OTC trade</h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Deliverable</p>
            <p className="font-mono">
              {formatAmount(
                escrow.deliverableAmount,
                sellerMeta?.decimals ?? 0,
              )}{" "}
              {sellerMeta?.symbol ?? escrow.deliverableType}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Price</p>
            <p className="font-mono">
              {formatAmount(escrow.payAmount, payMeta?.decimals ?? 0)}{" "}
              {payMeta?.symbol ?? escrow.payType}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Seller</p>
            <p className="font-mono text-xs break-all">{escrow.seller}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Buyer</p>
            <p className="font-mono text-xs break-all">{escrow.buyer}</p>
          </div>
          {escrow.memo && (
            <div className="col-span-2">
              <p className="text-xs text-muted-foreground">Memo</p>
              <p className="text-xs">{escrow.memo}</p>
            </div>
          )}
        </div>
        {!wallet && (
          <p className="text-xs text-muted-foreground">
            Connect a Sui wallet to settle or cancel this trade.
          </p>
        )}
      </div>

      {wallet && isBuyer && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <p className="text-sm">
            You&apos;re the buyer. One PTB will move{" "}
            <strong>
              {formatAmount(escrow.payAmount, payMeta?.decimals ?? 0)}{" "}
              {payMeta?.symbol ?? "pay"}
            </strong>{" "}
            from your wallet to the seller and release the deliverable to
            you atomically.
          </p>
          {error && <p className="text-xs text-red-500 break-all">{error}</p>}
          <button
            disabled={busy}
            onClick={onSettle}
            className="w-full rounded-md bg-primary text-primary-foreground text-sm font-medium py-2 hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? "Settling…" : "Settle (atomic)"}
          </button>
          <button
            onClick={onFaucet}
            disabled={busy}
            className="text-xs underline text-muted-foreground"
          >
            DUSDC faucet (mint 1000 DUSDC to this wallet)
          </button>
        </div>
      )}

      {wallet && isSeller && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <p className="text-sm">
            You&apos;re the seller. If the buyer hasn&apos;t signed yet you
            can cancel and recover the deliverable.
          </p>
          {error && <p className="text-xs text-red-500 break-all">{error}</p>}
          <button
            disabled={busy}
            onClick={onCancel}
            className="w-full rounded-md border border-border bg-background text-sm font-medium py-2 hover:bg-accent disabled:opacity-50"
          >
            {busy ? "Cancelling…" : "Cancel escrow"}
          </button>
        </div>
      )}

      {wallet && !isBuyer && !isSeller && (
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">
            Your connected wallet matches neither the buyer nor the
            seller of this escrow. Switch wallets to participate.
          </p>
        </div>
      )}
    </div>
  );
}
