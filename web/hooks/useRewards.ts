'use client';

import { useSuiQuery } from './useSuiQuery';
import type { RewardRegistryData, RewardBatchData } from '@/lib/types';

async function fetchRewardRegistry(): Promise<RewardRegistryData | null> { return null; }
async function fetchRewardBatches(): Promise<RewardBatchData[]> { return []; }

export function useRewardRegistry() {
  const {
    data: registry,
    isLoading,
    error,
  } = useSuiQuery<RewardRegistryData | null>(
    ['rewards', 'registry'],
    fetchRewardRegistry,
    { staleTime: 30_000 },
  );

  return {
    registry: registry ?? null,
    loading: isLoading,
    error: error?.message ?? null,
  };
}

export function useRewardBatches() {
  const {
    data: batches,
    isLoading,
    error,
  } = useSuiQuery<RewardBatchData[]>(
    ['rewards', 'batches'],
    fetchRewardBatches,
    { staleTime: 30_000 },
  );

  return {
    batches: batches ?? [],
    loading: isLoading,
    error: error?.message ?? null,
  };
}
