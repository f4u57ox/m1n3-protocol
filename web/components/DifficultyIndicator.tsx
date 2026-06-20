"use client";

import React, { useRef, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DifficultyAdjustment } from "@/lib/types";

interface NextAdjustment {
  progressPercent: number;
  difficultyChange: number;
  estimatedRetargetDate: number;
  remainingBlocks: number;
  remainingTime: number;
  nextRetargetHeight: number;
}

interface DifficultyIndicatorProps {
  nextAdjustment: NextAdjustment | null;
  difficultyAdjustments: DifficultyAdjustment[];
}

function formatTimeRemaining(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  if (days > 0) return `${days}d ${remainingHours}h`;
  return `${hours}h`;
}

function Sparkline({ adjustments }: { adjustments: DifficultyAdjustment[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const last10 = adjustments.slice(-10);
    if (last10.length === 0) return;

    const width = 120;
    const height = 30;
    const dpr = window.devicePixelRatio || 1;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const maxAbs = Math.max(
      ...last10.map((a) => Math.abs(a.difficultyChange)),
      1,
    );
    const barW = (width - (last10.length - 1) * 2) / last10.length;
    const midY = height / 2;

    last10.forEach((adj, i) => {
      const x = i * (barW + 2);
      const barH = (Math.abs(adj.difficultyChange) / maxAbs) * (height / 2 - 2);
      const isPositive = adj.difficultyChange >= 0;

      ctx.fillStyle = isPositive
        ? "rgba(239,68,68,0.7)"
        : "rgba(34,197,94,0.7)";

      if (isPositive) {
        ctx.fillRect(x, midY - barH, barW, barH);
      } else {
        ctx.fillRect(x, midY, barW, barH);
      }
    });

    // Center line
    const isDark = document.documentElement.classList.contains("dark");
    ctx.strokeStyle = isDark ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.15)";
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(width, midY);
    ctx.stroke();
  }, [adjustments]);

  useEffect(() => {
    draw();
  }, [draw]);

  return (
    <div ref={containerRef}>
      <canvas ref={canvasRef} />
    </div>
  );
}

export function DifficultyIndicator({
  nextAdjustment,
  difficultyAdjustments,
}: DifficultyIndicatorProps) {
  if (!nextAdjustment) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Next Difficulty Adjustment</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading...</p>
        </CardContent>
      </Card>
    );
  }

  const estDate = new Date(nextAdjustment.estimatedRetargetDate);
  const changeIsPositive = nextAdjustment.difficultyChange >= 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Next Difficulty Adjustment</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-muted-foreground">Blocks Remaining</p>
            <p className="text-xl font-bold font-mono">
              {nextAdjustment.remainingBlocks.toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Estimated Date</p>
            <p className="text-sm font-medium">
              {estDate.toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              })}
            </p>
            <p className="text-xs text-muted-foreground">
              ~{formatTimeRemaining(nextAdjustment.remainingTime)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Est. Change</p>
            <p
              className={`text-xl font-bold ${
                changeIsPositive ? "text-red-500" : "text-green-500"
              }`}
            >
              {changeIsPositive ? "+" : ""}
              {nextAdjustment.difficultyChange.toFixed(2)}%
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Retarget Height</p>
            <p className="text-sm font-mono">
              {nextAdjustment.nextRetargetHeight.toLocaleString()}
            </p>
          </div>
        </div>

        {/* Progress bar */}
        <div>
          <div className="flex justify-between text-xs text-muted-foreground mb-1">
            <span>Epoch Progress</span>
            <span>{nextAdjustment.progressPercent.toFixed(1)}%</span>
          </div>
          <div className="w-full bg-muted rounded-full h-2">
            <div
              className="bg-primary rounded-full h-2 transition-all"
              style={{ width: `${nextAdjustment.progressPercent}%` }}
            />
          </div>
        </div>

        {/* Sparkline of last 10 adjustments */}
        {difficultyAdjustments.length > 0 && (
          <div>
            <p className="text-xs text-muted-foreground mb-1">
              Recent Adjustments
            </p>
            <Sparkline adjustments={difficultyAdjustments} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
