"use client";

import React from "react";
import { Play, Pause, RotateCcw } from "lucide-react";
import type { IntroScenario } from "@/data/intro-scenarios";
import {
  getScenarioBoundaries,
  getTotalDuration,
} from "@/data/intro-scenarios";

export type PlayState = "idle" | "playing" | "paused" | "completed";

interface IntroTimelineProps {
  scenarios: IntroScenario[];
  currentIndex: number;
  elapsedMs: number;
  playState: PlayState;
  onPlayPause: () => void;
  onRestart: () => void;
  onJumpTo: (index: number) => void;
}

const SEG_BG: Record<string, string> = {
  bullish: "bg-green-500",
  bearish: "bg-red-500",
  recovery: "bg-blue-500",
};

const SEG_DIM: Record<string, string> = {
  bullish: "bg-green-500/20",
  bearish: "bg-red-500/20",
  recovery: "bg-blue-500/20",
};

export function IntroTimeline({
  scenarios,
  elapsedMs,
  playState,
  onPlayPause,
  onRestart,
  onJumpTo,
}: IntroTimelineProps) {
  const boundaries = getScenarioBoundaries(scenarios);
  const totalDur = getTotalDuration(scenarios);

  return (
    <div className="space-y-2">
      {/* Segmented progress bar */}
      <div className="flex gap-0.5 h-3 rounded-full overflow-hidden">
        {scenarios.map((sc, i) => {
          const segStart = boundaries[i];
          const segEnd = boundaries[i + 1];
          const segWidth = ((segEnd - segStart) / totalDur) * 100;

          let fillPct = 0;
          if (elapsedMs >= segEnd) fillPct = 100;
          else if (elapsedMs > segStart)
            fillPct =
              ((elapsedMs - segStart) / (segEnd - segStart)) * 100;

          return (
            <button
              key={sc.id}
              onClick={() => onJumpTo(i)}
              className={`relative h-full cursor-pointer ${SEG_DIM[sc.sentiment]} transition-all hover:opacity-80`}
              style={{ width: `${segWidth}%` }}
              title={sc.title}
            >
              <div
                className={`absolute inset-y-0 left-0 ${SEG_BG[sc.sentiment]} transition-none`}
                style={{ width: `${fillPct}%` }}
              />
            </button>
          );
        })}
      </div>

      {/* Controls */}
      <div className="flex items-center gap-2">
        <button
          onClick={onPlayPause}
          className="rounded-md p-1.5 hover:bg-accent transition-colors"
          aria-label={playState === "playing" ? "Pause" : "Play"}
        >
          {playState === "playing" ? (
            <Pause className="h-4 w-4" />
          ) : (
            <Play className="h-4 w-4" />
          )}
        </button>
        <button
          onClick={onRestart}
          className="rounded-md p-1.5 hover:bg-accent transition-colors"
          aria-label="Restart"
        >
          <RotateCcw className="h-4 w-4" />
        </button>
        <span className="text-xs text-muted-foreground ml-auto font-mono">
          {Math.floor(elapsedMs / 1000)}s / {Math.floor(totalDur / 1000)}s
        </span>
      </div>
    </div>
  );
}
