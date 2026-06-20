"use client";

import React, { useRef, useEffect, useCallback } from "react";
import type { ComparisonPoint } from "@/lib/types";

interface ComparisonChartProps {
  data: ComparisonPoint[];
  initialInvestment: number;
}

export const ComparisonChart = React.memo(function ComparisonChart({
  data,
  initialInvestment,
}: ComparisonChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const width = container.clientWidth;
    const height = 240;
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
    const orangeColor = "#f97316";
    const greenColor = "#22c55e";
    const baselineColor = isDark ? "#52525b" : "#a1a1aa";

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, width, height);

    const margin = { top: 35, right: 90, bottom: 40, left: 60 };
    const chartW = width - margin.left - margin.right;
    const chartH = height - margin.top - margin.bottom;

    if (data.length < 2) {
      ctx.fillStyle = textColor;
      ctx.font = "13px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(
        "Accumulating comparison data\u2026",
        width / 2,
        height / 2,
      );
      return;
    }

    // Ranges
    const minTime = data[0].elapsedSec;
    const maxTime = data[data.length - 1].elapsedSec;
    const timeSpan = maxTime - minTime || 1;

    let minVal = initialInvestment;
    let maxVal = initialInvestment;
    for (const pt of data) {
      if (pt.btcValue < minVal) minVal = pt.btcValue;
      if (pt.btcValue > maxVal) maxVal = pt.btcValue;
      if (pt.miningShareValue < minVal) minVal = pt.miningShareValue;
      if (pt.miningShareValue > maxVal) maxVal = pt.miningShareValue;
    }
    const valPad = (maxVal - minVal) * 0.15 || 10;
    minVal -= valPad;
    maxVal += valPad;

    const xOf = (sec: number) =>
      margin.left + ((sec - minTime) / timeSpan) * chartW;
    const yOf = (val: number) =>
      margin.top + chartH - ((val - minVal) / (maxVal - minVal)) * chartH;

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

    // Dashed baseline at initial investment
    ctx.strokeStyle = baselineColor;
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    const baseY = yOf(initialInvestment);
    ctx.beginPath();
    ctx.moveTo(margin.left, baseY);
    ctx.lineTo(margin.left + chartW, baseY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Baseline label
    ctx.fillStyle = baselineColor;
    ctx.font = "10px monospace";
    ctx.textAlign = "left";
    ctx.fillText(
      `$${initialInvestment.toLocaleString()}`,
      margin.left + chartW + 6,
      baseY + 3,
    );

    // Draw line helper
    const drawLine = (
      color: string,
      getValue: (pt: ComparisonPoint) => number,
    ) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < data.length; i++) {
        const x = xOf(data[i].elapsedSec);
        const y = yOf(getValue(data[i]));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };

    // BTC line (orange)
    drawLine(orangeColor, (pt) => pt.btcValue);

    // Mining shares line (green)
    drawLine(greenColor, (pt) => pt.miningShareValue);

    // Live value labels at right edge
    const lastPt = data[data.length - 1];
    const labelX = margin.left + chartW + 6;

    ctx.font = "11px monospace";
    ctx.textAlign = "left";

    // BTC label
    const btcY = yOf(lastPt.btcValue);
    ctx.fillStyle = orangeColor;
    ctx.fillText(`$${lastPt.btcValue.toFixed(0)}`, labelX, btcY + 4);

    // Mining shares label
    const miningY = yOf(lastPt.miningShareValue);
    ctx.fillStyle = greenColor;
    ctx.fillText(
      `$${lastPt.miningShareValue.toFixed(0)}`,
      labelX,
      miningY + 4,
    );

    // X-axis labels (elapsed time)
    ctx.fillStyle = textColor;
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    const numXTicks = 5;
    for (let i = 0; i <= numXTicks; i++) {
      const sec = minTime + (i / numXTicks) * timeSpan;
      const minutes = Math.floor(sec / 60);
      const secs = Math.floor(sec % 60);
      const label = minutes > 0 ? `${minutes}m${secs.toString().padStart(2, "0")}s` : `${secs}s`;
      ctx.fillText(label, xOf(sec), height - margin.bottom + 28);
    }

    // Y-axis labels
    ctx.textAlign = "right";
    for (let i = 0; i <= 4; i++) {
      const val = maxVal - (i / 4) * (maxVal - minVal);
      ctx.fillText(
        `$${val.toFixed(0)}`,
        margin.left - 8,
        margin.top + (i / 4) * chartH + 4,
      );
    }

    // Axis labels
    ctx.fillStyle = textColor;
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Elapsed Time", margin.left + chartW / 2, height - 2);
    ctx.save();
    ctx.translate(14, margin.top + chartH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("Portfolio Value (USD)", 0, 0);
    ctx.restore();

    // Title
    ctx.fillStyle = textColor;
    ctx.font = "12px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(
      "$1,000 BTC Spot vs Mining Shares",
      margin.left,
      18,
    );

    // Legend
    const legendX = margin.left + chartW - 160;
    const legendY = margin.top + 12;

    // Orange dot + BTC label
    ctx.fillStyle = orangeColor;
    ctx.beginPath();
    ctx.arc(legendX, legendY, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = textColor;
    ctx.font = "10px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("BTC Spot", legendX + 8, legendY + 3);

    // Green dot + Mining Shares label
    ctx.fillStyle = greenColor;
    ctx.beginPath();
    ctx.arc(legendX + 80, legendY, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = textColor;
    ctx.fillText("Mining Shares", legendX + 88, legendY + 3);
  }, [data, initialInvestment]);

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
