"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCurrentAccount, useSignAndExecuteTransaction } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import Link from "next/link";
import { useShareMarketOrders, type ShareMarketOrder } from "@/hooks/useShareMarketOrders";
import { useHashShareBalances } from "@/hooks/useHashShareBalances";
import { useHashShareBindings } from "@/hooks/useHashShareRedemptions";
import { useQuoteCoins } from "@/hooks/useQuoteCoins";
import { useMarketVolume } from "@/hooks/useMarketVolume";
import {
  useHashpowerOrders,
  type HashpowerOrder,
  type OrderFill,
} from "@/hooks/useHashpowerOrders";
import { formatPriceInQuote, parseQuoteAmount } from "@/lib/quote-format";
import { PACKAGE_ID } from "@/lib/constants";
import { useSuiQuery } from "@/hooks/useSuiQuery";
import { fetchTemplateById } from "@/lib/sui-queries";
import { TemplateCard } from "@/components/TemplateCard";
import { RoundSelector } from "@/components/market/RoundSelector";
import { SwapCard } from "@/components/market/SwapCard";
import { OrderBookSidebar } from "@/components/market/OrderBookSidebar";
import { DeepBookSwapPanel } from "@/components/market/DeepBookSwapPanel";
import { QUOTE_TOKENS, type QuoteToken } from "@/lib/quote-tokens";

type MarketTab = "public" | "private";

/**
 * Marketplace page — two side-by-side rails for trading mining work.
 *
 * **Public tab** (`?tab=public`, default): the round-bound HashShare
 * orderbook. Each Bitcoin round mints `Coin<HS_NNN>` to miners
 * proportional to share work; this tab lets anyone trade those
 * fungible HashShares against the chosen quote (USDC on mainnet, SUI on
 * testnet) via `hash_share_market::{place_buy_order, place_sell_order,
 * fill_buy_order, fill_sell_order}`. Renders {@link SwapCard} +
 * {@link OrderBookSidebar} for the active round.
 *
 * **Private tab** (`?tab=private`): the direct buyer ↔ miner rail.
 * Surfaces every open hashpower-buy order regardless of quote coin
 * (via {@link useHashpowerOrders}), discriminated by `order.kind`:
 *
 *   - `"v1"` — `pool::HashpowerBuyOrder<QuoteT>`, pinned to a single
 *     `Template.id`. Legacy; rendered with a `TEMPLATE-PINNED` chip.
 *   - `"v2"` — `pool::BuyerHashpowerOrder<QuoteT>`, buyer-bound. Any
 *     `Template` whose `owner == order.buyer` drains it. Rendered with
 *     a `BUYER-BOUND` chip and a computed `latestTemplateId` indicator.
 *
 * The owner of an order (connected wallet === `order.buyer`) gets an
 * inline manage panel with cancel / re-price (V2 dynamic only) / top
 * up actions. {@link entryName} routes each action to the right Move
 * entry based on the order's `kind`, so V1 and V2 orders coexist
 * cleanly under the same UI surface — no separate page per kind.
 */
