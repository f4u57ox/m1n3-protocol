"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useTemplates } from "@/hooks/useTemplates";
import { useSuiSubscription } from "@/hooks/useSuiSubscription";

const TimingChart = dynamic(
  () => import("@/components/TimingChart").then((m) => ({ default: m.TimingChart })),
  { ssr: false, loading: () => <div className="h-64 animate-pulse bg-muted rounded-lg" /> },
);

export function TimingTab() {
  const { templates, loading } = useTemplates();
  const { events } = useSuiSubscription();
  const [timeWindow, setTimeWindow] = useState(120);

  const chartEvents = useMemo(
    () =>
      events.map((e) => ({
        type: e.type,
        timestamp: e.timestamp,
        templateId: (e.data as Record<string, unknown>).template_id as string | undefined,
      })),
    [events],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        <div className="flex items-center gap-2">
          <label className="text-sm text-muted-foreground">Window:</label>
          <select
            value={timeWindow}
            onChange={(e) => setTimeWindow(Number(e.target.value))}
            className="rounded-md border bg-background px-2 py-1 text-sm"
          >
            <option value={30}>30s</option>
            <option value={60}>1m</option>
            <option value={120}>2m</option>
            <option value={300}>5m</option>
          </select>
        </div>
      </div>

      {loading ? (
        <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground animate-pulse">
          Loading...
        </div>
      ) : (
        <TimingChart
          templates={templates}
          events={chartEvents}
          timeWindowSeconds={timeWindow}
        />
      )}
    </div>
  );
}
