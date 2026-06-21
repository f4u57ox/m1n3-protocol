"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ChevronDown, Settings, Sparkles, Wallet, Zap } from "lucide-react";
import type { ShareMarketOrder } from "@/hooks/useShareMarketOrders";
import { useHashprice } from "@/hooks/useHashprice";
import { QuoteSelector } from "@/components/market/QuoteSelector";
import type { QuoteToken } from "@/lib/quote-tokens";
import {
  baseUnitLabel,
  formatPriceInQuote,
  parseQuoteAmount,
} from "@/lib/quote-format";

type Side = "buy" | "sell";
type Tab = "swap" | "limit" | "dca";

export type SwapAssetMeta = {
  symbol: string;
  short: string;
  helper: string;
};

export type SwapCardProps = {
  /** "HSXXX" label of the active round. */
  hsLabel: string;
  /** Active quote token (controls both display and which route the
   *  parent renders — non-SUI currently falls through to DeepBookNotice). */
  quote: QuoteToken;
  /** Quote change handler — opens the dropdown in the pill. */
  onQuoteChange: (q: QuoteToken) => void;
  /** Walletable quote balance in base units (MIST for SUI). */
  quoteBalance?: bigint;
  /** Walletable HashShare balance in units (for display only). */
  hsBalance: bigint;
  /** Full book — used by Swap tab to walk N orders for the receive estimate. */
  bids: ShareMarketOrder[];
  asks: ShareMarketOrder[];
  walletConnected: boolean;
  pending: boolean;

  // ── action handlers (wired by the parent) ─────────────────────────────
  /** Place a standing buy order at price + budget. */
  onPlaceBid: (priceMist: bigint, budgetMist: bigint) => void;
  /** Place a standing sell order at price + units. */
  onPlaceAsk: (priceMist: bigint, units: bigint) => void;
  /** Multi-fill BUY: walk asks, spend up to `payMist` SUI, one PTB. */
  onSwapBuy: (payMist: bigint) => void;
  /** Multi-fill SELL: walk bids, sell up to `payUnits` HashShares, one PTB. */
  onSwapSell: (payUnits: bigint) => void;
};

export function SwapCard(p: SwapCardProps) {
  const [tab, setTab] = useState<Tab>("swap");

  return (
    <div className="mx-auto w-full max-w-[480px]">
      <div className="overflow-hidden rounded-3xl border border-border bg-card/80 shadow-[0_10px_60px_-20px_rgba(0,0,0,0.5)] backdrop-blur-xl">
        <Tabs tab={tab} setTab={setTab} />
        {tab === "swap" && <SwapTab {...p} />}
        {tab === "limit" && <LimitTab {...p} />}
        {tab === "dca" && <DcaTab />}
      </div>
    </div>
  );
}

