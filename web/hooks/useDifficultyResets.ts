'use client';

import { useSuiQuery } from './useSuiQuery';
import type { DifficultyResetEvent } from '@/lib/types';

async function fetchDifficultyResets(_limit: number): Promise<DifficultyResetEvent[]> { return []; }

export function useDifficultyResets(limit = 20) {
  const {
    data: resets,
    isLoading,
    error,
  } = useSuiQuery<DifficultyResetEvent[]>(
    ['difficulty-resets', limit],
    () => fetchDifficultyResets(limit),
    { staleTime: 30_000 },
  );

  return {
    resets: resets ?? [],
    loading: isLoading,
    error: error?.message ?? null,
  };
}
