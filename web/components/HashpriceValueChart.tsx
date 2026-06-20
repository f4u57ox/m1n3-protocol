"use client";

import React, { useRef, useEffect, useCallback, useState } from "react";
import type { PricedShare } from "@/lib/types";
import { computeTheoreticalValue, BTC_BLOCK_SUBSIDY } from "@/lib/hashprice-utils";

interface HashpriceValueChartProps {
  listings: PricedShare[];
  networkDifficulty: number;
  btcPrice: number;
  onHashpriceChange?: (value: number) => void;
}

export const HashpriceValueChart = React.memo(function HashpriceValueChart({
  listings,
  networkDifficulty,
  btcPrice,
  onHashpriceChange,
}: HashpriceValueChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const [localBtcPrice, setLocalBtcPrice] = useState(btcPrice);

  useEffect(() => {
    setLocalBtcPrice(btcPrice);
  }, [btcPrice]);

  const blockRewardUsd = BTC_BLOCK_SUBSIDY * localBtcPrice;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const width = container.clientWidth;
    const height = 320;
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
    const lineColor = "#3b82f6";

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, width, height);

    const margin = { top: 35, right: 30, bottom: 40, left: 70 };
    const chartW = width - margin.left - margin.right;
    const chartH = height - margin.top - margin.bottom;

    // Determine axis ranges from listings
    const difficulties = listings.map((l) => l.difficultyAchieved);
    const minDiff = difficulties.length > 0 ? Math.min(...difficulties) : 1_000;
    const maxDiff = difficulties.length > 0 ? Math.max(...difficulties) : 10_000_000;
    const logMin = Math.log10(Math.max(1, minDiff * 0.5));
    const logMax = Math.log10(maxDiff * 2);

    const prices = listings.map((l) => l.marketPriceUsd);
    const theoMax = computeTheoreticalValue(maxDiff * 2, networkDifficulty, blockRewardUsd);
    const maxPrice = Math.max(
      theoMax,
      prices.length > 0 ? Math.max(...prices) * 1.1 : 0.001,
    );

    // Coordinate transforms
    const xOfDiff = (d: number) => {
      const logD = Math.log10(Math.max(1, d));
      return margin.left + ((logD - logMin) / (logMax - logMin)) * chartW;
    };
    const yOfPrice = (p: number) =>
      margin.top + chartH - (p / maxPrice) * chartH;

    // Grid
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 5; i++) {
      const y = margin.top + (i / 5) * chartH;
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(width - margin.right, y);
      ctx.stroke();
    }

    // X grid (log scale ticks)
    const logTicks = [1_000, 5_000, 10_000, 50_000, 100_000, 500_000, 1_000_000, 5_000_000, 10_000_000];
    ctx.fillStyle = textColor;
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    for (const tick of logTicks) {
      if (tick < minDiff * 0.5 || tick > maxDiff * 2) continue;
      const x = xOfDiff(tick);
      ctx.strokeStyle = gridColor;
      ctx.beginPath();
      ctx.moveTo(x, margin.top);
      ctx.lineTo(x, margin.top + chartH);
      ctx.stroke();
      const label = tick >= 1_000_000 ? `${tick / 1_000_000}M` : tick >= 1_000 ? `${tick / 1_000}K` : `${tick}`;
      ctx.fillStyle = textColor;
      ctx.fillText(label, x, height - margin.bottom + 16);
    }

    // Y axis labels — format small USD values
    ctx.textAlign = "right";
    for (let i = 0; i <= 5; i++) {
      const price = ((5 - i) / 5) * maxPrice;
      const y = margin.top + (i / 5) * chartH;
      const label = price < 0.01 ? `$${price.toFixed(6)}` : `$${price.toFixed(4)}`;
      ctx.fillStyle = textColor;
      ctx.fillText(label, margin.left - 8, y + 4);
    }

    // Axis labels
    ctx.fillStyle = textColor;
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Difficulty (log scale)", margin.left + chartW / 2, height - 4);
    ctx.save();
    ctx.translate(14, margin.top + chartH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("PPS Value (USD)", 0, 0);
    ctx.restore();

    // Theoretical value curve (blue line) — PPS formula
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    const CURVE_STEPS = 100;
    for (let i = 0; i <= CURVE_STEPS; i++) {
      const logD = logMin + (i / CURVE_STEPS) * (logMax - logMin);
      const d = Math.pow(10, logD);
      const theoUsd = computeTheoreticalValue(d, networkDifficulty, blockRewardUsd);
      const x = xOfDiff(d);
      const y = yOfPrice(theoUsd);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw dots for listings (color by blocks-to-mature)
    for (const listing of listings) {
      const x = xOfDiff(listing.difficultyAchieved);
      const y = yOfPrice(listing.marketPriceUsd);
      const maturityRatio = 1 - listing.blocksUntilMature / 100;
      const alpha = 0.3 + maturityRatio * 0.7;

      ctx.globalAlpha = alpha;
      ctx.fillStyle = listing.discountPct > 15 ? "#ef4444" : "#22c55e";
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Title
    ctx.fillStyle = textColor;
    ctx.font = "12px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("Market Price vs PPS Value by Difficulty", margin.left, 18);

    // Legend
    ctx.font = "10px sans-serif";
    const lx = width - margin.right - 250;
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(lx, 14);
    ctx.lineTo(lx + 20, 14);
    ctx.stroke();
    ctx.fillStyle = textColor;
    ctx.fillText("PPS Value", lx + 24, 18);

    ctx.globalAlpha = 0.8;
    ctx.fillStyle = "#22c55e";
    ctx.beginPath();
    ctx.arc(lx + 100, 14, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = textColor;
    ctx.globalAlpha = 1;
    ctx.fillText("< 15% disc.", lx + 108, 18);

    ctx.globalAlpha = 0.8;
    ctx.fillStyle = "#ef4444";
    ctx.beginPath();
    ctx.arc(lx + 185, 14, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = textColor;
    ctx.globalAlpha = 1;
    ctx.fillText("> 15% disc.", lx + 193, 18);
  }, [listings, networkDifficulty, blockRewardUsd]);

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
    <div className="space-y-2">
      <div className="flex items-center gap-4 text-sm">
        <label className="text-muted-foreground whitespace-nowrap">
          BTC Price: ${localBtcPrice.toLocaleString()}
        </label>
        <input
          type="range"
          min={20_000}
          max={200_000}
          step={1_000}
          value={localBtcPrice}
          onChange={(e) => {
            const v = Number(e.target.value);
            setLocalBtcPrice(v);
            onHashpriceChange?.(v);
          }}
          className="flex-1 accent-blue-500"
        />
      </div>
      <div ref={containerRef} className="w-full">
        <canvas ref={canvasRef} className="w-full rounded-lg border" />
      </div>
    </div>
  );
});
