"use client";

import { useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Label,
} from "recharts";
import { useHashprice } from "@/hooks/useHashprice";

/**
 * Cost comparison — m1n3 flat verification cost vs traditional pool's 2%
 * cut on every payout.
 *
 * All math is **subsidy-only**: we pull the live hashprice from
 * `useHashprice` (which itself uses `block_subsidy × blocks/day × btc_price`,
 * no transaction fees). When the live feed is unavailable we fall back to
 * a conservative subsidy-only constant.
 */
const M1N3_FIXED = 5.57; // $/day flat
const POOL_FEE_PCT = 0.02;
// Fallback hashprice for SSR / first paint, computed from subsidy only at
// Δ≈124T and BTC≈$100k. The live useHashprice value supersedes this on mount.
const FALLBACK_HASHPRICE_PER_TH = 0.0507;

type Pt = { ph: number; pool: number; m1n3: number };

function buildSeries(hashpricePerTh: number): Pt[] {
  const steps = [
    ...Array.from({ length: 20 }, (_, i) => (i + 1) * 0.5),
    ...Array.from({ length: 18 }, (_, i) => (i + 11) * 1),
    ...Array.from({ length: 10 }, (_, i) => (i + 3) * 10),
  ];
  const unique = [...new Set(steps)].sort((a, b) => a - b);
  return unique.map((ph) => {
    const thPerDay = ph * 1000;
    const pool = POOL_FEE_PCT * thPerDay * hashpricePerTh;
    return {
      ph,
      pool: +pool.toFixed(2),
      m1n3: M1N3_FIXED,
    };
  });
}

const COLOR_POOL = "#f7931a"; // bitcoin orange
const COLOR_M1N3 = "#34d399"; // emerald-400

interface TooltipPayloadItem {
  dataKey: string;
  value: number;
}

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: number;
}) {
  if (!active || !payload || !payload.length) return null;
  const pool = payload.find((p) => p.dataKey === "pool")?.value ?? 0;
  const m1n3 = payload.find((p) => p.dataKey === "m1n3")?.value ?? 0;
  const diff = pool - m1n3;
  return (
    <div className="rounded-xl border border-border bg-background/95 px-3 py-2 font-mono text-xs shadow-lg backdrop-blur">
      <div className="mb-1.5 text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
        {label} PH/s
      </div>
      <div className="flex items-center justify-between gap-4 text-foreground/80">
        <span style={{ color: COLOR_POOL }}>Pool 2%</span>
        <span className="text-foreground">${pool.toFixed(2)}/day</span>
      </div>
      <div className="mt-0.5 flex items-center justify-between gap-4 text-foreground/80">
        <span style={{ color: COLOR_M1N3 }}>m1n3 flat</span>
        <span className="text-foreground">${m1n3.toFixed(2)}/day</span>
      </div>
      <div
        className="mt-2 border-t border-border/60 pt-2 text-center text-[10px] uppercase tracking-[0.2em]"
        style={{ color: diff > 0 ? COLOR_M1N3 : "#ef4444" }}
      >
        {diff > 0
          ? `Saves $${diff.toFixed(2)}/day`
          : `Loses $${Math.abs(diff).toFixed(2)}/day`}
      </div>
    </div>
  );
}

