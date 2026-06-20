// Pure utility functions for PPS-based share valuation

/**
 * Compute the PPS (Pay-Per-Share) value of a share in USD.
 *
 * PPS_value = (block_reward_USD / network_difficulty) × share_difficulty
 *
 * @param shareDifficulty   The share's difficulty_achieved
 * @param networkDifficulty Current Bitcoin network difficulty
 * @param blockRewardUsd    Block reward in USD (subsidy × BTC price)
 */
export function computeTheoreticalValue(
  shareDifficulty: number,
  networkDifficulty: number,
  blockRewardUsd: number,
): number {
  if (networkDifficulty <= 0) return 0;
  return (blockRewardUsd / networkDifficulty) * shareDifficulty;
}

/**
 * Compute the discount percentage between market price and theoretical value.
 * Returns 0–100 (positive = trading below theoretical).
 */
export function computeDiscount(
  marketPrice: number,
  theoreticalValue: number,
): number {
  if (theoreticalValue <= 0) return 0;
  return Math.max(0, (1 - marketPrice / theoreticalValue) * 100);
}

/**
 * Expected discount at a given number of blocks until coinbase maturation.
 * Uses exponential decay: discount decreases as the share nears maturity.
 *
 * maxDiscount: peak discount % when freshly mined (e.g. 15)
 * alpha: curvature parameter (0.7 = moderate concavity)
 * MATURATION_BLOCKS: total blocks for coinbase to mature (100)
 */
export function discountAtBlock(
  blocksUntilMature: number,
  maxDiscount: number,
  alpha = 0.7,
): number {
  const MATURATION_BLOCKS = 100;
  const ratio = Math.min(blocksUntilMature / MATURATION_BLOCKS, 1);
  return maxDiscount * Math.pow(ratio, alpha);
}

/**
 * Convert a share's difficulty to the petahashes of work it represents.
 * A share at difficulty D represents D * 2^32 hashes.
 */
export function difficultyToWorkPh(difficulty: number): number {
  return (difficulty * 4_294_967_296) / 1e15;
}

/**
 * Format a petahash value as a human-readable string.
 * e.g. 4.2 → "4.20 PH", 0.0003 → "300.00 TH"
 */
export function formatHashrate(ph: number): string {
  if (ph >= 1) return `${ph.toFixed(2)} PH`;
  const th = ph * 1000;
  if (th >= 1) return `${th.toFixed(2)} TH`;
  const gh = th * 1000;
  return `${gh.toFixed(2)} GH`;
}

// ---------------------------------------------------------------------------
// Gas Cost Calculations
// ---------------------------------------------------------------------------

/** Standard share submission gas cost in MIST (~600K gas units * reference price). */
export const GAS_COST_STANDARD_MIST = 600_000;
/** Lightweight share submission gas cost in MIST (~150K gas units). */
export const GAS_COST_LIGHTWEIGHT_MIST = 150_000;
/** Template registration gas cost in MIST (~800K gas units). */
export const GAS_COST_TEMPLATE_REGISTER_MIST = 800_000;

/**
 * Compute gas cost per share in SOL (1 SOL = 1e9 lamports).
 */
export function gasCostPerShareSol(lightweight: boolean): number {
  const mist = lightweight ? GAS_COST_LIGHTWEIGHT_MIST : GAS_COST_STANDARD_MIST;
  return mist / 1e9;
}

/**
 * Compute total gas burn for a number of shares.
 */
export function totalGasBurnSol(
  standardShares: number,
  lightweightShares: number,
  templateRegistrations: number,
): number {
  return (
    (standardShares * GAS_COST_STANDARD_MIST +
      lightweightShares * GAS_COST_LIGHTWEIGHT_MIST +
      templateRegistrations * GAS_COST_TEMPLATE_REGISTER_MIST) /
    1e9
  );
}

// ---------------------------------------------------------------------------
// Staker APY
// ---------------------------------------------------------------------------

