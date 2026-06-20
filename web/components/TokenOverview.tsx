"use client";

import { Coins, ArrowDownUp, Layers } from "lucide-react";
import { formatM1N3 } from "@/lib/utils";
import { M1N3_DECIMALS } from "@/lib/constants";
import type { M1N3TreasuryData, TokenDistributionEntry } from "@/lib/types";

interface TokenOverviewProps {
  treasury: M1N3TreasuryData | null;
  distributions: TokenDistributionEntry[];
  loading: boolean;
}

export function TokenOverview({
  treasury,
  distributions,
  loading,
}: TokenOverviewProps) {
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

  if (!treasury) {
    return (
      <div className="rounded-lg border bg-card p-6 text-center text-muted-foreground">
        m1n3 Treasury not configured
      </div>
    );
  }

  const btcEquivalent = treasury.totalMinted / 10 ** M1N3_DECIMALS;

  const stats = [
    {
      label: "Total Minted",
      value: `${formatM1N3(treasury.totalMinted)} m1n3`,
      icon: Coins,
    },
    {
      label: "Equivalent BTC Value",
      value: `${btcEquivalent.toFixed(8)} BTC`,
      icon: ArrowDownUp,
    },
    {
      label: "Recent Distributions",
      value: distributions.length.toLocaleString(),
      icon: Layers,
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
