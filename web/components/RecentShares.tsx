"use client";

import React from "react";
import { useRecentShares } from "@/hooks/useRecentShares";
import { formatDifficulty, solscanTx, solscanAccount } from "@/lib/utils";
import { Zap, Box, ExternalLink, FileText, DollarSign } from "lucide-react";

/** Format µUSDC (6 decimals) as a compact USDC string. */
function formatPayoutUsdc(microUsdc: number): string {
  const usdc = microUsdc / 1_000_000;
  if (usdc >= 1) return `$${usdc.toFixed(2)}`;
  if (usdc >= 0.01) return `$${usdc.toFixed(4)}`;
  // Sub-cent — show with the full µUSDC precision so per-share payouts at
  // price_per_difficulty=1 (~1 µUSDC per diff-1 unit) stay readable.
  return `$${usdc.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}

function shortenAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatTimeAgo(timestampMs: number): string {
  const seconds = Math.floor((Date.now() - timestampMs) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export const RecentShares = React.memo(function RecentShares() {
  const { shares, loading, error } = useRecentShares(15);

  if (loading) {
    return (
      <div className="rounded-lg border bg-card p-4">
        <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
          <Zap className="h-4 w-4" />
          Recent Shares
        </h3>
        <div className="animate-pulse space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-8 bg-muted rounded" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border bg-card p-4">
        <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
          <Zap className="h-4 w-4" />
          Recent Shares
        </h3>
        <p className="text-sm text-muted-foreground">Failed to load shares</p>
      </div>
    );
  }

  const fullCount = shares.filter((s) => s.mode === "full").length;
  const lightweightCount = shares.filter((s) => s.mode === "lightweight").length;
  const buyerCount = shares.filter((s) => s.mode === "buyer-v1" || s.mode === "buyer-v2").length;

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Zap className="h-4 w-4" />
          Recent Shares
        </h3>
        <div className="flex gap-2 text-xs">
          {fullCount > 0 && (
            <span className="inline-flex items-center rounded-full px-2 py-0.5 bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
              <Box className="h-3 w-3 mr-1" />
              {fullCount} Pool
            </span>
          )}
          {buyerCount > 0 && (
            <span className="inline-flex items-center rounded-full px-2 py-0.5 bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20">
              <DollarSign className="h-3 w-3 mr-1" />
              {buyerCount} Private
            </span>
          )}
          {lightweightCount > 0 && (
            <span className="inline-flex items-center rounded-full px-2 py-0.5 bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20">
              <Zap className="h-3 w-3 mr-1" />
              {lightweightCount} Lite
            </span>
          )}
        </div>
      </div>

      {shares.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">
          No shares submitted yet — shares appear here in real-time as miners submit proof-of-work
        </p>
      ) : (
        <div className="space-y-1 max-h-[400px] overflow-y-auto">
          {shares.map((share, idx) => {
            const isBuyer = share.mode === "buyer-v1" || share.mode === "buyer-v2";
            const laneTitle =
              share.mode === "lightweight"
                ? "Lightweight (no NFT)"
                : share.mode === "buyer-v1"
                  ? "Buyer-pay V1 — template-pinned (paid in USDC)"
                  : share.mode === "buyer-v2"
                    ? "Buyer-pay V2 — buyer-bound (paid in USDC)"
                    : "Pool lane — credits MinerRoundStats";
            const laneClasses = isBuyer
              ? "bg-purple-500/20 text-purple-600 dark:text-purple-400"
              : share.mode === "lightweight"
                ? "bg-green-500/20 text-green-600 dark:text-green-400"
                : "bg-blue-500/20 text-blue-600 dark:text-blue-400";
            return (
            <div
              key={`${share.txDigest}-${idx}`}
              className={`flex items-center justify-between py-1.5 px-2 rounded text-xs ${
                share.isBlock
                  ? "bg-yellow-500/10 border border-yellow-500/30"
                  : "hover:bg-muted/50"
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`inline-flex items-center justify-center w-5 h-5 rounded ${laneClasses}`}
                  title={laneTitle}
                >
                  {isBuyer ? (
                    <DollarSign className="h-3 w-3" />
                  ) : share.mode === "lightweight" ? (
                    <Zap className="h-3 w-3" />
                  ) : (
                    <Box className="h-3 w-3" />
                  )}
                </span>
                <span className="font-mono text-muted-foreground">
                  {shortenAddress(share.miner)}
                </span>
                {share.isBlock && (
                  <span className="text-yellow-600 dark:text-yellow-400 font-medium">
                    BLOCK!
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3">
                {isBuyer && typeof share.payoutMicro === "number" && (
                  <span
                    className="text-purple-600 dark:text-purple-400 font-medium"
                    title="USDC paid to the miner inside the share-submission PTB"
                  >
                    {formatPayoutUsdc(share.payoutMicro)}
                  </span>
                )}
                <span className="text-muted-foreground">
                  diff: {formatDifficulty(share.difficultyAchieved)}
                </span>
                {share.templateId && (
                  <a
                    href={solscanAccount(share.templateId)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground hover:text-foreground"
                    title="View template on SuiScan"
                  >
                    <FileText className="h-3 w-3" />
                  </a>
                )}
                <span className="text-muted-foreground w-14 text-right">
                  {formatTimeAgo(share.timestampMs)}
                </span>
                <a
                  href={solscanTx(share.txDigest)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-foreground"
                  title="View transaction on SuiScan"
                >
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
            );
          })}
        </div>
      )}

      <div className="mt-3 pt-3 border-t text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <div className="flex items-center gap-1">
            <Box className="h-3 w-3 text-blue-500" />
            <span>Pool — credits MinerRoundStats, paid in BTC at round close</span>
          </div>
          <div className="flex items-center gap-1">
            <DollarSign className="h-3 w-3 text-purple-500" />
            <span>Private — buyer-pay, USDC paid atomically inside the share PTB</span>
          </div>
        </div>
      </div>
    </div>
  );
});