function Tabs({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const items: { id: Tab; label: string }[] = [
    { id: "swap", label: "Swap" },
    { id: "limit", label: "Limit" },
    { id: "dca", label: "DCA" },
  ];
  return (
    <div className="flex items-center justify-between border-b border-border/60 px-3 py-3">
      <div className="flex items-center gap-1 rounded-full bg-muted/40 p-1">
        {items.map((it) => (
          <button
            key={it.id}
            onClick={() => setTab(it.id)}
            className={`rounded-full px-4 py-1.5 text-xs font-semibold transition-colors ${
              tab === it.id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {it.label}
          </button>
        ))}
      </div>
      <button
        className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label="Settings"
      >
        <Settings className="h-4 w-4" />
      </button>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * SWAP — market-fill against the top of the book
 * The user picks a side (buy / sell). For BUY: pay SUI, receive HashShares
 * by filling the best ask. For SELL: pay HashShares, receive SUI by
 * filling the best bid.
 * ─────────────────────────────────────────────────────────────────────── */

function SwapTab(p: SwapCardProps) {
  const [side, setSide] = useState<Side>("buy");
  const [payAmount, setPayAmount] = useState("");

  // Best price visible on the relevant side, just for the "Best price" line.
  const topPrice =
    side === "buy"
      ? (p.asks[0]?.pricePerUnitMist ?? 0n)
      : (p.bids[0]?.pricePerUnitMist ?? 0n);
  const counterpartyAny =
    side === "buy" ? p.asks.length > 0 : p.bids.length > 0;

  // Walk the book to compute what would actually fill.
  const projection = useMemo(() => {
    if (!payAmount) return null;
    try {
      const pay = BigInt(payAmount);
      if (pay === 0n) return null;
      if (side === "buy") return walkBuyProjection(pay, p.asks);
      return walkSellProjection(pay, p.bids);
    } catch {
      return null;
    }
  }, [payAmount, side, p.asks, p.bids]);

  // Harmonised projection shape: totalUnits = HS units moved, totalQuote =
  // MIST moved. For buy: user pays totalQuote, receives totalUnits. For
  // sell: user pays totalUnits, receives totalQuote.
  const receiveEst =
    side === "buy"
      ? (projection?.totalUnits ?? 0n)
      : (projection?.totalQuote ?? 0n);
  const legCount = projection?.legs.length ?? 0;
  const canExecute = legCount > 0;

  // Weighted-average effective price (MIST per HS unit).
  const effectivePrice =
    projection && projection.totalUnits > 0n
      ? projection.totalQuote / projection.totalUnits
      : 0n;

  // Helper if the user's pay amount couldn't fully fit on the book.
  const helper = (() => {
    if (!projection || !payAmount) return "";
    if (legCount === 0) return "Book is too thin for this swap";
    try {
      const pay = BigInt(payAmount);
      if (side === "buy" && projection.totalQuote < pay) {
        const leftover = pay - projection.totalQuote;
        return `${leftover.toString()} ${baseUnitLabel(p.quote)} unfilled — book exhausted at this size`;
      }
      if (side === "sell" && projection.totalUnits < pay) {
        const leftover = pay - projection.totalUnits;
        return `${leftover.toString()} units unfilled — book exhausted at this size`;
      }
    } catch {}
    return "";
  })();

  function execute() {
    if (!canExecute) return;
    const pay = BigInt(payAmount);
    if (side === "buy") p.onSwapBuy(pay);
    else p.onSwapSell(pay);
  }

  // Pretty asset metadata
  const QUOTE: SwapAssetMeta = {
    symbol: p.quote.symbol,
    short: p.quote.symbol,
    helper: baseUnitLabel(p.quote),
  };
  const HS: SwapAssetMeta = {
    symbol: p.hsLabel,
    short: p.hsLabel,
    helper: "units",
  };
  // Which side is the quote (selectable) and which is the HashShare (fixed)?
  // Buy: pay QUOTE → receive HS.  Sell: pay HS → receive QUOTE.
  const payIsQuote = side === "buy";
  const payAsset = payIsQuote ? QUOTE : HS;
  const receiveAsset = payIsQuote ? HS : QUOTE;
  const payBalance = payIsQuote ? p.quoteBalance : p.hsBalance;
  const receiveBalance = payIsQuote ? p.hsBalance : p.quoteBalance;
  // Leave gas buffer when MAX-ing a SUI input so the tx itself can still pay
  // its gas fee. 0.05 SUI is generous for these PTBs.
  const GAS_BUFFER_MIST = 50_000_000n;
  function maxFromBalance(): string {
    if (payBalance === undefined) return "";
    if (side === "buy") {
      const usable =
        payBalance > GAS_BUFFER_MIST ? payBalance - GAS_BUFFER_MIST : 0n;
      return usable.toString();
    }
    return payBalance.toString();
  }
  const ctaLabel = !p.walletConnected
    ? "Connect wallet"
    : !counterpartyAny
      ? side === "buy"
        ? "No asks available"
        : "No bids available"
      : !payAmount
        ? "Enter an amount"
        : !canExecute
          ? "Book too thin"
          : side === "buy"
            ? `Buy ${p.hsLabel}`
            : `Sell ${p.hsLabel}`;

  return (
    <div className="px-4 pb-4 pt-3">
      <AssetPanel
        label="You pay"
        asset={payAsset}
        amount={payAmount}
        onAmountChange={setPayAmount}
        balance={payBalance}
        onMax={
          payBalance !== undefined
            ? () => setPayAmount(maxFromBalance())
            : undefined
        }
        quote={payIsQuote ? p.quote : undefined}
        onQuoteChange={payIsQuote ? p.onQuoteChange : undefined}
      />

      <FlipDivider
        onFlip={() => {
          setSide((s) => (s === "buy" ? "sell" : "buy"));
          setPayAmount("");
        }}
      />

      <AssetPanel
        label="You receive"
        asset={receiveAsset}
        amount={receiveEst === 0n ? "" : receiveEst.toString()}
        readOnly
        balance={receiveBalance}
        quote={!payIsQuote ? p.quote : undefined}
        onQuoteChange={!payIsQuote ? p.onQuoteChange : undefined}
      />

      <SwapDetails
        side={side}
        topPrice={topPrice}
        effectivePrice={effectivePrice}
        legCount={legCount}
        hsLabel={p.hsLabel}
        quote={p.quote}
        helper={helper}
      />

      <button
        onClick={execute}
        disabled={!p.walletConnected || !canExecute || p.pending}
        className="mt-3 w-full rounded-2xl bg-foreground py-4 text-sm font-semibold text-background transition-transform enabled:hover:scale-[1.005] disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
      >
        {ctaLabel}
      </button>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * LIMIT — price + quantity, place a standing order
 * ─────────────────────────────────────────────────────────────────────── */

function LimitTab(p: SwapCardProps) {
  const [side, setSide] = useState<Side>("buy");
  // `price` is the user-facing DECIMAL string ("0.000017"), not base units.
  // We convert to a u64 in `quote.decimals` base units inside `place()`
  // via `parseQuoteAmount`. `qty` stays an integer string (HashShare counts).
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState("");
  // Live PPS-derived reference: base units of quote per HashShare unit.
  // Only meaningful when SUI is the quote today (other tokens route
  // through DeepBook).
  const { fairMistPerShareUnit, satsPerDelta } = useHashprice();

  const referenceBase = useMemo(() => {
    if (!fairMistPerShareUnit || p.quote.symbol !== "SUI") return null;
    // Round to nearest integer base unit. Tiny values render as 0 — guard.
    const rounded = Math.max(1, Math.round(fairMistPerShareUnit));
    return BigInt(rounded);
  }, [fairMistPerShareUnit, p.quote.symbol]);

  // Pre-parse the price input once so notional + slippage + place() share
  // a single bigint conversion.
  const priceBaseUnits = useMemo(
    () => parseQuoteAmount(price, p.quote),
    [price, p.quote],
  );

  const notional = useMemo(() => {
    if (priceBaseUnits === null) return 0n;
    try {
      const q = BigInt(qty || "0");
      return priceBaseUnits * q;
    } catch {
      return 0n;
    }
  }, [priceBaseUnits, qty]);

  // % above/below the hashprice reference
  const slippageVsHashprice = useMemo(() => {
    if (!referenceBase || referenceBase === 0n || priceBaseUnits === null) {
      return null;
    }
    if (priceBaseUnits === 0n) return null;
    const diff = Number(priceBaseUnits) - Number(referenceBase);
    return (diff / Number(referenceBase)) * 100;
  }, [priceBaseUnits, referenceBase]);

  function place() {
    if (priceBaseUnits === null || !qty) return;
    let q: bigint;
    try {
      q = BigInt(qty);
    } catch {
      return;
    }
    if (priceBaseUnits === 0n || q === 0n) return;
    if (side === "buy") {
      // For a bid, budget = price × qty (the max amount of quote we'd spend).
      p.onPlaceBid(priceBaseUnits, priceBaseUnits * q);
    } else {
      p.onPlaceAsk(priceBaseUnits, q);
    }
  }

  const ctaLabel = !p.walletConnected
    ? "Connect wallet"
    : priceBaseUnits === null || !qty
      ? "Enter price and quantity"
      : side === "buy"
        ? `Place buy order`
        : `Place sell order`;

  return (
    <div className="px-4 pb-4 pt-3 space-y-3">
      {/* quote pill — embedded like Swap tab's asset picker */}
      <div className="flex items-center justify-between rounded-2xl border border-border/60 bg-muted/15 px-3 py-2 sm:px-4">
        <span className="font-mono text-[10px] sm:text-[11px] uppercase tracking-[0.2em] sm:tracking-[0.25em] text-muted-foreground">
          Quote
        </span>
        <QuoteSelector value={p.quote} onChange={p.onQuoteChange} />
      </div>

      {/* side toggle */}
      <div className="flex gap-2 rounded-full bg-muted/40 p-1">
        <button
          onClick={() => setSide("buy")}
          className={`flex-1 rounded-full py-2 text-xs font-semibold transition-colors ${
            side === "buy"
              ? "bg-emerald-500/15 text-emerald-400"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Buy
        </button>
        <button
          onClick={() => setSide("sell")}
          className={`flex-1 rounded-full py-2 text-xs font-semibold transition-colors ${
            side === "sell"
              ? "bg-rose-500/15 text-rose-400"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Sell
        </button>
      </div>

      {/* Hashprice reference — only meaningful when SUI is the quote */}
      {referenceBase != null && (
        <button
          type="button"
          onClick={() => {
            // Pre-fill the input with the *decimal* form (matches the
            // user-facing units). e.g. 1 MIST → "0.000000001".
            const dec = p.quote.decimals;
            const factor = BigInt(10) ** BigInt(dec);
            const whole = referenceBase / factor;
            const frac = referenceBase % factor;
            const fracStr = frac
              .toString()
              .padStart(dec, "0")
              .replace(/0+$/, "");
            setPrice(fracStr ? `${whole}.${fracStr}` : whole.toString());
          }}
          className="group flex w-full items-center justify-between gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5 text-left transition-colors hover:bg-emerald-500/10 sm:px-4"
        >
          <span className="flex min-w-0 items-center gap-2 sm:gap-2.5">
            <Zap className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
            <span className="flex flex-col">
              <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-emerald-300/90">
                Hashprice reference
              </span>
              <span className="font-mono text-xs sm:text-sm tabular-nums">
                <span className="text-foreground">
                  {formatPriceInQuote(referenceBase, p.quote)}
                </span>
                <span className="text-muted-foreground">/unit</span>
                {satsPerDelta != null && (
                  <span className="text-muted-foreground/70">
                    {" "}
                    · {(satsPerDelta * 1e9).toFixed(2)} pBTC/Δ
                  </span>
                )}
              </span>
            </span>
          </span>
          <span className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-emerald-300 transition-colors group-hover:bg-emerald-500/25">
            Use
          </span>
        </button>
      )}

      {/* price */}
      <LabeledNumericInput
        label="Limit price"
        suffix={`${p.quote.symbol}/unit`}
        value={price}
        onChange={setPrice}
        allowDecimal
        placeholder={
          referenceBase != null
            ? formatPriceInQuote(referenceBase, p.quote).replace(
                ` ${p.quote.symbol}`,
                "",
              )
            : "0"
        }
        rightHelper={
          slippageVsHashprice != null
            ? `${slippageVsHashprice > 0 ? "+" : ""}${slippageVsHashprice.toFixed(1)}% vs hashprice`
            : undefined
        }
      />

      {/* quantity */}
      <LabeledNumericInput
        label="Quantity"
        suffix={`${p.hsLabel} units`}
        value={qty}
        onChange={setQty}
        placeholder="0"
        rightHelper={
          side === "sell"
            ? `Balance ${formatUnits(p.hsBalance)}`
            : undefined
        }
        onMax={
          side === "sell"
            ? () => setQty(p.hsBalance.toString())
            : undefined
        }
      />

      {/* notional summary */}
      <div className="rounded-2xl border border-border/60 bg-muted/20 px-4 py-3 text-xs">
        <Row label="Notional">
          <span className="font-mono">
            {notional === 0n ? "—" : formatPriceInQuote(notional, p.quote)}
          </span>
        </Row>
        <Row label="Side">
          <span className={`font-mono ${side === "buy" ? "text-emerald-400" : "text-rose-400"}`}>
            {side === "buy" ? "Bid" : "Ask"}
          </span>
        </Row>
      </div>

      <button
        onClick={place}
        disabled={!p.walletConnected || !price || !qty || p.pending}
        className="w-full rounded-2xl bg-foreground py-4 text-sm font-semibold text-background transition-transform enabled:hover:scale-[1.005] disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
      >
        {ctaLabel}
      </button>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * DCA — placeholder for now; protocol doesn't have a DCA primitive yet.
 * ─────────────────────────────────────────────────────────────────────── */

function DcaTab() {
  return (
    <div className="px-6 pb-8 pt-6">
      <div className="rounded-2xl border border-dashed border-border/60 bg-muted/10 p-8 text-center">
        <Sparkles className="mx-auto h-6 w-6 text-muted-foreground" />
        <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
          Coming soon
        </p>
        <p className="mt-2 text-sm font-semibold">
          Dollar-cost-average into HashShares
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Drip-buy each round at the best ask. Set frequency, target round
          count, and price ceiling — the keeper will fill on your behalf.
        </p>
      </div>
    </div>
  );
}

/* ── shared bits ────────────────────────────────────────────────────────── */

function AssetPanel({
  label,
  asset,
  amount,
  onAmountChange,
  readOnly = false,
  balance,
  onMax,
  quote,
  onQuoteChange,
}: {
  label: string;
  asset: SwapAssetMeta;
  amount: string;
  onAmountChange?: (v: string) => void;
  readOnly?: boolean;
  /** When supplied, the right-side pill becomes a QuoteSelector dropdown
   *  instead of a static AssetPill. Only the quote side of a swap is
   *  user-selectable; the HashShare side stays static. */
  quote?: QuoteToken;
  onQuoteChange?: (q: QuoteToken) => void;
  balance?: bigint;
  onMax?: () => void;
}) {
  return (
    <div className="rounded-2xl border border-border/60 bg-muted/15 px-3 py-3 sm:px-4">
      <div className="flex items-center justify-between gap-2 text-[10px] sm:text-[11px] uppercase tracking-[0.2em] sm:tracking-[0.25em] text-muted-foreground">
        <span className="shrink-0">{label}</span>
        {balance !== undefined && (
          <span className="flex min-w-0 items-center gap-1 sm:gap-1.5 font-mono normal-case tracking-normal">
            <Wallet className="h-3 w-3 shrink-0" />
            <span className="truncate">{formatUnits(balance)} {asset.helper}</span>
            {onMax && (
              <button
                onClick={onMax}
                className="ml-1 shrink-0 rounded-full bg-foreground/10 px-2 py-0.5 text-[10px] text-foreground hover:bg-foreground/15"
              >
                MAX
              </button>
            )}
          </span>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 sm:gap-3">
        <input
          inputMode="numeric"
          value={amount}
          readOnly={readOnly}
          onChange={(e) =>
            onAmountChange?.(e.target.value.replace(/[^0-9]/g, ""))
          }
          placeholder="0"
          className="min-w-0 flex-1 bg-transparent font-mono text-2xl sm:text-3xl text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
        />
        {quote && onQuoteChange ? (
          <QuoteSelector value={quote} onChange={onQuoteChange} />
        ) : (
          <AssetPill asset={asset} />
        )}
      </div>
    </div>
  );
}

function AssetPill({ asset }: { asset: SwapAssetMeta }) {
  return (
    <div className="inline-flex shrink-0 items-center gap-1.5 sm:gap-2 rounded-full bg-foreground/5 px-2.5 sm:px-3 py-1.5 sm:py-2 ring-1 ring-border">
      <span className="grid h-5 w-5 sm:h-6 sm:w-6 place-items-center rounded-full bg-purple-500/15 text-[9px] sm:text-[10px] font-bold text-purple-400">
        {asset.short.startsWith("HS") ? "HS" : asset.short.slice(0, 2)}
      </span>
      <span className="font-mono text-xs sm:text-sm font-semibold">{asset.symbol}</span>
      <ChevronDown className="h-3 w-3 text-muted-foreground" />
    </div>
  );
}

function FlipDivider({ onFlip }: { onFlip: () => void }) {
  return (
    <div className="relative my-1.5 flex justify-center">
      <div className="absolute inset-x-0 top-1/2 h-px bg-border/60" />
      <button
        onClick={onFlip}
        className="relative grid h-9 w-9 place-items-center rounded-full border border-border bg-background text-foreground transition-transform hover:rotate-180"
        aria-label="Flip direction"
      >
        <ArrowDown className="h-4 w-4" />
      </button>
    </div>
  );
}

function SwapDetails({
  side,
  topPrice,
  effectivePrice,
  legCount,
  hsLabel,
  quote,
  helper,
}: {
  side: Side;
  topPrice: bigint;
  effectivePrice: bigint;
  legCount: number;
  hsLabel: string;
  quote: QuoteToken;
  helper: string;
}) {
  const [open, setOpen] = useState(false);
  const quoteSymbol = quote.symbol;
  const summary = (() => {
    if (effectivePrice > 0n) {
      return `Avg price · ${formatPriceInQuote(effectivePrice, quote)}/${hsLabel} · ${legCount} leg${legCount === 1 ? "" : "s"}`;
    }
    if (topPrice > 0n) {
      return `Best price · ${formatPriceInQuote(topPrice, quote)}/${hsLabel}`;
    }
    return "No price data";
  })();
  const slippageBps = (() => {
    if (topPrice === 0n || effectivePrice === 0n) return null;
    const diff =
      side === "buy" ? effectivePrice - topPrice : topPrice - effectivePrice;
    if (diff <= 0n) return 0;
    return Number((diff * 10000n) / topPrice) / 100;
  })();
  return (
    <div className="mt-3 rounded-2xl border border-border/60 bg-muted/10">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-xs text-muted-foreground"
      >
        <span>{summary}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="space-y-1.5 border-t border-border/40 px-4 py-3 text-xs">
          <Row label="Direction">
            <span className="font-mono">
              {side === "buy"
                ? `${quoteSymbol} → ${hsLabel}`
                : `${hsLabel} → ${quoteSymbol}`}
            </span>
          </Row>
          <Row label="Route">
            <span className="font-mono">
              m1n3 share market · multi-fill (up to 8 legs)
            </span>
          </Row>
          {topPrice > 0n && (
            <Row label="Top of book">
              <span className="font-mono">
                {formatPriceInQuote(topPrice, quote)}/{hsLabel}
              </span>
            </Row>
          )}
          {effectivePrice > 0n && (
            <Row label="Effective price">
              <span className="font-mono">
                {formatPriceInQuote(effectivePrice, quote)}/{hsLabel}
              </span>
            </Row>
          )}
          {slippageBps !== null && (
            <Row label="Slippage vs top">
              <span
                className={`font-mono ${slippageBps > 1 ? "text-amber-400" : "text-foreground"}`}
              >
                {slippageBps.toFixed(2)}%
              </span>
            </Row>
          )}
          <Row label="Protocol fee">
            <span className="font-mono">2% on every fill</span>
          </Row>
          {helper && (
            <Row label="Note">
              <span className="font-mono text-amber-400">{helper}</span>
            </Row>
          )}
        </div>
      )}
    </div>
  );
}

/* ── projection helpers (mirror of marketplace/page.tsx walkers) ─────────
 * Kept here so the SwapCard can render the receive estimate without a
 * round-trip; the parent's `onSwapBuy/onSwapSell` re-derive the same legs
 * before sending the tx. The two implementations must agree on price /
 * cap rules — both walk the same `bids`/`asks` arrays sorted by best price.
 */
type Projection = {
  legs: { order: ShareMarketOrder; units: bigint; gross: bigint }[];
  totalUnits: bigint;
  totalQuote: bigint;
};

function walkBuyProjection(payMist: bigint, asks: ShareMarketOrder[]): Projection {
  const legs: Projection["legs"] = [];
  let remaining = payMist;
  for (const ask of asks.slice(0, 8)) {
    if (remaining === 0n) break;
    const affordable = remaining / ask.pricePerUnitMist;
    const units = affordable > ask.maxUnits ? ask.maxUnits : affordable;
    if (units === 0n) continue;
    const gross = units * ask.pricePerUnitMist;
    legs.push({ order: ask, units, gross });
    remaining -= gross;
  }
  const totalUnits = legs.reduce((s, l) => s + l.units, 0n);
  const totalQuote = legs.reduce((s, l) => s + l.gross, 0n);
  return { legs, totalUnits, totalQuote };
}

function walkSellProjection(payUnits: bigint, bids: ShareMarketOrder[]): Projection {
  const legs: Projection["legs"] = [];
  let remaining = payUnits;
  for (const bid of bids.slice(0, 8)) {
    if (remaining === 0n) break;
    const units = remaining > bid.maxUnits ? bid.maxUnits : remaining;
    if (units === 0n) continue;
    const gross = units * bid.pricePerUnitMist;
    legs.push({ order: bid, units, gross });
    remaining -= units;
  }
  const totalUnits = legs.reduce((s, l) => s + l.units, 0n);
  const totalQuote = legs.reduce((s, l) => s + l.gross, 0n);
  return { legs, totalUnits, totalQuote };
}

function LabeledNumericInput({
  label,
  suffix,
  value,
  onChange,
  placeholder,
  rightHelper,
  onMax,
  allowDecimal = false,
}: {
  label: string;
  suffix: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rightHelper?: string;
  onMax?: () => void;
  /** When set, the input accepts a single `.` for decimal entry. Off by
   *  default so quantity/budget fields stay integer-only. */
  allowDecimal?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-border/60 bg-muted/15 px-4 py-3">
      <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.25em] text-muted-foreground">
        <span>{label}</span>
        {rightHelper && (
          <span className="flex items-center gap-1.5 font-mono normal-case tracking-normal">
            {rightHelper}
            {onMax && (
              <button
                onClick={onMax}
                className="rounded-full bg-foreground/10 px-2 py-0.5 text-[10px] text-foreground hover:bg-foreground/15"
              >
                MAX
              </button>
            )}
          </span>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between gap-3">
        <input
          inputMode={allowDecimal ? "decimal" : "numeric"}
          value={value}
          onChange={(e) => {
            const raw = e.target.value;
            if (allowDecimal) {
              // Allow ASCII digits and one decimal point. The second
              // pass strips any further dots the user types after the
              // first is already present.
              const cleaned = raw
                .replace(/[^0-9.]/g, "")
                .replace(/(\..*)\./g, "$1");
              onChange(cleaned);
            } else {
              onChange(raw.replace(/[^0-9]/g, ""));
            }
          }}
          placeholder={placeholder ?? "0"}
          className="min-w-0 flex-1 bg-transparent font-mono text-2xl sm:text-3xl text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
        />
        <span className="shrink-0 rounded-full bg-foreground/5 px-3 py-2 font-mono text-xs text-muted-foreground ring-1 ring-border">
          {suffix}
        </span>
      </div>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/* ── formatting helpers ─────────────────────────────────────────────────── */

function formatUnits(n: bigint): string {
  if (n < 1000n) return n.toString();
  if (n < 1_000_000n) return `${(Number(n) / 1000).toFixed(1)}K`;
  if (n < 1_000_000_000n) return `${(Number(n) / 1_000_000).toFixed(2)}M`;
  return `${(Number(n) / 1_000_000_000).toFixed(2)}B`;
}

function formatMist(n: bigint): string {
  // Render MIST as SUI for readability when large
  if (n >= 1_000_000_000n) {
    return `${(Number(n) / 1e9).toFixed(4)}`;
  }
  return n.toString();
}
