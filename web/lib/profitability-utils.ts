// Platform-level profitability metrics, risk analysis, and backtesting
//
// This module provides calculations for:
// - Net revenue (fees - gas costs)
// - Break-even volume analysis
// - Unit economics per share
// - Risk-adjusted returns (Sharpe ratio)
// - Historical backtesting

import type {
  PlatformProfitability,
  BuyerYieldMetrics,
  TradeRecord,
  CostOfCapitalAnalysis,
} from './types';
import {
  GAS_COST_STANDARD_MIST,
  GAS_COST_LIGHTWEIGHT_MIST,
  computeAnnualizedBuyerYield,
  computeImpliedWaitingCost,
} from './hashprice-utils';

// ---------------------------------------------------------------------------
// Net Revenue / Platform Profitability
// ---------------------------------------------------------------------------

/**
 * Compute platform profitability from marketplace fees and gas costs.
 *
 * @param totalFeesMist         Total marketplace fees collected (MIST)
 * @param totalSales            Total number of completed sales
 * @param totalSharesSubmitted  Total shares submitted (standard + lightweight)
 * @param lightweightRatio      Fraction of shares that are lightweight (0-1)
 * @param dailyInfraCostSol     Estimated daily infrastructure cost in SOL
 * @param periodDays            Period over which data was collected
 */
export function computePlatformProfitability(
  totalFeesMist: number,
  totalSales: number,
  totalSharesSubmitted: number,
  lightweightRatio: number,
  dailyInfraCostSol: number,
  periodDays: number,
): PlatformProfitability {
  const standardShares = Math.round(totalSharesSubmitted * (1 - lightweightRatio));
  const lightweightShares = Math.round(totalSharesSubmitted * lightweightRatio);

  const totalGasCostsMist =
    standardShares * GAS_COST_STANDARD_MIST +
    lightweightShares * GAS_COST_LIGHTWEIGHT_MIST;

  const netMarginMist = totalFeesMist - totalGasCostsMist;
  const netMarginPct = totalFeesMist > 0
    ? (netMarginMist / totalFeesMist) * 100
    : 0;

  const avgFeePerTrade = totalSales > 0 ? totalFeesMist / totalSales : 0;
  const avgGasPerShare = totalSharesSubmitted > 0
    ? totalGasCostsMist / totalSharesSubmitted
    : 0;

  // Break-even: daily fees must cover daily gas + infra
  const dailyGasCostSol = periodDays > 0
    ? totalGasCostsMist / 1e9 / periodDays
    : 0;
  const dailyCostSol = dailyGasCostSol + dailyInfraCostSol;
  // fees = volume * 2% (200 bps), so volume = fees / 0.02
  // We need daily fees >= daily cost, so daily volume >= daily cost / 0.02
  const breakEvenDailyVolumeSol = dailyCostSol / 0.02;

  return {
    netMarginMist,
    netMarginPct,
    totalFeesMist,
    totalGasCostsMist,
    avgFeePerTrade,
    avgGasPerShare,
    breakEvenDailyVolumeSol,
    dailyInfraCostSol,
  };
}

// ---------------------------------------------------------------------------
// Buyer Yield Metrics
// ---------------------------------------------------------------------------

/**
 * Compute buyer yield metrics from completed trade records.
 */
export function computeBuyerYieldMetrics(
  trades: TradeRecord[],
  currentHashpricePHPerDay: number,
): BuyerYieldMetrics {
  if (trades.length === 0) {
    return {
      annualizedYieldPct: 0,
      avgDiscountPct: 0,
      maturationHours: 16.67,
      historicalRoiPct: 0,
      sampleSize: 0,
    };
  }

  // Volume-weighted average discount
  let totalVolume = 0;
  let weightedDiscount = 0;
  let totalRoi = 0;

  for (const trade of trades) {
    const theoreticalValue =
      (trade.difficultyAchieved * 4_294_967_296) / 1e15 * currentHashpricePHPerDay;
    if (theoreticalValue <= 0) continue;

    const priceUsd = trade.price / 1e9; // convert MIST to SOL (proxy for USD)
    const discount = Math.max(0, (1 - priceUsd / theoreticalValue) * 100);
    const roi = theoreticalValue > 0
      ? ((theoreticalValue - priceUsd) / priceUsd) * 100
      : 0;

    totalVolume += trade.price;
    weightedDiscount += discount * trade.price;
    totalRoi += roi;
  }

  const avgDiscountPct = totalVolume > 0 ? weightedDiscount / totalVolume : 0;
  const historicalRoiPct = trades.length > 0 ? totalRoi / trades.length : 0;
  const maturationHours = (100 * 10) / 60;
  const annualizedYieldPct = computeAnnualizedBuyerYield(avgDiscountPct, 100);

  return {
    annualizedYieldPct,
    avgDiscountPct,
    maturationHours,
    historicalRoiPct,
    sampleSize: trades.length,
  };
}

// ---------------------------------------------------------------------------
// Cost-of-Capital Analysis
// ---------------------------------------------------------------------------

/**
 * Compute miner cost-of-capital analysis at various APR levels.
 */
export function computeCostOfCapitalAnalysis(
  costOfCapitalApr: number,
  stressedCostOfCapitalApr: number = 50,
): CostOfCapitalAnalysis {
  return {
    costOfCapitalApr,
    impliedWaitingCostPct: computeImpliedWaitingCost(costOfCapitalApr),
    breakEvenDiscountPct: computeImpliedWaitingCost(costOfCapitalApr),
    stressedBreakEvenPct: computeImpliedWaitingCost(stressedCostOfCapitalApr),
  };
}