/**
 * Compute staker APY from fee data and staking data.
 *
 * @param totalFeesCollectedMist  Total marketplace fees collected (MIST)
 * @param totalStakedBaseUnits    Total M1N3 staked (base units, 1 M1N3 = 1e8)
 * @param periodDays              Period over which fees were collected
 * @returns APY as a percentage
 */
export function computeStakerAPY(
  totalFeesCollectedMist: number,
  totalStakedBaseUnits: number,
  periodDays: number,
): number {
  if (totalStakedBaseUnits <= 0 || periodDays <= 0) return 0;
  const dailyFeeRate = totalFeesCollectedMist / periodDays;
  const annualFees = dailyFeeRate * 365;
  // Convert staked to same denomination (MIST) for ratio
  // M1N3 tokens don't have a direct MIST value, so APY = fees / staked_value
  // We express yield relative to staked amount in base units
  return (annualFees / totalStakedBaseUnits) * 100;
}

/**
 * Compute fee yield per single M1N3 token per day.
 *
 * @param totalFeesCollectedMist  Total fees in MIST
 * @param totalStakedBaseUnits    Total M1N3 staked (base units)
 * @param periodDays              Period over which fees were collected
 * @returns Daily yield per base unit in MIST
 */
export function computeDailyYieldPerToken(
  totalFeesCollectedMist: number,
  totalStakedBaseUnits: number,
  periodDays: number,
): number {
  if (totalStakedBaseUnits <= 0 || periodDays <= 0) return 0;
  return totalFeesCollectedMist / periodDays / totalStakedBaseUnits;
}

// ---------------------------------------------------------------------------
// Buyer / Arbitrageur Yield
// ---------------------------------------------------------------------------

/**
 * Compute annualized yield from buying shares at a discount.
 *
 * If you buy at X% discount and hold for ~16.7 hours (100 blocks),
 * annualized yield = (discount / (1 - discount)) * (8760 / holdingHours) * 100
 *
 * Example: 10% discount, 16.7h hold → ~219% annualized
 */
export function computeAnnualizedBuyerYield(
  discountPct: number,
  blocksUntilMature: number,
): number {
  if (discountPct <= 0 || blocksUntilMature <= 0) return 0;
  const holdingHours = (blocksUntilMature * 10) / 60; // ~10 min per block
  const discountFraction = discountPct / 100;
  const returnPct = (discountFraction / (1 - discountFraction)) * 100;
  return returnPct * (8760 / holdingHours);
}

/**
 * Compute realized ROI for a buyer who purchased at a given price
 * and the share matured to its theoretical value.
 */
export function computeBuyerROI(
  purchasePrice: number,
  theoreticalValue: number,
): number {
  if (purchasePrice <= 0) return 0;
  return ((theoreticalValue - purchasePrice) / purchasePrice) * 100;
}

// ---------------------------------------------------------------------------
// Pool Performance: Luck Factor
// ---------------------------------------------------------------------------

/**
 * Compute luck factor = actual_blocks / expected_blocks.
 *
 * Expected blocks = total_work / network_difficulty
 * where total_work = sum of all share difficulties * 2^32
 *
 * A luck factor > 1 means the pool found more blocks than expected (lucky).
 * A luck factor < 1 means fewer blocks than expected (unlucky).
 *
 * @param totalShares       Total shares submitted
 * @param totalBlocks       Total blocks found
 * @param poolDifficulty    Pool's minimum share difficulty
 * @param networkDifficulty Bitcoin network difficulty
 */
export function computeLuckFactor(
  totalShares: number,
  totalBlocks: number,
  poolDifficulty: number,
  networkDifficulty: number,
): number {
  if (networkDifficulty <= 0 || totalShares <= 0) return 1;
  // Expected blocks = (totalShares * poolDifficulty) / networkDifficulty
  const expectedBlocks = (totalShares * poolDifficulty) / networkDifficulty;
  if (expectedBlocks <= 0) return 1;
  return totalBlocks / expectedBlocks;
}

