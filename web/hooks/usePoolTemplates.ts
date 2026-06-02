'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchTemplates } from '@/lib/sui-rpc';

export type { JobTemplate, PoolStats, TemplatesResponse } from '@/lib/sui-rpc';

export function usePoolTemplates() {
  return useQuery({
    queryKey: ['pool', 'templates'],
    queryFn: fetchTemplates,
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: 2,
  });
}
