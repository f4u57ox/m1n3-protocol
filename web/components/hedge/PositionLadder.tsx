"use client";

import { Fragment, useMemo } from "react";
import { strikeToUsd } from "@/lib/predict-client";

export interface LadderRange {
  lower_strike: number;
  higher_strike: number;
  quantity: string | number;
}

interface Rung {
  lo: number;
  hi: number;
  qty: number;
  inMoney: boolean;
}

/**
 * Visual strike ladder for a set of range positions. Rungs are stacked
 * high→low strike; each bar's width is proportional to its DUSDC payout,
 * green when current spot sits inside it. A spot marker is threaded between
 * the rungs so the miner can see at a glance which ranges are live.
 */
export function PositionLadder({
  ranges,
  spot,
  quantityScale = 1_000_000,
}: {
  ranges: LadderRange[];
  spot: number;
  /** Divisor to convert raw quantity to DUSDC (1e6 for on-chain reads). */
  quantityScale?: number;
}) {
  const { rungs, maxQty, spotIndex } = useMemo(() => {
    const r: Rung[] = ranges
      .map((x) => {
        const lo = strikeToUsd(x.lower_strike);
        const hi = strikeToUsd(x.higher_strike);
        return {
          lo,
          hi,
          qty: Number(x.quantity) / quantityScale,
          inMoney: spot >= lo && spot < hi,
        };
      })
      .sort((a, b) => b.hi - a.hi);
    const maxQty = r.reduce((m, x) => Math.max(m, x.qty), 0) || 1;
    // Where does spot fall in the descending ladder? (index to insert before)
    let spotIndex = r.length;
    for (let i = 0; i < r.length; i++) {
      if (spot >= r[i].hi) {
        spotIndex = i;
        break;
      }
    }
    return { rungs: r, maxQty, spotIndex };
  }, [ranges, spot, quantityScale]);

  if (rungs.length === 0) return null;

  const SpotMarker = (
    <div className="flex items-center gap-2 py-0.5">
      <div className="h-px flex-1 bg-foreground/40" />
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-foreground/80">
        spot ${spot.toLocaleString(undefined, { maximumFractionDigits: 0 })}
      </span>
      <div className="h-px flex-1 bg-foreground/40" />
    </div>
  );

  return (
    <div className="space-y-1">
      {rungs.map((rung, i) => (
        <Fragment key={i}>
          {i === spotIndex && SpotMarker}
          <div className="flex items-center gap-3">
            <span className="w-28 shrink-0 font-mono text-[11px] text-muted-foreground">
              ${rung.lo.toFixed(0)}–${rung.hi.toFixed(0)}
            </span>
            <div className="relative h-5 flex-1 overflow-hidden rounded bg-muted/30">
              <div
                className={`h-full rounded ${
                  rung.inMoney ? "bg-emerald-500/70" : "bg-muted-foreground/25"
                }`}
                style={{ width: `${Math.max(4, (rung.qty / maxQty) * 100)}%` }}
              />
              <span className="absolute inset-y-0 left-2 flex items-center font-mono text-[10px] text-foreground/80">
                {rung.qty.toFixed(3)} DUSDC
              </span>
            </div>
            <span
              className={`w-12 shrink-0 text-right font-mono text-[10px] uppercase ${
                rung.inMoney ? "text-emerald-400" : "text-muted-foreground/60"
              }`}
            >
              {rung.inMoney ? "live" : "—"}
            </span>
          </div>
        </Fragment>
      ))}
      {spotIndex >= rungs.length && SpotMarker}
    </div>
  );
}
