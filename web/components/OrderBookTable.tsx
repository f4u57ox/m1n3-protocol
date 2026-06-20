"use client";

import React from "react";
import type { OrderBookData } from "@/lib/types";

interface OrderBookTableProps {
  orderBook: OrderBookData;
}

export const OrderBookTable = React.memo(function OrderBookTable({
  orderBook,
}: OrderBookTableProps) {
  const { bids, asks, spread, midpoint } = orderBook;

  // Show top 10 levels each side
  const topBids = bids.slice(0, 10);
  const topAsks = asks.slice(0, 10);
  const maxCum = Math.max(
    topBids.length > 0 ? topBids[topBids.length - 1].cumulativePh : 0,
    topAsks.length > 0 ? topAsks[topAsks.length - 1].cumulativePh : 0,
  );

  return (
    <div className="rounded-lg border bg-card text-sm overflow-hidden">
      <div className="grid grid-cols-2 divide-x divide-border">
        {/* Bids (green) */}
        <div>
          <div className="grid grid-cols-3 text-xs text-muted-foreground px-3 py-2 border-b font-medium">
            <span>Price</span>
            <span className="text-right">Hashrate (PH)</span>
            <span className="text-right">Total</span>
          </div>
          <div className="divide-y divide-border/50">
            {topBids.map((bid, i) => {
              const barWidth = maxCum > 0 ? (bid.cumulativePh / maxCum) * 100 : 0;
              return (
                <div
                  key={i}
                  className="grid grid-cols-3 px-3 py-1.5 relative"
                >
                  <div
                    className="absolute inset-0 bg-green-500/10"
                    style={{ width: `${barWidth}%` }}
                  />
                  <span className="relative text-green-600 dark:text-green-400 font-mono">
                    ${bid.price.toFixed(4)}
                  </span>
                  <span className="relative text-right font-mono">
                    {bid.hashratePh.toFixed(2)}
                  </span>
                  <span className="relative text-right font-mono text-muted-foreground">
                    {bid.cumulativePh.toFixed(2)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Asks (red) */}
        <div>
          <div className="grid grid-cols-3 text-xs text-muted-foreground px-3 py-2 border-b font-medium">
            <span>Price</span>
            <span className="text-right">Hashrate (PH)</span>
            <span className="text-right">Total</span>
          </div>
          <div className="divide-y divide-border/50">
            {topAsks.map((ask, i) => {
              const barWidth = maxCum > 0 ? (ask.cumulativePh / maxCum) * 100 : 0;
              return (
                <div
                  key={i}
                  className="grid grid-cols-3 px-3 py-1.5 relative"
                >
                  <div
                    className="absolute inset-0 bg-red-500/10"
                    style={{ width: `${barWidth}%` }}
                  />
                  <span className="relative text-red-600 dark:text-red-400 font-mono">
                    ${ask.price.toFixed(4)}
                  </span>
                  <span className="relative text-right font-mono">
                    {ask.hashratePh.toFixed(2)}
                  </span>
                  <span className="relative text-right font-mono text-muted-foreground">
                    {ask.cumulativePh.toFixed(2)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Spread row */}
      <div className="border-t px-3 py-2 text-xs text-muted-foreground flex justify-between">
        <span>
          Spread: <span className="font-mono">${spread.toFixed(4)} USD</span>
        </span>
        <span>
          Mid: <span className="font-mono">${midpoint.toFixed(4)} USD</span>
        </span>
      </div>
    </div>
  );
});
