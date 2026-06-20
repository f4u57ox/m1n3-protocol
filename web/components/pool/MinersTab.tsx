"use client";

import { useMiners } from "@/hooks/useMiners";
import { useDifficultyResets } from "@/hooks/useDifficultyResets";
import { MinerTable } from "@/components/MinerTable";
import { DifficultyResetLog } from "@/components/DifficultyResetLog";
import { RecentShares } from "@/components/RecentShares";
import { STALENESS_THRESHOLD_MS } from "@/lib/constants";
import { formatHashrate } from "@/lib/utils";

export function MinersTab() {
  const { miners, loading, error } = useMiners();
  const { resets, loading: resetsLoading } = useDifficultyResets();

  const now = Date.now();
  const staleCount = miners.filter(
    (m) => m.lastShareTimeMs > 0 && now - m.lastShareTimeMs > STALENESS_THRESHOLD_MS,
  ).length;
  const totalHashrate = miners.reduce((sum, m) => sum + m.estimatedHashrate, 0);
  const activeCount = miners.length - staleCount;
  const avgHashratePerMiner = activeCount > 0 ? totalHashrate / activeCount : 0;

  const soloCount = miners.filter((m) => m.miningMode === "solo").length;
  const pooledCount = miners.filter((m) => m.miningMode === "pooled").length;

  return (
    <div className="space-y-6">
      {/* Summary badges */}
      {!loading && miners.length > 0 && (
        <div className="flex gap-3 flex-wrap">
          <span className="inline-flex items-center rounded-full px-3 py-1 text-sm font-medium bg-card border">
            {miners.length} registered
          </span>
          <span className="inline-flex items-center rounded-full px-3 py-1 text-sm font-medium bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20">
            {miners.length - staleCount} active
          </span>
          {staleCount > 0 && (
            <span className="inline-flex items-center rounded-full px-3 py-1 text-sm font-medium bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border border-yellow-500/20">
              {staleCount} stale (&gt;{STALENESS_THRESHOLD_MS / 1000}s idle)
            </span>
          )}
          {totalHashrate > 0 && (
            <span className="inline-flex items-center rounded-full px-3 py-1 text-sm font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
              Pool: {formatHashrate(totalHashrate)}
            </span>
          )}
          {avgHashratePerMiner > 0 && (
            <span className="inline-flex items-center rounded-full px-3 py-1 text-sm font-medium bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20">
              Avg/Miner: {formatHashrate(avgHashratePerMiner)}
            </span>
          )}
          {soloCount > 0 && (
            <span className="inline-flex items-center rounded-full px-3 py-1 text-sm font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
              {soloCount} solo
            </span>
          )}
          {pooledCount > 0 && (
            <span className="inline-flex items-center rounded-full px-3 py-1 text-sm font-medium bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border border-cyan-500/20">
              {pooledCount} pooled
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          {loading ? (
            <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground animate-pulse">
              Loading miners...
            </div>
          ) : (
            <MinerTable miners={miners} />
          )}
        </div>
        <div>
          <RecentShares />
        </div>
      </div>

      {/* Difficulty Reset Log */}
      <div>
        <h2 className="text-lg font-semibold mb-2">Difficulty Resets</h2>
        <p className="text-sm text-muted-foreground mb-3">
          Miners whose on-chain difficulty was automatically reset due to inactivity
        </p>
        {resetsLoading ? (
          <div className="rounded-lg border bg-card p-6 text-center text-muted-foreground animate-pulse">
            Loading resets...
          </div>
        ) : (
          <DifficultyResetLog resets={resets} />
        )}
      </div>
    </div>
  );
}
