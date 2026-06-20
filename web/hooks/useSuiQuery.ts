'use client';

import {
  useQuery,
  type UseQueryOptions,
  type UseQueryResult,
  type QueryKey,
} from '@tanstack/react-query';

const DEFAULT_STALE_TIME = 10_000;
const DEFAULT_REFETCH_INTERVAL = 30_000;

export function useSuiQuery<T>(
  key: QueryKey,
  fetcher: () => Promise<T>,
  options?: Omit<UseQueryOptions<T, Error, T, QueryKey>, 'queryKey' | 'queryFn'>,
): UseQueryResult<T, Error> {
  return useQuery<T, Error, T, QueryKey>({
    queryKey: key,
    queryFn: fetcher,
    staleTime: DEFAULT_STALE_TIME,
    refetchInterval: DEFAULT_REFETCH_INTERVAL,
    ...options,
  });
}
