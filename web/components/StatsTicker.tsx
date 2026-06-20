"use client";

import { useHashprice } from "@/hooks/useHashprice";
import { useMarketHistory } from "@/hooks/useMarketHistory";

function compute24hChange(
  current: number | null,
  history: { timestamp: number; btcPrice: number; hashprice: number; networkHashrate: number }[],
  getter: (pt: { timestamp: number; btcPrice: number; hashprice: number; networkHashrate: number }) => number,
): number | null {
  if (current === null || history.length === 0) return null;
  const target = Date.now() - 24 * 60 * 60 * 1000;
  let closest = history[0];
  let closestDist = Math.abs(closest.timestamp - target);
  for (const pt of history) {
    const dist = Math.abs(pt.timestamp - target);
    if (dist < closestDist) { closestDist = dist; closest = pt; }
  }
  const prev = getter(closest);
  if (prev <= 0) return null;
  return ((current - prev) / prev) * 100;
}

interface TickerItemsProps {
  btcPrice: number | null;
  hashprice: number | null;
  networkHashrate: number | null;
  networkDifficulty: number | null;
  btcChange: number | null;
  hpChange: number | null;
  hrChange: number | null;
  nextAdjChange: number | null;
  nextAdjBlocks: number | null;
}

function TickerItems({
  btcPrice, hashprice, networkHashrate, networkDifficulty,
  btcChange, hpChange, hrChange, nextAdjChange, nextAdjBlocks,
}: TickerItemsProps) {
  const dot = <span className="text-white/20 mx-5 select-none">•</span>;

  return (
    <>
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <span className="text-white/40">BTC</span>
        <span className="font-semibold">
          {btcPrice ? `$${btcPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "—"}
        </span>
        {btcChange !== null && (
          <span className={btcChange >= 0 ? "text-green-400" : "text-red-400"}>
            {btcChange >= 0 ? "+" : ""}{btcChange.toFixed(2)}%
          </span>
        )}
      </span>
      {dot}
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <span className="text-white/40">Hashprice</span>
        <span className="font-semibold">
          {hashprice ? `$${hashprice.toFixed(2)}/PH/d` : "—"}
        </span>
        {hpChange !== null && (
          <span className={hpChange >= 0 ? "text-green-400" : "text-red-400"}>
            {hpChange >= 0 ? "+" : ""}{hpChange.toFixed(2)}%
          </span>
        )}
      </span>
      {dot}
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <span className="text-white/40">Network</span>
        <span className="font-semibold">
          {networkHashrate ? `${(networkHashrate / 1e18).toFixed(1)} EH/s` : "—"}
        </span>
        {hrChange !== null && (
          <span className={hrChange >= 0 ? "text-green-400" : "text-red-400"}>
            {hrChange >= 0 ? "+" : ""}{hrChange.toFixed(2)}%
          </span>
        )}
      </span>
      {dot}
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <span className="text-white/40">Difficulty</span>
        <span className="font-semibold">
          {networkDifficulty ? `${(networkDifficulty / 1e12).toFixed(2)}T` : "—"}
        </span>
      </span>
      {nextAdjChange !== null && nextAdjBlocks !== null && (
        <>
          {dot}
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <span className="text-white/40">Next Adj</span>
            <span className={`font-semibold ${nextAdjChange >= 0 ? "text-red-400" : "text-green-400"}`}>
              {nextAdjChange >= 0 ? "+" : ""}{nextAdjChange.toFixed(2)}%
            </span>
            <span className="text-white/40">in {nextAdjBlocks.toLocaleString()} blocks</span>
          </span>
        </>
      )}
      {/* trailing spacer so the loop gap is consistent */}
      <span className="inline-block w-12" />
    </>
  );
}

export function StatsTicker() {
  const { btcPrice, hashprice, networkHashrate, networkDifficulty } = useHashprice();
  const { data: history, nextAdjustment } = useMarketHistory("7d");

  const btcChange = compute24hChange(btcPrice, history, (p) => p.btcPrice);
  const hpChange  = compute24hChange(hashprice, history, (p) => p.hashprice);
  const hrChange  = compute24hChange(networkHashrate, history, (p) => p.networkHashrate);

  const props: TickerItemsProps = {
    btcPrice, hashprice, networkHashrate, networkDifficulty,
    btcChange, hpChange, hrChange,
    nextAdjChange: nextAdjustment?.difficultyChange ?? null,
    nextAdjBlocks: nextAdjustment?.remainingBlocks ?? null,
  };

  return (
    <div className="w-full overflow-hidden bg-black/60 border-b border-white/5 text-xs text-white/80 font-mono h-7 flex items-center">
      {/* Two identical copies side-by-side; CSS slides the pair left by 50% = one copy width, then resets invisibly */}
      <div className="ticker-track inline-flex items-center shrink-0">
        <TickerItems {...props} />
        <TickerItems {...props} />
      </div>
    </div>
  );
}
