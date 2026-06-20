"use client";

import { Award, Bitcoin, CheckCircle } from "lucide-react";
import type { RewardRegistryData } from "@/lib/types";

interface RewardOverviewProps {
  registry: RewardRegistryData | null;
  loading: boolean;
}

export function RewardOverview({ registry, loading }: RewardOverviewProps) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[...Array(3)].map((_, i) => (
          <div
            key={i}
            className="rounded-lg border bg-card p-4 animate-pulse"
          >
            <div className="h-4 bg-muted rounded w-24 mb-2" />
            <div className="h-6 bg-muted rounded w-16" />
          </div>
        ))}
      </div>
    );
  }

  if (!registry) {
    return (
      <div className="rounded-lg border bg-card p-6 text-center text-muted-foreground">
        Reward registry not configured
      </div>
    );
  }

  const btcValue = registry.totalSatsPaid / 1e8;

  const stats = [
    {
      label: "Total Batches",
      value: registry.totalBatches.toLocaleString(),
      icon: Award,
    },
    {
      label: "Total Sats Paid",
      value: `${registry.totalSatsPaid.toLocaleString()} sats (${btcValue.toFixed(8)} BTC)`,
      icon: Bitcoin,
    },
    {
      label: "Completed Rounds",
      value: registry.completedRounds.toLocaleString(),
      icon: CheckCircle,
    },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {stats.map((stat) => (
        <div
          key={stat.label}
          className="rounded-lg border bg-card p-4 flex items-start gap-3"
        >
          <stat.icon className="h-5 w-5 text-muted-foreground mt-0.5" />
          <div>
            <p className="text-sm text-muted-foreground">{stat.label}</p>
            <p className="text-xl font-semibold">{stat.value}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
