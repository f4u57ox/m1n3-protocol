'use client';

import { useSuiQuery } from './useSuiQuery';
import { fetchPoolStats, fetchPoolHashrate } from '@/lib/sui-queries';
import type { PoolData } from '@/lib/types';

async function fetchPoolData(): Promise<PoolData | null> {
  const [stats, hashrate] = await Promise.all([
    fetchPoolStats(),
    fetchPoolHashrate(),
  ]);
  if (!stats) return null;
  return {
    ...stats,
    poolHashrate: hashrate.instantaneous,
    poolHashrateAvg: hashrate.average,
  };
}

export function usePoolStats() {
  const {
    data: poolData,
    isLoading,
    error,
  } = useSuiQuery<PoolData | null>(
    ['pool', 'stats'],
    fetchPoolData,
  );

  return {
    poolData: poolData ?? null,
    loading: isLoading,
    error: error?.message ?? null,
  };
}
