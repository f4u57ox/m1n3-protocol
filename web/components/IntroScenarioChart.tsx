"use client";

import React, { useRef, useEffect, useCallback } from "react";
import type { ChartDataPoint, IntroScenario, Sentiment } from "@/data/intro-scenarios";
import {
  getScenarioBoundaries,
  getTotalDuration,
  BASELINE_PPS,
  BASELINE_DIFF,
  BASELINE_BTC,
} from "@/data/intro-scenarios";

interface IntroScenarioChartProps {
  data: ChartDataPoint[];
  currentTime: number;
  scenarios: IntroScenario[];
}

const SENTIMENT_COLORS: Record<
  Sentiment,
  { line: string; fill: string; activeFill: string }
> = {
  bullish: {
    line: "#22c55e",
    fill: "rgba(34,197,94,0.07)",
    activeFill: "rgba(34,197,94,0.14)",
  },
  bearish: {
    line: "#ef4444",
    fill: "rgba(239,68,68,0.07)",
    activeFill: "rgba(239,68,68,0.14)",
  },
  recovery: {
    line: "#3b82f6",
    fill: "rgba(59,130,246,0.07)",
    activeFill: "rgba(59,130,246,0.14)",
  },
};

const DIFF_COLOR = "#f97316"; // orange
const BTC_COLOR = "#a855f7"; // purple

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function pctFromBaseline(val: number, baseline: number): number {
  return ((val - baseline) / baseline) * 100;
}

