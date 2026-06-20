"use client";

import React, { useState } from "react";
import type { SubmitterColorAssignment } from "@/lib/types";
import { reverseHex } from "@/lib/bitcoin-utils";
import { Badge } from "@/components/ui/badge";

interface BlockCubeVizProps {
  height: number;
  blockHash: string | null;
  submitterColors: SubmitterColorAssignment[];
  fragmentCount: number;
  onClickScroll?: () => void;
}

export const BlockCubeViz = React.memo(function BlockCubeViz({
  height,
  blockHash,
  submitterColors,
  fragmentCount,
  onClickScroll,
}: BlockCubeVizProps) {
  const [hovered, setHovered] = useState(false);

  const hashDisplay = blockHash
    ? reverseHex(blockHash).slice(0, 16) + "..."
    : "Loading...";

  const totalFragments = submitterColors.reduce(
    (sum, sc) => sum + sc.fragmentIndices.length,
    0,
  );

  return (
    <div
      className="flex items-center justify-center"
      style={{ perspective: "800px" }}
    >
      <div
        className="relative cursor-pointer transition-transform duration-300 ease-out"
        style={{
          width: "220px",
          height: "200px",
          transformStyle: "preserve-3d",
          transform: hovered
            ? "rotateX(-15deg) rotateY(20deg)"
            : "rotateX(-10deg) rotateY(15deg)",
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={onClickScroll}
      >
        {/* Front face */}
        <div
          className="absolute inset-0 rounded-lg border bg-card p-4 flex flex-col justify-between"
          style={{
            transform: "translateZ(40px)",
            backfaceVisibility: "hidden",
          }}
        >
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-lg font-bold">
                #{height.toLocaleString()}
              </span>
              <Badge variant="secondary">Registered</Badge>
            </div>
            <p className="text-xs font-mono text-muted-foreground truncate">
              {hashDisplay}
            </p>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {fragmentCount} fragments
            </span>
            <span className="text-muted-foreground">
              {submitterColors.length} submitter
              {submitterColors.length !== 1 ? "s" : ""}
            </span>
          </div>
        </div>

        {/* Top face - submitter contribution bar */}
        <div
          className="absolute rounded-lg border overflow-hidden"
          style={{
            width: "220px",
            height: "40px",
            transform:
              "translateY(-20px) translateZ(20px) rotateX(90deg)",
            transformOrigin: "bottom center",
            backfaceVisibility: "hidden",
          }}
        >
          <div className="flex h-full">
            {submitterColors.length > 0 ? (
              submitterColors.map((sc) => (
                <div
                  key={sc.address}
                  className="h-full flex items-center justify-center"
                  style={{
                    flex: sc.fragmentIndices.length,
                    backgroundColor: sc.color,
                    minWidth: "2px",
                  }}
                  title={`${sc.address.slice(0, 10)}...: ${sc.fragmentIndices.length} fragments`}
                >
                  {totalFragments > 0 &&
                    sc.fragmentIndices.length / totalFragments > 0.15 && (
                      <span className="text-[8px] text-white font-mono truncate px-0.5">
                        {Math.round(
                          (sc.fragmentIndices.length / totalFragments) *
                            100,
                        )}
                        %
                      </span>
                    )}
                </div>
              ))
            ) : (
              <div className="h-full w-full bg-muted flex items-center justify-center">
                <span className="text-[9px] text-muted-foreground">
                  No fragments
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Right face */}
        <div
          className="absolute rounded-lg border bg-card/80 flex items-center justify-center p-2"
          style={{
            width: "40px",
            height: "200px",
            transform:
              "translateX(200px) translateZ(20px) rotateY(90deg)",
            transformOrigin: "left center",
            backfaceVisibility: "hidden",
          }}
        >
          <div className="flex flex-col items-center gap-1">
            <span className="text-[8px] font-mono text-primary">
              80B
            </span>
          </div>
        </div>
      </div>
    </div>
  );
});
