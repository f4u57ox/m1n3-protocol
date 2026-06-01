'use client';

import { useQuery } from '@tanstack/react-query';
import type { TemplatesResponse } from '@/app/api/pool/templates/route';

export type { JobTemplate, PoolStats, TemplatesResponse } from '@/app/api/pool/templates/route';

async function fetchTemplates(): Promise<TemplatesResponse> {
  const res = await fetch('/api/pool/templates');
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as TemplatesResponse;
}

export function usePoolTemplates() {
  return useQuery<TemplatesResponse, Error>({
    queryKey: ['pool', 'templates'],
    queryFn: fetchTemplates,
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: 2,
  });
}
