"use client";

import { Suspense } from "react";
import { HedgeDashboard } from "@/components/hedge/HedgeDashboard";

function HedgePageContent() {
  return (
    <>
      <title>m1n3 — Hedge</title>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Hedge</h1>
          <p className="text-muted-foreground">
            Offset BTC downside on your mining revenue with DeepBook Predict.
            Picks a put-strip from the live vol surface and runs a Monte-Carlo
            against your expected payoff distribution.
          </p>
        </div>
        <HedgeDashboard />
      </div>
    </>
  );
}

export default function HedgePage() {
  return (
    <Suspense>
      <HedgePageContent />
    </Suspense>
  );
}
