"use client";

import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  computeTheoreticalValue,
  computeDiscount,
  discountAtBlock,
  computeAnnualizedBuyerYield,
  computeImpliedWaitingCost,
  FPPS_POOL_DATA,
  BTC_BLOCK_SUBSIDY,
} from "@/lib/hashprice-utils";

interface MiningRevenueCalculatorProps {
  networkDifficulty: number;
  btcPrice: number;
  currentHashprice: number;
}

export function MiningRevenueCalculator({
  networkDifficulty,
  btcPrice,
  currentHashprice,
}: MiningRevenueCalculatorProps) {
  const [difficulty, setDifficulty] = useState(100_000);
  const [purchasePrice, setPurchasePrice] = useState(0.0003);
  const [holdingBlocks, setHoldingBlocks] = useState(50);
  const [costOfCapitalApr, setCostOfCapitalApr] = useState(15);
  const [showComparison, setShowComparison] = useState(false);

  const blockRewardUsd = BTC_BLOCK_SUBSIDY * btcPrice;

  const results = useMemo(() => {
    const theoreticalValue = computeTheoreticalValue(
      difficulty,
      networkDifficulty,
      blockRewardUsd,
    );
    const discountPct = computeDiscount(purchasePrice, theoreticalValue);
    const blocksRemaining = Math.max(0, 100 - holdingBlocks);
    const expectedDiscount = discountAtBlock(blocksRemaining, 15);
    const expectedValueAtMaturation =
      theoreticalValue * (1 - expectedDiscount / 100);
    const profitLoss = expectedValueAtMaturation - purchasePrice;
    const profitLossPct =
      purchasePrice > 0 ? (profitLoss / purchasePrice) * 100 : 0;

    // Break-even: what networkDifficulty would make PPS value = purchasePrice
    const breakEvenDifficulty =
      difficulty > 0 && purchasePrice > 0
        ? (blockRewardUsd / purchasePrice) * difficulty
        : 0;

    const holdingTimeHours = (holdingBlocks * 10) / 60;
    const annualizedROI =
      holdingTimeHours > 0
        ? profitLossPct * (8760 / holdingTimeHours)
        : 0;

    // Cost-of-capital analysis
    const impliedWaitingCost = computeImpliedWaitingCost(costOfCapitalApr);
    const breakEvenDiscount = impliedWaitingCost;
    const isRationalToSell = discountPct < breakEvenDiscount;

    // Buyer annualized yield at this discount
    const buyerAnnualizedYield = computeAnnualizedBuyerYield(
      discountPct,
      blocksRemaining,
    );

    // Payout speed comparison
    const m1n3PayoutMinutes = 5; // marketplace: minutes
    const traditionalPayoutHours = 24; // most pools: 24h+

    return {
      theoreticalValue,
      discountPct,
      expectedValueAtMaturation,
      profitLoss,
      profitLossPct,
      breakEvenDifficulty,
      annualizedROI,
      impliedWaitingCost,
      breakEvenDiscount,
      isRationalToSell,
      buyerAnnualizedYield,
      m1n3PayoutMinutes,
      traditionalPayoutHours,
    };
  }, [difficulty, purchasePrice, holdingBlocks, networkDifficulty, blockRewardUsd, costOfCapitalApr]);

  /** Format small USD values with sufficient precision */
  const fmtUsd = (v: number) => {
    if (Math.abs(v) < 0.01) return `$${v.toFixed(6)}`;
    if (Math.abs(v) < 1) return `$${v.toFixed(4)}`;
    return `$${v.toFixed(2)}`;
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Mining Revenue Calculator</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* PPS Formula Parameters */}
        <div className="border rounded-lg p-3 space-y-1">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            PPS Parameters
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
            <span className="text-muted-foreground">Network Difficulty:</span>
            <span className="text-right font-mono">{(networkDifficulty / 1e12).toFixed(2)}T</span>
            <span className="text-muted-foreground">Block Reward:</span>
            <span className="text-right font-mono">{BTC_BLOCK_SUBSIDY} BTC ({fmtUsd(blockRewardUsd)})</span>
            <span className="text-muted-foreground">BTC Price:</span>
            <span className="text-right font-mono">${btcPrice.toLocaleString()}</span>
            <span className="text-muted-foreground">Hashprice:</span>
            <span className="text-right font-mono">${currentHashprice.toFixed(2)}/PH/day</span>
          </div>
        </div>

        {/* Inputs */}
        <div className="space-y-3">
          <div>
            <div className="flex justify-between text-xs text-muted-foreground mb-1">
              <span>Share Difficulty</span>
              <span className="font-mono">{difficulty.toLocaleString()}</span>
            </div>
            <input
              type="range"
              min={1000}
              max={10_000_000}
              step={1000}
              value={difficulty}
              onChange={(e) => setDifficulty(Number(e.target.value))}
              className="w-full accent-blue-500"
            />
          </div>

          <div>
            <div className="flex justify-between text-xs text-muted-foreground mb-1">
              <span>Purchase Price (USD)</span>
              <span className="font-mono">{fmtUsd(purchasePrice)}</span>
            </div>
            <input
              type="range"
              min={0.000001}
              max={0.01}
              step={0.000001}
              value={purchasePrice}
              onChange={(e) => setPurchasePrice(Number(e.target.value))}
              className="w-full accent-blue-500"
            />
          </div>

          <div>
            <div className="flex justify-between text-xs text-muted-foreground mb-1">
              <span>Holding Period (blocks)</span>
              <span className="font-mono">{holdingBlocks}</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={holdingBlocks}
              onChange={(e) => setHoldingBlocks(Number(e.target.value))}
              className="w-full accent-blue-500"
            />
          </div>

          <div>
            <div className="flex justify-between text-xs text-muted-foreground mb-1">
              <span>Cost of Capital (APR %)</span>
              <span className="font-mono">{costOfCapitalApr}%</span>
            </div>
            <input
              type="range"
              min={1}
              max={100}
              step={1}
              value={costOfCapitalApr}
              onChange={(e) => setCostOfCapitalApr(Number(e.target.value))}
              className="w-full accent-orange-500"
            />
          </div>
        </div>

        {/* Core Results */}
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <tbody>
              <tr className="border-b">
                <td className="px-3 py-2 text-muted-foreground">
                  PPS Value
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {fmtUsd(results.theoreticalValue)}
                </td>
              </tr>
              <tr className="border-b">
                <td className="px-3 py-2 text-muted-foreground">
                  Current Discount
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {results.discountPct.toFixed(1)}%
                </td>
              </tr>
              <tr className="border-b">
                <td className="px-3 py-2 text-muted-foreground">
                  Expected Value at Maturation
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {fmtUsd(results.expectedValueAtMaturation)}
                </td>
              </tr>
              <tr className="border-b">
                <td className="px-3 py-2 text-muted-foreground">
                  Profit / Loss
                </td>
                <td
                  className={`px-3 py-2 text-right font-mono font-medium ${
                    results.profitLoss >= 0 ? "text-green-500" : "text-red-500"
                  }`}
                >
                  {results.profitLoss >= 0 ? "+" : ""}{fmtUsd(results.profitLoss)} (
                  {results.profitLossPct >= 0 ? "+" : ""}
                  {results.profitLossPct.toFixed(1)}%)
                </td>
              </tr>
              <tr className="border-b">
                <td className="px-3 py-2 text-muted-foreground">
                  Break-Even Network Difficulty
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {(results.breakEvenDifficulty / 1e12).toFixed(2)}T
                </td>
              </tr>
              <tr className="border-b">
                <td className="px-3 py-2 text-muted-foreground">
                  Annualized ROI
                </td>
                <td
                  className={`px-3 py-2 text-right font-mono font-medium ${
                    results.annualizedROI >= 0
                      ? "text-green-500"
                      : "text-red-500"
                  }`}
                >
                  {results.annualizedROI >= 0 ? "+" : ""}
                  {results.annualizedROI.toFixed(1)}%
                </td>
              </tr>
              <tr className="border-b">
                <td className="px-3 py-2 text-muted-foreground">
                  Buyer Annualized Yield
                </td>
                <td className="px-3 py-2 text-right font-mono font-medium text-blue-500">
                  {results.buyerAnnualizedYield.toFixed(1)}%
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Cost-of-Capital Analysis */}
        <div className="border rounded-lg p-3 space-y-2">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Miner Cost-of-Capital Analysis
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <span className="text-muted-foreground">Implied waiting cost:</span>
            </div>
            <div className="text-right font-mono">
              {results.impliedWaitingCost.toFixed(4)}%
            </div>
            <div>
              <span className="text-muted-foreground">Break-even discount:</span>
            </div>
            <div className="text-right font-mono">
              {results.breakEvenDiscount.toFixed(4)}%
            </div>
            <div>
              <span className="text-muted-foreground">Rational to sell at current discount?</span>
            </div>
            <div className={`text-right font-mono font-medium ${results.isRationalToSell ? "text-red-500" : "text-green-500"}`}>
              {results.isRationalToSell ? "No (below breakeven)" : "Yes"}
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            At {costOfCapitalApr}% APR, waiting 100 blocks (~16.7h) costs {results.impliedWaitingCost.toFixed(4)}%.
            Selling at a discount below this is irrational for well-capitalized miners.
          </p>
        </div>

        {/* Payout Speed Comparison */}
        <div className="border rounded-lg p-3 space-y-2">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Payout Speed
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="text-muted-foreground">m1n3 (marketplace):</div>
            <div className="text-right font-mono text-green-500">~{results.m1n3PayoutMinutes} min</div>
            <div className="text-muted-foreground">Traditional pools:</div>
            <div className="text-right font-mono text-orange-500">{results.traditionalPayoutHours}h+</div>
          </div>
        </div>

        {/* FPPS Comparison Toggle */}
        <button
          onClick={() => setShowComparison(!showComparison)}
          className="w-full text-xs text-blue-500 hover:text-blue-400 py-1"
        >
          {showComparison ? "Hide" : "Show"} Pool Fee Comparison
        </button>

        {showComparison && (
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-2 py-1.5 text-left font-medium">Pool</th>
                  <th className="px-2 py-1.5 text-right font-medium">Fee</th>
                  <th className="px-2 py-1.5 text-right font-medium">Method</th>
                  <th className="px-2 py-1.5 text-right font-medium">Payout</th>
                  <th className="px-2 py-1.5 text-right font-medium">Effective Rate</th>
                </tr>
              </thead>
              <tbody>
                {FPPS_POOL_DATA.map((pool) => (
                  <tr key={pool.poolName} className="border-t">
                    <td className={`px-2 py-1.5 ${pool.poolName.includes("m1n3") ? "font-medium text-blue-500" : ""}`}>
                      {pool.poolName}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono">{pool.feeRate}%</td>
                    <td className="px-2 py-1.5 text-right">{pool.payoutMethod}</td>
                    <td className="px-2 py-1.5 text-right">{pool.payoutDelay}</td>
                    <td className="px-2 py-1.5 text-right font-mono">
                      {(pool.effectivePayoutRate * 100).toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="px-2 py-1.5 text-xs text-muted-foreground bg-muted/30">
              m1n3 miners sell shares at a discount but receive instant liquidity.
              At discounts below {FPPS_POOL_DATA[0].feeRate}%, m1n3 is more cost-effective than {FPPS_POOL_DATA[0].poolName}.
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
