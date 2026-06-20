"use client";

import React, { useRef, useEffect, useCallback } from "react";
import type { DiscountCurvePoint, PricedShare } from "@/lib/types";

interface DiscountCurveChartProps {
  curve: DiscountCurvePoint[];
  listings: PricedShare[];
}

export const DiscountCurveChart = React.memo(function DiscountCurveChart({
  curve,
  listings,
}: DiscountCurveChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const width = container.clientWidth;
    const height = 280;
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
    const curveColor = "#8b5cf6";
    const areaColor = isDark ? "rgba(139,92,246,0.15)" : "rgba(139,92,246,0.1)";

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, width, height);

    const margin = { top: 35, right: 30, bottom: 40, left: 60 };
    const chartW = width - margin.left - margin.right;
    const chartH = height - margin.top - margin.bottom;

    // Axis ranges
    const maxDiscount = curve.length > 0
      ? Math.max(...curve.map((p) => p.discountPct)) * 1.2
      : 25;

    const xOf = (blocks: number) =>
      margin.left + ((100 - blocks) / 100) * chartW;
    const yOf = (disc: number) =>
      margin.top + chartH - (disc / maxDiscount) * chartH;

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
    for (let b = 0; b <= 100; b += 20) {
      const x = xOf(b);
      ctx.beginPath();
      ctx.moveTo(x, margin.top);
      ctx.lineTo(x, margin.top + chartH);
      ctx.stroke();
    }

    // X axis labels (blocks until mature, right-to-left: 100 → 0)
    ctx.fillStyle = textColor;
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    for (let b = 0; b <= 100; b += 20) {
      ctx.fillText(`${b}`, xOf(b), height - margin.bottom + 16);
    }

    // Y axis labels
    ctx.textAlign = "right";
    for (let i = 0; i <= 5; i++) {
      const disc = ((5 - i) / 5) * maxDiscount;
      ctx.fillText(`${disc.toFixed(1)}%`, margin.left - 8, margin.top + (i / 5) * chartH + 4);
    }

    // Shaded area under curve
    if (curve.length > 0) {
      ctx.fillStyle = areaColor;
      ctx.beginPath();
      ctx.moveTo(xOf(curve[0].blocksUntilMature), yOf(0));
      for (const pt of curve) {
        ctx.lineTo(xOf(pt.blocksUntilMature), yOf(pt.discountPct));
      }
      ctx.lineTo(xOf(curve[curve.length - 1].blocksUntilMature), yOf(0));
      ctx.closePath();
      ctx.fill();
    }

    // Draw curve
    if (curve.length > 0) {
      ctx.strokeStyle = curveColor;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      for (let i = 0; i < curve.length; i++) {
        const x = xOf(curve[i].blocksUntilMature);
        const y = yOf(curve[i].discountPct);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Scatter dots for individual listings
    for (const listing of listings) {
      const x = xOf(listing.blocksUntilMature);
      const y = yOf(listing.discountPct);
      ctx.fillStyle = curveColor;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Axis labels
    ctx.fillStyle = textColor;
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Blocks until maturation (100 → 0)", margin.left + chartW / 2, height - 4);
    ctx.save();
    ctx.translate(14, margin.top + chartH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("Discount %", 0, 0);
    ctx.restore();

    // Title
    ctx.fillStyle = textColor;
    ctx.font = "12px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("Discount vs Blocks Until Maturation", margin.left, 18);
  }, [curve, listings]);

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
