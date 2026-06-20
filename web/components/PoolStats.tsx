"use client";

import React, { useMemo, useState } from "react";
import { usePoolStats } from "@/hooks/usePoolStats";
import { formatDifficulty, formatHashrate } from "@/lib/utils";
import {
  Blocks,
  Hash,
  Gauge,
  TrendingUp,
  Zap,
  Activity,
  Clover,
  Timer,
  BarChart,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { computeLuckFactor } from "@/lib/hashprice-utils";
import { InfoTooltip } from "@/components/ui/info-tooltip";

interface PoolStatsProps {
  /** Bitcoin network difficulty for luck factor calculation. */
  networkDifficulty?: number;
  /** Block found timestamps (ms) for round duration analysis. */
  blockTimestampsMs?: number[];
}

export const PoolStats = React.memo(function PoolStats({
  networkDifficulty = 0,
  blockTimestampsMs = [],
}: PoolStatsProps) {
  const { poolData, loading } = usePoolStats();
  const [showPerformance, setShowPerformance] = useState(false);

  const performanceMetrics = useMemo(() => {
    if (!poolData) return null;

    // Luck factor
    const luck =
      networkDifficulty > 0
        ? computeLuckFactor(
            poolData.totalShares,
            poolData.totalBlocks,
            poolData.globalMinDifficulty,
            networkDifficulty,
          )
        : null;

    // Round duration analysis
    let avgRoundSec = 0;
    let stdDevSec = 0;
    if (blockTimestampsMs.length >= 2) {
      const sorted = [...blockTimestampsMs].sort((a, b) => a - b);
      const durations: number[] = [];
      for (let i = 1; i < sorted.length; i++) {
        durations.push((sorted[i] - sorted[i - 1]) / 1000);
      }
      avgRoundSec =
        durations.reduce((s, d) => s + d, 0) / durations.length;
      const variance =
        durations.reduce((s, d) => s + (d - avgRoundSec) ** 2, 0) /
        durations.length;
      stdDevSec = Math.sqrt(variance);
    }

    // Effective vs reported hashrate ratio
    const efficiencyRatio =
      poolData.poolHashrate && poolData.poolHashrateAvg
        ? poolData.poolHashrate / poolData.poolHashrateAvg
        : null;

    return {
      luck,
      avgRoundSec,
      stdDevSec,
      efficiencyRatio,
      roundsSampled: Math.max(0, blockTimestampsMs.length - 1),
    };
  }, [poolData, networkDifficulty, blockTimestampsMs]);

  if (loading || !poolData) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {[...Array(6)].map((_, i) => (
          <div
            key={i}
            className="rounded-lg border bg-card p-4 animate-pulse"
          >
            <div className="h-4 bg-muted rounded w-24 mb-2" />
            <div className="h-6 bg-muted rounded w-16" />
          </div>
        ))}
      </div>
    );
  }

  const primaryStats = [
    {
      label: "Total Shares",
      value: poolData.totalShares.toLocaleString(),
      icon: Hash,
      tooltip: "Total proof-of-work shares submitted by all miners since pool launch",
    },
    {
      label: "Blocks Found",
      value: poolData.totalBlocks.toLocaleString(),
      icon: Blocks,
      tooltip: "Number of Bitcoin blocks successfully mined by the pool",
    },
    {
      label: "Current Round",
      value: `#${poolData.currentRound}`,
      icon: TrendingUp,
      tooltip: "The pool's current mining round — resets each time a block is found",
    },
    {
      label: "Min Difficulty",
      value: formatDifficulty(poolData.globalMinDifficulty),
      icon: Gauge,
      tooltip: "Minimum share difficulty accepted by the pool — lower = more shares but less work each",
    },
    {
      label: "Pool Hashrate",
      value: poolData.poolHashrate
        ? formatHashrate(poolData.poolHashrate)
        : "—",
      icon: Zap,
      tooltip: "Current estimated computing power of all active miners, based on recent share submissions",
    },
    {
      label: "Avg Pool Hashrate",
      value: poolData.poolHashrateAvg
        ? formatHashrate(poolData.poolHashrateAvg)
        : "—",
      icon: Activity,
      tooltip: "Average hashrate over a longer period — smoother than the instant reading",
    },
  ];

  const luckColor = performanceMetrics?.luck
    ? performanceMetrics.luck >= 1.1
      ? "text-green-500"
      : performanceMetrics.luck <= 0.9
        ? "text-red-500"
        : "text-foreground"
    : "";

  function formatRoundDuration(sec: number): string {
    if (sec <= 0) return "—";
    if (sec < 60) return `${sec.toFixed(0)}s`;
    if (sec < 3600) return `${(sec / 60).toFixed(1)}m`;
    return `${(sec / 3600).toFixed(1)}h`;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {primaryStats.map((stat) => (
          <div
            key={stat.label}
            className="rounded-lg border bg-card p-4 flex items-start gap-3"
          >
            <stat.icon className="h-5 w-5 text-muted-foreground mt-0.5" />
            <div>
              <p className="text-sm text-muted-foreground">
                {stat.label}
                <InfoTooltip text={stat.tooltip} />
              </p>
              <p className="text-xl font-semibold">{stat.value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Performance Metrics Toggle */}
      <button
        onClick={() => setShowPerformance(!showPerformance)}
        className="flex items-center gap-1 text-xs text-blue-500 hover:text-blue-400"
      >
        {showPerformance ? (
          <ChevronUp className="h-3 w-3" />
        ) : (
          <ChevronDown className="h-3 w-3" />
        )}
        {showPerformance ? "Hide" : "Show"} Pool Performance Metrics
      </button>

      {showPerformance && performanceMetrics && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="rounded-lg border bg-card p-4 flex items-start gap-3">
            <Clover className="h-5 w-5 text-muted-foreground mt-0.5" />
            <div>
              <p className="text-sm text-muted-foreground">
                Luck Factor
                <InfoTooltip text="Ratio of expected vs actual blocks found. >1.0 = lucky, <1.0 = unlucky" />
              </p>
              <p className={`text-xl font-semibold ${luckColor}`}>
                {performanceMetrics.luck !== null
                  ? `${performanceMetrics.luck.toFixed(3)}x`
                  : "—"}
              </p>
              <p className="text-xs text-muted-foreground">
                {performanceMetrics.luck !== null
                  ? performanceMetrics.luck >= 1
                    ? "Finding more blocks than expected"
                    : "Finding fewer blocks than expected"
                  : "Network difficulty required"}
              </p>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-4 flex items-start gap-3">
            <Timer className="h-5 w-5 text-muted-foreground mt-0.5" />
            <div>
              <p className="text-sm text-muted-foreground">
                Avg Round Duration
                <InfoTooltip text="Average time between blocks found — depends on pool hashrate and network difficulty" />
              </p>
              <p className="text-xl font-semibold">
                {formatRoundDuration(performanceMetrics.avgRoundSec)}
              </p>
              <p className="text-xs text-muted-foreground">
                {performanceMetrics.roundsSampled > 0
                  ? `${performanceMetrics.roundsSampled} rounds sampled`
                  : "No round data"}
              </p>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-4 flex items-start gap-3">
            <BarChart className="h-5 w-5 text-muted-foreground mt-0.5" />
            <div>
              <p className="text-sm text-muted-foreground">
                Round Duration Variance
                <InfoTooltip text="How much round times vary — high variance is normal for small pools" />
              </p>
              <p className="text-xl font-semibold">
                {performanceMetrics.stdDevSec > 0
                  ? `\u00B1${formatRoundDuration(performanceMetrics.stdDevSec)}`
                  : "—"}
              </p>
              <p className="text-xs text-muted-foreground">Standard deviation</p>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-4 flex items-start gap-3">
            <Activity className="h-5 w-5 text-muted-foreground mt-0.5" />
            <div>
              <p className="text-sm text-muted-foreground">
                Hashrate Efficiency
                <InfoTooltip text="Ratio of current to average hashrate — shows if hashrate is above or below normal" />
              </p>
              <p className="text-xl font-semibold">
                {performanceMetrics.efficiencyRatio !== null
                  ? `${(performanceMetrics.efficiencyRatio * 100).toFixed(1)}%`
                  : "—"}
              </p>
              <p className="text-xs text-muted-foreground">
                Instant / average ratio
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
