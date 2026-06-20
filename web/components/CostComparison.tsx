"use client";

import { useState } from "react";
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

const HASH_PRICE = 0.0478; // $/TH/day
const M1N3_FIXED = 5.57; // $/day flat
const POOL_FEE_PCT = 0.02;
const BREAKEVEN_PH = M1N3_FIXED / (POOL_FEE_PCT * 1000 * HASH_PRICE); // ~5.83 PH

const generateData = () => {
  const points: { ph: number; pool: number; m1n3: number; savings: number }[] = [];
  const steps = [
    ...Array.from({ length: 20 }, (_, i) => (i + 1) * 0.5),
    ...Array.from({ length: 18 }, (_, i) => (i + 11) * 1),
    ...Array.from({ length: 10 }, (_, i) => (i + 3) * 10),
  ];
  const unique = [...new Set(steps)].sort((a, b) => a - b);
  for (const ph of unique) {
    const thPerDay = ph * 1000;
    const poolCost = POOL_FEE_PCT * thPerDay * HASH_PRICE;
    points.push({
      ph,
      pool: parseFloat(poolCost.toFixed(2)),
      m1n3: M1N3_FIXED,
      savings: parseFloat((poolCost - M1N3_FIXED).toFixed(2)),
    });
  }
  return points;
};

const data = generateData();

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
    <div className="rounded border border-neutral-200 bg-white p-3 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-900">
      <div className="mb-2 text-[10px] tracking-widest text-neutral-400 dark:text-neutral-500">
        {label} PH/s
      </div>
      <div className="mb-1 text-[#f7931a]">
        Pool 2%:{" "}
        <span className="text-neutral-900 dark:text-white">${pool.toFixed(2)}/day</span>
      </div>
      <div className="mb-2 text-[#3ecf8e]">
        m1n3:{" "}
        <span className="text-neutral-900 dark:text-white">${m1n3.toFixed(2)}/day</span>
      </div>
      <div
        className="border-t border-neutral-200 pt-2 dark:border-neutral-700"
        style={{ color: diff > 0 ? "#3ecf8e" : "#ff4444" }}
      >
        {diff > 0
          ? `m1n3 saves $${diff.toFixed(2)}/day`
          : `Pool saves $${Math.abs(diff).toFixed(2)}/day`}
      </div>
    </div>
  );
}

