"use client";

import React from "react";
import { Card, CardContent } from "@/components/ui/card";
import type { IntroScenario, ScenarioState } from "@/data/intro-scenarios";
import { BASELINE_DIFF, BASELINE_BTC, BASELINE_PPS } from "@/data/intro-scenarios";

interface IntroScenarioCardProps {
  scenario: IntroScenario;
  progress: number;
  currentPps: number;
  currentState: ScenarioState;
  startPps: number;
}

const BORDER: Record<string, string> = {
  bullish: "border-l-green-500",
  bearish: "border-l-red-500",
  recovery: "border-l-blue-500",
};

const BADGE: Record<string, string> = {
  bullish: "bg-green-500/10 text-green-500",
  bearish: "bg-red-500/10 text-red-500",
  recovery: "bg-blue-500/10 text-blue-500",
};

function fmtPct(val: number, baseline: number): string {
  const pct = ((val - baseline) / baseline) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function fmtDiff(val: number): string {
  return `${(val / 1e12).toFixed(1)}T`;
}

function fmtPrice(val: number): string {
  return `$${(val / 1000).toFixed(0)}K`;
}

function pctColor(val: number, baseline: number, invert = false): string {
  const pct = ((val - baseline) / baseline) * 100;
  const positive = invert ? pct < 0 : pct > 0;
  if (Math.abs(pct) < 0.5) return "text-muted-foreground";
  return positive ? "text-green-500" : "text-red-500";
}

export function IntroScenarioCard({
  scenario,
  currentPps,
  currentState,
}: IntroScenarioCardProps) {
  return (
    <Card
      className={`border-l-4 ${BORDER[scenario.sentiment]} transition-opacity duration-300`}
    >
      <CardContent className="pt-4 space-y-3">
        <div className="flex items-start gap-3">
          <span className="text-2xl">{scenario.icon}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-lg font-semibold">{scenario.title}</h3>
              <span
                className={`text-xs px-2 py-0.5 rounded-full ${BADGE[scenario.sentiment]}`}
              >
                {scenario.sentiment}
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              {scenario.subtitle}
            </p>
          </div>
        </div>

        <p className="text-sm leading-relaxed">{scenario.description}</p>

        {/* Metrics grid — target changes for this scenario */}
        <div className="grid grid-cols-3 gap-3 pt-1">
          <div className="text-center">
            <div className="text-xs text-muted-foreground">Difficulty</div>
            <div
              className={`text-sm font-mono font-medium ${
                scenario.metrics.diffChange.startsWith("-")
                  ? "text-green-500"
                  : scenario.metrics.diffChange === "0%"
                    ? "text-muted-foreground"
                    : "text-red-500"
              }`}
            >
              {scenario.metrics.diffChange}
            </div>
          </div>
          <div className="text-center">
            <div className="text-xs text-muted-foreground">BTC Price</div>
            <div
              className={`text-sm font-mono font-medium ${
                scenario.metrics.btcChange.startsWith("+")
                  ? "text-green-500"
                  : scenario.metrics.btcChange === "0%"
                    ? "text-muted-foreground"
                    : "text-red-500"
              }`}
            >
              {scenario.metrics.btcChange}
            </div>
          </div>
          <div className="text-center">
            <div className="text-xs text-muted-foreground">PPS Value</div>
            <div
              className={`text-sm font-mono font-medium ${
                scenario.metrics.ppsChange.startsWith("+")
                  ? "text-green-500"
                  : "text-red-500"
              }`}
            >
              {scenario.metrics.ppsChange}
            </div>
          </div>
        </div>

        {/* Live values from baseline */}
        <div className="grid grid-cols-3 gap-3 pt-2 border-t">
          <div className="text-center">
            <div className="text-xs text-muted-foreground">Difficulty</div>
            <div className="text-sm font-mono font-medium">
              {fmtDiff(currentState.networkDifficulty)}
            </div>
            <div
              className={`text-xs font-mono ${pctColor(currentState.networkDifficulty, BASELINE_DIFF, true)}`}
            >
              {fmtPct(currentState.networkDifficulty, BASELINE_DIFF)}
            </div>
          </div>
          <div className="text-center">
            <div className="text-xs text-muted-foreground">BTC Price</div>
            <div className="text-sm font-mono font-medium">
              {fmtPrice(currentState.btcPrice)}
            </div>
            <div
              className={`text-xs font-mono ${pctColor(currentState.btcPrice, BASELINE_BTC)}`}
            >
              {fmtPct(currentState.btcPrice, BASELINE_BTC)}
            </div>
          </div>
          <div className="text-center">
            <div className="text-xs text-muted-foreground">PPS Value</div>
            <div className="text-sm font-mono font-medium">
              ${currentPps.toFixed(2)}
            </div>
            <div
              className={`text-xs font-mono ${pctColor(currentPps, BASELINE_PPS)}`}
            >
              {fmtPct(currentPps, BASELINE_PPS)}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
