"use client";

import { useMemo, useState } from "react";
import { useCurrentAccount, useSuiClientQuery } from "@mysten/dapp-kit";
import { activeOtcAssets, type OtcAsset, activeOtcEscrowConfig } from "@/lib/confidential-constants";
import { encodeOtcLink, parseAmount, formatAmount } from "@/lib/otc-ticket";
import { useLockEscrow, useDusdcFaucet } from "@/hooks/useOtcEscrow";

/**
 * Seller's lock-escrow form. Drives `m1n3_confidential_otc::lock_escrow`
 * and returns a URL the seller pastes to the buyer.
 */
export function OtcDraft() {
  const account = useCurrentAccount();
  const cfg = activeOtcEscrowConfig();
  const assets = activeOtcAssets();
  const deliverables = assets.filter((a) => !a.isQuote);
  const quotes = assets.filter((a) => a.isQuote);

  const [sellAsset, setSellAsset] = useState<OtcAsset | null>(
    deliverables[0] ?? null,
  );
  const [payAsset, setPayAsset] = useState<OtcAsset | null>(quotes[0] ?? null);
  const [buyer, setBuyer] = useState("");
  const [sellAmount, setSellAmount] = useState("");
  const [payAmount, setPayAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareEscrowId, setShareEscrowId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const lockEscrow = useLockEscrow();
  const dusdcFaucet = useDusdcFaucet();

  // Live deliverable balance for the seller
  const sellerBalance = useSuiClientQuery(
    "getBalance",
    {
      owner: account?.address ?? "",
      coinType: sellAsset?.coinType ?? "",
    },
    { enabled: !!account?.address && !!sellAsset, refetchInterval: 12_000 },
  );

  const valid = useMemo(() => {
    if (!account?.address) return false;
    if (!sellAsset || !payAsset) return false;
    if (!buyer || !/^0x[0-9a-fA-F]{64}$/.test(buyer.trim())) return false;
    if (!sellAmount || Number(sellAmount) <= 0) return false;
    if (!payAmount || Number(payAmount) <= 0) return false;
    return true;
  }, [account?.address, sellAsset, payAsset, buyer, sellAmount, payAmount]);

  if (!account?.address) {
    return (
      <div className="rounded-lg border border-border bg-card p-6">
        <p className="text-sm text-muted-foreground">
          Connect a Sui wallet to draft an OTC ticket.
        </p>
      </div>
    );
  }

  if (!cfg || assets.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-6">
        <p className="text-sm text-muted-foreground">
          OTC is devnet-only. Switch the dapp to devnet to use it.
        </p>
      </div>
    );
  }

  async function onLock() {
    if (!account?.address || !sellAsset || !payAsset || !cfg) return;
    setError(null);
    setBusy(true);
    try {
      const sellRaw = parseAmount(sellAmount, sellAsset.decimals);
      const payRaw = parseAmount(payAmount, payAsset.decimals);
      if (sellRaw === null || payRaw === null) {
        throw new Error("Invalid amount input");
      }
      const r = await lockEscrow({
        sellerAddress: account.address,
        deliverableType: sellAsset.coinType,
        payType: payAsset.coinType,
        deliverableAmount: sellRaw,
        payAmount: payRaw,
        buyer: buyer.trim(),
        memo,
      });
      setShareEscrowId(r.escrowId);
      const link = encodeOtcLink({
        v: 1,
        escrowId: r.escrowId,
        sellAsset: sellAsset.coinType,
        payAsset: payAsset.coinType,
      });
      setShareUrl(`${window.location.origin}/otc?link=${link}`);
      setCopied(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onFaucet() {
    setError(null);
    setBusy(true);
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
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Lock an OTC trade</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Locks <code>Coin&lt;HS_NNN&gt;</code> in a shared escrow bound
            to a buyer address + DUSDC price. Atomic settle in a single
            buyer-signed PTB. You can cancel any time the buyer hasn&apos;t
            already settled.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="block space-y-1.5">
            <span className="text-xs text-muted-foreground">You deliver</span>
            <select
              className="w-full rounded-md border border-border bg-background text-sm px-3 py-2"
              value={sellAsset?.symbol ?? ""}
              onChange={(e) =>
                setSellAsset(
                  deliverables.find((a) => a.symbol === e.target.value) ?? null,
                )
              }
            >
              {deliverables.map((a) => (
                <option key={a.symbol} value={a.symbol}>
                  {a.symbol}
                </option>
              ))}
            </select>
            <input
              type="number"
              min="0"
              step="any"
              className="w-full rounded-md border border-border bg-background text-sm px-3 py-2"
              placeholder="Amount"
              value={sellAmount}
              onChange={(e) => setSellAmount(e.target.value)}
            />
            {sellAsset && sellerBalance.data && (
              <p className="text-[11px] text-muted-foreground">
                balance:{" "}
                {formatAmount(
                  sellerBalance.data.totalBalance,
                  sellAsset.decimals,
                )}{" "}
                {sellAsset.symbol}
              </p>
            )}
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs text-muted-foreground">Buyer pays</span>
            <select
              className="w-full rounded-md border border-border bg-background text-sm px-3 py-2"
              value={payAsset?.symbol ?? ""}
              onChange={(e) =>
                setPayAsset(
                  quotes.find((a) => a.symbol === e.target.value) ?? null,
                )
              }
            >
              {quotes.map((a) => (
                <option key={a.symbol} value={a.symbol}>
                  {a.symbol}
                </option>
              ))}
            </select>
            <input
              type="number"
              min="0"
              step="any"
              className="w-full rounded-md border border-border bg-background text-sm px-3 py-2"
              placeholder="Amount"
              value={payAmount}
              onChange={(e) => setPayAmount(e.target.value)}
            />
          </label>
        </div>

        <label className="block space-y-1.5">
          <span className="text-xs text-muted-foreground">
            Buyer address (Sui)
          </span>
          <input
            className="w-full rounded-md border border-border bg-background text-sm px-3 py-2 font-mono"
            placeholder="0x…"
            value={buyer}
            onChange={(e) => setBuyer(e.target.value)}
          />
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs text-muted-foreground">
            Memo (optional, recorded on chain in the escrow object)
          </span>
          <input
            className="w-full rounded-md border border-border bg-background text-sm px-3 py-2"
            placeholder="Round 7 settlement, deal #1234…"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            maxLength={120}
          />
        </label>

        {error && (
          <p className="text-xs text-red-500 break-all">{error}</p>
        )}

        <button
          onClick={onLock}
          disabled={!valid || busy}
          className="w-full rounded-md bg-primary text-primary-foreground text-sm font-medium py-2 hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? "Locking escrow…" : "Lock escrow + share link"}
        </button>

        <div className="border-t border-border pt-3">
          <button
            onClick={onFaucet}
            disabled={busy}
            className="text-xs underline text-muted-foreground"
          >
            DUSDC faucet — mint 1000 DUSDC to this wallet
          </button>
        </div>
      </div>

      {shareUrl && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-2">
          <p className="text-sm font-semibold">
            Share with the buyer
          </p>
          <code className="block break-all rounded bg-muted px-3 py-2 text-[11px] font-mono">
            {shareUrl}
          </code>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                void navigator.clipboard.writeText(shareUrl);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="rounded-md border border-border bg-background text-xs px-3 py-1.5"
            >
              {copied ? "Copied" : "Copy URL"}
            </button>
            {shareEscrowId && (
              <a
                href={`https://suiscan.xyz/devnet/object/${shareEscrowId}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs underline text-muted-foreground"
              >
                Escrow on SuiScan ↗
              </a>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            The escrow object is shared on chain. The trade size is
            public on the escrow object — this is the Phase A
            limitation; see <code>docs/otc.md</code> for the Phase B
            sponsored-PTB path that makes the size confidential.
          </p>
        </div>
      )}
    </div>
  );
}
