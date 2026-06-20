'use client';

import { useSuiQuery } from './useSuiQuery';
import type { MinerStatsData } from '@/lib/types';

// Stub — full miner enumeration requires GraphQL object query
async function fetchAllMiners(): Promise<MinerStatsData[]> { return []; }

export function useMiners() {
  const { data: miners, isLoading, error } = useSuiQuery<MinerStatsData[]>(
    ['miners', 'all'],
    fetchAllMiners,
    { staleTime: 30_000 },
  );
  return { miners: miners ?? [], loading: isLoading, error: error?.message ?? null };
}
