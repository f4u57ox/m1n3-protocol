'use client';

import { useQuery } from '@tanstack/react-query';
import type {
  MarketHistoryPoint,
  MarketHistoryRange,
  DifficultyAdjustment,
} from '@/lib/types';

// ---------------------------------------------------------------------------
// Range helpers
// ---------------------------------------------------------------------------

const RANGE_TO_DAYS: Record<MarketHistoryRange, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '1y': 365,
};

const RANGE_TO_MEMPOOL_TF: Record<MarketHistoryRange, string> = {
  '7d': '1m',
  '30d': '1m',
  '90d': '3m',
  '1y': '1y',
};

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

async function fetchBtcPriceHistory(days: number): Promise<[number, number][]> {
  const res = await fetch(
    `https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=${days}`,
  );
  if (!res.ok) throw new Error(`CoinGecko responded ${res.status}`);
  const data = await res.json();
  return data.prices as [number, number][]; // [[timestamp_ms, price], ...]
}

async function fetchHashrateHistory(
  timeframe: string,
): Promise<{ timestamp: number; avgHashrate: number }[]> {
  const res = await fetch(
    `https://mempool.space/api/v1/mining/hashrate/${timeframe}`,
  );
  if (!res.ok) throw new Error(`mempool.space hashrate responded ${res.status}`);
  const data = await res.json();
  return (data.hashrates ?? []) as { timestamp: number; avgHashrate: number }[];
}

async function fetchDifficultyAdjustments(): Promise<DifficultyAdjustment[]> {
  const res = await fetch(
    'https://mempool.space/api/v1/mining/difficulty-adjustments/1y',
  );
  if (!res.ok)
    throw new Error(
      `mempool.space difficulty-adjustments responded ${res.status}`,
    );
  const raw: number[][] = await res.json();
  // Each entry: [timestamp, height, difficulty, difficultyChange]
  return raw.map((entry) => ({
    timestamp: entry[0],
    height: entry[1],
    difficulty: entry[2],
    difficultyChange: entry[3],
  }));
}

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

async function fetchNextDifficultyAdjustment(): Promise<NextDifficultyAdjustment> {
  const res = await fetch('https://mempool.space/api/v1/difficulty-adjustment');
  if (!res.ok)
    throw new Error(
      `mempool.space difficulty-adjustment responded ${res.status}`,
    );
  return res.json();
}

// ---------------------------------------------------------------------------
// Alignment: binary-search-interpolate BTC price at hashrate timestamps
// ---------------------------------------------------------------------------

function interpolatePrice(
  prices: [number, number][],
  targetMs: number,
): number {
  if (prices.length === 0) return 0;
  if (targetMs <= prices[0][0]) return prices[0][1];
  if (targetMs >= prices[prices.length - 1][0])
    return prices[prices.length - 1][1];

  let lo = 0;
  let hi = prices.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >>> 1;
    if (prices[mid][0] <= targetMs) lo = mid;
    else hi = mid;
  }

  const [t0, p0] = prices[lo];
  const [t1, p1] = prices[hi];
  const ratio = (targetMs - t0) / (t1 - t0);
  return p0 + ratio * (p1 - p0);
}

function alignData(
  prices: [number, number][],
  hashrates: { timestamp: number; avgHashrate: number }[],
  rangeDays: number,
): MarketHistoryPoint[] {
  const cutoff = Date.now() - rangeDays * 86_400_000;
  const filtered = hashrates.filter((h) => h.timestamp * 1000 >= cutoff);

  return filtered.map((h) => {
    const tsMs = h.timestamp * 1000;
    const btcPrice = interpolatePrice(prices, tsMs);
    const networkHashrate = h.avgHashrate;
    // hashprice = (block_reward * blocks_per_day * btc_price) / (hashrate in PH/s)
    const hashprice =
      networkHashrate > 0
        ? (3.125 * 144 * btcPrice) / (networkHashrate / 1e15)
        : 0;
    return { timestamp: tsMs, btcPrice, networkHashrate, hashprice };
  });
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useMarketHistory(range: MarketHistoryRange = '30d') {
  const days = RANGE_TO_DAYS[range];
  const tf = RANGE_TO_MEMPOOL_TF[range];

  const historyQuery = useQuery({
    queryKey: ['market-history', range],
    queryFn: async (): Promise<MarketHistoryPoint[]> => {
      const [prices, hashrates] = await Promise.all([
        fetchBtcPriceHistory(days),
        fetchHashrateHistory(tf),
      ]);
      return alignData(prices, hashrates, days);
    },
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });

  const difficultyQuery = useQuery({
    queryKey: ['difficulty-adjustments'],
    queryFn: fetchDifficultyAdjustments,
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });

  const nextAdjQuery = useQuery({
    queryKey: ['next-difficulty-adjustment'],
    queryFn: fetchNextDifficultyAdjustment,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  return {
    data: historyQuery.data ?? [],
    difficultyAdjustments: difficultyQuery.data ?? [],
    nextAdjustment: nextAdjQuery.data ?? null,
    loading:
      historyQuery.isLoading ||
      difficultyQuery.isLoading ||
      nextAdjQuery.isLoading,
    error:
      historyQuery.error?.message ??
      difficultyQuery.error?.message ??
      nextAdjQuery.error?.message ??
      null,
  };
}
