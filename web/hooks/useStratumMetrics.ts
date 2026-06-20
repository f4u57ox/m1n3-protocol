"use client";

import { useState, useEffect, useRef } from "react";
import { fetchStratumMetrics, type StratumMetrics } from "@/lib/stratum-client";

const POLL_MS = 3_000;

export function useStratumMetrics() {
  const [data, setData] = useState<StratumMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let alive = true;

    async function poll() {
      const metrics = await fetchStratumMetrics();
      if (!alive) return;
      if (metrics) {
        setData(metrics);
        setError(null);
      } else {
        setError("Stratum server unreachable (localhost:9091)");
      }
      setLoading(false);
    }

    poll();
    timer.current = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  return { data, loading, error };
}
