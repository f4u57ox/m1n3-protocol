"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCurrentAccount, useSignAndExecuteTransaction } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { useShareMarketOrders, type ShareMarketOrder } from "@/hooks/useShareMarketOrders";
import { useHashShareBalances } from "@/hooks/useHashShareBalances";
import { useHashShareBindings } from "@/hooks/useHashShareRedemptions";
import { useSuiBalance } from "@/hooks/useSuiBalance";
import { PACKAGE_ID } from "@/lib/constants";
import { RoundSelector } from "@/components/market/RoundSelector";
import { SwapCard } from "@/components/market/SwapCard";
import { OrderBookSidebar } from "@/components/market/OrderBookSidebar";
import { DeepBookSwapPanel } from "@/components/market/DeepBookSwapPanel";
import { QUOTE_TOKENS, type QuoteToken } from "@/lib/quote-tokens";

function MarketplaceInner() {
  const router = useRouter();
  const params = useSearchParams();
  const coin = params.get("coin") ?? "";

  const account = useCurrentAccount();
  const bindings = useHashShareBindings();
  const orders = useShareMarketOrders(coin);
  const hashshares = useHashShareBalances(account?.address);
  const suiBalance = useSuiBalance(account?.address);

  // Quote currency selector — SUI routes through `hash_share_market`;
  // other tokens route through DeepBookV3 (UI staged for follow-up).
  const [quote, setQuote] = useState<QuoteToken>(QUOTE_TOKENS[0]); // SUI

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
      const tx = new Transaction();
      const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(budget)]);
      tx.moveCall({
        target: `${PACKAGE_ID}::hash_share_market::place_buy_order`,
        typeArguments: [coin],
        arguments: [tx.pure.u64(price), tx.pure.u64(0n), payment],
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
        typeArguments: [coin],
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
      const tx = new Transaction();
      const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(gross)]);
      tx.moveCall({
        target: `${PACKAGE_ID}::hash_share_market::fill_sell_order`,
        typeArguments: [coin],
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
        typeArguments: [coin],
        arguments: [tx.object(order.objectId), tx.object(feePoolId), payment],
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
      const tx = new Transaction();
      for (const leg of legs) {
        const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(leg.gross)]);
        tx.moveCall({
          target: `${PACKAGE_ID}::hash_share_market::fill_sell_order`,
          typeArguments: [coin],
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
      suiBalance.refetch();
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
          typeArguments: [coin],
          arguments: [tx.object(leg.order.objectId), tx.object(feePoolId), inv],
        });
      }
      const r = await signAndExecute({
        transaction: tx as unknown as Parameters<typeof signAndExecute>[0]["transaction"],
      });
      setLastResult({ kind: "ok", digest: r.digest });
      orders.refetch();
      hashshares.refetch();
      suiBalance.refetch();
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
        typeArguments: [coin],
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

  // Loading: bindings haven't resolved yet
  if (!coin && bindings.isLoading) {
    return <FullPageLoader label="Loading the most recent round…" />;
  }

  // Empty state: nothing has been bound yet
  if (!coin && (bindings.data ?? []).length === 0) {
    return <EmptyState />;
  }

  // Bindings are present but we haven't redirected yet (transient): show loader
  if (!coin) {
    return <FullPageLoader label="Loading market…" />;
  }

  const bids = orders.data?.bids ?? [];
  const asks = orders.data?.asks ?? [];

  return (
    <>
      <title>{`m1n3 — ${activeLabel} market`}</title>
      <div className="space-y-6">
        {/* ── Header row ───────────────────────────────────────────── */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Share market</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Trade HashShares against{" "}
              <span className="font-mono">{quote.symbol}</span>. Each round is a
              fresh orderbook on its own coin type.
            </p>
          </div>
          <div className="flex items-center gap-2 max-w-full overflow-x-auto sm:overflow-visible">
            <RoundSelector
              bindings={bindings.data ?? []}
              activeCoin={coin}
            />
          </div>
        </div>

        {/* tx status pill */}
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

        {/* ── Main grid ────────────────────────────────────────────── */}
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
          <div className="flex justify-center">
            {quote.routing === "m1n3-market" ? (
              <SwapCard
                hsLabel={activeLabel}
                quote={quote}
                onQuoteChange={setQuote}
                quoteBalance={suiBalance.mist}
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
          />
        </div>
      </div>
    </>
  );
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
