'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSuiQuery } from './useSuiQuery';
import { fetchBlockHashesPage } from '@/lib/block-hashes-client';
import {
  decomposeBlockHeader,
  generateMinerColors,
} from '@/lib/bitcoin-utils';
import type {
  RegisteredBlock,
  FragmentSubmission,
  HeaderSegment,
  SubmitterColorAssignment,
  FragmentLayout,
} from '@/lib/types';

async function fetchRegisteredBlocks(): Promise<RegisteredBlock[]> { return []; }
async function fetchFragmentsForHeight(_height: number): Promise<FragmentSubmission[]> { return []; }
async function fetchBlockHeaderHex(_blockHash: string): Promise<string | null> { return null; }

export function useRegisteredBlocks() {
  const { data, isLoading, error } = useSuiQuery<RegisteredBlock[]>(
    ['registered-blocks'],
    fetchRegisteredBlocks,
    { staleTime: 60_000, refetchInterval: 120_000 },
  );

  return {
    blocks: data ?? [],
    loading: isLoading,
    error: error?.message ?? null,
  };
}

interface HashEntry {
  height: number;
  hash: string;
}

interface HashesResponse {
  hashes: HashEntry[];
  total: number;
  offset: number;
  limit: number;
}

export function useBlockHashes(offset: number, limit: number) {
  const { data, isLoading, error } = useQuery<HashesResponse>({
    queryKey: ['block-hashes', offset, limit],
    queryFn: () => fetchBlockHashesPage(offset, limit, 'desc'),
    staleTime: 300_000,
  });

  return {
    hashes: data?.hashes ?? [],
    total: data?.total ?? 0,
    loading: isLoading,
    error: error instanceof Error ? error.message : null,
  };
}

export function useBlockDetail(blockHash: string, height: number) {
  const {
    data: headerHex,
    isLoading: headerLoading,
    error: headerError,
  } = useQuery<string | null>({
    queryKey: ['block-header', blockHash],
    queryFn: () => fetchBlockHeaderHex(blockHash),
    enabled: !!blockHash,
    staleTime: Infinity,
  });

  const {
    data: fragments,
    isLoading: fragmentsLoading,
    error: fragmentsError,
  } = useSuiQuery<FragmentSubmission[]>(
    ['fragments', height],
    () => fetchFragmentsForHeight(height),
    { staleTime: 60_000, refetchInterval: 120_000 },
  );

  const segments = useMemo<HeaderSegment[]>(() => {
    if (!headerHex || headerHex.length !== 160) return [];
    return decomposeBlockHeader(headerHex);
  }, [headerHex]);

  const fragmentLayouts = useMemo<FragmentLayout[]>(() => {
    if (!fragments || fragments.length === 0) return [];
    const seen = new Map<number, FragmentSubmission>();
    for (const f of fragments) {
      if (!seen.has(f.fragmentIndex)) seen.set(f.fragmentIndex, f);
    }
    return [...seen.entries()]
      .sort(([a], [b]) => a - b)
      .map(([idx, f]) => ({
        index: idx,
        offset: Math.floor(f.bitOffset / 8),
        size: Math.ceil((f.bitOffset + f.bitCount) / 8) - Math.floor(f.bitOffset / 8),
      }));
  }, [fragments]);

  const submitterColors = useMemo<SubmitterColorAssignment[]>(() => {
    if (!fragments || fragments.length === 0) return [];
    const submitterMap = new Map<string, Set<number>>();
    for (const f of fragments) {
      if (!submitterMap.has(f.submitter)) submitterMap.set(f.submitter, new Set());
      submitterMap.get(f.submitter)!.add(f.fragmentIndex);
    }
    const submitters = [...submitterMap.entries()];
    const colors = generateMinerColors(submitters.length);
    return submitters.map(([address, indices], i) => ({
      address,
      color: colors[i],
      fragmentIndices: [...indices].sort((a, b) => a - b),
    }));
  }, [fragments]);

  const loading = headerLoading || fragmentsLoading;
  const error =
    (headerError instanceof Error ? headerError.message : null) ??
    fragmentsError?.message ??
    null;

  return {
    headerHex: headerHex ?? null,
    segments,
    fragments: fragments ?? [],
    fragmentLayouts,
    submitterColors,
    loading,
    error,
  };
}
