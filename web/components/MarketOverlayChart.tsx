"use client";

import React, { useRef, useEffect, useCallback, useState } from "react";
import type { MarketHistoryPoint, MarketHistoryRange, DifficultyAdjustment } from "@/lib/types";

interface MarketOverlayChartProps {
  data: MarketHistoryPoint[];
  range: MarketHistoryRange;
  onRangeChange: (range: MarketHistoryRange) => void;
  difficultyAdjustments?: DifficultyAdjustment[];
}

const RANGES: MarketHistoryRange[] = ["7d", "30d", "90d", "1y"];

function formatXLabel(ts: number, range: MarketHistoryRange): string {
  const d = new Date(ts);
  switch (range) {
    case "7d":
      return d.toLocaleDateString("en-US", { weekday: "short", day: "numeric" });
    case "30d":
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    case "90d":
      return d.toLocaleDateString("en-US", { month: "short" });
    case "1y":
      return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  }
}

function formatUsd(v: number): string {
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`;
  return `$${v.toFixed(2)}`;
}

function formatEH(hs: number): string {
  return `${(hs / 1e18).toFixed(1)} EH/s`;
}

export const MarketOverlayChart = React.memo(function MarketOverlayChart({
  data,
  range,
  onRangeChange,
  difficultyAdjustments,
}: MarketOverlayChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const width = container.clientWidth;
    const height = 400;
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

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, width, height);

    if (data.length < 2) {
      ctx.fillStyle = textColor;
      ctx.font = "13px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Loading chart data...", width / 2, height / 2);
      return;
    }

    const margin = { top: 45, right: 80, bottom: 50, left: 80 };
    const chartW = width - margin.left - margin.right;
    const chartH = height - margin.top - margin.bottom;

    // Compute axis ranges
    const timestamps = data.map((d) => d.timestamp);
    const btcPrices = data.map((d) => d.btcPrice);
    const hashprices = data.map((d) => d.hashprice);
    const hashrates = data.map((d) => d.networkHashrate);

    const minTs = Math.min(...timestamps);
    const maxTs = Math.max(...timestamps);
    const minBtc = Math.min(...btcPrices) * 0.98;
    const maxBtc = Math.max(...btcPrices) * 1.02;
    const minHp = Math.min(...hashprices) * 0.95;
    const maxHp = Math.max(...hashprices) * 1.05;
    const minHr = Math.min(...hashrates) * 0.95;
    const maxHr = Math.max(...hashrates) * 1.05;

    // Coordinate transforms
    const xOf = (ts: number) =>
      margin.left + ((ts - minTs) / (maxTs - minTs)) * chartW;
    const yOfBtc = (p: number) =>
      margin.top + chartH - ((p - minBtc) / (maxBtc - minBtc)) * chartH;
    const yOfHp = (p: number) =>
      margin.top + chartH - ((p - minHp) / (maxHp - minHp)) * chartH;
    const yOfHr = (h: number) =>
      margin.top + chartH - ((h - minHr) / (maxHr - minHr)) * chartH;

    // Grid lines
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 5; i++) {
      const y = margin.top + (i / 5) * chartH;
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(width - margin.right, y);
      ctx.stroke();
    }

    // X-axis labels
    const xTickCount = range === "7d" ? 7 : range === "30d" ? 6 : range === "90d" ? 6 : 6;
    ctx.fillStyle = textColor;
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    const seenLabels = new Set<string>();
    for (let i = 0; i <= xTickCount; i++) {
      const ts = minTs + (i / xTickCount) * (maxTs - minTs);
      const x = xOf(ts);
      const label = formatXLabel(ts, range);
      if (seenLabels.has(label)) continue;
      seenLabels.add(label);
      ctx.fillText(label, x, height - margin.bottom + 18);
      ctx.strokeStyle = gridColor;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(x, margin.top);
      ctx.lineTo(x, margin.top + chartH);
      ctx.stroke();
    }

    // Left Y-axis labels (BTC price)
    ctx.textAlign = "right";
    ctx.fillStyle = "#f97316";
    ctx.font = "10px monospace";
    for (let i = 0; i <= 5; i++) {
      const price = minBtc + ((5 - i) / 5) * (maxBtc - minBtc);
      const y = margin.top + (i / 5) * chartH;
      ctx.fillText(formatUsd(price), margin.left - 8, y + 4);
    }

    // Right Y-axis labels (Hashprice)
    ctx.textAlign = "left";
    ctx.fillStyle = "#3b82f6";
    for (let i = 0; i <= 5; i++) {
      const hp = minHp + ((5 - i) / 5) * (maxHp - minHp);
      const y = margin.top + (i / 5) * chartH;
      ctx.fillText(`$${hp.toFixed(1)}`, width - margin.right + 8, y + 4);
    }

    // Axis labels
    ctx.font = "11px sans-serif";
    ctx.fillStyle = "#f97316";
    ctx.textAlign = "center";
    ctx.save();
    ctx.translate(14, margin.top + chartH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("BTC Price (USD)", 0, 0);
    ctx.restore();

    ctx.fillStyle = "#3b82f6";
    ctx.save();
    ctx.translate(width - 14, margin.top + chartH / 2);
    ctx.rotate(Math.PI / 2);
    ctx.fillText("Hashprice ($/PH/day)", 0, 0);
    ctx.restore();

    // Hashrate background area (purple fill)
    ctx.beginPath();
    ctx.moveTo(xOf(data[0].timestamp), margin.top + chartH);
    for (const pt of data) {
      ctx.lineTo(xOf(pt.timestamp), yOfHr(pt.networkHashrate));
    }
    ctx.lineTo(xOf(data[data.length - 1].timestamp), margin.top + chartH);
    ctx.closePath();
    ctx.fillStyle = "rgba(139,92,246,0.15)";
    ctx.fill();

    // Hashrate line (thin purple)
    ctx.strokeStyle = "rgba(139,92,246,0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = xOf(data[i].timestamp);
      const y = yOfHr(data[i].networkHashrate);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Difficulty adjustment markers (vertical dashed lines)
    if (difficultyAdjustments) {
      ctx.strokeStyle = isDark ? "rgba(251,191,36,0.3)" : "rgba(217,119,6,0.3)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      for (const adj of difficultyAdjustments) {
        const adjMs = adj.timestamp * 1000;
        if (adjMs < minTs || adjMs > maxTs) continue;
        const x = xOf(adjMs);
        ctx.beginPath();
        ctx.moveTo(x, margin.top);
        ctx.lineTo(x, margin.top + chartH);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // BTC price line (orange)
    ctx.strokeStyle = "#f97316";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = xOf(data[i].timestamp);
      const y = yOfBtc(data[i].btcPrice);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Hashprice line (blue)
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = xOf(data[i].timestamp);
      const y = yOfHp(data[i].hashprice);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Title
    ctx.fillStyle = textColor;
    ctx.font = "12px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("BTC Price / Hashprice / Network Hashrate", margin.left, 18);

    // Legend
    ctx.font = "10px sans-serif";
    const lx = width - margin.right - 320;

    ctx.strokeStyle = "#f97316";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(lx, 14);
    ctx.lineTo(lx + 20, 14);
    ctx.stroke();
    ctx.fillStyle = textColor;
    ctx.fillText("BTC Price", lx + 24, 18);

    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(lx + 90, 14);
    ctx.lineTo(lx + 110, 14);
    ctx.stroke();
    ctx.fillStyle = textColor;
    ctx.fillText("Hashprice", lx + 114, 18);

    ctx.fillStyle = "rgba(139,92,246,0.4)";
    ctx.fillRect(lx + 185, 8, 20, 12);
    ctx.fillStyle = textColor;
    ctx.fillText("Hashrate", lx + 209, 18);

    if (difficultyAdjustments && difficultyAdjustments.length > 0) {
      ctx.strokeStyle = isDark ? "rgba(251,191,36,0.5)" : "rgba(217,119,6,0.5)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(lx + 270, 14);
      ctx.lineTo(lx + 290, 14);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = textColor;
      ctx.fillText("Diff. Adj.", lx + 294, 18);
    }

    // Crosshair tooltip
    if (mousePos) {
      const mx = mousePos.x;
      if (mx >= margin.left && mx <= width - margin.right) {
        // Find nearest data point
        const targetTs = minTs + ((mx - margin.left) / chartW) * (maxTs - minTs);
        let closest = 0;
        let closestDist = Infinity;
        for (let i = 0; i < data.length; i++) {
          const dist = Math.abs(data[i].timestamp - targetTs);
          if (dist < closestDist) {
            closestDist = dist;
            closest = i;
          }
        }
        const pt = data[closest];
        const cx = xOf(pt.timestamp);

        // Vertical crosshair line
        ctx.strokeStyle = isDark ? "rgba(255,255,255,0.3)" : "rgba(0,0,0,0.2)";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(cx, margin.top);
        ctx.lineTo(cx, margin.top + chartH);
        ctx.stroke();
        ctx.setLineDash([]);

        // Tooltip box
        const tooltipW = 180;
        const tooltipH = 72;
        let tx = cx + 12;
        if (tx + tooltipW > width - margin.right) tx = cx - tooltipW - 12;
        const ty = margin.top + 10;

        ctx.fillStyle = isDark ? "rgba(24,24,27,0.95)" : "rgba(255,255,255,0.95)";
        ctx.strokeStyle = gridColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(tx, ty, tooltipW, tooltipH, 6);
        ctx.fill();
        ctx.stroke();

        ctx.font = "10px monospace";
        ctx.textAlign = "left";
        const dateStr = new Date(pt.timestamp).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });

        ctx.fillStyle = textColor;
        ctx.fillText(dateStr, tx + 8, ty + 14);

        ctx.fillStyle = "#f97316";
        ctx.fillText(`BTC: $${pt.btcPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })}`, tx + 8, ty + 30);

        ctx.fillStyle = "#3b82f6";
        ctx.fillText(`Hashprice: $${pt.hashprice.toFixed(2)}/PH/day`, tx + 8, ty + 46);

        ctx.fillStyle = "rgb(139,92,246)";
        ctx.fillText(`Hashrate: ${formatEH(pt.networkHashrate)}`, tx + 8, ty + 62);
      }
    }
  }, [data, range, difficultyAdjustments, mousePos]);

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

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      setMousePos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    },
    [],
  );

  const handleMouseLeave = useCallback(() => {
    setMousePos(null);
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1">
        {RANGES.map((r) => (
          <button
            key={r}
            onClick={() => onRangeChange(r)}
            className={`px-3 py-1 text-sm rounded-md transition-colors ${
              range === r
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
          >
            {r}
          </button>
        ))}
      </div>
      <div ref={containerRef} className="w-full">
        <canvas
          ref={canvasRef}
          className="w-full rounded-lg border cursor-crosshair"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        />
      </div>
    </div>
  );
});