/**
 * Compute average round duration from block timestamps.
 * Returns duration in seconds.
 */
export function computeAvgRoundDuration(
  blockTimestampsMs: number[],
): { avgSec: number; stdDevSec: number } {
  if (blockTimestampsMs.length < 2) return { avgSec: 0, stdDevSec: 0 };

  const sorted = [...blockTimestampsMs].sort((a, b) => a - b);
  const durations: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    durations.push((sorted[i] - sorted[i - 1]) / 1000);
  }

  const avg = durations.reduce((s, d) => s + d, 0) / durations.length;
  const variance =
    durations.reduce((s, d) => s + (d - avg) ** 2, 0) / durations.length;
  return { avgSec: avg, stdDevSec: Math.sqrt(variance) };
}

/**
 * Compute expected round duration based on pool hashrate vs network difficulty.
 *
 * Expected time to find a block = (networkDifficulty * 2^32) / poolHashrateHps
 * where poolHashrateHps is in hashes per second.
 */
export function computeExpectedRoundDuration(
  networkDifficulty: number,
  poolHashrateHps: number,
): number {
  if (poolHashrateHps <= 0) return Infinity;
  return (networkDifficulty * 4_294_967_296) / poolHashrateHps;
}

// ---------------------------------------------------------------------------
// Miner Cost-of-Capital
// ---------------------------------------------------------------------------

/**
 * Compute the implied cost of waiting 100 blocks for coinbase maturation,
 * given a miner's annual cost of capital (APR).
 *
 * 100 blocks ≈ 16.67 hours = 16.67/8760 of a year
 * Implied cost = APR * (16.67 / 8760)
 */
export function computeImpliedWaitingCost(costOfCapitalApr: number): number {
  const maturationHours = (100 * 10) / 60; // ~16.67 hours
  return costOfCapitalApr * (maturationHours / 8760);
}

/**
 * Compute the breakeven discount for a miner.
 * Any discount below this is irrational for the miner to accept
 * (they're better off waiting for maturation).
 *
 * For a stressed miner with higher cost of capital, the breakeven is higher.
 */
export function computeMinerBreakEvenDiscount(
  costOfCapitalApr: number,
): number {
  return computeImpliedWaitingCost(costOfCapitalApr);
}

// ---------------------------------------------------------------------------
// FPPS Pool Comparison
// ---------------------------------------------------------------------------

import type { FPPSComparison } from './types';

/** Major Bitcoin mining pool fee rates for comparison. */
export const FPPS_POOL_DATA: FPPSComparison[] = [
  {
    poolName: 'Foundry USA',
    feeRate: 2.0,
    payoutMethod: 'FPPS',
    payoutDelay: '24h+',
    effectivePayoutRate: 0.98,
    m1n3EquivalentDiscount: 2.0,
  },
  {
    poolName: 'AntPool',
    feeRate: 2.5,
    payoutMethod: 'FPPS',
    payoutDelay: '24h+',
    effectivePayoutRate: 0.975,
    m1n3EquivalentDiscount: 2.5,
  },
  {
    poolName: 'F2Pool',
    feeRate: 2.5,
    payoutMethod: 'PPS+',
    payoutDelay: '24h+',
    effectivePayoutRate: 0.975,
    m1n3EquivalentDiscount: 2.5,
  },
  {
    poolName: 'ViaBTC',
    feeRate: 4.0,
    payoutMethod: 'PPS+',
    payoutDelay: '24h+',
    effectivePayoutRate: 0.96,
    m1n3EquivalentDiscount: 4.0,
  },
  {
    poolName: 'm1n3 (marketplace)',
    feeRate: 0,
    payoutMethod: 'Instant (marketplace)',
    payoutDelay: 'Minutes',
    effectivePayoutRate: 1.0,
    m1n3EquivalentDiscount: 0,
  },
];