export function CostComparison() {
  const [hovered, setHovered] = useState<number | null>(null);

  return (
    <div className="flex flex-col items-center justify-center rounded-lg bg-neutral-50 px-4 py-8 font-mono text-neutral-900 sm:px-8 sm:py-12 dark:bg-neutral-950 dark:text-white">
      {/* Header */}
      <div className="mb-8 w-full max-w-[900px] sm:mb-12">
        <div className="mb-3 text-[10px] uppercase tracking-[4px] text-[#f7931a]">
          Protocol Economics
        </div>
        <div className="mb-2 font-['Space_Grotesk',sans-serif] text-2xl font-bold leading-tight tracking-tight sm:text-[32px]">
          Daily Verification Cost
          <br />
          <span className="text-[#f7931a]">m1n3</span>{" "}
          <span className="text-neutral-300 dark:text-neutral-600">vs</span>{" "}
          <span className="text-neutral-500 dark:text-neutral-400">Traditional Pool</span>
        </div>
        <div className="text-xs tracking-wider text-neutral-400 dark:text-neutral-500">
          Hash price ${HASH_PRICE}/TH/day &middot; SOL $140 &middot; 1 share/30s
        </div>
      </div>

      {/* Stats Row */}
      <div className="mb-8 grid w-full max-w-[900px] grid-cols-1 gap-3 sm:mb-10 sm:grid-cols-3">
        <div className="rounded border border-neutral-200 bg-white px-6 py-4 text-center dark:border-neutral-800 dark:bg-neutral-900">
          <div className="font-mono text-2xl font-semibold text-[#3ecf8e] sm:text-[28px]">
            $5.57
          </div>
          <div className="mt-1 text-[10px] uppercase tracking-widest text-neutral-400 dark:text-neutral-500">
            m1n3 fixed / day
          </div>
        </div>
        <div className="rounded border border-neutral-200 bg-white px-6 py-4 text-center dark:border-neutral-800 dark:bg-neutral-900">
          <div className="font-mono text-2xl font-semibold text-[#f7931a] sm:text-[28px]">
            2%
          </div>
          <div className="mt-1 text-[10px] uppercase tracking-widest text-neutral-400 dark:text-neutral-500">
            Pool fee on every payout
          </div>
        </div>
        <div className="rounded border border-neutral-200 bg-white px-6 py-4 text-center dark:border-neutral-800 dark:bg-neutral-900">
          <div className="font-mono text-2xl font-semibold text-neutral-900 sm:text-[28px] dark:text-white">
            ~5.8 PH/s
          </div>
          <div className="mt-1 text-[10px] uppercase tracking-widest text-neutral-400 dark:text-neutral-500">
            Break-even point
          </div>
        </div>
      </div>

      {/* Chart */}
      <div className="h-[300px] w-full max-w-[900px] sm:h-[420px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data}
            margin={{ top: 10, right: 10, left: 0, bottom: 40 }}
          >
            <defs>
              <linearGradient id="poolGrad" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#f7931a" stopOpacity={0.6} />
                <stop offset="100%" stopColor="#f7931a" stopOpacity={1} />
              </linearGradient>
            </defs>

            <CartesianGrid
              strokeDasharray="1 4"
              className="stroke-neutral-200 dark:stroke-neutral-800"
              vertical={false}
            />

            <XAxis
              dataKey="ph"
              className="stroke-neutral-300 dark:stroke-neutral-700"
              tick={{ fontSize: 11, fontFamily: "IBM Plex Mono" }}
              tickLine={false}
              tickFormatter={(v) => `${v} PH`}
            >
              <Label
                value="Miner Hashrate"
                offset={-10}
                position="insideBottom"
                style={{
                  fontSize: 11,
                  fontFamily: "IBM Plex Mono",
                  letterSpacing: 2,
                  textTransform: "uppercase",
                }}
              />
            </XAxis>

            <YAxis
              className="stroke-neutral-300 dark:stroke-neutral-700"
              tick={{ fontSize: 11, fontFamily: "IBM Plex Mono" }}
              tickLine={false}
              tickFormatter={(v) => `${v}`}
              domain={[0, 120]}
              width={40}
            >
              <Label
                value="Daily Cost (USD)"
                angle={-90}
                position="insideLeft"
                offset={-5}
                style={{
                  fontSize: 11,
                  fontFamily: "IBM Plex Mono",
                  letterSpacing: 2,
                  textTransform: "uppercase",
                }}
              />
            </YAxis>

            <Tooltip content={<CustomTooltip />} />

            {/* Break-even line */}
            <ReferenceLine
              x={parseFloat(BREAKEVEN_PH.toFixed(1))}
              strokeDasharray="3 6"
              strokeOpacity={0.25}
              className="stroke-neutral-400 dark:stroke-white"
              label={{
                value: "BREAK-EVEN",
                position: "insideTopRight",
                fontSize: 9,
                fontFamily: "IBM Plex Mono",
              }}
            />

            {/* Pool fee line */}
            <Line
              type="monotone"
              dataKey="pool"
              stroke="#f7931a"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, fill: "#f7931a", stroke: "#000", strokeWidth: 2 }}
              name="Pool 2%"
            />

            {/* m1n3 flat line */}
            <Line
              type="monotone"
              dataKey="m1n3"
              stroke="#3ecf8e"
              strokeWidth={2}
              strokeDasharray="6 3"
              dot={false}
              activeDot={{ r: 4, fill: "#3ecf8e", stroke: "#000", strokeWidth: 2 }}
              name="m1n3"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Legend */}
      <div className="mt-2 flex flex-col gap-3 text-xs tracking-wider text-neutral-500 sm:flex-row sm:gap-8 dark:text-neutral-400">
        <div className="flex items-center">
          <span className="mr-2 inline-block h-2 w-2 rounded-full bg-[#f7931a]" />
          Traditional Pool (2% per payout)
        </div>
        <div className="flex items-center">
          <span className="mr-2 inline-block h-2 w-2 rounded-full bg-[#3ecf8e]" />
          m1n3 on-chain verification (fixed)
        </div>
      </div>

      {/* Footer note */}
      <div className="mt-8 flex w-full max-w-[900px] flex-col gap-2 border-t border-neutral-200 pt-5 text-[10px] tracking-wider text-neutral-400 sm:flex-row sm:justify-between sm:gap-0 dark:border-neutral-800 dark:text-neutral-500">
        <span>Above break-even, m1n3 advantage compounds with scale</span>
        <span>m1n3 cost produces tradeable on-chain PoW assets &middot; pool fee produces nothing</span>
      </div>
    </div>
  );
}
