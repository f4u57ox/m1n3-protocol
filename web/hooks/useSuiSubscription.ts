'use client';

import { useState } from 'react';
import type { TemplateEvent } from '@/lib/types';

export interface UseSuiSubscriptionOptions {
  onEvent?: (event: TemplateEvent) => void;
  maxEvents?: number;
  enabled?: boolean;
}

export interface UseSuiSubscriptionReturn {
  connected: boolean;
  events: TemplateEvent[];
  subscribe: () => void;
  unsubscribe: () => void;
}

export function useSuiSubscription(
  _options: UseSuiSubscriptionOptions = {},
): UseSuiSubscriptionReturn {
  const [events] = useState<TemplateEvent[]>([]);
  return { connected: false, events, subscribe: () => {}, unsubscribe: () => {} };
}