export const IntroScenarioChart = React.memo(function IntroScenarioChart({
  data,
  currentTime,
  scenarios,
}: IntroScenarioChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const width = container.clientWidth;
    const height = 360;
    const dpr = window.devicePixelRatio || 1;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const isDark = document.documentElement.classList.contains("dark");
    const textColor = isDark ? "#a1a1aa" : "#71717a";
    const gridColor = isDark ? "#27272a" : "#e4e4e7";
    const bgColor = isDark ? "#09090b" : "#ffffff";
    const baselineColor = isDark ? "#52525b" : "#a1a1aa";
    const boundaryColor = isDark ? "#3f3f46" : "#d4d4d8";

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, width, height);

    const margin = { top: 30, right: 90, bottom: 55, left: 55 };
    const chartW = width - margin.left - margin.right;
    const chartH = height - margin.top - margin.bottom;

    const boundaries = getScenarioBoundaries(scenarios);
    const totalDur = getTotalDuration(scenarios);

    // Compute Y range from all 3 series (percentage change from baseline)
    let minPct = 0;
    let maxPct = 0;
    for (const pt of data) {
      const ppsPct = pctFromBaseline(pt.pps, BASELINE_PPS);
      const diffPct = pctFromBaseline(pt.networkDifficulty, BASELINE_DIFF);
      const btcPct = pctFromBaseline(pt.btcPrice, BASELINE_BTC);
      const lo = Math.min(ppsPct, diffPct, btcPct);
      const hi = Math.max(ppsPct, diffPct, btcPct);
      if (lo < minPct) minPct = lo;
      if (hi > maxPct) maxPct = hi;
    }
    const pctRange = maxPct - minPct || 50;
    minPct -= pctRange * 0.12;
    maxPct += pctRange * 0.12;

    const xOf = (t: number) => margin.left + (t / totalDur) * chartW;
    const yOf = (pct: number) =>
      margin.top +
      chartH -
      ((pct - minPct) / (maxPct - minPct || 1)) * chartH;

    // Active scenario index
    let activeIdx = 0;
    for (let i = boundaries.length - 2; i >= 0; i--) {
      if (currentTime >= boundaries[i]) {
        activeIdx = Math.min(i, scenarios.length - 1);
        break;
      }
    }

    // Background fills per scenario
    for (let i = 0; i < scenarios.length; i++) {
      const sc = scenarios[i];
      const colors = SENTIMENT_COLORS[sc.sentiment];
      const x1 = xOf(boundaries[i]);
      const x2 = xOf(boundaries[i + 1]);
      ctx.fillStyle = i === activeIdx ? colors.activeFill : colors.fill;
      ctx.fillRect(x1, margin.top, x2 - x1, chartH);
    }

    // Grid lines
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = margin.top + (i / 4) * chartH;
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(margin.left + chartW, y);
      ctx.stroke();
    }

    // Horizontal baseline at 0%
    const baseY = yOf(0);
    if (baseY >= margin.top && baseY <= margin.top + chartH) {
      ctx.strokeStyle = baselineColor;
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(margin.left, baseY);
      ctx.lineTo(margin.left + chartW, baseY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = baselineColor;
      ctx.font = "9px monospace";
      ctx.textAlign = "left";
      ctx.fillText("0%", margin.left + chartW + 4, baseY + 3);
    }

    // Vertical scenario boundaries
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = boundaryColor;
    ctx.lineWidth = 0.5;
    for (let i = 1; i < boundaries.length - 1; i++) {
      const x = xOf(boundaries[i]);
      ctx.beginPath();
      ctx.moveTo(x, margin.top);
      ctx.lineTo(x, margin.top + chartH);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // X-axis scenario labels
    ctx.fillStyle = textColor;
    ctx.font = "9px sans-serif";
    ctx.textAlign = "center";
    for (let i = 0; i < scenarios.length; i++) {
      const midX = (xOf(boundaries[i]) + xOf(boundaries[i + 1])) / 2;
      const label =
        scenarios[i].title.length > 12
          ? scenarios[i].title.slice(0, 11) + "\u2026"
          : scenarios[i].title;
      ctx.fillText(label, midX, margin.top + chartH + 14);
      ctx.fillText(scenarios[i].icon, midX, margin.top + chartH + 28);
    }

    // --- Draw 3 lines ---

    // Helper: draw a line from data using a value extractor
    const drawLine = (
      color: string | null,
      lineWidth: number,
      dash: number[],
      getValue: (pt: ChartDataPoint) => number,
    ) => {
      if (data.length < 2) return;
      ctx.lineWidth = lineWidth;
      ctx.setLineDash(dash);
      for (let i = 1; i < data.length; i++) {
        const prev = data[i - 1];
        const curr = data[i];
        if (color) {
          ctx.strokeStyle = color;
        } else {
          // Per-sentiment coloring
          const sc =
            scenarios[curr.scenarioIndex] || scenarios[prev.scenarioIndex];
          ctx.strokeStyle = SENTIMENT_COLORS[sc.sentiment].line;
        }
        ctx.beginPath();
        ctx.moveTo(xOf(prev.time), yOf(getValue(prev)));
        ctx.lineTo(xOf(curr.time), yOf(getValue(curr)));
        ctx.stroke();
      }
      ctx.setLineDash([]);
    };

    // Difficulty line (orange, dashed, thinner — behind)
    drawLine(DIFF_COLOR, 1.5, [4, 3], (pt) =>
      pctFromBaseline(pt.networkDifficulty, BASELINE_DIFF),
    );

    // BTC Price line (purple, dashed, thinner — behind)
    drawLine(BTC_COLOR, 1.5, [4, 3], (pt) =>
      pctFromBaseline(pt.btcPrice, BASELINE_BTC),
    );

    // PPS line (sentiment-colored, solid, thicker — on top)
    drawLine(null, 2.5, [], (pt) =>
      pctFromBaseline(pt.pps, BASELINE_PPS),
    );

    // Pulsing dot + live labels at current position
    if (data.length > 0) {
      const lastPt = data[data.length - 1];
      const ppsPct = pctFromBaseline(lastPt.pps, BASELINE_PPS);
      const diffPct = pctFromBaseline(lastPt.networkDifficulty, BASELINE_DIFF);
      const btcPct = pctFromBaseline(lastPt.btcPrice, BASELINE_BTC);
      const labelX = margin.left + chartW + 4;

      // Pulsing dot on PPS line
      const dotX = xOf(lastPt.time);
      const dotY = yOf(ppsPct);
      const pulse = Math.sin(Date.now() * 0.005) * 0.3 + 0.7;
      const sc = scenarios[lastPt.scenarioIndex];
      const dotColor = SENTIMENT_COLORS[sc.sentiment].line;

      ctx.beginPath();
      ctx.arc(dotX, dotY, 8, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(dotColor, pulse * 0.25);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
      ctx.fillStyle = dotColor;
      ctx.fill();

      // Live value labels (right edge)
      ctx.font = "10px monospace";
      ctx.textAlign = "left";

      const fmtPct = (v: number) =>
        `${v >= 0 ? "+" : ""}${v.toFixed(0)}%`;

      // PPS label
      ctx.fillStyle = dotColor;
      ctx.fillText(fmtPct(ppsPct), labelX, yOf(ppsPct) + 3);

      // Difficulty label (offset to avoid overlap)
      ctx.fillStyle = DIFF_COLOR;
      const diffLabelY = yOf(diffPct);
      ctx.fillText(fmtPct(diffPct), labelX, diffLabelY + 3);

      // BTC label
      ctx.fillStyle = BTC_COLOR;
      const btcLabelY = yOf(btcPct);
      ctx.fillText(fmtPct(btcPct), labelX, btcLabelY + 3);
    }

    // Y-axis labels (percentage)
    ctx.fillStyle = textColor;
    ctx.font = "10px monospace";
    ctx.textAlign = "right";
    for (let i = 0; i <= 4; i++) {
      const val = maxPct - (i / 4) * (maxPct - minPct);
      const sign = val >= 0 ? "+" : "";
      ctx.fillText(
        `${sign}${val.toFixed(0)}%`,
        margin.left - 6,
        margin.top + (i / 4) * chartH + 4,
      );
    }

    // Title
    ctx.fillStyle = textColor;
    ctx.font = "12px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("Change from Baseline (%)", margin.left, 18);

    // Legend (top right)
    const lgX = margin.left + chartW - 210;
    const lgY = margin.top + 14;
    ctx.font = "10px sans-serif";

    // PPS dot
    ctx.fillStyle = "#22c55e";
    ctx.beginPath();
    ctx.arc(lgX, lgY, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = textColor;
    ctx.textAlign = "left";
    ctx.fillText("PPS Value", lgX + 7, lgY + 3);

    // Difficulty dot
    ctx.fillStyle = DIFF_COLOR;
    ctx.beginPath();
    ctx.arc(lgX + 75, lgY, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = textColor;
    ctx.fillText("Difficulty", lgX + 82, lgY + 3);

    // BTC Price dot
    ctx.fillStyle = BTC_COLOR;
    ctx.beginPath();
    ctx.arc(lgX + 150, lgY, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = textColor;
    ctx.fillText("BTC Price", lgX + 157, lgY + 3);
  }, [data, currentTime, scenarios]);

  useEffect(() => {
    draw();
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(draw);
    });
    if (containerRef.current) observer.observe(containerRef.current);
    return () => {
      cancelAnimationFrame(rafRef.current);
      observer.disconnect();
    };
  }, [draw]);

  return (
    <div ref={containerRef} className="w-full">
      <canvas ref={canvasRef} className="w-full rounded-lg border" />
    </div>
  );
});
