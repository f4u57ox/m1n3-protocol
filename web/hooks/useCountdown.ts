'use client';

import { useState, useEffect, useCallback } from 'react';

export interface UseCountdownReturn {
  /** Milliseconds remaining until deadline. 0 if expired. */
  remainingMs: number;
  /** Human-readable "MM:SS" or "HH:MM:SS" format. */
  formatted: string;
  /** Whether the deadline has passed. */
  isExpired: boolean;
  /** Fraction elapsed (0..1). 1 = fully elapsed. */
  progress: number;
}

function formatMs(ms: number): string {
  if (ms <= 0) return '0:00';
  const totalSec = Math.ceil(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins >= 60) {
    const hrs = Math.floor(mins / 60);
    const remainMins = mins % 60;
    return `${hrs}:${String(remainMins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/**
 * Countdown hook that ticks every second.
 *
 * @param deadlineMs  Unix timestamp (ms) of when the countdown expires.
 *                    Pass 0 to disable.
 * @param totalDurationMs  Total duration used to calculate progress fraction.
 */
export function useCountdown(
  deadlineMs: number,
  totalDurationMs: number,
): UseCountdownReturn {
  const compute = useCallback((): UseCountdownReturn => {
    if (!deadlineMs || !totalDurationMs) {
      return { remainingMs: 0, formatted: '--:--', isExpired: true, progress: 1 };
    }
    const now = Date.now();
    const remaining = Math.max(0, deadlineMs - now);
    const elapsed = totalDurationMs - remaining;
    const progress = Math.min(1, Math.max(0, elapsed / totalDurationMs));
    return {
      remainingMs: remaining,
      formatted: formatMs(remaining),
      isExpired: remaining <= 0,
      progress,
    };
  }, [deadlineMs, totalDurationMs]);

  const [state, setState] = useState<UseCountdownReturn>(compute);

  useEffect(() => {
    if (!deadlineMs || !totalDurationMs) {
      setState(compute());
      return;
    }

    // Immediately compute
    setState(compute());

    const interval = setInterval(() => {
      const next = compute();
      setState(next);
      if (next.isExpired) clearInterval(interval);
    }, 1000);

    return () => clearInterval(interval);
  }, [deadlineMs, totalDurationMs, compute]);

  return state;
}
