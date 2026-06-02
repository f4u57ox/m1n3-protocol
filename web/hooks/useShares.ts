'use client';

import { useQuery } from '@tanstack/react-query';
import type { SharesResponse } from '@/app/api/pool/shares/route';

export type { ShareEvent, SharesResponse } from '@/app/api/pool/shares/route';

async function fetchShares(): Promise<SharesResponse> {
  const res  = await fetch('/api/pool/shares');
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as SharesResponse;
}

export function useShares() {
  return useQuery<SharesResponse, Error>({
    queryKey: ['pool', 'shares'],
    queryFn:  fetchShares,
    staleTime:       10_000,
    refetchInterval: 15_000,
    retry: 2,
  });
}
