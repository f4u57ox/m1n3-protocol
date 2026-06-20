"use client";

import React, { useRef, useEffect, useCallback, useMemo } from "react";
import type { TemplateData } from "@/lib/types";
import { truncateAddress } from "@/lib/utils";

interface TimingChartProps {
  templates: TemplateData[];
  events?: Array<{
    type: string;
    timestamp: number;
    templateId?: string;
  }>;
  timeWindowSeconds?: number;
}

const COLORS = [
  "#6366f1",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
];

export const TimingChart = React.memo(function TimingChart({
  templates,
  events = [],
  timeWindowSeconds = 120,
}: TimingChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);

  // Pre-compute template ID → index map so event lookup is O(1)
  const templateIdxMap = useMemo(() => {
    const map = new Map<string, number>();
    templates.forEach((t, i) => map.set(t.id, i));
    return map;
  }, [templates]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const width = container.clientWidth;
    const height = 300;
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

    // Background
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, width, height);

    const margin = { top: 30, right: 20, bottom: 30, left: 120 };
    const chartW = width - margin.left - margin.right;
    const chartH = height - margin.top - margin.bottom;

    const now = Date.now();
    const timeStart = now - timeWindowSeconds * 1000;

    // Y-axis: templates
    const templateIds = templates.map((t) => t.id);
    const yStep = templateIds.length > 0 ? chartH / templateIds.length : chartH;

    // Grid lines
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 0.5;

    // Horizontal grid
    templateIds.forEach((_, i) => {
      const y = margin.top + i * yStep + yStep / 2;
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(width - margin.right, y);
      ctx.stroke();
    });

    // Time axis labels
    ctx.fillStyle = textColor;
    ctx.font = "10px monospace";
    ctx.textAlign = "center";

    const numTicks = 6;
    for (let i = 0; i <= numTicks; i++) {
      const t = timeStart + (i / numTicks) * timeWindowSeconds * 1000;
      const x = margin.left + (i / numTicks) * chartW;
      const secs = Math.round((t - now) / 1000);
      ctx.fillText(`${secs}s`, x, height - 8);

      ctx.strokeStyle = gridColor;
      ctx.beginPath();
      ctx.moveTo(x, margin.top);
      ctx.lineTo(x, margin.top + chartH);
      ctx.stroke();
    }

    // Template labels on y-axis
    ctx.textAlign = "right";
    ctx.font = "11px monospace";
    templateIds.forEach((id, i) => {
      const y = margin.top + i * yStep + yStep / 2;
      ctx.fillStyle = COLORS[i % COLORS.length];
      ctx.fillText(truncateAddress(id), margin.left - 8, y + 4);
    });

    // Template creation markers (diamonds)
    templates.forEach((t, i) => {
      if (t.createdAtMs < timeStart || t.createdAtMs > now) return;

      const x =
        margin.left + ((t.createdAtMs - timeStart) / (timeWindowSeconds * 1000)) * chartW;
      const y = margin.top + i * yStep + yStep / 2;

      ctx.fillStyle = COLORS[i % COLORS.length];
      ctx.beginPath();
      ctx.moveTo(x, y - 6);
      ctx.lineTo(x + 6, y);
      ctx.lineTo(x, y + 6);
      ctx.lineTo(x - 6, y);
      ctx.closePath();
      ctx.fill();
    });

    // Events as circles
    events.forEach((evt) => {
      if (evt.timestamp < timeStart || evt.timestamp > now) return;

      const templateIdx = evt.templateId
        ? (templateIdxMap.get(evt.templateId) ?? -1)
        : -1;
      if (templateIdx === -1) return;

      const x =
        margin.left +
        ((evt.timestamp - timeStart) / (timeWindowSeconds * 1000)) * chartW;
      const y = margin.top + templateIdx * yStep + yStep / 2;

      const color = COLORS[templateIdx % COLORS.length];
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.7;

      const radius = evt.type === "block_found" ? 6 : 3;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      // Block found gets a star marker
      if (evt.type === "block_found") {
        ctx.strokeStyle = "#fbbf24";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 8, 0, Math.PI * 2);
        ctx.stroke();
      }
    });

    // Title
    ctx.fillStyle = textColor;
    ctx.font = "12px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("Template Activity Timeline", margin.left, 16);

    // Legend
    ctx.font = "10px sans-serif";
    const legendX = width - margin.right - 200;
    ctx.fillStyle = COLORS[0];
    ctx.beginPath();
    ctx.moveTo(legendX, 12);
    ctx.lineTo(legendX + 6, 18);
    ctx.lineTo(legendX, 24);
    ctx.lineTo(legendX - 6, 18);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = textColor;
    ctx.fillText("= Created", legendX + 10, 22);

    ctx.fillStyle = COLORS[0];
    ctx.beginPath();
    ctx.arc(legendX + 100, 18, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = textColor;
    ctx.fillText("= Share", legendX + 108, 22);
  }, [templates, events, timeWindowSeconds, templateIdxMap]);

  useEffect(() => {
    draw();

    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(draw);
    });
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

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
