'use client';

import { useSuiQuery } from './useSuiQuery';
import type { M1N3TreasuryData, TokenDistributionEntry } from '@/lib/types';

async function fetchM1N3Treasury(): Promise<M1N3TreasuryData | null> { return null; }
async function fetchRecentRewards(): Promise<TokenDistributionEntry[]> { return []; }

export function useM1N3Treasury() {
  const {
    data: treasury,
    isLoading,
    error,
  } = useSuiQuery<M1N3TreasuryData | null>(
    ['token', 'treasury'],
    fetchM1N3Treasury,
    { staleTime: 30_000 },
  );

  return {
    treasury: treasury ?? null,
    loading: isLoading,
    error: error?.message ?? null,
  };
}

export function useRecentRewards() {
  const {
    data: distributions,
    isLoading,
    error,
  } = useSuiQuery<TokenDistributionEntry[]>(
    ['token', 'distributions'],
    fetchRecentRewards,
    { staleTime: 30_000 },
  );

  return {
    distributions: distributions ?? [],
    loading: isLoading,
    error: error?.message ?? null,
  };
}
