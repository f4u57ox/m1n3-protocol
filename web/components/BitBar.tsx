"use client";

import React, { useRef, useEffect, useCallback, useState } from "react";
import type { BitAssignment, FragmentSubmission } from "@/lib/types";
import { generateMinerColors } from "@/lib/bitcoin-utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOTAL_BITS = 640;
const HEADER_H = 20;
const BAR_H = 32;
const LABEL_H = 16;
const CANVAS_H = HEADER_H + BAR_H + LABEL_H + 8;

/** Header field bit ranges for labeling. */
const FIELDS = [
  { label: "Version", start: 0, end: 31 },
  { label: "PrevHash", start: 32, end: 287 },
  { label: "MerkleRoot", start: 288, end: 543 },
  { label: "nTime", start: 544, end: 575 },
  { label: "nBits", start: 576, end: 607 },
  { label: "Nonce", start: 608, end: 639 },
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BitBarProps {
  assignments: BitAssignment[];
  submittedFragments: FragmentSubmission[];
  participants: string[];
  /** Currently selected participant address for highlight. */
  selectedParticipant?: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const BitBar = React.memo(function BitBar({
  assignments,
  submittedFragments,
  participants,
  selectedParticipant,
}: BitBarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const throttleRef = useRef(false);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    text: string[];
  } | null>(null);

  const colors = React.useMemo(
    () => generateMinerColors(participants.length),
    [participants.length],
  );

  // Map participant address → color index
  const colorMap = React.useMemo(() => {
    const m = new Map<string, number>();
    participants.forEach((addr, i) => m.set(addr, i));
    return m;
  }, [participants]);

  // Set of submitted bit offsets for quick lookup
  const submittedSet = React.useMemo(() => {
    const s = new Set<string>();
    for (const f of submittedFragments) {
      s.add(`${f.submitter}:${f.bitOffset}`);
    }
    return s;
  }, [submittedFragments]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const width = container.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = CANVAS_H * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${CANVAS_H}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const isDark = document.documentElement.classList.contains("dark");
    const textColor = isDark ? "#e4e4e7" : "#27272a";
    const dimText = isDark ? "#71717a" : "#a1a1aa";
    const bgColor = isDark ? "#09090b" : "#ffffff";
    const unassignedColor = isDark ? "#27272a" : "#e4e4e7";

    // Clear
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, width, CANVAS_H);

    const bitWidth = width / TOTAL_BITS;

    // Draw field labels on top
    ctx.font = "9px sans-serif";
    ctx.textBaseline = "top";
    ctx.textAlign = "center";
    ctx.fillStyle = dimText;

    for (const field of FIELDS) {
      const x1 = field.start * bitWidth;
      const x2 = (field.end + 1) * bitWidth;
      const cx = (x1 + x2) / 2;
      const fieldWidth = x2 - x1;

      // Only draw label if there's enough room
      const textWidth = ctx.measureText(field.label).width;
      if (fieldWidth > textWidth + 4) {
        ctx.fillText(field.label, cx, 2);
      }

      // Field separator line
      if (field.start > 0) {
        ctx.strokeStyle = isDark ? "#3f3f46" : "#d4d4d8";
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(x1, HEADER_H);
        ctx.lineTo(x1, HEADER_H + BAR_H);
        ctx.stroke();
      }
    }

    // Draw the bit bar
    const barY = HEADER_H;

    if (assignments.length === 0) {
      // No assignments yet — show gray bar
      ctx.fillStyle = unassignedColor;
      ctx.fillRect(0, barY, width, BAR_H);
    } else {
      // Draw each assignment range
      for (const assignment of assignments) {
        const x = assignment.bitOffset * bitWidth;
        const w = assignment.bitCount * bitWidth;
        const colorIdx = colorMap.get(assignment.participantAddress) ?? 0;
        const color = colors[colorIdx] ?? "hsl(0, 0%, 50%)";

        const isSubmitted = submittedSet.has(
          `${assignment.participantAddress}:${assignment.bitOffset}`,
        );
        const isSelected = selectedParticipant === assignment.participantAddress;
        const isDimmed = selectedParticipant && !isSelected;

        ctx.globalAlpha = isDimmed ? 0.15 : isSubmitted ? 1.0 : 0.3;
        ctx.fillStyle = color;
        ctx.fillRect(x, barY, w, BAR_H);
        ctx.globalAlpha = 1;
      }
    }

    // Draw bar border
    ctx.strokeStyle = isDark ? "#3f3f46" : "#d4d4d8";
    ctx.lineWidth = 1;
    ctx.strokeRect(0, barY, width, BAR_H);

    // Bottom label: bit count
    const labelY = barY + BAR_H + 4;
    ctx.fillStyle = dimText;
    ctx.font = "9px monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("0", 0, labelY);
    ctx.textAlign = "right";
    ctx.fillText("640", width, labelY);
    ctx.textAlign = "center";
    ctx.fillText("320", width / 2, labelY);
  }, [assignments, submittedFragments, colors, colorMap, submittedSet, selectedParticipant]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (throttleRef.current) return;
      throttleRef.current = true;
      requestAnimationFrame(() => {
        throttleRef.current = false;
      });

      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      // Only show tooltip within the bar area
      if (my < HEADER_H || my > HEADER_H + BAR_H) {
        setTooltip(null);
        return;
      }

      const bitWidth = rect.width / TOTAL_BITS;
      const bit = Math.floor(mx / bitWidth);
      if (bit < 0 || bit >= TOTAL_BITS) {
        setTooltip(null);
        return;
      }

      const field = FIELDS.find((f) => bit >= f.start && bit <= f.end);
      const lines = [`Bit ${bit}`, `Field: ${field?.label ?? "Unknown"}`];

      // Find which assignment covers this bit
      const assignment = assignments.find(
        (a) => bit >= a.bitOffset && bit < a.bitOffset + a.bitCount,
      );
      if (assignment) {
        lines.push(`Participant: ${assignment.participantAddress.slice(0, 10)}...`);
        lines.push(`Range: ${assignment.bitOffset}-${assignment.bitOffset + assignment.bitCount - 1}`);

        const isSubmitted = submittedSet.has(
          `${assignment.participantAddress}:${assignment.bitOffset}`,
        );
        lines.push(isSubmitted ? "Status: Submitted" : "Status: Pending");
      } else {
        lines.push("Unassigned");
      }

      setTooltip({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        text: lines,
      });
    },
    [assignments, submittedSet],
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
    <div ref={containerRef} className="w-full relative">
      <canvas
        ref={canvasRef}
        className="w-full rounded cursor-crosshair"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      />
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
  );
});
