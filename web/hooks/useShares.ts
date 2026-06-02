'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchShares } from '@/lib/sui-rpc';

export type { ShareEvent, SharesResponse } from '@/lib/sui-rpc';

export function useShares() {
  return useQuery({
    queryKey: ['pool', 'shares'],
    queryFn: fetchShares,
    staleTime: 10_000,
    refetchInterval: 15_000,
    retry: 2,
  });
}
