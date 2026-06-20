"use client";

import React, { useRef, useEffect, useCallback } from "react";
import type { OrderBookData } from "@/lib/types";

interface OrderBookDepthChartProps {
  orderBook: OrderBookData;
}

export const OrderBookDepthChart = React.memo(function OrderBookDepthChart({
  orderBook,
}: OrderBookDepthChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const width = container.clientWidth;
    const height = 260;
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
    const bidColor = isDark ? "rgba(34,197,94,0.3)" : "rgba(34,197,94,0.2)";
    const bidLine = "#22c55e";
    const askColor = isDark ? "rgba(239,68,68,0.3)" : "rgba(239,68,68,0.2)";
    const askLine = "#ef4444";

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, width, height);

    const margin = { top: 35, right: 20, bottom: 40, left: 60 };
    const chartW = width - margin.left - margin.right;
    const chartH = height - margin.top - margin.bottom;

    const { bids, asks } = orderBook;
    if (bids.length === 0 && asks.length === 0) {
      ctx.fillStyle = textColor;
      ctx.font = "13px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No order book data", width / 2, height / 2);
      return;
    }

    // Price range
    const allPrices = [...bids.map((b) => b.price), ...asks.map((a) => a.price)];
    const priceMin = Math.min(...allPrices) * 0.95;
    const priceMax = Math.max(...allPrices) * 1.05;

    // Volume range
    const maxCum = Math.max(
      bids.length > 0 ? bids[bids.length - 1].cumulativePh : 0,
      asks.length > 0 ? asks[asks.length - 1].cumulativePh : 0,
    );

    const xOf = (price: number) =>
      margin.left + ((price - priceMin) / (priceMax - priceMin)) * chartW;
    const yOf = (cum: number) =>
      margin.top + chartH - (cum / (maxCum * 1.1)) * chartH;

    // Grid
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = margin.top + (i / 4) * chartH;
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(width - margin.right, y);
      ctx.stroke();
    }

    // Bid area (green, right to left)
    if (bids.length > 0) {
      ctx.fillStyle = bidColor;
      ctx.strokeStyle = bidLine;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(xOf(bids[0].price), yOf(0));
      for (const bid of bids) {
        ctx.lineTo(xOf(bid.price), yOf(bid.cumulativePh));
      }
      ctx.lineTo(xOf(bids[bids.length - 1].price), yOf(0));
      ctx.closePath();
      ctx.fill();

      // Bid line
      ctx.beginPath();
      for (let i = 0; i < bids.length; i++) {
        const x = xOf(bids[i].price);
        const y = yOf(bids[i].cumulativePh);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Ask area (red, left to right)
    if (asks.length > 0) {
      ctx.fillStyle = askColor;
      ctx.strokeStyle = askLine;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(xOf(asks[0].price), yOf(0));
      for (const ask of asks) {
        ctx.lineTo(xOf(ask.price), yOf(ask.cumulativePh));
      }
      ctx.lineTo(xOf(asks[asks.length - 1].price), yOf(0));
      ctx.closePath();
      ctx.fill();

      // Ask line
      ctx.beginPath();
      for (let i = 0; i < asks.length; i++) {
        const x = xOf(asks[i].price);
        const y = yOf(asks[i].cumulativePh);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Spread label
    if (bids.length > 0 && asks.length > 0) {
      const spreadX = xOf(orderBook.midpoint);
      ctx.strokeStyle = textColor;
      ctx.lineWidth = 0.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(spreadX, margin.top);
      ctx.lineTo(spreadX, margin.top + chartH);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = textColor;
      ctx.font = "10px monospace";
      ctx.textAlign = "center";
      ctx.fillText(
        `Spread: $${orderBook.spread.toFixed(4)} USD`,
        spreadX,
        margin.top + chartH + 14,
      );
    }

    // X axis labels
    ctx.fillStyle = textColor;
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    const numPriceTicks = 6;
    for (let i = 0; i <= numPriceTicks; i++) {
      const p = priceMin + (i / numPriceTicks) * (priceMax - priceMin);
      ctx.fillText(`$${p.toFixed(4)}`, xOf(p), height - margin.bottom + 28);
    }

    // Y axis labels
    ctx.textAlign = "right";
    for (let i = 0; i <= 4; i++) {
      const vol = ((4 - i) / 4) * maxCum * 1.1;
      ctx.fillText(
        vol.toFixed(2),
        margin.left - 8,
        margin.top + (i / 4) * chartH + 4,
      );
    }

    // Axis labels
    ctx.fillStyle = textColor;
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Price (USD)", margin.left + chartW / 2, height - 2);
    ctx.save();
    ctx.translate(14, margin.top + chartH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("Cumulative Hashrate (PH)", 0, 0);
    ctx.restore();

    // Title
    ctx.fillStyle = textColor;
    ctx.font = "12px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("Order Book Depth", margin.left, 18);
  }, [orderBook]);

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
