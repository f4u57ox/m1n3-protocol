"use client";

import React, { useState, useRef, useCallback, useEffect } from "react";
import { useAnimationFrame } from "@/hooks/useAnimationFrame";
import { IntroScenarioChart } from "@/components/IntroScenarioChart";
import { IntroScenarioCard } from "@/components/IntroScenarioCard";
import { IntroTimeline, type PlayState } from "@/components/IntroTimeline";
import {
  INTRO_SCENARIOS,
  BASELINE_PPS,
  SCENARIO_START_PPS,
  interpolateScenario,
  computeScenarioPpsValue,
  getScenarioBoundaries,
  getTotalDuration,
  computeChartDataUpTo,
  type ChartDataPoint,
  type ScenarioState,
} from "@/data/intro-scenarios";

interface UiState {
  playState: PlayState;
  scenarioIndex: number;
  currentPps: number;
  currentState: ScenarioState;
  scenarioStartPps: number;
  localProgress: number;
  chartData: ChartDataPoint[];
  elapsedMs: number;
}

const INITIAL_STATE: ScenarioState = {
  networkDifficulty: 100e12,
  btcPrice: 90_000,
  blockSubsidy: 3.125,
};

const boundaries = getScenarioBoundaries(INTRO_SCENARIOS);
const totalDur = getTotalDuration(INTRO_SCENARIOS);

