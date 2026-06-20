"use client";

import { useEffect, useMemo, useState } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
} from "@mysten/dapp-kit";
import { useQuery } from "@tanstack/react-query";
import { Transaction } from "@mysten/sui/transactions";
import { OrderType, SelfMatchingOptions } from "@mysten/deepbook-v3";
import { ArrowDown, Sparkles } from "lucide-react";
import {
  activeDeepBookConfig,
  activeNetwork,
  type QuoteToken,
} from "@/lib/quote-tokens";
import { useDeepBookPool } from "@/hooks/useDeepBookPool";
import { useQuoteCoins } from "@/hooks/useQuoteCoins";
import { swapBuyBase, swapSellBase } from "@/lib/deepbook";
import { QuoteSelector } from "@/components/market/QuoteSelector";
import {
  useDeepBookClient,
  registerHashSharePool,
} from "@/lib/deepbook-client";
import { ACTIVE_BM_KEY, useBalanceManager } from "@/hooks/useBalanceManager";

/**
 * Real DeepBookV3 swap panel for the non-SUI quote tokens. Replaces the
 * old `DeepBookNotice` stub.
 *
 * Behaviour
 * ─────────
 * • Looks up `Pool<HS_NNN, QUOTE>` via the `PoolCreated` event log.
 * • If the pool is found → renders a Swap form that calls
 *   `pool::swap_exact_*` directly (no BalanceManager required for taker
 *   trades, which is what "Swap" means).
 * • If the pool is missing → shows a "create permissionless pool" CTA.
 * • If the network has no DeepBookV3 (devnet) → shows a hard banner
 *   telling the user to switch network.
 *
 * Limit orders are intentionally *not* in this panel — they require a
 * BalanceManager + deposits and stay in a follow-up.
 */
