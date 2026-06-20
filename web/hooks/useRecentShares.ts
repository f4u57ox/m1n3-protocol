'use client';

import { useSuiQuery } from './useSuiQuery';
import { fetchRecentShares } from '@/lib/sui-shares';
import type { ShareEvent } from '@/lib/types';

export function useRecentShares(limit = 20) {
  const {
    data: shares,
    isLoading,
    error,
  } = useSuiQuery<ShareEvent[]>(
    ['shares', 'recent', limit],
    () => fetchRecentShares(limit),
    { staleTime: 15_000, refetchInterval: 30_000 },
  );

  return {
    shares: shares ?? [],
    loading: isLoading,
    error: error?.message ?? null,
  };
}
