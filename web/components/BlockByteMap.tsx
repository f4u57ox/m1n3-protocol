"use client";

import React, { useRef, useEffect, useCallback, useState } from "react";
import type {
  HeaderSegment,
  FragmentLayout,
  SubmitterColorAssignment,
  FragmentSubmission,
} from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLS = 16;
const ROWS = 5; // 80 bytes total
const CELL_PAD = 2;
const HEADER_H = 24;
const LEGEND_H = 32;

const FIELD_COLORS_DARK: Record<string, string> = {
  Version: "#4f6d7a",
  PrevHash: "#3b5998",
  MerkleRoot: "#5b4a8c",
  nTime: "#6b5b3e",
  nBits: "#3b6e5e",
  Nonce: "#7a4a4f",
};

const FIELD_COLORS_LIGHT: Record<string, string> = {
  Version: "#8bb4c7",
  PrevHash: "#7ea0d4",
  MerkleRoot: "#a294c9",
  nTime: "#c4a96e",
  nBits: "#7ec4a8",
  Nonce: "#c98a8f",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ByteRect {
  x: number;
  y: number;
  w: number;
  h: number;
  byteOffset: number;
}

interface BlockByteMapProps {
  headerHex: string | null;
  segments: HeaderSegment[];
  fragmentLayouts: FragmentLayout[];
  submitterColors: SubmitterColorAssignment[];
  fragments: FragmentSubmission[];
  selectedSubmitter: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fieldLabel(byteOffset: number): string {
  if (byteOffset < 4) return "Version";
  if (byteOffset < 36) return "PrevHash";
  if (byteOffset < 68) return "MerkleRoot";
  if (byteOffset < 72) return "nTime";
  if (byteOffset < 76) return "nBits";
  return "Nonce";
}

function getFragmentForByte(
  byteOffset: number,
  layouts: FragmentLayout[],
): FragmentLayout | undefined {
  return layouts.find(
    (l) => byteOffset >= l.offset && byteOffset < l.offset + l.size,
  );
}

function getSubmitterForFragment(
  fragmentIndex: number,
  submitterColors: SubmitterColorAssignment[],
): SubmitterColorAssignment | undefined {
  return submitterColors.find((sc) =>
    sc.fragmentIndices.includes(fragmentIndex),
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const BlockByteMap = React.memo(function BlockByteMap({
  headerHex,
  segments,
  fragmentLayouts,
  submitterColors,
  fragments,
  selectedSubmitter,
}: BlockByteMapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const byteRectsRef = useRef<ByteRect[]>([]);
  const throttleRef = useRef(false);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    text: string[];
  } | null>(null);

  const hasFragments = fragmentLayouts.length > 0;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const width = container.clientWidth;
    const cellW = Math.floor((width - CELL_PAD * (COLS + 1)) / COLS);
    const cellH = Math.max(cellW * 0.7, 28);
    const height = HEADER_H + ROWS * (cellH + CELL_PAD) + CELL_PAD + LEGEND_H;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const isDark = document.documentElement.classList.contains("dark");
    const textColor = isDark ? "#e4e4e7" : "#27272a";
    const dimText = isDark ? "#71717a" : "#a1a1aa";
    const bgColor = isDark ? "#09090b" : "#ffffff";
    const fieldColors = isDark ? FIELD_COLORS_DARK : FIELD_COLORS_LIGHT;

    // Clear
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, width, height);

    // Header label
    ctx.fillStyle = textColor;
    ctx.font = "12px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("80-Byte Block Header", CELL_PAD, 16);

    ctx.textAlign = "right";
    ctx.fillStyle = dimText;
    ctx.font = "10px monospace";
    ctx.fillText("16 cols \u00d7 5 rows = 80 bytes", width - CELL_PAD, 16);

    // Draw cells
    const byteRects: ByteRect[] = [];

    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const byteOffset = row * COLS + col;
        if (byteOffset >= 80) continue;

        const x = CELL_PAD + col * (cellW + CELL_PAD);
        const y = HEADER_H + CELL_PAD + row * (cellH + CELL_PAD);

        byteRects.push({ x, y, w: cellW, h: cellH, byteOffset });

        const label = fieldLabel(byteOffset);
        const unknownColor = isDark ? "#2a2a35" : "#d8d8e0";
        let fillColor: string = unknownColor;

        // Default: always color by header field type
        fillColor = fieldColors[label] ?? unknownColor;

        if (selectedSubmitter && hasFragments) {
          // Submitter selected: highlight their fragment bytes
          const frag = getFragmentForByte(byteOffset, fragmentLayouts);
          const sc = submitterColors.find(
            (s) => s.address === selectedSubmitter,
          );
          if (frag && sc && sc.fragmentIndices.includes(frag.index)) {
            fillColor = sc.color;
          } else {
            ctx.globalAlpha = 0.3;
          }
        }

        // Draw cell background
        ctx.fillStyle = fillColor;
        ctx.beginPath();
        ctx.roundRect(x, y, cellW, cellH, 3);
        ctx.fill();
        ctx.globalAlpha = 1;

        // Hex text
        let hexText = "??";
        if (headerHex && headerHex.length === 160) {
          hexText = headerHex.slice(byteOffset * 2, byteOffset * 2 + 2);
        }

        ctx.fillStyle = isDark ? "#e4e4e7" : "#1a1a2e";
        ctx.font = `${Math.min(cellW * 0.35, 12)}px monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(hexText.toUpperCase(), x + cellW / 2, y + cellH / 2);

        // Byte offset in top-left corner
        ctx.fillStyle = dimText;
        ctx.font = `${Math.min(cellW * 0.2, 8)}px monospace`;
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText(String(byteOffset), x + 2, y + 2);
      }
    }

    byteRectsRef.current = byteRects;

    // Draw fragment boundary lines
    if (hasFragments) {
      ctx.strokeStyle = isDark ? "#ffffff44" : "#00000044";
      ctx.lineWidth = 2;
      for (const layout of fragmentLayouts) {
        const startRect = byteRects.find(
          (r) => r.byteOffset === layout.offset,
        );
        if (startRect) {
          ctx.beginPath();
          ctx.moveTo(startRect.x - 1, startRect.y);
          ctx.lineTo(startRect.x - 1, startRect.y + startRect.h);
          ctx.stroke();
        }
      }
    }

    // Legend bar (only when header data is available)
    if (headerHex) {
      const legendY = HEADER_H + ROWS * (cellH + CELL_PAD) + CELL_PAD + 8;
      const labels = [
        "Version",
        "PrevHash",
        "MerkleRoot",
        "nTime",
        "nBits",
        "Nonce",
      ];
      ctx.font = "10px sans-serif";
      ctx.textBaseline = "middle";
      let lx = CELL_PAD;

      for (const l of labels) {
        const c = fieldColors[l] ?? (isDark ? "#3a3a4a" : "#d0d0dd");
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.roundRect(lx, legendY, 12, 12, 2);
        ctx.fill();

        ctx.fillStyle = textColor;
        ctx.textAlign = "left";
        const tw = ctx.measureText(l).width;
        ctx.fillText(l, lx + 16, legendY + 6);
        lx += 16 + tw + 12;
      }
    } else {
      const legendY = HEADER_H + ROWS * (cellH + CELL_PAD) + CELL_PAD + 8;
      ctx.fillStyle = dimText;
      ctx.font = "11px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText("Not yet registered \u2014 header bytes unknown", CELL_PAD, legendY + 6);
    }
  }, [
    headerHex,
    segments,
    fragmentLayouts,
    submitterColors,
    selectedSubmitter,
    hasFragments,
  ]);

  // Mouse move handler (throttled to ~60fps)
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (throttleRef.current) return;
      throttleRef.current = true;
      requestAnimationFrame(() => { throttleRef.current = false; });

      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      const hit = byteRectsRef.current.find(
        (br) =>
          mx >= br.x &&
          mx <= br.x + br.w &&
          my >= br.y &&
          my <= br.y + br.h,
      );

      if (!hit) {
        setTooltip(null);
        return;
      }

      const label = fieldLabel(hit.byteOffset);
      const lines = [`Byte ${hit.byteOffset}`, `Field: ${label}`];

      if (headerHex && headerHex.length === 160) {
        const hex = headerHex.slice(
          hit.byteOffset * 2,
          hit.byteOffset * 2 + 2,
        );
        lines.push(`Value: 0x${hex.toUpperCase()}`);
      }

      if (hasFragments) {
        const frag = getFragmentForByte(hit.byteOffset, fragmentLayouts);
        if (frag) {
          lines.push(`Fragment: #${frag.index}`);
          const sc = getSubmitterForFragment(frag.index, submitterColors);
          if (sc) {
            lines.push(`Submitter: ${sc.address.slice(0, 10)}...`);
          }
        }
      }

      setTooltip({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        text: lines,
      });
    },
    [headerHex, fragmentLayouts, submitterColors, hasFragments],
  );

  const handleMouseLeave = useCallback(() => setTooltip(null), []);

  useEffect(() => {
    draw();

    const observer = new ResizeObserver(draw);
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => observer.disconnect();
  }, [draw]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">
          Header Byte Map
          {hasFragments && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {fragmentLayouts.length} fragments,{" "}
              {submitterColors.length} submitter
              {submitterColors.length !== 1 ? "s" : ""}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div ref={containerRef} className="w-full relative">
          <canvas
            ref={canvasRef}
            className="w-full rounded-lg cursor-crosshair"
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
          />
          {/* Tooltip overlay */}
          {tooltip && (
            <div
              className="absolute pointer-events-none z-10 bg-popover text-popover-foreground border rounded-md shadow-md px-2 py-1.5 text-xs"
              style={{
                left: Math.min(
                  tooltip.x + 12,
                  (containerRef.current?.clientWidth ?? 300) - 160,
                ),
                top: tooltip.y + 12,
              }}
            >
              {tooltip.text.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
});
