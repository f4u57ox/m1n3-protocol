'use client';

import { useMemo } from 'react';
import { useSuiQuery } from './useSuiQuery';
import { fetchActiveTemplates } from '@/lib/sui-queries';
import type { TemplateData } from '@/lib/types';

export function useTemplates() {
  const {
    data: rawTemplates,
    isLoading,
    error,
    refetch,
  } = useSuiQuery<TemplateData[]>(
    ['templates', 'active'],
    fetchActiveTemplates,
  );

  const templates = useMemo<TemplateData[]>(() => {
    if (!rawTemplates) return [];
    return [...rawTemplates].sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      if (b.height !== a.height) return b.height - a.height;
      return b.createdAtMs - a.createdAtMs;
    });
  }, [rawTemplates]);

  return {
    templates,
    loading: isLoading,
    error: error?.message ?? null,
    refetch,
  };
}
