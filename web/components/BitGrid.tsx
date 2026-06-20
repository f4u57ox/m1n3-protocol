"use client";

import React, { useState, useMemo } from "react";
import type { BitAssignment, FragmentSubmission } from "@/lib/types";
import { generateMinerColors } from "@/lib/bitcoin-utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOTAL_BITS = 640;
const COLS = 32;

/** Header field bit ranges with colors for the grid visualization. */
const FIELDS = [
  { label: "Version",    start: 0,   end: 31,  color: "rgb(59, 130, 246)" },   // blue
  { label: "PrevHash",   start: 32,  end: 287, color: "rgb(34, 197, 94)" },    // green
  { label: "MerkleRoot", start: 288, end: 543, color: "rgb(168, 85, 247)" },   // purple
  { label: "nTime",      start: 544, end: 575, color: "rgb(249, 115, 22)" },   // orange
  { label: "nBits",      start: 576, end: 607, color: "rgb(236, 72, 153)" },   // pink
  { label: "Nonce",      start: 608, end: 639, color: "rgb(234, 179, 8)" },    // yellow
] as const;

function getFieldForBit(bit: number) {
  return FIELDS.find((f) => bit >= f.start && bit <= f.end);
}

/** Row index where each field starts (32-bit aligned). */
const FIELD_ROW_LABELS = FIELDS.map((f) => ({
  label: f.label,
  row: Math.floor(f.start / COLS),
  span: Math.floor((f.end - f.start + 1) / COLS),
}));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BitGridProps {
  phase: "commitment" | "finalization" | "submission" | "verified" | "expired";
  participants: string[];
  assignments: BitAssignment[];
  submittedFragments: FragmentSubmission[];
  committedCount: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const BitGrid = React.memo(function BitGrid({
  phase,
  participants,
  assignments,
  submittedFragments,
  committedCount,
}: BitGridProps) {
  const [hoveredBit, setHoveredBit] = useState<number | null>(null);

  const colors = useMemo(
    () => generateMinerColors(participants.length),
    [participants.length],
  );

  const colorMap = useMemo(() => {
    const m = new Map<string, number>();
    participants.forEach((addr, i) => m.set(addr, i));
    return m;
  }, [participants]);

  // Bit index → assignment lookup
  const bitAssignmentMap = useMemo(() => {
    const m = new Map<number, BitAssignment>();
    for (const a of assignments) {
      for (let i = 0; i < a.bitCount; i++) {
        m.set(a.bitOffset + i, a);
      }
    }
    return m;
  }, [assignments]);

  const submittedSet = useMemo(() => {
    const s = new Set<string>();
    for (const f of submittedFragments) {
      s.add(`${f.submitter}:${f.bitOffset}`);
    }
    return s;
  }, [submittedFragments]);

  const hoveredField = hoveredBit !== null ? getFieldForBit(hoveredBit) : null;
  const hoveredAssignment =
    hoveredBit !== null ? bitAssignmentMap.get(hoveredBit) : null;

  // Pre-compute cell styles once
  const cellData = useMemo(() => {
    return Array.from({ length: TOTAL_BITS }, (_, bit) => {
      const field = getFieldForBit(bit);
      const assignment = bitAssignmentMap.get(bit);

      let bgColor: string;
      let opacity: number;

      if (phase === "commitment" || phase === "finalization") {
        // Show header field structure; light up proportionally to committed count
        bgColor = field?.color ?? "#666";
        const filledBits = Math.floor((committedCount / 640) * TOTAL_BITS);
        opacity = bit < filledBits ? 0.8 : 0.15;
      } else if (assignment) {
        // Submission/verified: color by participant assignment
        const colorIdx = colorMap.get(assignment.participantAddress) ?? 0;
        bgColor = colors[colorIdx] ?? "#666";
        const isSubmitted = submittedSet.has(
          `${assignment.participantAddress}:${assignment.bitOffset}`,
        );
        opacity = phase === "verified" ? 1.0 : isSubmitted ? 1.0 : 0.3;
      } else {
        bgColor = "#666";
        opacity = 0.1;
      }

      return { bgColor, opacity };
    });
  }, [phase, committedCount, assignments, bitAssignmentMap, colorMap, colors, submittedSet]);

  return (
    <div className="space-y-2">
      {/* Field legend */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        {FIELDS.map((f) => (
          <div key={f.label} className="flex items-center gap-1">
            <div
              className="w-2 h-2 rounded-sm"
              style={{ backgroundColor: f.color, opacity: 0.7 }}
            />
            <span>{f.label}</span>
          </div>
        ))}
      </div>

      {/* Grid with row labels */}
      <div className="flex gap-1">
        {/* Field row labels */}
        <div
          className="flex-shrink-0 text-[9px] text-muted-foreground/60"
          style={{
            display: "grid",
            gridTemplateRows: `repeat(20, 1fr)`,
            width: "60px",
            gap: "1px",
          }}
        >
          {FIELD_ROW_LABELS.map((f) => (
            <div
              key={f.label}
              className="flex items-center justify-end pr-1"
              style={{
                gridRow: `${f.row + 1} / span ${f.span}`,
              }}
            >
              {f.label}
            </div>
          ))}
        </div>

        {/* Bit cells */}
        <div
          className="flex-1 grid gap-[1px]"
          style={{ gridTemplateColumns: `repeat(${COLS}, 1fr)` }}
        >
          {cellData.map((cell, bit) => (
            <div
              key={bit}
              className="aspect-square rounded-[1px] cursor-crosshair"
              style={{
                backgroundColor: cell.bgColor,
                opacity: cell.opacity,
              }}
              onMouseEnter={() => setHoveredBit(bit)}
              onMouseLeave={() => setHoveredBit(null)}
            />
          ))}
        </div>
      </div>

      {/* Hover info bar */}
      <div className="h-4 text-[10px] text-muted-foreground flex items-center gap-3">
        {hoveredBit !== null ? (
          <>
            <span className="tabular-nums">Bit {hoveredBit}</span>
            <span className="tabular-nums">
              Byte {Math.floor(hoveredBit / 8)}
            </span>
            {hoveredField && <span>{hoveredField.label}</span>}
            {hoveredAssignment && (
              <>
                <span className="font-mono">
                  {hoveredAssignment.participantAddress.slice(0, 10)}...
                </span>
                <span className="tabular-nums">
                  bits {hoveredAssignment.bitOffset}&ndash;
                  {hoveredAssignment.bitOffset +
                    hoveredAssignment.bitCount -
                    1}
                </span>
              </>
            )}
          </>
        ) : (
          <span>
            {phase === "commitment"
              ? `${committedCount} / 640 slots committed`
              : `${TOTAL_BITS} bits \u00b7 80 bytes \u00b7 6 header fields`}
          </span>
        )}
      </div>
    </div>
  );
});
