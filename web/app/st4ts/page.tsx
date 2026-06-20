"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useHashprice } from "@/hooks/useHashprice";
import { useMarketHistory } from "@/hooks/useMarketHistory";
import type { MarketHistoryRange } from "@/lib/types";

const MarketOverlayChart = dynamic(
  () =>
    import("@/components/MarketOverlayChart").then((m) => ({
      default: m.MarketOverlayChart,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="h-[400px] animate-pulse bg-muted rounded-lg" />
    ),
  },
);

function formatTimeRemaining(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  if (days > 0) return `${days}d ${remainingHours}h`;
  return `${hours}h`;
}

export default function St4tsPage() {
  const [historyRange, setHistoryRange] = useState<MarketHistoryRange>("30d");

  const { btcPrice, hashprice, networkHashrate, networkDifficulty } = useHashprice();
  const {
    data: historyData,
    difficultyAdjustments,
    nextAdjustment,
  } = useMarketHistory(historyRange);

  const changeIsPositive = (nextAdjustment?.difficultyChange ?? 0) >= 0;

  return (
    <>
      <title>m1n3 — Stats</title>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Stats</h1>
          <p className="text-muted-foreground">
            Bitcoin network health, hashprice trends, and difficulty adjustment tracking
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-muted-foreground">BTC Price</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-bold">
              {btcPrice != null ? `$${btcPrice.toLocaleString()}` : '—'}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-muted-foreground">Hashprice</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-bold">
              {hashprice != null ? `$${hashprice.toFixed(3)} / PH/day` : '—'}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-muted-foreground">Network Hashrate</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-bold">
              {networkHashrate != null ? `${(networkHashrate / 1e18).toFixed(1)} EH/s` : '—'}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-muted-foreground">Difficulty</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-bold">
              {networkDifficulty != null ? `${(networkDifficulty / 1e12).toFixed(2)}T` : '—'}
            </CardContent>
          </Card>
        </div>

        {/* Market Overview + compacted difficulty info */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <CardTitle>Market Overview</CardTitle>

              {/* Compact difficulty info inline */}
              {nextAdjustment && (
                <div className="flex items-center gap-4 text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground">Next Diff:</span>
                    <span
                      className={`font-mono font-medium ${
                        changeIsPositive ? "text-red-500" : "text-green-500"
                      }`}
                    >
                      {changeIsPositive ? "+" : ""}
                      {nextAdjustment.difficultyChange.toFixed(2)}%
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground">in</span>
                    <span className="font-mono">
                      {nextAdjustment.remainingBlocks.toLocaleString()} blocks
                    </span>
                    <span className="text-muted-foreground">
                      (~{formatTimeRemaining(nextAdjustment.remainingTime)})
                    </span>
                  </div>
                  <div className="hidden sm:flex items-center gap-1.5">
                    <span className="text-muted-foreground">Epoch:</span>
                    <div className="w-16 bg-muted rounded-full h-1.5 relative">
                      <div
                        className="bg-primary rounded-full h-1.5"
                        style={{ width: `${nextAdjustment.progressPercent}%` }}
                      />
                    </div>
                    <span className="font-mono">
                      {nextAdjustment.progressPercent.toFixed(0)}%
                    </span>
                  </div>
                  {networkDifficulty && (
                    <div className="hidden md:flex items-center gap-1.5">
                      <span className="text-muted-foreground">Current:</span>
                      <span className="font-mono">
                        {(networkDifficulty / 1e12).toFixed(2)}T
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <MarketOverlayChart
              data={historyData}
              range={historyRange}
              onRangeChange={setHistoryRange}
              difficultyAdjustments={difficultyAdjustments}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