export function CostChart() {
  const [hovered, _setHovered] = useState<number | null>(null);
  void hovered;

  // Live, subsidy-only hashprice from on-chain difficulty.
  const { hashprice: hashpricePerPh, btcPrice, networkDifficulty } =
    useHashprice();
  // useHashprice gives $/PH/day. Convert to $/TH/day (÷ 1000).
  const hashpricePerTh = hashpricePerPh
    ? hashpricePerPh / 1000
    : FALLBACK_HASHPRICE_PER_TH;

  const data = useMemo(
    () => buildSeries(hashpricePerTh),
    [hashpricePerTh],
  );
  const breakevenPh = useMemo(
    () => M1N3_FIXED / (POOL_FEE_PCT * 1000 * hashpricePerTh),
    [hashpricePerTh],
  );

  return (
    <section className="relative">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:py-16 md:py-20">
        <div className="text-center">
          <p className="font-mono text-[10px] sm:text-[11px] uppercase tracking-[0.3em] sm:tracking-[0.4em] text-muted-foreground">
            Protocol economics
          </p>
          <h2 className="mt-4 text-balance text-3xl font-semibold tracking-tight sm:text-4xl md:text-5xl">
            One flat cost vs 2% on every payout.
          </h2>
          <p className="mx-auto mt-4 sm:mt-5 max-w-2xl text-balance text-sm sm:text-base md:text-lg text-muted-foreground">
            m1n3 charges a fixed daily verification cost — the gas to settle
            each share on Sui. Traditional pools charge a percentage. Above{" "}
            <span className="font-mono text-foreground">
              {breakevenPh.toFixed(1)} PH/s
            </span>{" "}
            the m1n3 flat fee is the cheaper one, and the gap widens linearly
            with your hashrate.
          </p>
          <p className="mt-4 inline-flex items-center gap-2 rounded-full bg-emerald-500/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.25em] text-emerald-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Subsidy only · no tx fees · live difficulty
          </p>
        </div>

        {/* KPI row */}
        <div className="mt-10 sm:mt-12 grid gap-3 sm:gap-4 sm:grid-cols-3">
          <Kpi value="$5.57" unit="m1n3 flat / day" color={COLOR_M1N3} />
          <Kpi
            value={`$${hashpricePerTh.toFixed(4)}`}
            unit="Subsidy-only hashprice / TH·day"
            color={COLOR_POOL}
          />
          <Kpi
            value={`~${breakevenPh.toFixed(1)} PH/s`}
            unit="Break-even hashrate"
            color="hsl(var(--foreground))"
          />
        </div>

        {/* Chart */}
        <div className="mt-8 sm:mt-10 rounded-2xl border border-border bg-card/40 p-4 backdrop-blur sm:p-6">
          <div className="h-[260px] w-full sm:h-[360px] md:h-[420px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={data}
                margin={{ top: 10, right: 16, left: 0, bottom: 32 }}
              >
                <CartesianGrid
                  strokeDasharray="1 4"
                  className="stroke-border"
                  vertical={false}
                />
                <XAxis
                  dataKey="ph"
                  className="stroke-muted-foreground/40"
                  tick={{ fontSize: 10, fontFamily: "var(--font-mono)" }}
                  tickLine={false}
                  tickFormatter={(v) => `${v} PH`}
                >
                  <Label
                    value="Miner hashrate"
                    offset={-8}
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
                  tickFormatter={(v) => `$${v}`}
                  domain={[0, 120]}
                  width={40}
                />
                <Tooltip content={<CustomTooltip />} cursor={{ stroke: "currentColor", strokeOpacity: 0.15 }} />
                <ReferenceLine
                  x={parseFloat(breakevenPh.toFixed(1))}
                  strokeDasharray="3 6"
                  strokeOpacity={0.4}
                  className="stroke-foreground"
                  label={{
                    value: "BREAK-EVEN",
                    position: "insideTopRight",
                    fontSize: 9,
                    fontFamily: "var(--font-mono)",
                    fill: "currentColor",
                    opacity: 0.7,
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="pool"
                  stroke={COLOR_POOL}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, fill: COLOR_POOL, stroke: "hsl(var(--background))", strokeWidth: 2 }}
                  name="Pool 2%"
                />
                <Line
                  type="monotone"
                  dataKey="m1n3"
                  stroke={COLOR_M1N3}
                  strokeWidth={2}
                  strokeDasharray="6 3"
                  dot={false}
                  activeDot={{ r: 4, fill: COLOR_M1N3, stroke: "hsl(var(--background))", strokeWidth: 2 }}
                  name="m1n3"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="mt-4 flex flex-col gap-2 text-[11px] font-mono uppercase tracking-[0.2em] text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: COLOR_POOL }} />
                Traditional pool (2% per payout)
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: COLOR_M1N3 }} />
                m1n3 (flat verification)
              </div>
            </div>
            <span className="text-muted-foreground/70">
              Hashprice ${hashpricePerTh.toFixed(4)}/TH·day
              {btcPrice != null && networkDifficulty != null && (
                <>
                  {" "}· BTC ${(btcPrice / 1000).toFixed(1)}k · Δ{" "}
                  {(networkDifficulty / 1e12).toFixed(1)}T
                </>
              )}
            </span>
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground sm:text-sm">
          Above break-even, the m1n3 advantage compounds with scale. And the
          flat cost produces a tradeable on-chain HashShare — the pool fee
          produces nothing.
        </p>
      </div>
    </section>
  );
}

function Kpi({
  value,
  unit,
  color,
}: {
  value: string;
  unit: string;
  color: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card/40 px-5 py-4 text-center backdrop-blur sm:px-6 sm:py-5">
      <div
        className="font-mono text-2xl font-semibold sm:text-3xl"
        style={{ color }}
      >
        {value}
      </div>
      <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
        {unit}
      </div>
    </div>
  );
}
