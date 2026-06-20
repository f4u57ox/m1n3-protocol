"use client";

import type {
  SubmitterColorAssignment,
  FragmentSubmission,
} from "@/lib/types";
import { truncateAddress } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface SubmitterLegendProps {
  submitterColors: SubmitterColorAssignment[];
  fragments: FragmentSubmission[];
  selectedSubmitter: string | null;
  onSubmitterSelect: (address: string | null) => void;
}

export function MinerLegend({
  submitterColors,
  fragments,
  selectedSubmitter,
  onSubmitterSelect,
}: SubmitterLegendProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">
          Fragment Submitters ({submitterColors.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        {submitterColors.map((sc) => {
          const isSelected = selectedSubmitter === sc.address;
          const submitCount = fragments.filter(
            (f) => f.submitter === sc.address,
          ).length;
          return (
            <button
              key={sc.address}
              onClick={() =>
                onSubmitterSelect(isSelected ? null : sc.address)
              }
              className={cn(
                "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-sm transition-colors",
                isSelected
                  ? "bg-accent ring-1 ring-primary"
                  : "hover:bg-accent/50",
              )}
            >
              <span
                className="inline-block w-3 h-3 rounded-sm flex-shrink-0"
                style={{ backgroundColor: sc.color }}
              />
              <span className="font-mono text-xs truncate flex-1">
                {truncateAddress(sc.address)}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {submitCount} submission{submitCount !== 1 ? "s" : ""}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                [{sc.fragmentIndices.join(", ")}]
              </span>
            </button>
          );
        })}

        {submitterColors.length === 0 && (
          <p className="text-xs text-muted-foreground py-2">
            No fragment submissions yet
          </p>
        )}
      </CardContent>
    </Card>
  );
}
