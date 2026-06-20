"use client";

import { useState, useMemo, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  computeStakerAPY,
  computeDailyYieldPerToken,
  computeAnnualizedBuyerYield,
  computeImpliedWaitingCost,
  computeTAM,
  generateRevenueProjections,
  FPPS_POOL_DATA,
  BTC_BLOCK_SUBSIDY,
  BTC_BLOCKS_PER_DAY,
  GAS_COST_STANDARD_MIST,
  GAS_COST_LIGHTWEIGHT_MIST,
  gasCostPerShareSol,
  totalGasBurnSol,
} from "@/lib/hashprice-utils";
import {
  computePlatformProfitability,
  computeBuyerYieldMetrics,
  computeCostOfCapitalAnalysis,
  computeSharpeRatio,
  computeFillRate,
  computeAvgTimeToFill,
  countUniqueParticipants,
} from "@/lib/profitability-utils";
async function fetchTradeHistory(_limit?: number): Promise<TradeRecord[]> { return []; }
async function fetchExtendedMarketplaceStats(): Promise<ExtendedMarketplaceStats | null> { return null; }
async function fetchMarketplaceStats(): Promise<MarketplaceStats | null> { return null; }
import { InfoTooltip } from "@/components/ui/info-tooltip";
import type {
  TradeRecord,
  ExtendedMarketplaceStats,
  MarketplaceStats,
  RevenueProjection,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ProfitabilityDashboardProps {
  /** Current hashprice in $/PH/day */
  currentHashprice: number;
  /** BTC price in USD */
  btcPriceUsd: number;
  /** Total M1N3 staked (base units, 1 M1N3 = 1e8) */
  totalStaked: number;
  /** Total M1N3 supply (base units) */
  totalSupply: number;
  /** Days since marketplace launch */
  periodDays: number;
  /** Pool total shares submitted */
  totalSharesSubmitted: number;
  /** Fraction of shares using lightweight mode (0-1) */
  lightweightRatio: number;
  /** Global network hashrate in PH/s */
  globalHashratePh: number;
  /** Estimated daily infrastructure cost in SOL */
  dailyInfraCostSol?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatSol(mist: number): string {
  return (mist / 1e9).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function formatUsd(usd: number): string {
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(2)}M`;
  if (usd >= 1e3) return `$${(usd / 1e3).toFixed(2)}K`;
  return `$${usd.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProfitabilityDashboard({
  currentHashprice,
  btcPriceUsd,
  totalStaked,
  totalSupply,
  periodDays,
  totalSharesSubmitted,
  lightweightRatio,
  globalHashratePh,
  dailyInfraCostSol = 10,
}: ProfitabilityDashboardProps) {
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [marketStats, setMarketStats] = useState<MarketplaceStats | null>(null);
  const [extStats, setExtStats] = useState<ExtendedMarketplaceStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetchTradeHistory(200),
      fetchMarketplaceStats(),
      fetchExtendedMarketplaceStats(),
    ]).then(([t, ms, es]) => {
      setTrades(t);
      setMarketStats(ms);
      setExtStats(es);
      setLoading(false);
    });
  }, []);

  // ---- Staker Metrics ----
  const stakerMetrics = useMemo(() => {
    if (!marketStats) return null;
    const apy = computeStakerAPY(
      marketStats.totalFeesCollected,
      totalStaked,
      periodDays,
    );
    const dailyYield = computeDailyYieldPerToken(
      marketStats.totalFeesCollected,
      totalStaked,
      periodDays,
    );
    const stakingUtilization = totalSupply > 0
      ? (totalStaked / totalSupply) * 100
      : 0;
    return {
      apy,
      dailyYield,
      monthlyYield: dailyYield * 30,
      annualYield: dailyYield * 365,
      stakingUtilization,
      projectedApy10x: apy * 10,
      projectedApy100x: apy * 100,
    };
  }, [marketStats, totalStaked, totalSupply, periodDays]);

  // ---- Buyer Metrics ----
  const buyerMetrics = useMemo(() => {
    return computeBuyerYieldMetrics(trades, currentHashprice);
  }, [trades, currentHashprice]);

  // ---- Platform Profitability ----
  const platformProfit = useMemo(() => {
    if (!marketStats) return null;
    return computePlatformProfitability(
      marketStats.totalFeesCollected,
      marketStats.totalSales,
      totalSharesSubmitted,
      lightweightRatio,
      dailyInfraCostSol,
      periodDays,
    );
  }, [marketStats, totalSharesSubmitted, lightweightRatio, dailyInfraCostSol, periodDays]);

  // ---- TAM ----
  const tam = useMemo(() => {
    return computeTAM(btcPriceUsd);
  }, [btcPriceUsd]);

  // ---- Revenue Projections ----
  const projections = useMemo(() => {
    return generateRevenueProjections(
      globalHashratePh,
      currentHashprice,
      totalStaked,
    );
  }, [globalHashratePh, currentHashprice, totalStaked]);

  // ---- Market Health ----
  const marketHealth = useMemo(() => {
    if (!extStats) return null;
    const { sellers, buyers } = countUniqueParticipants(trades);
    return {
      fillRate: extStats.fillRate,
      avgTimeToFill: extStats.averageTimeToFillMs,
      uniqueSellers: sellers || extStats.uniqueSellers,
      uniqueBuyers: buyers || extStats.uniqueBuyers,
    };
  }, [extStats, trades]);

  // ---- Risk Metrics ----
  const riskMetrics = useMemo(() => {
    if (trades.length < 5) return null;
    const returns = trades.map((t) => {
      const theo = (t.difficultyAchieved * 4_294_967_296) / 1e15 * currentHashprice;
      const price = t.price / 1e9;
      return theo > 0 ? ((theo - price) / price) * 100 : 0;
    });
    return {
      sharpeRatio: computeSharpeRatio(returns),
      avgReturn: returns.reduce((s, r) => s + r, 0) / returns.length,
      maxReturn: Math.max(...returns),
      minReturn: Math.min(...returns),
    };
  }, [trades, currentHashprice]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-8 bg-muted rounded w-64 animate-pulse" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-32 bg-muted rounded animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Headline Numbers */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Staker APY */}
        <Card className="border-blue-500/30 bg-blue-500/5">
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              M1N3 Staker APY
              <InfoTooltip text="Projected annual return from staking, based on marketplace trading fees" />
            </p>
            <p className="text-4xl font-bold text-blue-500">
              {stakerMetrics ? `${stakerMetrics.apy.toFixed(2)}%` : "—"}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {stakerMetrics
                ? `${stakerMetrics.stakingUtilization.toFixed(1)}% of supply staked`
                : ""}
            </p>
          </CardContent>
        </Card>

        {/* Buyer Yield */}
        <Card className="border-green-500/30 bg-green-500/5">
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              Buyer Annualized Yield
              <InfoTooltip text="Projected annual return for buying discounted shares and holding to maturation" />
            </p>
            <p className="text-4xl font-bold text-green-500">
              {buyerMetrics.annualizedYieldPct > 0
                ? `${buyerMetrics.annualizedYieldPct.toFixed(0)}%`
                : "—"}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              At {buyerMetrics.avgDiscountPct.toFixed(1)}% avg discount, {buyerMetrics.maturationHours.toFixed(1)}h hold
            </p>
          </CardContent>
        </Card>

        {/* Net Margin */}
        <Card
          className={
            platformProfit && platformProfit.netMarginMist > 0
              ? "border-green-500/30 bg-green-500/5"
              : "border-orange-500/30 bg-orange-500/5"
          }
        >
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              Platform Net Margin
              <InfoTooltip text="Net revenue after subtracting gas costs from fee income" />
            </p>
            <p
              className={`text-4xl font-bold ${
                platformProfit && platformProfit.netMarginMist > 0
                  ? "text-green-500"
                  : "text-orange-500"
              }`}
            >
              {platformProfit
                ? `${platformProfit.netMarginPct.toFixed(1)}%`
                : "—"}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {platformProfit
                ? `${formatSol(platformProfit.totalFeesMist)} SOL fees - ${formatSol(platformProfit.totalGasCostsMist)} SOL gas`
                : ""}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Tabbed Detail Sections */}
      <Tabs defaultValue="investors">
        <TabsList className="w-full justify-start flex-wrap h-auto gap-1">
          <TabsTrigger value="investors">Platform Economics</TabsTrigger>
          <TabsTrigger value="miners">Miner Economics</TabsTrigger>
          <TabsTrigger value="buyers">Buyer Economics</TabsTrigger>
          <TabsTrigger value="market">Market Health</TabsTrigger>
          <TabsTrigger value="stakers">Token Economics</TabsTrigger>
          <TabsTrigger value="projections">Projections</TabsTrigger>
        </TabsList>

        {/* ---- Platform Economics Tab ---- */}
        <TabsContent value="investors">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Gas Costs */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Gas Cost Analysis</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      Standard share gas
                      <InfoTooltip text="Gas cost to submit a full mining share on Sui" />
                      :
                    </span>
                    <span className="font-mono">{gasCostPerShareSol(false).toFixed(6)} SOL</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Lightweight share gas:</span>
                    <span className="font-mono">{gasCostPerShareSol(true).toFixed(6)} SOL</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Gas savings (lightweight):</span>
                    <span className="font-mono text-green-500">
                      {((1 - GAS_COST_LIGHTWEIGHT_MIST / GAS_COST_STANDARD_MIST) * 100).toFixed(0)}%
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Lightweight share ratio:</span>
                    <span className="font-mono">{(lightweightRatio * 100).toFixed(0)}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Total gas burn:</span>
                    <span className="font-mono">
                      {totalGasBurnSol(
                        Math.round(totalSharesSubmitted * (1 - lightweightRatio)),
                        Math.round(totalSharesSubmitted * lightweightRatio),
                        0,
                      ).toFixed(4)} SOL
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Unit Economics */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Unit Economics</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Avg fee per trade:</span>
                    <span className="font-mono">
                      {platformProfit ? formatSol(platformProfit.avgFeePerTrade) : "0"} SOL
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Avg gas per share:</span>
                    <span className="font-mono">
                      {platformProfit ? formatSol(platformProfit.avgGasPerShare) : "0"} SOL
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      Break-even daily volume
                      <InfoTooltip text="Minimum daily trading volume needed for fee revenue to cover gas + infrastructure costs" />
                      :
                    </span>
                    <span className="font-mono">
                      {platformProfit
                        ? `${platformProfit.breakEvenDailyVolumeSol.toFixed(2)} SOL`
                        : "—"}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Daily infra cost:</span>
                    <span className="font-mono">{dailyInfraCostSol} SOL</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* TAM */}
            <Card className="md:col-span-2">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">
                  Total Addressable Market
                  <InfoTooltip text="TAM — the total daily Bitcoin mining revenue that m1n3 could capture as a trading marketplace" />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <p className="text-muted-foreground">Daily Block Rewards</p>
                    <p className="text-lg font-semibold">
                      {tam.dailyBlockRewardsBtc.toFixed(1)} BTC
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatUsd(tam.dailyBlockRewardsBtc * btcPriceUsd)}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Daily Tx Fees</p>
                    <p className="text-lg font-semibold">
                      ~{tam.dailyTxFeesBtc.toFixed(1)} BTC
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatUsd(tam.dailyTxFeesBtc * btcPriceUsd)}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">
                      Total Daily Mining Revenue
                    </p>
                    <p className="text-lg font-semibold">
                      {formatUsd(tam.dailyMiningRevenueUsd)}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">
                      m1n3 Addressable (Rewards)
                    </p>
                    <p className="text-lg font-semibold">
                      {formatUsd(tam.addressableRevenueUsd)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {BTC_BLOCK_SUBSIDY} BTC/block x {BTC_BLOCKS_PER_DAY} blocks
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ---- Miner Economics Tab ---- */}
        <TabsContent value="miners">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">
                  Cost-of-Capital Analysis
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {[5, 15, 30, 50, 100].map((apr) => {
                    const analysis = computeCostOfCapitalAnalysis(apr);
                    return (
                      <div
                        key={apr}
                        className="flex justify-between items-center text-sm"
                      >
                        <div>
                          <span className="text-muted-foreground">
                            At {apr}% APR:
                          </span>
                        </div>
                        <div className="text-right font-mono">
                          <span>
                            Break-even: {analysis.breakEvenDiscountPct.toFixed(3)}%
                          </span>
                        </div>
                      </div>
                    );
                  })}
                  <p className="text-xs text-muted-foreground mt-2 border-t pt-2">
                    A miner should sell on m1n3 if the marketplace discount is less than
                    their cost of waiting 100 blocks (~16.7h). Well-capitalized miners
                    (low APR) have tiny breakeven discounts, while stressed miners
                    (high APR) benefit more from instant liquidity.
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">
                  FPPS Pool Fee Comparison
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-xs text-muted-foreground">
                        <th className="pb-2 text-left">Pool</th>
                        <th className="pb-2 text-right">Fee</th>
                        <th className="pb-2 text-right">Method</th>
                        <th className="pb-2 text-right">Payout</th>
                      </tr>
                    </thead>
                    <tbody>
                      {FPPS_POOL_DATA.map((pool) => (
                        <tr
                          key={pool.poolName}
                          className={`border-b last:border-0 ${
                            pool.poolName.includes("m1n3")
                              ? "bg-blue-500/5"
                              : ""
                          }`}
                        >
                          <td
                            className={`py-2 ${
                              pool.poolName.includes("m1n3")
                                ? "font-medium text-blue-500"
                                : ""
                            }`}
                          >
                            {pool.poolName}
                          </td>
                          <td className="py-2 text-right font-mono">
                            {pool.feeRate}%
                          </td>
                          <td className="py-2 text-right">
                            {pool.payoutMethod}
                          </td>
                          <td className="py-2 text-right">
                            {pool.payoutDelay}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-muted-foreground mt-3">
                  m1n3 miners get instant liquidity via marketplace. At discounts
                  below 2%, m1n3 is more cost-effective than Foundry&apos;s 2% FPPS fee.
                </p>
              </CardContent>
            </Card>

            {/* Payout Speed */}
            <Card className="md:col-span-2">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">
                  Payout Speed Comparison
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-4 text-center">
                  <div className="p-4 rounded-lg bg-blue-500/10 border border-blue-500/20">
                    <p className="text-3xl font-bold text-blue-500">~5 min</p>
                    <p className="text-sm text-muted-foreground">m1n3 Marketplace</p>
                    <p className="text-xs text-muted-foreground">
                      Share to liquidity
                    </p>
                  </div>
                  <div className="p-4 rounded-lg bg-muted/50 border">
                    <p className="text-3xl font-bold text-orange-500">~16.7h</p>
                    <p className="text-sm text-muted-foreground">
                      Coinbase Maturation
                    </p>
                    <p className="text-xs text-muted-foreground">
                      100 blocks wait
                    </p>
                  </div>
                  <div className="p-4 rounded-lg bg-muted/50 border">
                    <p className="text-3xl font-bold text-red-500">24h+</p>
                    <p className="text-sm text-muted-foreground">
                      Traditional Pools
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Maturation + pool delay
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ---- Buyer Economics Tab ---- */}
        <TabsContent value="buyers">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="border-green-500/30">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">
                  Discount Arbitrage Returns
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="text-center p-4 rounded-lg bg-green-500/10">
                    <p className="text-sm text-muted-foreground">
                      Buy at {buyerMetrics.avgDiscountPct.toFixed(1)}% discount
                    </p>
                    <p className="text-5xl font-bold text-green-500">
                      {buyerMetrics.annualizedYieldPct > 0
                        ? `${buyerMetrics.annualizedYieldPct.toFixed(0)}%`
                        : "—"}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      annualized yield
                    </p>
                  </div>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Hold time:</span>
                      <span className="font-mono">
                        {buyerMetrics.maturationHours.toFixed(1)}h (100 blocks)
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Historical avg ROI:</span>
                      <span className="font-mono text-green-500">
                        +{buyerMetrics.historicalRoiPct.toFixed(2)}%
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Trade sample size:</span>
                      <span className="font-mono">{buyerMetrics.sampleSize}</span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Yield at different discounts */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">
                  Yield by Discount Level
                </CardTitle>
              </CardHeader>
              <CardContent>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="pb-2 text-left">Discount</th>
                      <th className="pb-2 text-right">Per-Trade ROI</th>
                      <th className="pb-2 text-right">Annualized</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[2, 5, 10, 15, 20, 30].map((disc) => {
                      const annualized = computeAnnualizedBuyerYield(disc, 100);
                      const perTrade = (disc / (100 - disc)) * 100;
                      return (
                        <tr key={disc} className="border-b last:border-0">
                          <td className="py-1.5 font-mono">{disc}%</td>
                          <td className="py-1.5 text-right font-mono text-green-500">
                            +{perTrade.toFixed(2)}%
                          </td>
                          <td className="py-1.5 text-right font-mono font-medium text-green-500">
                            {annualized.toFixed(0)}%
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            {/* Risk Metrics */}
            {riskMetrics && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">
                    Risk-Adjusted Returns
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        Sharpe Ratio
                        <InfoTooltip text="Risk-adjusted return metric — above 2.0 is excellent, above 1.0 is good" />
                        :
                      </span>
                      <span className="font-mono font-medium">
                        {riskMetrics.sharpeRatio.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Avg Return:</span>
                      <span className="font-mono text-green-500">
                        +{riskMetrics.avgReturn.toFixed(2)}%
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Best Trade:</span>
                      <span className="font-mono text-green-500">
                        +{riskMetrics.maxReturn.toFixed(2)}%
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Worst Trade:</span>
                      <span
                        className={`font-mono ${
                          riskMetrics.minReturn >= 0
                            ? "text-green-500"
                            : "text-red-500"
                        }`}
                      >
                        {riskMetrics.minReturn >= 0 ? "+" : ""}
                        {riskMetrics.minReturn.toFixed(2)}%
                      </span>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    Sharpe &gt; 2.0 indicates excellent risk-adjusted returns.
                    Based on {buyerMetrics.sampleSize} trades.
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Comparison to other yield strategies */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">
                  BTC Yield Strategy Comparison
                </CardTitle>
              </CardHeader>
              <CardContent>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="pb-2 text-left">Strategy</th>
                      <th className="pb-2 text-right">Est. APY</th>
                      <th className="pb-2 text-right">Risk</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b bg-green-500/5">
                      <td className="py-1.5 font-medium text-green-500">
                        m1n3 Share Arbitrage
                      </td>
                      <td className="py-1.5 text-right font-mono font-medium text-green-500">
                        {buyerMetrics.annualizedYieldPct > 0
                          ? `${buyerMetrics.annualizedYieldPct.toFixed(0)}%`
                          : "~200%+"}
                      </td>
                      <td className="py-1.5 text-right">
                        <Badge variant="outline" className="text-xs">Low</Badge>
                      </td>
                    </tr>
                    <tr className="border-b">
                      <td className="py-1.5">DeFi BTC Lending</td>
                      <td className="py-1.5 text-right font-mono">2-8%</td>
                      <td className="py-1.5 text-right">
                        <Badge variant="outline" className="text-xs">Medium</Badge>
                      </td>
                    </tr>
                    <tr className="border-b">
                      <td className="py-1.5">Futures Basis Trade</td>
                      <td className="py-1.5 text-right font-mono">5-20%</td>
                      <td className="py-1.5 text-right">
                        <Badge variant="outline" className="text-xs">Medium</Badge>
                      </td>
                    </tr>
                    <tr className="border-b">
                      <td className="py-1.5">BTC Staking (LST)</td>
                      <td className="py-1.5 text-right font-mono">1-5%</td>
                      <td className="py-1.5 text-right">
                        <Badge variant="outline" className="text-xs">Low</Badge>
                      </td>
                    </tr>
                    <tr>
                      <td className="py-1.5">Options Premium</td>
                      <td className="py-1.5 text-right font-mono">10-40%</td>
                      <td className="py-1.5 text-right">
                        <Badge variant="outline" className="text-xs">High</Badge>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ---- Market Health Tab ---- */}
        <TabsContent value="market">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">
                  Fill Rate
                  <InfoTooltip text="Percentage of listings that result in a sale — higher is better for market health" />
                </p>
                <p className="text-3xl font-bold">
                  {marketHealth ? `${marketHealth.fillRate.toFixed(1)}%` : "—"}
                </p>
                <p className="text-xs text-muted-foreground">
                  % of listings resulting in sale
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">Avg Time-to-Fill</p>
                <p className="text-3xl font-bold">
                  {marketHealth
                    ? formatDuration(marketHealth.avgTimeToFill)
                    : "—"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Listing to purchase
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">Unique Sellers</p>
                <p className="text-3xl font-bold">
                  {marketHealth?.uniqueSellers ?? "—"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Distinct miners selling
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">Unique Buyers</p>
                <p className="text-3xl font-bold">
                  {marketHealth?.uniqueBuyers ?? "—"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Distinct arbitrageurs
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Recent Trade History */}
          {trades.length > 0 && (
            <Card className="mt-4">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">
                    Recent Trade History
                  </CardTitle>
                  <Badge variant="outline" className="text-xs">
                    On-Chain Data
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b text-muted-foreground">
                        <th className="pb-2 text-left">Time</th>
                        <th className="pb-2 text-right">Price (SOL)</th>
                        <th className="pb-2 text-right">Difficulty</th>
                        <th className="pb-2 text-right">Time-to-Fill</th>
                        <th className="pb-2 text-right">Fee (SOL)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trades.slice(0, 15).map((trade) => (
                        <tr key={trade.txDigest} className="border-b last:border-0">
                          <td className="py-1.5">
                            {new Date(trade.purchasedAtMs).toLocaleString(
                              undefined,
                              { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" },
                            )}
                          </td>
                          <td className="py-1.5 text-right font-mono">
                            {formatSol(trade.price)}
                          </td>
                          <td className="py-1.5 text-right font-mono">
                            {trade.difficultyAchieved.toLocaleString()}
                          </td>
                          <td className="py-1.5 text-right font-mono">
                            {formatDuration(trade.timeToFillMs)}
                          </td>
                          <td className="py-1.5 text-right font-mono text-muted-foreground">
                            {formatSol(trade.feePaid)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ---- Token Economics Tab ---- */}
        <TabsContent value="stakers">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="border-blue-500/30">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">M1N3 Staker Yield</CardTitle>
              </CardHeader>
              <CardContent>
                {stakerMetrics ? (
                  <div className="space-y-3">
                    <div className="text-center p-4 rounded-lg bg-blue-500/10">
                      <p className="text-5xl font-bold text-blue-500">
                        {stakerMetrics.apy.toFixed(2)}%
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Current APY
                      </p>
                    </div>
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">
                          Daily yield per M1N3:
                        </span>
                        <span className="font-mono">
                          {stakerMetrics.dailyYield.toFixed(6)} MIST
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">
                          Monthly yield per M1N3:
                        </span>
                        <span className="font-mono">
                          {stakerMetrics.monthlyYield.toFixed(4)} MIST
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">
                          Staking utilization:
                        </span>
                        <span className="font-mono">
                          {stakerMetrics.stakingUtilization.toFixed(1)}%
                        </span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-muted-foreground text-sm">
                    Staking data unavailable
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">
                  Projected APY at Scale
                </CardTitle>
              </CardHeader>
              <CardContent>
                {stakerMetrics ? (
                  <div className="space-y-3">
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">Current:</span>
                        <span className="font-mono text-lg font-medium">
                          {stakerMetrics.apy.toFixed(2)}%
                        </span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">At 10x volume:</span>
                        <span className="font-mono text-lg font-medium text-blue-500">
                          {stakerMetrics.projectedApy10x.toFixed(2)}%
                        </span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">At 100x volume:</span>
                        <span className="font-mono text-lg font-medium text-green-500">
                          {stakerMetrics.projectedApy100x.toFixed(2)}%
                        </span>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground border-t pt-2">
                      APY scales linearly with trading volume.
                      Assumes constant staking level.
                    </p>
                  </div>
                ) : (
                  <p className="text-muted-foreground text-sm">
                    Staking data unavailable
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ---- Projections Tab ---- */}
        <TabsContent value="projections">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">
                  Revenue Projections by Adoption Level
                </CardTitle>
                <Badge variant="outline" className="text-xs">
                  Modeled
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="pb-2 text-left">Adoption</th>
                      <th className="pb-2 text-right">Daily Hashrate</th>
                      <th className="pb-2 text-right">Daily Volume</th>
                      <th className="pb-2 text-right">Daily Fees</th>
                      <th className="pb-2 text-right">Monthly Fees</th>
                      <th className="pb-2 text-right">Annual Fees</th>
                    </tr>
                  </thead>
                  <tbody>
                    {projections.map((proj) => (
                      <tr key={proj.label} className="border-b last:border-0">
                        <td className="py-2">
                          <div>{proj.label}</div>
                          <div className="text-xs text-muted-foreground">
                            {proj.adoptionPct}% of global
                          </div>
                        </td>
                        <td className="py-2 text-right font-mono">
                          {proj.dailyHashratePh.toFixed(1)} PH/s
                        </td>
                        <td className="py-2 text-right font-mono">
                          {formatUsd(proj.dailyVolumeUsd)}
                        </td>
                        <td className="py-2 text-right font-mono">
                          {formatUsd(proj.dailyFeesUsd)}
                        </td>
                        <td className="py-2 text-right font-mono">
                          {formatUsd(proj.monthlyFeesUsd)}
                        </td>
                        <td className="py-2 text-right font-mono font-medium">
                          {formatUsd(proj.annualFeesUsd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted-foreground mt-3">
                Projections assume current hashprice (${currentHashprice.toFixed(2)}/PH/day),
                10% average discount, and 2% fee rate. Global network hashrate: {globalHashratePh.toFixed(0)} PH/s.
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