function MarketplaceInner() {
  const router = useRouter();
  const params = useSearchParams();
  const coin = params.get("coin") ?? "";

  const [tab, setTab] = useState<MarketTab>(
    (params.get("tab") as MarketTab) === "private" ? "private" : "public",
  );

  const account = useCurrentAccount();
  const bindings = useHashShareBindings();

  // Quote currency selector — the first entry in QUOTE_TOKENS is the
  // network's primary in-house market quote (USDC on mainnet, SUI on
  // testnet — see `web/lib/quote-tokens.ts`). Others route through
  // DeepBookV3.
  const [quote, setQuote] = useState<QuoteToken>(QUOTE_TOKENS[0]);

  const orders = useShareMarketOrders(coin, quote.type);
  const hashshares = useHashShareBalances(account?.address);
  // Cumulative quote-token volume traded through the in-house market across
  // all HashShare round coins. Single KPI surfaced in the page header.
  const marketVolume = useMarketVolume();
  // Live owned coin objects for whichever quote asset is selected. Used
  // for both `getBalance`-style displays and as the spendable input to
  // `placeBid`/`fillAsk`/`swapBuy` PTBs — we never spend from `tx.gas`
  // directly any more because on mainnet `tx.gas` is SUI and the in-house
  // market expects `Coin<USDC>` payments.
  const quoteCoins = useQuoteCoins(account?.address, quote.type);

  // Default to the latest-round binding when no ?coin= is present.
  // Only fires once we have data — keeps a loader visible until then.
  const latestCoin = useMemo(() => {
    const map = new Map<string, bigint>();
    for (const b of bindings.data ?? []) {
      const cur = map.get(b.fullType);
      if (!cur || cur < b.roundId) map.set(b.fullType, b.roundId);
    }
    const list = Array.from(map.entries()).sort((a, b) =>
      Number(b[1] - a[1]),
    );
    return list[0]?.[0] ?? "";
  }, [bindings.data]);

  useEffect(() => {
    if (coin) return;
    if (bindings.isLoading) return;
    if (!latestCoin) return;
    router.replace(`/marketplace?coin=${encodeURIComponent(latestCoin)}`);
  }, [coin, bindings.isLoading, latestCoin, router]);

  const { mutateAsync: signAndExecute, isPending } =
    useSignAndExecuteTransaction();
  const [lastResult, setLastResult] = useState<
    null | { kind: "ok"; digest: string } | { kind: "err"; message: string }
  >(null);

  const myInventory = useMemo(
    () => hashshares.data?.find((b) => b.fullType === coin),
    [hashshares.data, coin],
  );
  const myShareBalance = myInventory?.balanceUnits ?? 0n;

  // The active round's label, derived once.
  const activeLabel = useMemo(() => {
    const b = (bindings.data ?? [])
      .filter((x) => x.fullType === coin)
      .sort((a, b) => Number(b.roundId - a.roundId))[0];
    return b?.label ?? coin.slice(0, 6);
  }, [bindings.data, coin]);

  // ── Move-call wrappers (kept thin; bug-for-bug equivalent to the old page) ──

  async function placeBid(price: bigint, budget: bigint) {
    setLastResult(null);
    try {
      if (price === 0n || budget === 0n) {
        setLastResult({ kind: "err", message: "Price and budget must be > 0" });
        return;
      }
      if (quoteCoins.balance < budget) {
        setLastResult({
          kind: "err",
          message: `Insufficient ${quote.symbol} balance`,
        });
        return;
      }
      const tx = new Transaction();
      const payment = splitQuote(tx, quoteCoins.ids, budget);
      tx.moveCall({
        target: `${PACKAGE_ID}::hash_share_market::place_buy_order`,
        typeArguments: [coin, quote.type],
        arguments: [tx.pure.u64(price), tx.pure.u64(0n), payment],
      });
      const r = await signAndExecute({
        transaction: tx as unknown as Parameters<typeof signAndExecute>[0]["transaction"],
      });
      setLastResult({ kind: "ok", digest: r.digest });
      orders.refetch();
      quoteCoins.refetch();
    } catch (e) {
      setLastResult({
        kind: "err",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function placeAsk(price: bigint, units: bigint) {
    setLastResult(null);
    try {
      if (price === 0n || units === 0n) {
        setLastResult({ kind: "err", message: "Price and units must be > 0" });
        return;
      }
      if (!myInventory || myInventory.coinObjectIds.length === 0) {
        setLastResult({ kind: "err", message: "No HashShare inventory in wallet" });
        return;
      }
      if (units > myInventory.balanceUnits) {
        setLastResult({ kind: "err", message: "Insufficient inventory" });
        return;
      }
      const tx = new Transaction();
      const [first, ...rest] = myInventory.coinObjectIds;
      if (rest.length > 0) {
        tx.mergeCoins(tx.object(first), rest.map((r) => tx.object(r)));
      }
      const [inv] = tx.splitCoins(tx.object(first), [tx.pure.u64(units)]);
      tx.moveCall({
        target: `${PACKAGE_ID}::hash_share_market::place_sell_order`,
        typeArguments: [coin, quote.type],
        arguments: [tx.pure.u64(price), tx.pure.u64(0n), inv],
      });
      const r = await signAndExecute({
        transaction: tx as unknown as Parameters<typeof signAndExecute>[0]["transaction"],
      });
      setLastResult({ kind: "ok", digest: r.digest });
      orders.refetch();
      hashshares.refetch();
    } catch (e) {
      setLastResult({
        kind: "err",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function fillAsk(order: ShareMarketOrder, units: bigint) {
    setLastResult(null);
    try {
      let buyUnits = units;
      if (buyUnits > order.maxUnits) buyUnits = order.maxUnits;
      if (buyUnits === 0n) {
        setLastResult({ kind: "err", message: "Computed fill quantity = 0" });
        return;
      }
      const gross = buyUnits * order.pricePerUnitMist;
      const feePoolId = process.env.NEXT_PUBLIC_HASH_SHARE_MARKET_FEE_POOL_ID;
      if (!feePoolId) {
        setLastResult({
          kind: "err",
          message: "NEXT_PUBLIC_HASH_SHARE_MARKET_FEE_POOL_ID not set",
        });
        return;
      }
      if (quoteCoins.balance < gross) {
        setLastResult({
          kind: "err",
          message: `Insufficient ${quote.symbol} for fill`,
        });
        return;
      }
      const tx = new Transaction();
      const payment = splitQuote(tx, quoteCoins.ids, gross);
      tx.moveCall({
        target: `${PACKAGE_ID}::hash_share_market::fill_sell_order`,
        typeArguments: [coin, quote.type],
        arguments: [
          tx.object(order.objectId),
          tx.object(feePoolId),
          payment,
          tx.pure.u64(buyUnits),
        ],
      });
      const r = await signAndExecute({
        transaction: tx as unknown as Parameters<typeof signAndExecute>[0]["transaction"],
      });
      setLastResult({ kind: "ok", digest: r.digest });
      orders.refetch();
      hashshares.refetch();
      quoteCoins.refetch();
    } catch (e) {
      setLastResult({
        kind: "err",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function fillBid(order: ShareMarketOrder, units: bigint) {
    setLastResult(null);
    try {
      if (!myInventory || myInventory.coinObjectIds.length === 0) {
        setLastResult({ kind: "err", message: "No HashShare inventory to sell" });
        return;
      }
      let sellUnits = units;
      if (sellUnits > order.maxUnits) sellUnits = order.maxUnits;
      if (sellUnits > myInventory.balanceUnits) sellUnits = myInventory.balanceUnits;
      if (sellUnits === 0n) {
        setLastResult({ kind: "err", message: "Computed fill quantity = 0" });
        return;
      }
      const tx = new Transaction();
      const [first, ...rest] = myInventory.coinObjectIds;
      if (rest.length > 0) {
        tx.mergeCoins(tx.object(first), rest.map((r) => tx.object(r)));
      }
      const [payment] = tx.splitCoins(tx.object(first), [tx.pure.u64(sellUnits)]);
      const feePoolId = process.env.NEXT_PUBLIC_HASH_SHARE_MARKET_FEE_POOL_ID;
      if (!feePoolId) {
        setLastResult({
          kind: "err",
          message: "NEXT_PUBLIC_HASH_SHARE_MARKET_FEE_POOL_ID not set",
        });
        return;
      }
      tx.moveCall({
        target: `${PACKAGE_ID}::hash_share_market::fill_buy_order`,
        typeArguments: [coin, quote.type],
        arguments: [tx.object(order.objectId), tx.object(feePoolId), payment],
      });
      const r = await signAndExecute({
        transaction: tx as unknown as Parameters<typeof signAndExecute>[0]["transaction"],
      });
      setLastResult({ kind: "ok", digest: r.digest });
      orders.refetch();
      hashshares.refetch();
      quoteCoins.refetch();
    } catch (e) {
      setLastResult({
        kind: "err",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Walk the book up to `maxOrders` asks in price-ascending order, chaining
   * one `fill_sell_order` per ask in a single PTB. The user spends up to
   * `payMist` worth of SUI; whatever doesn't slot into a leg is unused.
   *
   * `simulate=true` returns the projection without sending the tx — used by
   * the SwapCard estimate so the receive number reflects what would *actually*
   * land, not just the top-of-book price.
   */
  function walkBuy(payMist: bigint, asks: ShareMarketOrder[], maxOrders = 8) {
    const legs: { order: ShareMarketOrder; units: bigint; gross: bigint }[] = [];
    let remaining = payMist;
    for (const ask of asks.slice(0, maxOrders)) {
      if (remaining === 0n) break;
      const affordable = remaining / ask.pricePerUnitMist;
      const units = affordable > ask.maxUnits ? ask.maxUnits : affordable;
      if (units === 0n) continue;
      const gross = units * ask.pricePerUnitMist;
      legs.push({ order: ask, units, gross });
      remaining -= gross;
    }
    const totalUnits = legs.reduce((s, l) => s + l.units, 0n);
    const totalSpend = legs.reduce((s, l) => s + l.gross, 0n);
    return { legs, totalUnits, totalSpend };
  }

  /**
   * Mirror of `walkBuy` for selling: walk bids in price-descending order,
   * accumulating up to `payUnits` of HashShare inventory.
   */
  function walkSell(payUnits: bigint, bids: ShareMarketOrder[], maxOrders = 8) {
    const legs: { order: ShareMarketOrder; units: bigint; gross: bigint }[] = [];
    let remaining = payUnits;
    for (const bid of bids.slice(0, maxOrders)) {
      if (remaining === 0n) break;
      const units = remaining > bid.maxUnits ? bid.maxUnits : remaining;
      if (units === 0n) continue;
      const gross = units * bid.pricePerUnitMist;
      legs.push({ order: bid, units, gross });
      remaining -= units;
    }
    const totalUnits = legs.reduce((s, l) => s + l.units, 0n);
    const totalReceive = legs.reduce((s, l) => s + l.gross, 0n);
    return { legs, totalUnits, totalReceive };
  }

  async function swapBuy(payMist: bigint) {
    setLastResult(null);
    try {
      const feePoolId = process.env.NEXT_PUBLIC_HASH_SHARE_MARKET_FEE_POOL_ID;
      if (!feePoolId) {
        setLastResult({
          kind: "err",
          message: "NEXT_PUBLIC_HASH_SHARE_MARKET_FEE_POOL_ID not set",
        });
        return;
      }
      const asks = orders.data?.asks ?? [];
      const { legs } = walkBuy(payMist, asks);
      if (legs.length === 0) {
        setLastResult({
          kind: "err",
          message: "Couldn't fill any asks for that pay amount",
        });
        return;
      }
      const totalCost = legs.reduce((s, l) => s + l.gross, 0n);
      if (quoteCoins.balance < totalCost) {
        setLastResult({
          kind: "err",
          message: `Insufficient ${quote.symbol} for full walk`,
        });
        return;
      }
      const tx = new Transaction();
      // Merge all quote coins into the first so we can split N legs off
      // a single coin object inside the PTB.
      const [quoteFirst, ...quoteRest] = quoteCoins.ids;
      if (quoteRest.length > 0) {
        tx.mergeCoins(
          tx.object(quoteFirst),
          quoteRest.map((id) => tx.object(id)),
        );
      }
      for (const leg of legs) {
        const [payment] = tx.splitCoins(tx.object(quoteFirst), [
          tx.pure.u64(leg.gross),
        ]);
        tx.moveCall({
          target: `${PACKAGE_ID}::hash_share_market::fill_sell_order`,
          typeArguments: [coin, quote.type],
          arguments: [
            tx.object(leg.order.objectId),
            tx.object(feePoolId),
            payment,
            tx.pure.u64(leg.units),
          ],
        });
      }
      const r = await signAndExecute({
        transaction: tx as unknown as Parameters<typeof signAndExecute>[0]["transaction"],
      });
      setLastResult({ kind: "ok", digest: r.digest });
      orders.refetch();
      hashshares.refetch();
      quoteCoins.refetch();
    } catch (e) {
      setLastResult({
        kind: "err",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function swapSell(payUnits: bigint) {
    setLastResult(null);
    try {
      const feePoolId = process.env.NEXT_PUBLIC_HASH_SHARE_MARKET_FEE_POOL_ID;
      if (!feePoolId) {
        setLastResult({
          kind: "err",
          message: "NEXT_PUBLIC_HASH_SHARE_MARKET_FEE_POOL_ID not set",
        });
        return;
      }
      if (!myInventory || myInventory.coinObjectIds.length === 0) {
        setLastResult({ kind: "err", message: "No HashShare inventory to sell" });
        return;
      }
      const cap = payUnits > myInventory.balanceUnits ? myInventory.balanceUnits : payUnits;
      const bids = orders.data?.bids ?? [];
      const { legs } = walkSell(cap, bids);
      if (legs.length === 0) {
        setLastResult({
          kind: "err",
          message: "No bids on the book to sell into",
        });
        return;
      }
      const tx = new Transaction();
      const [first, ...rest] = myInventory.coinObjectIds;
      if (rest.length > 0) {
        tx.mergeCoins(tx.object(first), rest.map((r) => tx.object(r)));
      }
      for (const leg of legs) {
        const [inv] = tx.splitCoins(tx.object(first), [tx.pure.u64(leg.units)]);
        tx.moveCall({
          target: `${PACKAGE_ID}::hash_share_market::fill_buy_order`,
          typeArguments: [coin, quote.type],
          arguments: [tx.object(leg.order.objectId), tx.object(feePoolId), inv],
        });
      }
      const r = await signAndExecute({
        transaction: tx as unknown as Parameters<typeof signAndExecute>[0]["transaction"],
      });
      setLastResult({ kind: "ok", digest: r.digest });
      orders.refetch();
      hashshares.refetch();
      quoteCoins.refetch();
    } catch (e) {
      setLastResult({
        kind: "err",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function cancel(order: ShareMarketOrder) {
    setLastResult(null);
    try {
      const tx = new Transaction();
      const target = order.side === "bid"
        ? `${PACKAGE_ID}::hash_share_market::cancel_buy_order`
        : `${PACKAGE_ID}::hash_share_market::cancel_sell_order`;
      tx.moveCall({
        target,
        typeArguments: [coin, quote.type],
        arguments: [tx.object(order.objectId)],
      });
      const r = await signAndExecute({
        transaction: tx as unknown as Parameters<typeof signAndExecute>[0]["transaction"],
      });
      setLastResult({ kind: "ok", digest: r.digest });
      orders.refetch();
    } catch (e) {
      setLastResult({
        kind: "err",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ── Render ────────────────────────────────────────────────────────────

  // Public-tab early returns. The private tab doesn't depend on round
  // bindings — it shows global HashpowerBuyOrders — so we let it render
  // even before the HashShare market data resolves.
  if (tab === "public") {
    if (!coin && bindings.isLoading) {
      return (
        <PageShell tab={tab} setTab={setTab}>
          <FullPageLoader label="Loading the most recent round…" />
        </PageShell>
      );
    }
    if (!coin && (bindings.data ?? []).length === 0) {
      return (
        <PageShell tab={tab} setTab={setTab}>
          <EmptyState />
        </PageShell>
      );
    }
    if (!coin) {
      return (
        <PageShell tab={tab} setTab={setTab}>
          <FullPageLoader label="Loading market…" />
        </PageShell>
      );
    }
  }

  const bids = orders.data?.bids ?? [];
  const asks = orders.data?.asks ?? [];

  return (
    <>
      <title>
        {tab === "private"
          ? "m1n3 — private hashpower market"
          : `m1n3 — ${activeLabel} market`}
      </title>
      <div className="space-y-6">
        {/* ── Header + tab switcher ────────────────────────────────── */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Share market</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {tab === "public" ? (
                <>
                  Trade HashShares against{" "}
                  <span className="font-mono">{quote.symbol}</span>. Each round
                  is a fresh orderbook on its own coin type.
                </>
              ) : (
                <>
                  Direct buyer ↔ miner orders — no round binding, no HashShare
                  mint. Per-share USDC payouts from a buyer-funded budget.
                </>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2 max-w-full overflow-x-auto sm:overflow-visible">
            <MarketTabs tab={tab} setTab={setTab} />
            {tab === "public" && (
              <RoundSelector bindings={bindings.data ?? []} activeCoin={coin} />
            )}
          </div>
        </div>

        {/* tx status pill — shared between both tabs */}
        {lastResult && (
          <div
            className={`rounded-2xl border px-4 py-3 text-xs ${
              lastResult.kind === "ok"
                ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-400"
                : "border-rose-500/30 bg-rose-500/5 text-rose-400"
            }`}
          >
            {lastResult.kind === "ok" ? (
              <span>
                ✓ Confirmed · <code>{lastResult.digest.slice(0, 16)}…</code>
              </span>
            ) : (
              <span>✗ {lastResult.message}</span>
            )}
          </div>
        )}

        {tab === "public" ? (
          <>
            {/* ── Cumulative market-volume KPI ─────────────────────── */}
            <div className="grid grid-cols-3 overflow-hidden rounded-2xl border border-border bg-card/60 backdrop-blur">
              <KpiCell
                label={`Total volume (${quote.symbol})`}
                value={
                  marketVolume.isLoading
                    ? "…"
                    : formatPriceInQuote(
                        marketVolume.data?.quoteBaseUnits ?? 0n,
                        quote,
                      ).replace(` ${quote.symbol}`, "")
                }
                hint="all rounds, since launch"
              />
              <KpiCell
                label="Trades"
                value={
                  marketVolume.isLoading
                    ? "…"
                    : (marketVolume.data?.fills ?? 0).toLocaleString()
                }
                hint="settled fills"
              />
              <KpiCell
                label={`Fees collected (${quote.symbol})`}
                value={
                  marketVolume.isLoading
                    ? "…"
                    : formatPriceInQuote(
                        marketVolume.data?.fees ?? 0n,
                        quote,
                      ).replace(` ${quote.symbol}`, "")
                }
                hint="protocol take"
              />
            </div>

            {/* ── Main grid ────────────────────────────────────────── */}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
              <div className="flex justify-center">
                {quote.routing === "m1n3-market" ? (
                  <SwapCard
                    hsLabel={activeLabel}
                    quote={quote}
                    onQuoteChange={setQuote}
                    quoteBalance={quoteCoins.balance}
                    hsBalance={myShareBalance}
                    bids={bids}
                    asks={asks}
                    walletConnected={!!account}
                    pending={isPending}
                    onPlaceBid={placeBid}
                    onPlaceAsk={placeAsk}
                    onSwapBuy={swapBuy}
                    onSwapSell={swapSell}
                  />
                ) : (
                  <DeepBookSwapPanel
                    quote={quote}
                    onQuoteChange={setQuote}
                    hsLabel={activeLabel}
                    hsCoinType={coin}
                    hsBalance={myShareBalance}
                    hsCoinObjectIds={myInventory?.coinObjectIds ?? []}
                  />
                )}
              </div>
              <OrderBookSidebar
                bids={bids}
                asks={asks}
                loading={orders.isLoading}
                myAddress={account?.address}
                onCancel={cancel}
                quote={quote}
              />
            </div>
          </>
        ) : (
          <PrivateMarketSection
            account={account?.address}
            quoteCoins={quoteCoins}
            onResult={setLastResult}
          />
        )}
      </div>
    </>
  );
}

/**
 * Split exactly `amount` base units off whichever quote coin objects the
 * caller's wallet holds. Merges all of them onto the first object first,
 * then splits — same pattern as `placeAsk` does for HashShare inventory.
 *
 * Works for both SUI and non-SUI quote tokens. We never spend from
 * `tx.gas` here because on mainnet `tx.gas` is SUI but the in-house
 * market expects `Coin<USDC>`.
 */
function splitQuote(
  tx: Transaction,
  ids: readonly string[],
  amount: bigint,
) {
  if (ids.length === 0) {
    throw new Error("No quote coins in wallet");
  }
  const [first, ...rest] = ids;
  if (rest.length > 0) {
    tx.mergeCoins(tx.object(first), rest.map((id) => tx.object(id)));
  }
  const [out] = tx.splitCoins(tx.object(first), [tx.pure.u64(amount)]);
  return out;
}

function KpiCell({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1 border-r border-border/60 px-4 py-3 last:border-r-0">
      <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
        {label}
      </p>
      <p className="font-mono text-base font-semibold tabular-nums">{value}</p>
      {hint && (
        <p className="text-[10px] text-muted-foreground/70">{hint}</p>
      )}
    </div>
  );
}

function MarketTabs({
  tab,
  setTab,
}: {
  tab: MarketTab;
  setTab: (t: MarketTab) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded-full border border-border bg-card/60 text-[11px] font-mono uppercase tracking-wider">
      {(["public", "private"] as MarketTab[]).map((id) => (
        <button
          key={id}
          onClick={() => setTab(id)}
          className={`px-3 py-1.5 transition-colors ${
            tab === id
              ? "bg-emerald-500/15 text-emerald-400"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {id} market
        </button>
      ))}
    </div>
  );
}

/**
 * Common shell used by the public-tab early-return states (loading /
 * empty). Renders the header + tabs so the user can still switch over
 * to the private market while the public side resolves.
 */
function PageShell({
  tab,
  setTab,
  children,
}: {
  tab: MarketTab;
  setTab: (t: MarketTab) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Share market</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            HashShare round orderbook + private hashpower buy orders.
          </p>
        </div>
        <MarketTabs tab={tab} setTab={setTab} />
      </div>
      {children}
    </div>
  );
}

// ── Private market: HashpowerBuyOrder discovery + management ───────────────

type TxResult =
  | { kind: "ok"; digest: string }
  | { kind: "err"; message: string };

/**
 * Lookup table from full Move type to display metadata. Falls back to a
 * 6-decimal synthetic for unknown coins.
 */
function quoteForCoinType(
  type: string,
  table: Map<string, QuoteToken>,
): QuoteToken {
  const known = table.get(type);
  if (known) return known;
  const segment = type.split("::").pop() ?? "?";
  return {
    symbol: segment.toUpperCase(),
    type,
    decimals: 6,
    routing: "m1n3-market",
  };
}

function PrivateMarketSection({
  account,
  quoteCoins,
  onResult,
}: {
  account: string | undefined;
  quoteCoins: ReturnType<typeof useQuoteCoins>;
  onResult: (r: TxResult) => void;
}) {
  const orders = useHashpowerOrders();
  const { mutateAsync: signAndExecute, isPending } =
    useSignAndExecuteTransaction();
  const [showMineOnly, setShowMineOnly] = useState(false);

  const quoteLookup = useMemo(() => {
    const m = new Map<string, QuoteToken>();
    for (const q of QUOTE_TOKENS) m.set(q.type, q);
    return m;
  }, []);

  const filtered = useMemo(() => {
    let xs = orders.data ?? [];
    if (showMineOnly && account) xs = xs.filter((o) => o.buyer === account);
    return xs;
  }, [orders.data, showMineOnly, account]);

  // ── KPIs computed on the open-orders set ────────────────────────────
  const kpis = useMemo(() => {
    const xs = orders.data ?? [];
    let totalBudget = 0n;
    for (const o of xs) totalBudget += o.budget;
    const mine = account ? xs.filter((o) => o.buyer === account).length : 0;
    return { openCount: xs.length, totalBudget, mineCount: mine };
  }, [orders.data, account]);

  // ── Move-call wrappers ──────────────────────────────────────────────

  // Pick the right entry name per order kind. V1 (template-pinned) keeps
  // its original entries — they still resolve on the upgraded package via
  // back-compat — while V2 (buyer-bound) uses the dedicated entries.
  function entryName(order: HashpowerOrder, base: "cancel" | "update_price" | "top_up"): string {
    if (order.kind === "v2") {
      switch (base) {
        case "cancel":
          return "cancel_buyer_order";
        case "update_price":
          return "update_buyer_order_price";
        case "top_up":
          return "top_up_buyer_order";
      }
    }
    switch (base) {
      case "cancel":
        return "cancel_hashpower_order";
      case "update_price":
        return "update_hashpower_order_price";
      case "top_up":
        return "top_up_hashpower_order";
    }
  }

  async function cancel(order: HashpowerOrder) {
    onResult({ kind: "ok", digest: "" }); // clear
    try {
      if (!account) throw new Error("Connect wallet first");
      const tx = new Transaction();
      const [refund] = [
        tx.moveCall({
          target: `${PACKAGE_ID}::pool::${entryName(order, "cancel")}`,
          typeArguments: [order.quoteCoinType],
          arguments: [tx.object(order.objectId)],
        }),
      ];
      tx.transferObjects([refund], tx.pure.address(account));
      const r = await signAndExecute({
        transaction: tx as unknown as Parameters<typeof signAndExecute>[0]["transaction"],
      });
      onResult({ kind: "ok", digest: r.digest });
      orders.refetch();
      quoteCoins.refetch();
    } catch (e) {
      onResult({
        kind: "err",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function updatePrice(order: HashpowerOrder, newPriceBaseUnits: bigint) {
    try {
      if (!account) throw new Error("Connect wallet first");
      if (newPriceBaseUnits <= 0n) throw new Error("Price must be > 0");
      const tx = new Transaction();
      tx.moveCall({
        target: `${PACKAGE_ID}::pool::${entryName(order, "update_price")}`,
        typeArguments: [order.quoteCoinType],
        arguments: [tx.object(order.objectId), tx.pure.u64(newPriceBaseUnits)],
      });
      const r = await signAndExecute({
        transaction: tx as unknown as Parameters<typeof signAndExecute>[0]["transaction"],
      });
      onResult({ kind: "ok", digest: r.digest });
      orders.refetch();
    } catch (e) {
      onResult({
        kind: "err",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function topUp(order: HashpowerOrder, addAmount: bigint) {
    try {
      if (!account) throw new Error("Connect wallet first");
      if (addAmount <= 0n) throw new Error("Amount must be > 0");
      if (order.quoteCoinType !== quoteCoins.coinType) {
        throw new Error(
          `Switch the marketplace quote to ${order.quoteCoinType.split("::").pop()} before topping up`,
        );
      }
      if (quoteCoins.balance < addAmount) {
        throw new Error("Insufficient balance for top-up");
      }
      const tx = new Transaction();
      const [first, ...rest] = quoteCoins.ids;
      if (rest.length > 0) {
        tx.mergeCoins(tx.object(first), rest.map((id) => tx.object(id)));
      }
      const [payment] = tx.splitCoins(tx.object(first), [
        tx.pure.u64(addAmount),
      ]);
      tx.moveCall({
        target: `${PACKAGE_ID}::pool::${entryName(order, "top_up")}`,
        typeArguments: [order.quoteCoinType],
        arguments: [tx.object(order.objectId), payment],
      });
      const r = await signAndExecute({
        transaction: tx as unknown as Parameters<typeof signAndExecute>[0]["transaction"],
      });
      onResult({ kind: "ok", digest: r.digest });
      orders.refetch();
      quoteCoins.refetch();
    } catch (e) {
      onResult({
        kind: "err",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return (
    <div className="space-y-6">
      {/* KPI row — short labels keep all 3 cells legible on phones */}
      <div className="grid grid-cols-3 overflow-hidden rounded-2xl border border-border bg-card/60 backdrop-blur">
        <KpiCell
          label="Open"
          value={orders.isLoading ? "…" : kpis.openCount.toLocaleString()}
          hint="all quote coins"
        />
        <KpiCell
          label="Budget"
          value={
            orders.isLoading
              ? "…"
              : formatPriceInQuote(
                  kpis.totalBudget,
                  quoteForCoinType("usdc", quoteLookup),
                ).replace(/ \S+$/, "")
          }
          hint="aggregated (6-dec)"
        />
        <KpiCell
          label="Yours"
          value={account ? kpis.mineCount.toLocaleString() : "—"}
          hint={account ? "you are the buyer" : "connect wallet"}
        />
      </div>

      {/* Filter strip */}
      <div className="flex flex-col gap-2 text-xs sm:flex-row sm:items-center sm:justify-between">
        <p className="text-muted-foreground">
          Place new orders via{" "}
          <code className="font-mono">scripts/place-hashpower-order.sh</code>{" "}
          (UI flow coming soon).
        </p>
        <label className="flex w-fit cursor-pointer items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1.5 font-mono uppercase tracking-wider hover:bg-card">
          <input
            type="checkbox"
            checked={showMineOnly}
            onChange={(e) => setShowMineOnly(e.target.checked)}
            className="h-3 w-3 accent-emerald-400"
            disabled={!account}
          />
          mine only
        </label>
      </div>

      {/* Orders list — card layout on mobile, table grid on md+ */}
      <div className="overflow-hidden rounded-2xl border border-border bg-card/60 backdrop-blur">
        {/* Column headers visible only on md+ (matches the order row's md grid) */}
        <div className="hidden md:grid md:grid-cols-[1fr_minmax(110px,auto)_minmax(110px,auto)_minmax(80px,auto)_minmax(160px,auto)] md:gap-2 md:border-b md:border-border/60 md:px-4 md:py-3 md:font-mono md:text-[10px] md:uppercase md:tracking-[0.25em] md:text-muted-foreground">
          <span>Buyer · template</span>
          <span className="text-right">Price / diff</span>
          <span className="text-right">Budget</span>
          <span className="text-center">Type</span>
          <span className="text-right">Manage</span>
        </div>

        {orders.isLoading ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">
            Loading…
          </p>
        ) : filtered.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">
            {showMineOnly
              ? "You have no open hashpower buy orders."
              : "No open hashpower buy orders on chain right now."}
          </p>
        ) : (
          <ul className="divide-y divide-border/40">
            {filtered.map((o) => (
              <PrivateOrderRow
                key={o.objectId}
                order={o}
                isMine={!!account && o.buyer === account}
                quote={quoteForCoinType(o.quoteCoinType, quoteLookup)}
                onCancel={() => cancel(o)}
                onUpdatePrice={(p) => updatePrice(o, p)}
                onTopUp={(a) => topUp(o, a)}
                pending={isPending}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PrivateOrderRow({
  order,
  isMine,
  quote,
  onCancel,
  onUpdatePrice,
  onTopUp,
  pending,
}: {
  order: HashpowerOrder;
  isMine: boolean;
  quote: QuoteToken;
  onCancel: () => void;
  onUpdatePrice: (newPrice: bigint) => void;
  onTopUp: (amount: bigint) => void;
  pending: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showTpl, setShowTpl] = useState(false);
  const [newPriceStr, setNewPriceStr] = useState("");
  const [topUpStr, setTopUpStr] = useState("");

  // The block template backing this order: pinned for v1, latest-seen for v2.
  const tplId = order.kind === "v2" ? order.latestTemplateId : order.templateId;

  function submitNewPrice() {
    const p = parseQuoteAmount(newPriceStr, quote);
    if (p == null || p <= 0n) return;
    onUpdatePrice(p);
    setNewPriceStr("");
  }

  function submitTopUp() {
    const a = parseQuoteAmount(topUpStr, quote);
    if (a == null || a <= 0n) return;
    onTopUp(a);
    setTopUpStr("");
  }

  return (
    <li className="px-4 py-3 text-xs">
      {/* ── Mobile: stacked card layout ──────────────────────────────── */}
      <div className="space-y-2 md:hidden">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-col">
            <span className="flex items-center gap-2 truncate font-mono">
              <span className="truncate">{shortHex(order.buyer)}</span>
              {isMine && (
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[9px] uppercase tracking-wider text-emerald-400">
                  you
                </span>
              )}
              <OrderKindBadge order={order} />
            </span>
            <TemplateLink order={order} />
          </div>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
              order.isDynamic
                ? "bg-amber-500/15 text-amber-400"
                : "bg-emerald-500/15 text-emerald-400"
            }`}
          >
            {order.isDynamic ? "dynamic" : "fixed"}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2 rounded-lg border border-border/40 bg-background/30 p-2 font-mono">
          <div className="flex flex-col">
            <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
              Price / diff
            </span>
            <span className="tabular-nums">
              {formatPriceInQuote(order.pricePerDifficulty, quote)}
            </span>
          </div>
          <div className="flex flex-col text-right">
            <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
              Budget
            </span>
            <span className="tabular-nums">
              {formatPriceInQuote(order.budget, quote)}
            </span>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Link
            href={`https://suiscan.xyz/mainnet/object/${order.objectId}`}
            target="_blank"
            rel="noopener"
            className="rounded-full bg-foreground/10 px-2 py-1 text-[10px] uppercase tracking-wider text-foreground/70 hover:bg-foreground/15"
          >
            ↗ Suiscan
          </Link>
          {tplId && (
            <button
              onClick={() => setShowTpl((v) => !v)}
              className="rounded-full bg-foreground/10 px-3 py-1 text-[10px] uppercase tracking-wider text-foreground/70 hover:bg-foreground/15"
            >
              {showTpl ? "hide template" : "template"}
            </button>
          )}
          {isMine && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="rounded-full bg-emerald-500/15 px-3 py-1 text-[10px] uppercase tracking-wider text-emerald-400 hover:bg-emerald-500/25"
            >
              {expanded ? "close" : "manage"}
            </button>
          )}
        </div>
      </div>

      {/* ── Desktop: grid table row ─────────────────────────────────── */}
      <div className="hidden md:grid md:grid-cols-[1fr_minmax(110px,auto)_minmax(110px,auto)_minmax(80px,auto)_minmax(160px,auto)] md:gap-2 md:items-center">
        <div className="flex min-w-0 flex-col">
          <span className="flex items-center gap-2 truncate font-mono">
            <span>{shortHex(order.buyer)}</span>
            {isMine && (
              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[9px] uppercase tracking-wider text-emerald-400">
                you
              </span>
            )}
            <OrderKindBadge order={order} />
          </span>
          <TemplateLink order={order} />
        </div>
        <span className="text-right font-mono tabular-nums">
          {formatPriceInQuote(order.pricePerDifficulty, quote)}
        </span>
        <span className="text-right font-mono tabular-nums">
          {formatPriceInQuote(order.budget, quote)}
        </span>
        <span className="text-center">
          <span
            className={`rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
              order.isDynamic
                ? "bg-amber-500/15 text-amber-400"
                : "bg-emerald-500/15 text-emerald-400"
            }`}
          >
            {order.isDynamic ? "dynamic" : "fixed"}
          </span>
        </span>
        <div className="flex justify-end gap-2">
          <Link
            href={`https://suiscan.xyz/mainnet/object/${order.objectId}`}
            target="_blank"
            rel="noopener"
            className="rounded-full bg-foreground/10 px-2 py-1 text-[10px] uppercase tracking-wider text-foreground/70 hover:bg-foreground/15"
          >
            ↗
          </Link>
          {tplId && (
            <button
              onClick={() => setShowTpl((v) => !v)}
              className="rounded-full bg-foreground/10 px-2 py-1 text-[10px] uppercase tracking-wider text-foreground/70 hover:bg-foreground/15"
            >
              {showTpl ? "hide" : "template"}
            </button>
          )}
          {isMine && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="rounded-full bg-emerald-500/15 px-2 py-1 text-[10px] uppercase tracking-wider text-emerald-400 hover:bg-emerald-500/25"
            >
              {expanded ? "close" : "manage"}
            </button>
          )}
        </div>
      </div>

      <OrderActivityFooter order={order} quote={quote} />

      {showTpl && tplId && (
        <div className="mt-3">
          <PrivateOrderTemplate order={order} tplId={tplId} />
        </div>
      )}

      {isMine && expanded && (
        <div className="mt-3 grid grid-cols-1 gap-2 rounded-xl border border-border/60 bg-background/40 p-3 md:grid-cols-3">
          {/* Cancel + refund */}
          <button
            onClick={onCancel}
            disabled={pending}
            className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs font-mono uppercase tracking-wider text-rose-300 hover:bg-rose-500/20 disabled:opacity-50"
          >
            Cancel & refund
          </button>

          {/* Update price (dynamic only) */}
          {order.isDynamic ? (
            <div className="flex gap-1">
              <input
                value={newPriceStr}
                onChange={(e) => {
                  const v = e.target.value
                    .replace(/[^0-9.]/g, "")
                    .replace(/(\..*)\./g, "$1");
                  setNewPriceStr(v);
                }}
                placeholder={`new price ${quote.symbol}/diff`}
                className="w-full rounded-lg border border-border bg-background/60 px-2 py-2 font-mono text-xs"
              />
              <button
                onClick={submitNewPrice}
                disabled={pending || !newPriceStr}
                className="shrink-0 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-mono uppercase tracking-wider text-amber-300 hover:bg-amber-500/20 disabled:opacity-50"
              >
                Re-price
              </button>
            </div>
          ) : (
            <div className="rounded-lg border border-border/40 px-2 py-2 text-[10px] text-muted-foreground">
              Fixed-price order — price re-quote disabled at creation
            </div>
          )}

          {/* Top up */}
          <div className="flex gap-1">
            <input
              value={topUpStr}
              onChange={(e) => {
                const v = e.target.value
                  .replace(/[^0-9.]/g, "")
                  .replace(/(\..*)\./g, "$1");
                setTopUpStr(v);
              }}
              placeholder={`add ${quote.symbol}`}
              className="w-full rounded-lg border border-border bg-background/60 px-2 py-2 font-mono text-xs"
            />
            <button
              onClick={submitTopUp}
              disabled={pending || !topUpStr}
              className="shrink-0 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs font-mono uppercase tracking-wider text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
            >
              Top up
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function shortHex(s: string): string {
  if (!s.startsWith("0x") || s.length <= 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

/**
 * Inline block-template detail for a private (hashpower) order — renders the
 * same `TemplateCard` the public template rows expand into, giving private
 * orders full parity. v1 shows its pinned template; v2 shows the latest
 * template seen for the buyer (it rotates as the operator publishes new ones).
 */
function PrivateOrderTemplate({
  order,
  tplId,
}: {
  order: HashpowerOrder;
  tplId: string;
}) {
  const { data: template, isLoading, error } = useSuiQuery(
    ["template", tplId],
    () => fetchTemplateById(tplId),
  );
  return (
    <div className="rounded-xl border border-border/60 bg-background/40 p-3">
      <div className="mb-2 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
        <span>
          {order.kind === "v2"
            ? "Latest block template"
            : "Pinned block template"}
        </span>
        <Link href={`/template/${tplId}`} className="hover:text-foreground">
          open ↗
        </Link>
      </div>
      {isLoading ? (
        <div className="h-40 animate-pulse rounded-lg bg-muted" />
      ) : error || !template ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          Template not found: {shortHex(tplId)}
        </p>
      ) : (
        <TemplateCard template={template} />
      )}
    </div>
  );
}

/**
 * One-glance order-kind chip. V2 = green "buyer-bound" (the new design;
 * orders survive template rotation). V1 = amber "template-pinned" — the
 * legacy lane that goes stale on every buyer-template publish; kept for
 * zombie-cleanup management.
 */
function OrderKindBadge({ order }: { order: HashpowerOrder }) {
  if (order.kind === "v2") {
    return (
      <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[9px] uppercase tracking-wider text-emerald-400">
        buyer-bound
      </span>
    );
  }
  return (
    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[9px] uppercase tracking-wider text-amber-400">
      template-pinned
    </span>
  );
}

/**
 * V1: pinned `templateId` (immutable, often stale). V2: most-recent
 * `latestTemplateId` for the buyer, computed off-chain from the operator's
 * `TemplateRegistered` event stream. Either way we surface the same
 * `tpl 0x…/`-style chip linking to /template/<id>; V2 shows `latest` to
 * distinguish.
 */
function TemplateLink({ order }: { order: HashpowerOrder }) {
  const tplId = order.kind === "v2" ? order.latestTemplateId : order.templateId;
  if (!tplId) {
    return (
      <span className="truncate font-mono text-[10px] text-muted-foreground">
        {order.kind === "v2" ? "no template yet" : "—"}
      </span>
    );
  }
  return (
    <Link
      href={`/template/${tplId}`}
      className="truncate font-mono text-[10px] text-muted-foreground hover:text-foreground"
    >
      {order.kind === "v2" ? "latest tpl" : "tpl"} {shortHex(tplId)}
    </Link>
  );
}

/**
 * Always-visible activity strip rendered just below each order's main
 * row. Surfaces:
 *
 *   • "Last buyer template update" — when this buyer most recently
 *     called `register_template_public`. V2 only; V1 orders are pinned
 *     to a single template by design, so the chip is omitted there.
 *   • "Recent fills" — last 3 valid shares that drained this order,
 *     each rendered as `<relative time> · <payout> · <miner>`. Lets
 *     buyers see at a glance whether their hashpower order is actually
 *     being mined into. Empty hint when no shares have landed yet.
 */
function OrderActivityFooter({
  order,
  quote,
}: {
  order: HashpowerOrder;
  quote: QuoteToken;
}) {
  const fills = order.recentFills.slice(0, 3);
  const showTemplateUpdate = order.kind === "v2" && !!order.latestTemplateAtMs;
  if (!showTemplateUpdate && fills.length === 0) {
    return (
      <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground/70">
        <span>No fills yet on this order.</span>
        {order.kind === "v2" && !order.latestTemplateId && (
          <span>Buyer hasn&apos;t published a template yet.</span>
        )}
      </div>
    );
  }
  return (
    <div className="mt-2 space-y-1.5 rounded-lg border border-border/40 bg-background/30 px-3 py-2 text-[10px]">
      {showTemplateUpdate && (
        <div className="flex items-center justify-between font-mono">
          <span className="text-muted-foreground">Last template update</span>
          <span className="tabular-nums">
            {relativeTime(order.latestTemplateAtMs as bigint)}
          </span>
        </div>
      )}
      {fills.length > 0 ? (
        <div className="space-y-1">
          <span className="font-mono text-muted-foreground">Recent fills</span>
          <ul className="space-y-0.5">
            {fills.map((f, i) => (
              <FillRow key={`${f.timestampMs}-${i}`} fill={f} quote={quote} />
            ))}
          </ul>
        </div>
      ) : (
        <span className="font-mono text-muted-foreground">
          No fills yet on this order.
        </span>
      )}
    </div>
  );
}

function FillRow({ fill, quote }: { fill: OrderFill; quote: QuoteToken }) {
  return (
    <li className="flex items-center justify-between gap-2 font-mono">
      <span className="tabular-nums text-muted-foreground">
        {relativeTime(fill.timestampMs)}
      </span>
      <span className="flex items-center gap-2 tabular-nums">
        <span>{formatPriceInQuote(fill.payout, quote)}</span>
        {fill.isBlock && (
          <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-amber-400">
            BLOCK
          </span>
        )}
      </span>
      <span className="truncate text-muted-foreground">
        {shortHex(fill.miner)}
      </span>
    </li>
  );
}

/**
 * "5m ago", "2h ago", "3d ago" — best-effort coarse relative time for
 * audit-trail strips. Anything more than a week becomes the ISO date.
 */
function relativeTime(timestampMs: bigint): string {
  const ms = Number(BigInt(Date.now()) - timestampMs);
  if (ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(Number(timestampMs)).toISOString().slice(0, 10);
}

function FullPageLoader({ label }: { label: string }) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span className="h-2 w-2 animate-pulse rounded-full bg-foreground/60" />
        {label}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mx-auto max-w-md py-24 text-center">
      <h1 className="text-2xl font-bold">Share market</h1>
      <p className="mt-4 text-sm text-muted-foreground">
        No HashShare slots have been bound to rounds yet. As soon as the first
        round opens and the keeper binds a slot, this page lights up.
      </p>
    </div>
  );
}

export default function MarketplacePage() {
  return (
    <Suspense>
      <MarketplaceInner />
    </Suspense>
  );
}