export function IntroPlayer() {
  const [ui, setUi] = useState<UiState>({
    playState: "idle",
    scenarioIndex: 0,
    currentPps: BASELINE_PPS,
    currentState: INITIAL_STATE,
    scenarioStartPps: SCENARIO_START_PPS[0],
    localProgress: 0,
    chartData: [],
    elapsedMs: 0,
  });

  // Refs for fast-changing data (mutated every frame)
  const playStateRef = useRef<PlayState>("idle");
  const elapsedRef = useRef(0);
  const chartDataRef = useRef<ChartDataPoint[]>([]);
  const lastDataPointRef = useRef(0);
  const lastUiUpdateRef = useRef(0);
  const currentPpsRef = useRef(BASELINE_PPS);
  const scenarioIndexRef = useRef(0);

  // Auto-start on mount
  useEffect(() => {
    playStateRef.current = "playing";
    setUi((prev) => ({ ...prev, playState: "playing" }));
  }, []);

  // Main tick loop via shared RAF coordinator
  useAnimationFrame(
    useCallback((_now: number, dt: number) => {
      if (playStateRef.current !== "playing") return;

      // Cap dt to prevent jumps when tab is backgrounded
      const cappedDt = Math.min(dt, 0.1);
      elapsedRef.current += cappedDt * 1000;

      // Completed?
      if (elapsedRef.current >= totalDur) {
        elapsedRef.current = totalDur;
        playStateRef.current = "completed";

        const lastSc = INTRO_SCENARIOS[INTRO_SCENARIOS.length - 1];
        const finalState = interpolateScenario(lastSc, 1);
        const finalPps = computeScenarioPpsValue(finalState);
        chartDataRef.current = [
          ...chartDataRef.current,
          {
            time: totalDur,
            pps: finalPps,
            networkDifficulty: finalState.networkDifficulty,
            btcPrice: finalState.btcPrice,
            scenarioIndex: INTRO_SCENARIOS.length - 1,
          },
        ];

        setUi({
          playState: "completed",
          scenarioIndex: INTRO_SCENARIOS.length - 1,
          currentPps: finalPps,
          currentState: finalState,
          scenarioStartPps: SCENARIO_START_PPS[INTRO_SCENARIOS.length - 1],
          localProgress: 1,
          chartData: chartDataRef.current,
          elapsedMs: totalDur,
        });
        return;
      }

      // Determine current scenario
      let scIdx = 0;
      for (let i = boundaries.length - 2; i >= 0; i--) {
        if (elapsedRef.current >= boundaries[i]) {
          scIdx = Math.min(i, INTRO_SCENARIOS.length - 1);
          break;
        }
      }
      scenarioIndexRef.current = scIdx;

      const localProgress =
        (elapsedRef.current - boundaries[scIdx]) /
        INTRO_SCENARIOS[scIdx].durationMs;
      const state = interpolateScenario(
        INTRO_SCENARIOS[scIdx],
        localProgress,
      );
      const pps = computeScenarioPpsValue(state);
      currentPpsRef.current = pps;

      // Accumulate data point (~3/sec = every 333ms)
      if (elapsedRef.current - lastDataPointRef.current >= 333) {
        lastDataPointRef.current = elapsedRef.current;
        chartDataRef.current = [
          ...chartDataRef.current,
          {
            time: elapsedRef.current,
            pps,
            networkDifficulty: state.networkDifficulty,
            btcPrice: state.btcPrice,
            scenarioIndex: scIdx,
          },
        ];
      }

      // Throttle React state updates (~10/sec)
      const now = performance.now();
      if (now - lastUiUpdateRef.current >= 100) {
        lastUiUpdateRef.current = now;
        setUi({
          playState: "playing",
          scenarioIndex: scIdx,
          currentPps: pps,
          currentState: state,
          scenarioStartPps: SCENARIO_START_PPS[scIdx],
          localProgress,
          chartData: chartDataRef.current,
          elapsedMs: elapsedRef.current,
        });
      }
    }, []),
  );

  const handlePlayPause = useCallback(() => {
    if (playStateRef.current === "playing") {
      playStateRef.current = "paused";
      setUi((prev) => ({ ...prev, playState: "paused" }));
    } else if (
      playStateRef.current === "paused" ||
      playStateRef.current === "completed"
    ) {
      if (playStateRef.current === "completed") {
        // Restart from beginning
        elapsedRef.current = 0;
        chartDataRef.current = [];
        lastDataPointRef.current = 0;
        scenarioIndexRef.current = 0;
        currentPpsRef.current = BASELINE_PPS;
      }
      playStateRef.current = "playing";
      setUi((prev) => ({
        ...prev,
        playState: "playing",
        ...(prev.playState === "completed"
          ? {
              scenarioIndex: 0,
              elapsedMs: 0,
              chartData: [],
              currentPps: BASELINE_PPS,
              currentState: INITIAL_STATE,
              scenarioStartPps: SCENARIO_START_PPS[0],
              localProgress: 0,
            }
          : {}),
      }));
    } else {
      // idle
      playStateRef.current = "playing";
      setUi((prev) => ({ ...prev, playState: "playing" }));
    }
  }, []);

  const handleRestart = useCallback(() => {
    elapsedRef.current = 0;
    chartDataRef.current = [];
    lastDataPointRef.current = 0;
    lastUiUpdateRef.current = 0;
    scenarioIndexRef.current = 0;
    currentPpsRef.current = BASELINE_PPS;
    playStateRef.current = "playing";

    setUi({
      playState: "playing",
      scenarioIndex: 0,
      currentPps: BASELINE_PPS,
      currentState: INITIAL_STATE,
      scenarioStartPps: SCENARIO_START_PPS[0],
      localProgress: 0,
      chartData: [],
      elapsedMs: 0,
    });
  }, []);

  const handleJumpTo = useCallback((index: number) => {
    const targetMs = boundaries[index];
    elapsedRef.current = targetMs;
    chartDataRef.current = computeChartDataUpTo(targetMs);
    lastDataPointRef.current = targetMs;
    scenarioIndexRef.current = index;

    const sc = INTRO_SCENARIOS[index];
    const state = interpolateScenario(sc, 0);
    const pps = computeScenarioPpsValue(state);
    currentPpsRef.current = pps;

    const wasCompleted = playStateRef.current === "completed";
    if (wasCompleted) {
      playStateRef.current = "playing";
    }

    setUi({
      playState:
        playStateRef.current === "paused" ? "paused" : "playing",
      scenarioIndex: index,
      currentPps: pps,
      currentState: state,
      scenarioStartPps: SCENARIO_START_PPS[index],
      localProgress: 0,
      chartData: chartDataRef.current,
      elapsedMs: targetMs,
    });
  }, []);

  return (
    <div className="space-y-6">
      <IntroScenarioChart
        data={ui.chartData}
        currentTime={ui.elapsedMs}
        scenarios={INTRO_SCENARIOS}
      />

      <IntroScenarioCard
        scenario={INTRO_SCENARIOS[ui.scenarioIndex]}
        progress={ui.localProgress}
        currentPps={ui.currentPps}
        currentState={ui.currentState}
        startPps={ui.scenarioStartPps}
      />

      <IntroTimeline
        scenarios={INTRO_SCENARIOS}
        currentIndex={ui.scenarioIndex}
        elapsedMs={ui.elapsedMs}
        playState={ui.playState}
        onPlayPause={handlePlayPause}
        onRestart={handleRestart}
        onJumpTo={handleJumpTo}
      />
    </div>
  );
}