// ---------------------------------------------------------------------------
// TAM Analysis
// ---------------------------------------------------------------------------

/** Current Bitcoin block subsidy (post-2024 halving). */
export const BTC_BLOCK_SUBSIDY = 3.125;
/** Blocks per day (~144). */
export const BTC_BLOCKS_PER_DAY = 144;

/**
 * Compute Total Addressable Market for m1n3.
 */
export function computeTAM(
  btcPriceUsd: number,
  // Default to 0 — all our hashprice/share-value math uses the coinbase
  // subsidy ONLY. Callers that explicitly want fee-included revenue can
  // pass a value (e.g. 0.5 BTC/day) but nothing in the codebase does.
  avgDailyTxFeesBtc: number = 0,
): {
  dailyBlockRewardsBtc: number;
  dailyTxFeesBtc: number;
  dailyMiningRevenueUsd: number;
  addressableRevenueUsd: number;
} {
  const dailyBlockRewardsBtc = BTC_BLOCK_SUBSIDY * BTC_BLOCKS_PER_DAY; // ~450 BTC
  const dailyMiningRevenueUsd =
    (dailyBlockRewardsBtc + avgDailyTxFeesBtc) * btcPriceUsd;
  return {
    dailyBlockRewardsBtc,
    dailyTxFeesBtc: avgDailyTxFeesBtc,
    dailyMiningRevenueUsd,
    addressableRevenueUsd: dailyBlockRewardsBtc * btcPriceUsd,
  };
}

// ---------------------------------------------------------------------------
// Revenue Projections
// ---------------------------------------------------------------------------

import type { RevenueProjection } from './types';

/**
 * Generate revenue projections at different adoption levels.
 *
 * @param globalHashratePh  Global network hashrate in PH/s
 * @param hashpricePerPh    $/PH/day
 * @param totalStakedBase   Total M1N3 staked for APY calculation
 * @param avgDiscountPct    Average marketplace discount
 * @param feeRateBps        Fee rate in basis points (200 = 2%)
 */
export function generateRevenueProjections(
  globalHashratePh: number,
  hashpricePerPh: number,
  totalStakedBase: number,
  avgDiscountPct: number = 10,
  feeRateBps: number = 200,
): RevenueProjection[] {
  const adoptionLevels = [
    { label: '0.1% (early)', pct: 0.1 },
    { label: '1% (growing)', pct: 1 },
    { label: '5% (established)', pct: 5 },
    { label: '10% (major)', pct: 10 },
  ];

  return adoptionLevels.map(({ label, pct }) => {
    const dailyHashratePh = globalHashratePh * (pct / 100);
    // Daily mining value flowing through m1n3
    const dailyVolumeUsd = dailyHashratePh * hashpricePerPh;
    // Marketplace volume = mining value * (1 - discount) since shares trade at discount
    const marketplaceVolumeUsd = dailyVolumeUsd * (1 - avgDiscountPct / 100);
    const dailyFeesUsd = marketplaceVolumeUsd * (feeRateBps / 10000);
    const monthlyFeesUsd = dailyFeesUsd * 30;
    const annualFeesUsd = dailyFeesUsd * 365;

    // Estimate daily shares: assume average share difficulty = pool min difficulty
    // This is a rough estimate
    const dailySharesEstimate = Math.round(dailyHashratePh * 1e15 / (4096 * 4_294_967_296) * 86400);

    const stakerApyPct = totalStakedBase > 0
      ? (annualFeesUsd / totalStakedBase) * 1e8 * 100 // normalize to base units
      : 0;

    return {
      label,
      adoptionPct: pct,
      dailyHashratePh,
      dailySharesEstimate,
      dailyVolumeUsd: marketplaceVolumeUsd,
      dailyFeesUsd,
      monthlyFeesUsd,
      annualFeesUsd,
      stakerApyPct,
    };
  });
}
