"use client";

import {
  Area,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ReferenceArea,
  ResponsiveContainer,
  Label,
} from "recharts";
import type { HedgeSummary, PayoffPoint } from "@/lib/hedge-math";

const COLOR_UNHEDGED = "#f7931a"; // bitcoin orange
const COLOR_HEDGED = "#34d399"; // emerald-400

function fmtUsd(v: number): string {
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

interface TooltipItem {
  dataKey: string;
  value: number;
}

function PayoffTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipItem[];
  label?: number;
}) {
  if (!active || !payload || !payload.length || label == null) return null;
  const unhedged = payload.find((p) => p.dataKey === "unhedged")?.value ?? 0;
  const hedged = payload.find((p) => p.dataKey === "hedged")?.value ?? 0;
  const diff = hedged - unhedged;
  return (
    <div className="rounded-xl border border-border bg-background/95 px-3 py-2 font-mono text-xs shadow-lg backdrop-blur">
      <div className="mb-1.5 text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        BTC settles {fmtUsd(label)}
      </div>
      <div className="flex items-center justify-between gap-4">
        <span style={{ color: COLOR_UNHEDGED }}>Unhedged</span>
        <span className="text-foreground">${unhedged.toFixed(2)}</span>
      </div>
      <div className="mt-0.5 flex items-center justify-between gap-4">
        <span style={{ color: COLOR_HEDGED }}>Hedged</span>
        <span className="text-foreground">${hedged.toFixed(2)}</span>
      </div>
      <div
        className="mt-2 border-t border-border/60 pt-1.5 text-center text-[10px] uppercase tracking-[0.2em]"
        style={{ color: diff >= 0 ? COLOR_HEDGED : "#ef4444" }}
      >
        {diff >= 0
          ? `+$${diff.toFixed(2)} protected`
          : `−$${Math.abs(diff).toFixed(2)} premium`}
      </div>
    </div>
  );
}

/**
 * Hedged-vs-unhedged revenue as a function of BTC settlement price. The
 * shaded band is where the put-strip pays; the dashed line is current spot.
 * Below the floor the hedged line goes flat — that flat is the protection.
 */
export function HedgePayoffChart({
  payoff,
  spot,
  summary,
}: {
  payoff: PayoffPoint[];
  spot: number;
  summary: HedgeSummary | null;
}) {
  if (payoff.length === 0) return null;

  return (
    <div className="h-[240px] w-full sm:h-[300px]">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={payoff}
          margin={{ top: 8, right: 12, left: 4, bottom: 26 }}
        >
          <defs>
            <linearGradient id="hedgeFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={COLOR_HEDGED} stopOpacity={0.18} />
              <stop offset="100%" stopColor={COLOR_HEDGED} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="1 4"
            className="stroke-border"
            vertical={false}
          />
          {summary && (
            <ReferenceArea
              x1={summary.floorUsd}
              x2={summary.topUsd}
              fill={COLOR_HEDGED}
              fillOpacity={0.06}
              ifOverflow="extendDomain"
            />
          )}
          <XAxis
            dataKey="price"
            type="number"
            domain={["dataMin", "dataMax"]}
            className="stroke-muted-foreground/40"
            tick={{ fontSize: 10, fontFamily: "var(--font-mono)" }}
            tickLine={false}
            tickFormatter={(v) => `$${(v / 1000).toFixed(1)}k`}
          >
            <Label
              value="BTC settlement price"
              offset={-6}
              position="insideBottom"
              style={{
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                letterSpacing: 2,
                textTransform: "uppercase",
                fill: "currentColor",
                opacity: 0.6,
              }}
            />
          </XAxis>
          <YAxis
            className="stroke-muted-foreground/40"
            tick={{ fontSize: 10, fontFamily: "var(--font-mono)" }}
            tickLine={false}
            tickFormatter={(v) => `$${v.toFixed(0)}`}
            width={48}
            domain={["auto", "auto"]}
          />
          <Tooltip content={<PayoffTooltip />} cursor={{ stroke: "currentColor", strokeOpacity: 0.15 }} />
          <ReferenceLine
            x={spot}
            strokeDasharray="3 5"
            strokeOpacity={0.5}
            className="stroke-foreground"
            label={{
              value: "SPOT",
              position: "insideTopLeft",
              fontSize: 9,
              fontFamily: "var(--font-mono)",
              fill: "currentColor",
              opacity: 0.7,
            }}
          />
          {summary && (
            <ReferenceLine
              x={summary.floorUsd}
              strokeDasharray="2 4"
              stroke={COLOR_HEDGED}
              strokeOpacity={0.5}
              label={{
                value: "FLOOR",
                position: "insideBottomLeft",
                fontSize: 9,
                fontFamily: "var(--font-mono)",
                fill: COLOR_HEDGED,
                opacity: 0.9,
              }}
            />
          )}
          <Area
            type="monotone"
            dataKey="hedged"
            stroke="none"
            fill="url(#hedgeFill)"
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="unhedged"
            stroke={COLOR_UNHEDGED}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
            name="Unhedged"
          />
          <Line
            type="monotone"
            dataKey="hedged"
            stroke={COLOR_HEDGED}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
            name="Hedged"
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
