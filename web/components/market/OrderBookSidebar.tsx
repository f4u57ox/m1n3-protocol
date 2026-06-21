"use client";

import { useMemo } from "react";
import type { ShareMarketOrder } from "@/hooks/useShareMarketOrders";
import { useHashprice } from "@/hooks/useHashprice";
import type { QuoteToken } from "@/lib/quote-tokens";
import { baseUnitLabel, formatPriceInQuote } from "@/lib/quote-format";

/**
 * Small "is this stablecoin $1" registry. Anything in here is treated as
 * 1 quote unit = $1 (USD). For everything else (SUI, ETH, etc.) we fall
 * back to the live spot price from `useHashprice` when we have it.
 */
const USD_PEGGED = new Set(["USDC", "DUSDC", "USDT", "USDY", "DBUSDC", "DBUSDT"]);

/** Price × quantity → notional in USD, network-rate-aware. Returns null if
 *  we don't have a usable rate (e.g. SUI but suiPrice not yet loaded). */
function notionalUsd(
  priceBaseUnits: bigint,
  units: bigint,
  quote: QuoteToken,
  suiPrice: number | null,
): number | null {
  const totalBase = Number(priceBaseUnits * units);
  const quoteAmount = totalBase / 10 ** quote.decimals;
  if (USD_PEGGED.has(quote.symbol)) return quoteAmount;
  if (quote.symbol === "SUI") {
    if (!suiPrice || suiPrice <= 0) return null;
    return quoteAmount * suiPrice;
  }
  return null;
}

/**
 * Compact orderbook + my-orders side rail. Asks first (top, red), bids second
 * (bottom, green) — DEX convention. Each row carries a depth bar (proportional
 * to the largest visible order on that side) so the user gets a quick read of
 * liquidity at a glance.
 */
export function OrderBookSidebar({
  bids,
  asks,
  loading,
  myAddress,
  onCancel,
  quote,
}: {
  bids: ShareMarketOrder[];
  asks: ShareMarketOrder[];
  loading: boolean;
  myAddress?: string;
  onCancel?: (order: ShareMarketOrder) => void;
  quote: QuoteToken;
}) {
  const mine = useMemo(
    () =>
      myAddress
        ? [...bids, ...asks].filter((o) => o.owner === myAddress)
        : [],
    [bids, asks, myAddress],
  );

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-2xl border border-border bg-card/60 backdrop-blur">
        <Header label="Order book" />
        {loading ? (
          <div className="p-6 text-center text-xs text-muted-foreground">
            Loading…
          </div>
        ) : (
          <>
            <Side
              orders={asks.slice().reverse().slice(-10)}
              side="ask"
              quote={quote}
            />
            <Spread bids={bids} asks={asks} quote={quote} />
            <Side orders={bids.slice(0, 10)} side="bid" quote={quote} />
          </>
        )}
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card/60 backdrop-blur">
        <Header label="Your orders" />
        {!myAddress ? (
          <div className="p-6 text-center text-xs text-muted-foreground">
            Connect wallet to see your open orders.
          </div>
        ) : mine.length === 0 ? (
          <div className="p-6 text-center text-xs text-muted-foreground">
            You have no open orders on this round.
          </div>
        ) : (
          <MyOrdersList orders={mine} onCancel={onCancel} quote={quote} />
        )}
      </div>
    </div>
  );
}

