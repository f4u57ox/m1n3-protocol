"use client";

import React, { useRef, useEffect, useState, useCallback } from "react";
import { OrderBookDepthChart } from "@/components/OrderBookDepthChart";
import { OrderBookTable } from "@/components/OrderBookTable";
import { TradeHistory } from "@/components/TradeHistory";
import type {
  MarketSimulationParams,
  OrderBookData,
  SimulatedTrade,
  ComparisonPoint,
} from "@/lib/types";
import {
  computeTheoreticalValue,
  computeDiscount,
  difficultyToWorkPh,
  discountAtBlock,
} from "@/lib/hashprice-utils";
import { ComparisonChart } from "@/components/ComparisonChart";
import {
  SCENARIO_PRESETS,
  generateOrderBook,
  generateTradeHistory,
  generateMockListings,
} from "@/data/mock-market";

const DEFAULT_CHAIN_HEIGHT = 890_000;

const PARAMS: MarketSimulationParams = {
  ...SCENARIO_PRESETS.stable,
  tradeFrequencyPerMin: 24,
};

export const MarketSimulator = React.memo(function MarketSimulator() {
  const [orderBook, setOrderBook] = useState<OrderBookData>({
    bids: [],
    asks: [],
    spread: 0,
    midpoint: 0,
    lastTradePrice: 0,
  });
  const [trades, setTrades] = useState<SimulatedTrade[]>([]);
  const [comparisonData, setComparisonData] = useState<ComparisonPoint[]>([]);
  const rafRef = useRef(0);
  const lastTickRef = useRef(0);
  const seedRef = useRef(1);
  const orderBookRef = useRef(orderBook);

  // Comparison simulation refs
  const INITIAL_INVESTMENT = 1_000;
  const MAX_DISCOUNT = 10; // 10% entry discount
  const simStartRef = useRef(Date.now());
  const btcPriceRef = useRef(1); // normalized to 1 (we track multiplier)
  const simBlockRef = useRef(0); // simulated blocks elapsed

  // Keep ref in sync so the rAF callback always sees latest midpoint
  useEffect(() => {
    orderBookRef.current = orderBook;
  }, [orderBook]);

  // Generate initial data once on mount
  useEffect(() => {
    const listings = generateMockListings(PARAMS, DEFAULT_CHAIN_HEIGHT, seedRef.current);
    const ob = generateOrderBook(listings, PARAMS.spreadBps, seedRef.current + 10);
    const history = generateTradeHistory(PARAMS, ob.midpoint, 60, seedRef.current + 20);
    seedRef.current += 1;
    setOrderBook(ob);
    setTrades(history);
  }, []);

  // Stable tick — reads midpoint from ref, no deps that change
  const tick = useCallback(() => {
    const now = Date.now();
    const dt = now - lastTickRef.current;
    const intervalMs = (60 / PARAMS.tradeFrequencyPerMin) * 1000;

    if (dt >= intervalMs) {
      lastTickRef.current = now;

      const mid = orderBookRef.current.midpoint;
      const side: "buy" | "sell" = Math.random() > 0.5 ? "buy" : "sell";
      const noise =
        (Math.random() - 0.5) * mid * (PARAMS.spreadBps / 10_000);
      const price = Math.max(0.001, mid + noise);

      const avgDiff = 50_000;
      const ph = difficultyToWorkPh(avgDiff) * (0.5 + Math.random() * 2);
      const theoUsd = computeTheoreticalValue(avgDiff, PARAMS.networkDifficulty, PARAMS.blockRewardUsd);
      const disc =
        theoUsd > 0
          ? computeDiscount(price, theoUsd)
          : PARAMS.averageDiscount;

      const newTrade: SimulatedTrade = {
        price,
        hashratePh: ph,
        side,
        discountPct: Math.max(0, disc),
        timestampMs: now,
      };

      setTrades((prev) => [newTrade, ...prev].slice(0, 100));

      setOrderBook((prev) => {
        const drift = (Math.random() - 0.5) * prev.midpoint * 0.002;
        const newMid = prev.midpoint + drift;
        const halfSpread = prev.spread / 2;

        const bids = prev.bids.map((b, i) => ({
          ...b,
          price: newMid - halfSpread - i * newMid * 0.005,
        }));
        const asks = prev.asks.map((a, i) => ({
          ...a,
          price: newMid + halfSpread + i * newMid * 0.005,
        }));

        return {
          ...prev,
          bids,
          asks,
          midpoint: newMid,
          lastTradePrice: price,
        };
      });

      // --- Comparison data accumulation ---
      // BTC price random walk: ±0.3% per tick
      const btcDrift = (Math.random() - 0.5) * 0.006;
      btcPriceRef.current *= 1 + btcDrift;
      const btcValue = INITIAL_INVESTMENT * btcPriceRef.current;

      // Mining share: 1 simulated block per ~10s → 4 ticks at 2.5s each
      simBlockRef.current += 0.25;
      const blocksElapsed = Math.floor(simBlockRef.current);
      const blocksUntilMature = Math.max(0, 100 - blocksElapsed);
      const currentDiscount = discountAtBlock(blocksUntilMature, MAX_DISCOUNT);
      // Share value = investment bought at MAX_DISCOUNT discount, now worth (1 - currentDiscount/100) of theoretical
      const entryMultiplier = 1 / (1 - MAX_DISCOUNT / 100); // bought more shares due to discount
      const miningShareValue =
        INITIAL_INVESTMENT * entryMultiplier * (1 - currentDiscount / 100);

      const elapsedSec = (now - simStartRef.current) / 1000;

      setComparisonData((prev) => {
        const next = [
          ...prev,
          { timestampMs: now, elapsedSec, btcValue, miningShareValue },
        ];
        return next.length > 300 ? next.slice(next.length - 300) : next;
      });
    }

    rafRef.current = requestAnimationFrame(tick);
  }, []);

  // Auto-start on mount, cleanup on unmount
  useEffect(() => {
    lastTickRef.current = Date.now();
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [tick]);

  return (
    <div className="space-y-4">
      <p className="text-xs text-yellow-600 bg-yellow-500/10 border border-yellow-500/20 rounded px-2 py-1">
        All data below is simulated for demonstration purposes. Real market data will replace this once sufficient on-chain trading activity is available.
      </p>

      {/* BTC vs Mining Shares Comparison */}
      <ComparisonChart data={comparisonData} initialInvestment={INITIAL_INVESTMENT} />

      {/* Order Book: Depth Chart + Table side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <OrderBookDepthChart orderBook={orderBook} />
        <OrderBookTable orderBook={orderBook} />
      </div>

      {/* Trade History */}
      <TradeHistory trades={trades} />
    </div>
  );
});