export function DeepBookSwapPanel({
  quote,
  onQuoteChange,
  hsLabel,
  hsCoinType,
  hsBalance,
  hsCoinObjectIds,
}: {
  quote: QuoteToken;
  onQuoteChange: (q: QuoteToken) => void;
  hsLabel: string;
  /** Full Move type of the active HashShare coin. */
  hsCoinType: string;
  /** Wallet-held HashShare unit balance, for display + MAX. */
  hsBalance: bigint;
  /** Caller's HashShare Coin object ids (to merge + split when selling). */
  hsCoinObjectIds: string[];
}) {
  const account = useCurrentAccount();
  const { mutateAsync: signAndExecute, isPending } =
    useSignAndExecuteTransaction();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [mode, setMode] = useState<"swap" | "limit">("swap");
  const [amount, setAmount] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [lastResult, setLastResult] = useState<
    null | { kind: "ok"; digest: string } | { kind: "err"; message: string }
  >(null);

  const cfg = activeDeepBookConfig();
  const net = activeNetwork();
  const poolQ = useDeepBookPool(hsCoinType, quote);
  const quoteCoins = useQuoteCoins(
    account?.address,
    quote.symbol === "SUI" ? undefined : quote.type,
  );

  // SDK client + BalanceManager (only used by the Limit mode path).
  const db = useDeepBookClient();
  const bm = useBalanceManager();

  // Register this (HS_NNN × QUOTE) pool with the SDK as soon as the
  // event-scan lookup finds an address. Idempotent — safe to re-run.
  // `poolKey` is what the SDK's place_limit_order / midPrice methods need.
  const poolKey = useMemo(
    () => (poolQ.data?.poolId ? `${hsLabel.toUpperCase()}_${quote.symbol.toUpperCase()}` : null),
    [poolQ.data?.poolId, hsLabel, quote.symbol],
  );
  useEffect(() => {
    if (!poolQ.data?.poolId) return;
    registerHashSharePool(poolQ.data.poolId, hsCoinType, hsLabel, quote);
  }, [poolQ.data?.poolId, hsCoinType, hsLabel, quote]);

  // Live mid-price + best-bid/ask via the SDK. Polls every 8s. Skipped
  // when not in limit mode to avoid wasted RPC traffic.
  const priceQ = useQuery({
    queryKey: ["deepbook", "midprice", poolKey, mode],
    enabled: mode === "limit" && !!db && !!poolKey,
    refetchInterval: 8_000,
    queryFn: async () => {
      if (!db || !poolKey) return null;
      try {
        return await db.midPrice(poolKey);
      } catch {
        return null;
      }
    },
  });

  // Open orders for the active BM on this pool. Re-fetches after a
  // successful place/cancel so the list stays consistent.
  const openOrdersQ = useQuery({
    queryKey: ["deepbook", "open-orders", poolKey, bm.activeManagerId],
    enabled:
      mode === "limit" && !!db && !!poolKey && !!bm.activeManagerId,
    refetchInterval: 10_000,
    queryFn: async () => {
      if (!db || !poolKey || !bm.activeManagerId) return [] as string[];
      try {
        // The SDK looks up the manager id via ACTIVE_BM_KEY in its
        // internal map — we registered it inline in useBalanceManager.
        return await db.accountOpenOrders(poolKey, ACTIVE_BM_KEY);
      } catch {
        return [] as string[];
      }
    },
  });

  // Default the limit price input to mid-price the first time it
  // becomes available, so the user has a reasonable starting point.
  useEffect(() => {
    if (mode !== "limit") return;
    if (limitPrice !== "") return;
    const mid = priceQ.data;
    if (mid && mid > 0) {
      setLimitPrice(mid.toFixed(6));
    }
  }, [mode, limitPrice, priceQ.data]);

  /* ── No DeepBook on this network ────────────────────────────────── */
  if (!cfg) {
    return (
      <Card>
        <QuotePill quote={quote} onQuoteChange={onQuoteChange} />
        <div className="px-6 pb-8 pt-2 text-center">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-amber-400">
            Wrong network
          </p>
          <h3 className="mt-3 text-xl font-semibold tracking-tight">
            DeepBookV3 isn&apos;t deployed on{" "}
            <span className="font-mono">{net}</span>.
          </h3>
          <p className="mt-3 text-sm text-muted-foreground">
            To trade <span className="font-mono">{hsLabel}</span> against{" "}
            <span className="font-mono">{quote.symbol}</span>, repoint
            <code className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono">
              NEXT_PUBLIC_SUI_NETWORK
            </code>
            to <span className="font-mono">testnet</span> or{" "}
            <span className="font-mono">mainnet</span>.
          </p>
        </div>
      </Card>
    );
  }

  /* ── Discovering the pool ───────────────────────────────────────── */
  if (poolQ.isLoading) {
    return (
      <Card>
        <QuotePill quote={quote} onQuoteChange={onQuoteChange} />
        <Loader label="Searching DeepBookV3 registry…" />
      </Card>
    );
  }

  const poolId = poolQ.data?.poolId ?? null;

  /* ── Pool not found → create flow ───────────────────────────────── */
  if (!poolId) {
    return (
      <Card>
        <QuotePill quote={quote} onQuoteChange={onQuoteChange} />
        <div className="px-6 pb-8 pt-2 text-center">
          <Sparkles className="mx-auto h-5 w-5 text-muted-foreground" />
          <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            No pool yet
          </p>
          <h3 className="mt-3 text-xl font-semibold tracking-tight">
            {hsLabel} / {quote.symbol} has no DeepBook pool.
          </h3>
          <p className="mt-3 text-sm text-muted-foreground">
            The keeper hasn&apos;t created this pair yet, or this is the first
            time anyone&apos;s wanted to trade it. Pool creation is
            permissionless — costs{" "}
            <span className="font-mono">{net === "mainnet" ? "100" : "10"}</span>{" "}
            DEEP. Wire-up for the click-to-create flow is in
            <code className="ml-1 rounded bg-muted px-1.5 py-0.5 font-mono">
              lib/deepbook.ts::createPermissionlessPool
            </code>{" "}
            — a follow-up.
          </p>
        </div>
      </Card>
    );
  }

  /* ── Pool found → swap form ─────────────────────────────────────── */

  const baseScale = 1n; // HashShares are integer units (no decimals)
  const quoteScale = BigInt(10) ** BigInt(quote.decimals);

  function parseAmount(raw: string): bigint {
    try {
      const v = BigInt(raw.replace(/[^0-9]/g, "") || "0");
      return v;
    } catch {
      return 0n;
    }
  }

  async function placeLimitOrder() {
    setLastResult(null);
    try {
      if (!account || !poolKey || !db) return;
      if (!bm.activeManagerId) {
        setLastResult({
          kind: "err",
          message: "No DeepBook balance manager — create one first",
        });
        return;
      }
      const qty = Number(amount);
      const price = Number(limitPrice);
      if (!isFinite(qty) || qty <= 0) {
        setLastResult({ kind: "err", message: "Enter a quantity" });
        return;
      }
      if (!isFinite(price) || price <= 0) {
        setLastResult({ kind: "err", message: "Enter a price" });
        return;
      }
      const tx = new Transaction();
      db.deepBook.placeLimitOrder({
        poolKey,
        balanceManagerKey: ACTIVE_BM_KEY,
        clientOrderId: String(Date.now()),
        price,
        quantity: qty,
        isBid: side === "buy",
        orderType: OrderType.NO_RESTRICTION,
        selfMatchingOption: SelfMatchingOptions.CANCEL_TAKER,
        payWithDeep: false,
      })(tx);
      const r = await signAndExecute({
        transaction: tx as unknown as Parameters<
          typeof signAndExecute
        >[0]["transaction"],
      });
      setLastResult({ kind: "ok", digest: r.digest });
      openOrdersQ.refetch();
    } catch (e) {
      setLastResult({
        kind: "err",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function cancelOrder(orderId: string) {
    setLastResult(null);
    try {
      if (!account || !poolKey || !db) return;
      const tx = new Transaction();
      db.deepBook.cancelOrder(poolKey, ACTIVE_BM_KEY, orderId)(tx);
      const r = await signAndExecute({
        transaction: tx as unknown as Parameters<
          typeof signAndExecute
        >[0]["transaction"],
      });
      setLastResult({ kind: "ok", digest: r.digest });
      openOrdersQ.refetch();
    } catch (e) {
      setLastResult({
        kind: "err",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function execute() {
    if (mode === "limit") return placeLimitOrder();

    setLastResult(null);
    try {
      if (!account || !poolId) return;
      const amt = parseAmount(amount);
      if (amt === 0n) {
        setLastResult({ kind: "err", message: "Enter an amount" });
        return;
      }
      const tx = new Transaction();

      if (side === "buy") {
        // Buy HashShare by spending `amount` × 10^decimals of the quote
        // currency. For SUI we split from gas. For any other quote we
        // pull the wallet's owned Coin<QUOTE> objects, merge them, then
        // split off the exact amount — same pattern as the sell path
        // does for HashShares.
        const spend = amt * quoteScale;
        let quoteCoinArg;
        if (quote.symbol === "SUI") {
          const [qc] = tx.splitCoins(tx.gas, [tx.pure.u64(spend)]);
          quoteCoinArg = qc;
        } else {
          if (quoteCoins.ids.length === 0) {
            setLastResult({
              kind: "err",
              message: `No Coin<${quote.symbol}> in your wallet`,
            });
            return;
          }
          if (spend > quoteCoins.balance) {
            setLastResult({
              kind: "err",
              message: `Spending ${amount} ${quote.symbol} but wallet only holds ${
                quoteCoins.balance / quoteScale
              }`,
            });
            return;
          }
          const [first, ...rest] = quoteCoins.ids;
          if (rest.length > 0) {
            tx.mergeCoins(
              tx.object(first),
              rest.map((r) => tx.object(r)),
            );
          }
          const [qc] = tx.splitCoins(tx.object(first), [tx.pure.u64(spend)]);
          quoteCoinArg = qc;
        }

        const { baseOut } = swapBuyBase(tx, {
          pool: poolId,
          baseType: hsCoinType,
          quoteType: quote.type,
          quoteCoinArg,
          minBase: 0n,
        });
        // Send the HashShares (and any unused quote remainder) back to the user
        tx.transferObjects([baseOut as any], account.address);
      } else {
        if (hsCoinObjectIds.length === 0) {
          setLastResult({ kind: "err", message: "No HashShare inventory" });
          return;
        }
        if (amt > hsBalance) {
          setLastResult({ kind: "err", message: "Exceeds your HashShare balance" });
          return;
        }
        const [first, ...rest] = hsCoinObjectIds;
        if (rest.length > 0) {
          tx.mergeCoins(
            tx.object(first),
            rest.map((r) => tx.object(r)),
          );
        }
        const [bc] = tx.splitCoins(tx.object(first), [
          tx.pure.u64(amt * baseScale),
        ]);
        const { quoteOut } = swapSellBase(tx, {
          pool: poolId,
          baseType: hsCoinType,
          quoteType: quote.type,
          baseCoinArg: bc,
          minQuote: 0n,
        });
        tx.transferObjects([quoteOut as any], account.address);
      }

      const r = await signAndExecute({
        transaction:
          tx as unknown as Parameters<typeof signAndExecute>[0]["transaction"],
      });
      setLastResult({ kind: "ok", digest: r.digest });
    } catch (e) {
      setLastResult({
        kind: "err",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const ctaLabel = !account
    ? "Connect wallet"
    : amount === ""
      ? "Enter an amount"
      : side === "buy"
        ? `Buy ${hsLabel}`
        : `Sell ${hsLabel}`;

  return (
    <Card>
      <QuotePill quote={quote} onQuoteChange={onQuoteChange} />

      <div className="space-y-3 px-4 pb-4 pt-3">
        {/* Mode toggle: instant swap vs resting limit order */}
        <div className="flex gap-2 rounded-full border border-border/60 bg-muted/20 p-1">
          <button
            onClick={() => setMode("swap")}
            className={`flex-1 rounded-full py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors ${
              mode === "swap"
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Swap
          </button>
          <button
            onClick={() => setMode("limit")}
            className={`flex-1 rounded-full py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors ${
              mode === "limit"
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Limit
          </button>
        </div>

        {/* BalanceManager onboarding banner (limit mode only). */}
        {mode === "limit" && account && !bm.activeManagerId && (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
            <p className="font-mono uppercase tracking-wider text-amber-400">
              DeepBook balance manager required
            </p>
            <p className="mt-1 text-muted-foreground">
              Limit orders escrow funds in a per-wallet BalanceManager. Create
              one now — it's a one-time on-chain object.
            </p>
            <button
              onClick={async () => {
                try {
                  const r = await bm.createBalanceManager();
                  setLastResult({ kind: "ok", digest: r.digest });
                } catch (e) {
                  setLastResult({
                    kind: "err",
                    message: e instanceof Error ? e.message : String(e),
                  });
                }
              }}
              className="mt-2 rounded-full bg-amber-500/20 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-amber-300 hover:bg-amber-500/30"
            >
              Create balance manager
            </button>
          </div>
        )}

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

        <div className="rounded-2xl border border-border/60 bg-muted/15 px-3 py-3 sm:px-4">
          <div className="flex items-center justify-between gap-2 text-[10px] sm:text-[11px] uppercase tracking-[0.2em] sm:tracking-[0.25em] text-muted-foreground">
            <span className="shrink-0">
              {side === "buy"
                ? `Pay (${quote.symbol})`
                : `Sell (${hsLabel})`}
            </span>
            <span className="flex min-w-0 items-center gap-1 sm:gap-1.5 font-mono normal-case tracking-normal">
              {side === "buy" ? (
                quote.symbol === "SUI" ? null : quoteCoins.isLoading ? (
                  <span className="text-muted-foreground/70">…</span>
                ) : (
                  <>
                    <span className="truncate">
                      Bal {(quoteCoins.balance / quoteScale).toString()} {quote.symbol}
                    </span>
                    <button
                      onClick={() =>
                        setAmount(
                          (quoteCoins.balance / quoteScale).toString(),
                        )
                      }
                      className="ml-1 shrink-0 rounded-full bg-foreground/10 px-2 py-0.5 text-[10px] text-foreground hover:bg-foreground/15"
                    >
                      MAX
                    </button>
                  </>
                )
              ) : (
                <>
                  <span className="truncate">
                    Bal {hsBalance.toString()} {hsLabel}
                  </span>
                  <button
                    onClick={() => setAmount(hsBalance.toString())}
                    className="ml-1 shrink-0 rounded-full bg-foreground/10 px-2 py-0.5 text-[10px] text-foreground hover:bg-foreground/15"
                  >
                    MAX
                  </button>
                </>
              )}
            </span>
          </div>
          <input
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="0"
            className="mt-2 w-full bg-transparent font-mono text-2xl sm:text-3xl text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
          />
        </div>

        <div className="flex items-center justify-center">
          <span className="grid h-9 w-9 place-items-center rounded-full border border-border bg-background">
            <ArrowDown className="h-4 w-4" />
          </span>
        </div>

        {mode === "swap" ? (
          <div className="rounded-2xl border border-border/60 bg-muted/15 px-3 py-3 sm:px-4">
            <div className="flex items-center justify-between text-[10px] sm:text-[11px] uppercase tracking-[0.2em] sm:tracking-[0.25em] text-muted-foreground">
              <span>
                {side === "buy"
                  ? `Receive (${hsLabel})`
                  : `Receive (${quote.symbol})`}
              </span>
              <span className="font-mono normal-case tracking-normal">
                market price
              </span>
            </div>
            <p className="mt-2 font-mono text-sm text-muted-foreground">
              Settled at top-of-book via{" "}
              <code className="rounded bg-muted px-1 py-0.5">
                pool::swap_exact_*
              </code>
              {" — "}routed through DeepBookV3 on {net}.
            </p>
          </div>
        ) : (
          <div className="rounded-2xl border border-border/60 bg-muted/15 px-3 py-3 sm:px-4">
            <div className="flex items-center justify-between text-[10px] sm:text-[11px] uppercase tracking-[0.2em] sm:tracking-[0.25em] text-muted-foreground">
              <span>Price ({quote.symbol} per {hsLabel})</span>
              <span className="font-mono normal-case tracking-normal">
                {priceQ.data
                  ? `mid ${priceQ.data.toFixed(6)}`
                  : priceQ.isLoading
                    ? "loading mid…"
                    : "no mid"}
              </span>
            </div>
            <input
              inputMode="decimal"
              value={limitPrice}
              onChange={(e) =>
                setLimitPrice(e.target.value.replace(/[^0-9.]/g, ""))
              }
              placeholder={priceQ.data ? priceQ.data.toFixed(6) : "0.000000"}
              className="mt-2 w-full bg-transparent font-mono text-2xl sm:text-3xl text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
            />
            <p className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              {side === "buy"
                ? "Resting bid — fills when the ask drops to your price."
                : "Resting ask — fills when a bid rises to your price."}
            </p>
          </div>
        )}

        <button
          onClick={execute}
          disabled={!account || !amount || isPending}
          className="mt-1 w-full rounded-2xl bg-foreground py-4 text-sm font-semibold text-background transition-transform enabled:hover:scale-[1.005] disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
        >
          {ctaLabel}
        </button>

        {lastResult && (
          <div
            className={`rounded-xl border px-3 py-2 text-xs ${
              lastResult.kind === "ok"
                ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-400"
                : "border-rose-500/30 bg-rose-500/5 text-rose-400"
            }`}
          >
            {lastResult.kind === "ok" ? (
              <span>
                ✓ <code>{lastResult.digest.slice(0, 16)}…</code>
              </span>
            ) : (
              <span>✗ {lastResult.message}</span>
            )}
          </div>
        )}

        <div className="rounded-xl border border-border/60 bg-muted/20 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
          Pool · <span className="break-all">{poolId.slice(0, 20)}…</span>
        </div>

        {/* Open orders for the active BM on this pool (limit mode only). */}
        {mode === "limit" && (
          <div className="rounded-2xl border border-border/60 bg-muted/10 px-3 py-3">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
              <span>Your open orders</span>
              <span className="font-mono normal-case tracking-normal">
                {bm.activeManagerId
                  ? `BM ${bm.activeManagerId.slice(0, 8)}…`
                  : "no BM"}
              </span>
            </div>
            {!bm.activeManagerId ? (
              <p className="mt-2 text-xs text-muted-foreground italic">
                Create a balance manager above to place limit orders.
              </p>
            ) : openOrdersQ.isLoading ? (
              <p className="mt-2 text-xs text-muted-foreground">Loading…</p>
            ) : (openOrdersQ.data ?? []).length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground italic">
                No resting orders on {hsLabel} · {quote.symbol}.
              </p>
            ) : (
              <ul className="mt-2 space-y-1">
                {(openOrdersQ.data ?? []).map((orderId) => (
                  <li
                    key={orderId}
                    className="flex items-center justify-between rounded border border-border/40 bg-card/60 px-2 py-1 font-mono text-[11px]"
                  >
                    <span className="truncate">{orderId.slice(0, 18)}…</span>
                    <button
                      onClick={() => cancelOrder(orderId)}
                      className="ml-2 rounded-full bg-foreground/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-foreground hover:bg-foreground/15"
                    >
                      Cancel
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[480px]">
      <div className="overflow-hidden rounded-3xl border border-border bg-card/80 shadow-[0_10px_60px_-20px_rgba(0,0,0,0.5)] backdrop-blur-xl">
        {children}
      </div>
    </div>
  );
}

function QuotePill({
  quote,
  onQuoteChange,
}: {
  quote: QuoteToken;
  onQuoteChange: (q: QuoteToken) => void;
}) {
  return (
    <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
      <span className="font-mono text-[10px] sm:text-[11px] uppercase tracking-[0.25em] text-muted-foreground">
        DeepBookV3 route
      </span>
      <QuoteSelector value={quote} onChange={onQuoteChange} />
    </div>
  );
}

function Loader({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-3 px-6 py-16 text-sm text-muted-foreground">
      <span className="h-2 w-2 animate-pulse rounded-full bg-foreground/60" />
      {label}
    </div>
  );
}
