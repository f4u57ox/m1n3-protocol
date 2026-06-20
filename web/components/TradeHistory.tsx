"use client";

import React from "react";
import type { SimulatedTrade } from "@/lib/types";

interface TradeHistoryProps {
  trades: SimulatedTrade[];
}

function formatTimeAgo(timestampMs: number): string {
  const seconds = Math.floor((Date.now() - timestampMs) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export const TradeHistory = React.memo(function TradeHistory({
  trades,
}: TradeHistoryProps) {
  const recent = trades.slice(0, 20);

  return (
    <div className="rounded-lg border bg-card">
      <div className="px-4 py-3 border-b">
        <h3 className="text-sm font-medium">Recent Trades</h3>
      </div>

      {recent.length === 0 ? (
        <div className="px-4 py-6 text-sm text-muted-foreground text-center">
          No trades yet. Run the simulation to generate trades.
        </div>
      ) : (
        <div className="max-h-[320px] overflow-y-auto divide-y divide-border/50">
          {recent.map((trade, idx) => (
            <div
              key={idx}
              className="flex items-center justify-between px-4 py-2 text-xs hover:bg-muted/50"
            >
              <div className="flex items-center gap-3">
                <span
                  className={`inline-flex items-center rounded px-1.5 py-0.5 font-medium ${
                    trade.side === "buy"
                      ? "bg-green-500/10 text-green-600 dark:text-green-400"
                      : "bg-red-500/10 text-red-600 dark:text-red-400"
                  }`}
                >
                  {trade.side.toUpperCase()}
                </span>
                <span className="font-mono">${trade.price.toFixed(4)}</span>
                <span className="text-muted-foreground">
                  {trade.hashratePh.toFixed(2)} PH
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-muted-foreground">
                  {trade.discountPct.toFixed(1)}% disc.
                </span>
                <span className="text-muted-foreground w-16 text-right">
                  {formatTimeAgo(trade.timestampMs)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