function MyOrdersList({
  orders,
  onCancel,
  quote,
}: {
  orders: ShareMarketOrder[];
  onCancel?: (o: ShareMarketOrder) => void;
  quote: QuoteToken;
}) {
  const { suiPrice } = useHashprice();
  function totalUsd(o: ShareMarketOrder): number | null {
    return notionalUsd(o.pricePerUnitMist, o.maxUnits, quote, suiPrice);
  }
  return (
    <ul className="divide-y divide-border/40">
      {orders.map((o) => {
        const usd = totalUsd(o);
        return (
          <li
            key={o.objectId}
            className="flex items-center gap-3 px-4 py-2.5 text-xs"
          >
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                o.side === "bid"
                  ? "bg-emerald-500/15 text-emerald-400"
                  : "bg-rose-500/15 text-rose-400"
              }`}
            >
              {o.side === "bid" ? "Buy" : "Sell"}
            </span>
            <div className="flex flex-col leading-tight">
              <span className="font-mono tabular-nums">
                {formatUnits(o.maxUnits)}{" "}
                <span className="text-muted-foreground">@ {o.pricePerUnitMist.toString()}</span>
              </span>
              <span className="text-[10px] text-muted-foreground">
                {usd != null
                  ? `≈ ${formatUsd(usd)} total`
                  : `${o.pricePerUnitMist} ${baseUnitLabel(quote)}/unit`}
              </span>
            </div>
            {onCancel && (
              <button
                onClick={() => onCancel(o)}
                className="ml-auto rounded-full bg-foreground/10 px-2 py-1 text-[10px] uppercase tracking-wider text-foreground/80 hover:bg-foreground/15"
              >
                Cancel
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Header({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border/60 px-4 py-2.5">
      <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
        {label}
      </p>
    </div>
  );
}

function Side({
  orders,
  side,
  quote,
}: {
  orders: ShareMarketOrder[];
  side: "bid" | "ask";
  quote: QuoteToken;
}) {
  const max = useMemo(
    () =>
      orders.reduce(
        (m, o) => (o.maxUnits > m ? o.maxUnits : m),
        1n,
      ),
    [orders],
  );

  if (orders.length === 0) {
    return (
      <div className="px-4 py-3 text-center text-[11px] text-muted-foreground">
        No {side === "bid" ? "bids" : "asks"} on the book
      </div>
    );
  }

  return <SideRows orders={orders} side={side} max={max} quote={quote} />;
}

function SideRows({
  orders,
  side,
  max,
  quote,
}: {
  orders: ShareMarketOrder[];
  side: "bid" | "ask";
  max: bigint;
  quote: QuoteToken;
}) {
  const { suiPrice } = useHashprice();
  return (
    <ul className="px-1 py-1.5">
      <li className="grid grid-cols-[1fr_auto_auto] gap-2 px-3 pb-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
        <span>price ({quote.symbol}/unit)</span>
        <span className="text-right">size · units</span>
        <span className="w-16 text-right">depth</span>
      </li>
      {orders.map((o) => {
        const pct = max > 0n ? Number((o.maxUnits * 100n) / max) : 0;
        const usd = notionalUsd(o.pricePerUnitMist, 1n, quote, suiPrice);
        const priceStr = formatPriceInQuote(o.pricePerUnitMist, quote);
        return (
          <li
            key={o.objectId}
            className="relative grid grid-cols-[1fr_auto_auto] items-center gap-2 px-3 py-1 font-mono text-xs"
          >
            <span
              aria-hidden
              className={`absolute inset-y-0.5 left-0 right-0 rounded-sm ${
                side === "bid" ? "bg-emerald-500/10" : "bg-rose-500/10"
              }`}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
            <span
              className={`relative flex flex-col leading-tight ${
                side === "bid" ? "text-emerald-400" : "text-rose-400"
              }`}
            >
              <span>{priceStr}</span>
              <span className="text-[9px] text-muted-foreground/70">
                {o.pricePerUnitMist.toString()} {baseUnitLabel(quote)}
                {usd != null && ` · ≈ ${formatUsd(usd)}`}
              </span>
            </span>
            <span className="relative text-right tabular-nums">
              {formatUnits(o.maxUnits)}
            </span>
            <span className="relative w-16 text-right text-muted-foreground">
              {pct.toFixed(0)}%
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/* ── number formatting helpers ─────────────────────────────────────────── */

function formatUnits(n: bigint): string {
  if (n < 1000n) return n.toString();
  if (n < 1_000_000n) return `${(Number(n) / 1000).toFixed(1)}K`;
  if (n < 1_000_000_000n) return `${(Number(n) / 1_000_000).toFixed(2)}M`;
  return `${(Number(n) / 1_000_000_000).toFixed(2)}B`;
}

function formatUsd(n: number): string {
  if (n === 0) return "$0";
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  if (n >= 1e-6) return `$${(n * 1e6).toFixed(2)} µ`; // micro-dollars
  return `$${(n * 1e9).toFixed(2)} n`;                 // nano-dollars
}

function Spread({
  bids,
  asks,
  quote,
}: {
  bids: ShareMarketOrder[];
  asks: ShareMarketOrder[];
  quote: QuoteToken;
}) {
  const { suiPrice } = useHashprice();
  const topBid = bids[0]?.pricePerUnitMist ?? 0n;
  const topAsk = asks[0]?.pricePerUnitMist ?? 0n;
  if (topBid === 0n || topAsk === 0n) {
    return (
      <div className="border-y border-border/40 bg-muted/10 px-4 py-2 text-center font-mono text-[11px] uppercase tracking-[0.25em] text-muted-foreground">
        spread —
      </div>
    );
  }
  const spread = topAsk - topBid;
  const pct = Number((spread * 10000n) / topAsk) / 100;
  const spreadUsd = notionalUsd(spread, 1n, quote, suiPrice);
  return (
    <div className="border-y border-border/40 bg-muted/20 px-4 py-2 text-center font-mono text-[10px] uppercase tracking-[0.2em]">
      <span className="text-muted-foreground">spread</span>{" "}
      <span className="text-foreground">
        {formatPriceInQuote(spread, quote)}
        {spreadUsd != null && ` · ≈ ${formatUsd(spreadUsd)}`}
      </span>{" "}
      <span className="text-muted-foreground">({pct.toFixed(2)}%)</span>
    </div>
  );
}