// ---------------------------------------------------------------------------
// Risk-Adjusted Returns (Sharpe Ratio)
// ---------------------------------------------------------------------------

/**
 * Compute Sharpe ratio for the "buy discounted shares" strategy.
 *
 * Sharpe = (mean_return - risk_free_rate) / std_dev_returns
 *
 * @param tradeReturns     Array of individual trade return percentages
 * @param riskFreeRateAnn  Annual risk-free rate (e.g. 0.05 for 5%)
 * @param periodsPerYear   Number of trading periods per year (365 * 24 for hourly)
 */
export function computeSharpeRatio(
  tradeReturns: number[],
  riskFreeRateAnn: number = 0.05,
  periodsPerYear: number = 365 * 24,
): number {
  if (tradeReturns.length < 2) return 0;

  const mean = tradeReturns.reduce((s, r) => s + r, 0) / tradeReturns.length;
  const variance =
    tradeReturns.reduce((s, r) => s + (r - mean) ** 2, 0) /
    (tradeReturns.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev <= 0) return 0;

  const periodRiskFree = riskFreeRateAnn / periodsPerYear;
  const excessReturn = mean - periodRiskFree;

  // Annualize the Sharpe ratio
  return (excessReturn / stdDev) * Math.sqrt(periodsPerYear);
}

// ---------------------------------------------------------------------------
// Backtesting Engine
// ---------------------------------------------------------------------------

/** A single backtesting data point. */
export interface BacktestPoint {
  timestamp: number;
  btcPrice: number;
  networkDifficulty: number;
  hashprice: number;
  blockFees: number;
  discountPct: number;
  buyerPnlPct: number;
  sellerEffectiveRate: number;
}

/**
 * Backtest the discount arbitrage strategy over historical data.
 *
 * For each period: simulate buying at the given discount,
 * holding for 100 blocks (~16.7h), and receiving face value at maturation.
 *
 * @param historicalData   Array of {timestamp, btcPrice, networkDifficulty, hashprice, blockFees}
 * @param baseDiscount     Base discount percentage (varies with market conditions)
 * @param feeRatePct       Marketplace fee rate (2%)
 */
export function backtestDiscountArbitrage(
  historicalData: {
    timestamp: number;
    btcPrice: number;
    networkDifficulty: number;
    hashprice: number;
    blockFees: number;
  }[],
  baseDiscount: number = 10,
  feeRatePct: number = 2,
): BacktestPoint[] {
  const MATURATION_BLOCKS = 100;
  const MATURATION_HOURS = (MATURATION_BLOCKS * 10) / 60;
  const results: BacktestPoint[] = [];

  for (let i = 0; i < historicalData.length; i++) {
    const point = historicalData[i];

    // Discount varies with hashprice volatility and fee spikes
    // Higher fees = miners more eager to sell = lower discount
    // Lower hashprice = higher stress = higher discount
    const feeMultiplier = Math.max(0.5, Math.min(2, point.blockFees / 0.5));
    const hashpriceStress = point.hashprice < 30 ? 1.5 : point.hashprice < 50 ? 1.0 : 0.7;
    const adjustedDiscount = baseDiscount * hashpriceStress / feeMultiplier;

    // Buyer P&L: buys at (1-discount)% of value, receives 100% at maturation
    // Net of 2% marketplace fee
    const buyPrice = 1 - adjustedDiscount / 100;
    const netBuyPrice = buyPrice * (1 + feeRatePct / 100); // buyer pays fee
    const buyerPnlPct = ((1 - netBuyPrice) / netBuyPrice) * 100;

    // Seller effective rate: 1 - discount (what fraction of theoretical value they get)
    const sellerEffectiveRate = (1 - adjustedDiscount / 100) * 100;

    results.push({
      timestamp: point.timestamp,
      btcPrice: point.btcPrice,
      networkDifficulty: point.networkDifficulty,
      hashprice: point.hashprice,
      blockFees: point.blockFees,
      discountPct: adjustedDiscount,
      buyerPnlPct,
      sellerEffectiveRate,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Market Health Metrics
// ---------------------------------------------------------------------------

/**
 * Compute fill rate from listing and sale counts.
 * Fill rate = sales / (sales + cancellations) * 100
 */
export function computeFillRate(
  totalSales: number,
  totalCanceled: number,
): number {
  const total = totalSales + totalCanceled;
  if (total <= 0) return 0;
  return (totalSales / total) * 100;
}

/**
 * Compute average time-to-fill from trade records.
 */
export function computeAvgTimeToFill(trades: TradeRecord[]): number {
  if (trades.length === 0) return 0;
  const totalMs = trades.reduce((s, t) => s + t.timeToFillMs, 0);
  return totalMs / trades.length;
}

/**
 * Count unique participants from trade records.
 */
export function countUniqueParticipants(
  trades: TradeRecord[],
): { sellers: number; buyers: number } {
  const sellers = new Set<string>();
  const buyers = new Set<string>();
  for (const trade of trades) {
    sellers.add(trade.seller);
    buyers.add(trade.buyer);
  }
  return { sellers: sellers.size, buyers: buyers.size };
}
