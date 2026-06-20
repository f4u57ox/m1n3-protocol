"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MiningRevenueCalculator } from "@/components/MiningRevenueCalculator";
import { DifficultyImpactSimulator } from "@/components/DifficultyImpactSimulator";
import { useHashprice } from "@/hooks/useHashprice";
import { useMarketHistory } from "@/hooks/useMarketHistory";
import { BTC_BLOCK_SUBSIDY } from "@/lib/hashprice-utils";
import { generateMockListings, generateDiscountCurve } from "@/data/mock-market";

const HashpriceValueChart = dynamic(
  () =>
    import("@/components/HashpriceValueChart").then((m) => ({
      default: m.HashpriceValueChart,
    })),
  {
    ssr: false,
    loading: () => <div className="h-64 animate-pulse bg-muted rounded-lg" />,
  },
);

const DiscountCurveChart = dynamic(
  () =>
    import("@/components/DiscountCurveChart").then((m) => ({
      default: m.DiscountCurveChart,
    })),
  {
    ssr: false,
    loading: () => <div className="h-64 animate-pulse bg-muted rounded-lg" />,
  },
);

const MarketSimulator = dynamic(
  () =>
    import("@/components/MarketSimulator").then((m) => ({
      default: m.MarketSimulator,
    })),
  {
    ssr: false,
    loading: () => <div className="h-64 animate-pulse bg-muted rounded-lg" />,
  },
);

const DEFAULT_CHAIN_HEIGHT = 890_000;
const DEFAULT_NET_DIFF = 100e12;

export default function ToolsPage() {
  const { hashprice, btcPrice, networkDifficulty } = useHashprice();
  const { nextAdjustment } = useMarketHistory("30d");

  const effectiveBtcPrice = btcPrice ?? 90_000;
  const effectiveNetDiff = networkDifficulty ?? DEFAULT_NET_DIFF;
  const effectiveHashprice = hashprice ?? 50;
  const blockRewardUsd = BTC_BLOCK_SUBSIDY * effectiveBtcPrice;

  const mockListings = useMemo(
    () =>
      generateMockListings(
        {
          networkDifficulty: effectiveNetDiff,
          blockRewardUsd,
          averageDiscount: 10,
          spreadBps: 150,
          tradeFrequencyPerMin: 4,
        },
        DEFAULT_CHAIN_HEIGHT,
      ),
    [effectiveNetDiff, blockRewardUsd],
  );

  const discountCurve = useMemo(
    () => generateDiscountCurve(effectiveNetDiff, blockRewardUsd, 15),
    [effectiveNetDiff, blockRewardUsd],
  );

  return (
    <>
      <title>m1n3 — Tools</title>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Tools</h1>
          <p className="text-muted-foreground">
            Mining calculators, simulators, and valuation charts
          </p>
        </div>

        {/* Revenue Calculator & Difficulty Impact */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <MiningRevenueCalculator
            networkDifficulty={effectiveNetDiff}
            btcPrice={effectiveBtcPrice}
            currentHashprice={effectiveHashprice}
          />
          <DifficultyImpactSimulator
            networkDifficulty={effectiveNetDiff}
            btcPrice={effectiveBtcPrice}
            nextAdjustment={nextAdjustment}
          />
        </div>

        {/* PPS Value & Share Valuation */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>PPS Value & Share Valuation</CardTitle>
              <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/10 text-yellow-600 border border-yellow-500/20">
                Simulated Data
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Charts use modeled data to demonstrate the valuation framework
            </p>
          </CardHeader>
          <CardContent className="space-y-6">
            <HashpriceValueChart
              listings={mockListings}
              networkDifficulty={effectiveNetDiff}
              btcPrice={effectiveBtcPrice}
            />
            <DiscountCurveChart curve={discountCurve} listings={mockListings} />
          </CardContent>
        </Card>

        {/* Market Simulation */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Market Simulation</CardTitle>
              <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/10 text-yellow-600 border border-yellow-500/20">
                Simulated Data
              </span>
            </div>
          </CardHeader>
          <CardContent>
            <MarketSimulator />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
