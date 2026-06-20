"use client";

import React from "react";
import { getMerkleColor } from "@/lib/bitcoin-utils";

interface MerkleTreeVizProps {
  branches: string[];
}

export const MerkleTreeViz = React.memo(function MerkleTreeViz({ branches }: MerkleTreeVizProps) {
  if (branches.length === 0) return null;

  return (
    <div className="space-y-2">
      {/* Coinbase hash (root input) */}
      <div className="flex items-center gap-2">
        <div className="w-8 text-xs text-muted-foreground text-right shrink-0">
          tx
        </div>
        <div className="flex-1 bg-primary/10 text-primary rounded px-3 py-1.5 font-mono text-xs">
          coinbase_hash (sha256d of coinbase)
        </div>
      </div>

      {/* Branch levels */}
      {branches.map((branch, i) => {
        const color = getMerkleColor(branch);
        const displayHash = branch;

        return (
          <div key={i} className="flex items-center gap-2">
            <div className="w-8 text-xs text-muted-foreground text-right shrink-0">
              L{i}
            </div>
            <div className="flex items-center gap-1 flex-1 min-w-0">
              <div className="h-px w-4 bg-border shrink-0" />
              {/* Color indicator */}
              <span
                className="inline-block w-3 h-3 rounded-sm shrink-0"
                style={{ backgroundColor: color }}
              />
              <div className="flex-1 bg-muted rounded px-3 py-1.5 font-mono text-xs break-all min-w-0">
                {displayHash}
              </div>
            </div>
          </div>
        );
      })}

      {/* Merkle root */}
      <div className="flex items-center gap-2">
        <div className="w-8 text-xs text-muted-foreground text-right shrink-0">
          root
        </div>
        <div className="flex-1 bg-green-500/10 text-green-700 dark:text-green-400 rounded px-3 py-1.5 font-mono text-xs">
          merkle_root = sha256d(... combined hashes)
        </div>
      </div>

      {/* Legend */}
      <p className="text-xs text-muted-foreground pt-2">
        Hashes in display byte order (matches block explorer txids). L0 = first non-coinbase txid.
      </p>
    </div>
  );
});
