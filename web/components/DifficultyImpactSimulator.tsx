"use client";

import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { computeTheoreticalValue, BTC_BLOCK_SUBSIDY } from "@/lib/hashprice-utils";

interface NextDifficultyAdjustment {
  progressPercent: number;
  difficultyChange: number;
  estimatedRetargetDate: number;
  remainingBlocks: number;
  remainingTime: number;
  previousRetarget: number;
  nextRetargetHeight: number;
  timeAvg: number;
  timeOffset: number;
}

interface DifficultyImpactSimulatorProps {
  networkDifficulty: number;
  btcPrice: number;
  nextAdjustment: NextDifficultyAdjustment | null;
}

const SCENARIO_ROWS = [-10, -5, 0, 5, 10, 20];

export function DifficultyImpactSimulator({
  networkDifficulty,
  btcPrice,
  nextAdjustment,
}: DifficultyImpactSimulatorProps) {
  const estimatedChange = nextAdjustment?.difficultyChange ?? 0;
  const [diffChangeSlider, setDiffChangeSlider] = useState(estimatedChange);
  const [btcChangeSlider, setBtcChangeSlider] = useState(0);
  const [refDifficulty, setRefDifficulty] = useState(100_000);

  // Sync slider if estimated changes
  const blockRewardUsd = BTC_BLOCK_SUBSIDY * btcPrice;

  const currentPpsValue = useMemo(
    () => computeTheoreticalValue(refDifficulty, networkDifficulty, blockRewardUsd),
    [refDifficulty, networkDifficulty, blockRewardUsd],
  );

  // Slider-driven projection
  const projectedValue = useMemo(() => {
    const newDiff = networkDifficulty * (1 + diffChangeSlider / 100);
    const newBtcPrice = btcPrice * (1 + btcChangeSlider / 100);
    const newBlockReward = BTC_BLOCK_SUBSIDY * newBtcPrice;
    return computeTheoreticalValue(refDifficulty, newDiff, newBlockReward);
  }, [refDifficulty, networkDifficulty, btcPrice, diffChangeSlider, btcChangeSlider]);

  const projectedChangePct =
    currentPpsValue > 0
      ? ((projectedValue - currentPpsValue) / currentPpsValue) * 100
      : 0;

  // Scenario table
  const scenarioData = useMemo(() => {
    return SCENARIO_ROWS.map((diffPct) => {
      const newDiff = networkDifficulty * (1 + diffPct / 100);
      const newValue = computeTheoreticalValue(refDifficulty, newDiff, blockRewardUsd);
      const changePct =
        currentPpsValue > 0
          ? ((newValue - currentPpsValue) / currentPpsValue) * 100
          : 0;
      return { diffPct, newValue, changePct };
    });
  }, [refDifficulty, networkDifficulty, blockRewardUsd, currentPpsValue]);

  const fmtUsd = (v: number) => {
    if (Math.abs(v) < 0.01) return `$${v.toFixed(6)}`;
    if (Math.abs(v) < 1) return `$${v.toFixed(4)}`;
    return `$${v.toFixed(2)}`;
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Difficulty Impact on Share Value</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Next adjustment info */}
        {nextAdjustment && (
          <div className="border rounded-lg p-3 space-y-1">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Next Retarget
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
              <span className="text-muted-foreground">Estimated Change:</span>
              <span className={`text-right font-mono font-medium ${estimatedChange > 0 ? "text-red-500" : "text-green-500"}`}>
                {estimatedChange > 0 ? "+" : ""}{estimatedChange.toFixed(2)}%
              </span>
              <span className="text-muted-foreground">Progress:</span>
              <span className="text-right font-mono">{nextAdjustment.progressPercent.toFixed(1)}%</span>
              <span className="text-muted-foreground">Remaining Blocks:</span>
              <span className="text-right font-mono">{nextAdjustment.remainingBlocks.toLocaleString()}</span>
              <span className="text-muted-foreground">Est. Retarget:</span>
              <span className="text-right font-mono">
                {new Date(nextAdjustment.estimatedRetargetDate * 1000).toLocaleDateString()}
              </span>
            </div>
          </div>
        )}

        {/* Current PPS value */}
        <div className="border rounded-lg p-3 space-y-1">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Current PPS Value
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
            <span className="text-muted-foreground">Share D={refDifficulty.toLocaleString()}:</span>
            <span className="text-right font-mono font-medium">{fmtUsd(currentPpsValue)}</span>
            <span className="text-muted-foreground">Network Difficulty:</span>
            <span className="text-right font-mono">{(networkDifficulty / 1e12).toFixed(2)}T</span>
          </div>
        </div>

        {/* Interactive sliders */}
        <div className="space-y-3">
          <div>
            <div className="flex justify-between text-xs text-muted-foreground mb-1">
              <span>Reference Share Difficulty</span>
              <span className="font-mono">{refDifficulty.toLocaleString()}</span>
            </div>
            <input
              type="range"
              min={1000}
              max={10_000_000}
              step={1000}
              value={refDifficulty}
              onChange={(e) => setRefDifficulty(Number(e.target.value))}
              className="w-full accent-blue-500"
            />
          </div>

          <div>
            <div className="flex justify-between text-xs text-muted-foreground mb-1">
              <span>Difficulty Change %</span>
              <span className={`font-mono ${diffChangeSlider > 0 ? "text-red-500" : diffChangeSlider < 0 ? "text-green-500" : ""}`}>
                {diffChangeSlider > 0 ? "+" : ""}{diffChangeSlider.toFixed(1)}%
              </span>
            </div>
            <input
              type="range"
              min={-30}
              max={30}
              step={0.5}
              value={diffChangeSlider}
              onChange={(e) => setDiffChangeSlider(Number(e.target.value))}
              className="w-full accent-purple-500"
            />
          </div>

          <div>
            <div className="flex justify-between text-xs text-muted-foreground mb-1">
              <span>BTC Price Change %</span>
              <span className={`font-mono ${btcChangeSlider > 0 ? "text-green-500" : btcChangeSlider < 0 ? "text-red-500" : ""}`}>
                {btcChangeSlider > 0 ? "+" : ""}{btcChangeSlider.toFixed(1)}%
              </span>
            </div>
            <input
              type="range"
              min={-50}
              max={50}
              step={1}
              value={btcChangeSlider}
              onChange={(e) => setBtcChangeSlider(Number(e.target.value))}
              className="w-full accent-orange-500"
            />
          </div>
        </div>

        {/* Projected value */}
        <div className="border rounded-lg p-3">
          <div className="flex justify-between items-center text-sm">
            <span className="text-muted-foreground">Projected PPS Value:</span>
            <span className="font-mono font-medium">{fmtUsd(projectedValue)}</span>
          </div>
          <div className="flex justify-between items-center text-sm mt-1">
            <span className="text-muted-foreground">Value Change:</span>
            <span className={`font-mono font-medium ${projectedChangePct >= 0 ? "text-green-500" : "text-red-500"}`}>
              {projectedChangePct >= 0 ? "+" : ""}{projectedChangePct.toFixed(2)}%
            </span>
          </div>
        </div>

        {/* Scenario table (difficulty only, fixed BTC price) */}
        <div>
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            Difficulty Scenarios (BTC price constant)
          </div>
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">Diff Change</th>
                  <th className="px-3 py-1.5 text-right font-medium">New PPS Value</th>
                  <th className="px-3 py-1.5 text-right font-medium">Value Change</th>
                </tr>
              </thead>
              <tbody>
                {scenarioData.map((row) => (
                  <tr
                    key={row.diffPct}
                    className={`border-t ${
                      Math.abs(row.diffPct - estimatedChange) < 1
                        ? "bg-blue-500/10"
                        : ""
                    }`}
                  >
                    <td className="px-3 py-1.5 font-mono">
                      {row.diffPct > 0 ? "+" : ""}{row.diffPct}%
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono">
                      {fmtUsd(row.newValue)}
                    </td>
                    <td className={`px-3 py-1.5 text-right font-mono font-medium ${
                      row.changePct >= 0 ? "text-green-500" : "text-red-500"
                    }`}>
                      {row.changePct >= 0 ? "+" : ""}{row.changePct.toFixed(2)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {nextAdjustment && (
            <p className="text-xs text-muted-foreground mt-1.5">
              Row highlighted near estimated next adjustment ({estimatedChange > 0 ? "+" : ""}{estimatedChange.toFixed(1)}%).
              Higher difficulty reduces PPS value proportionally.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
