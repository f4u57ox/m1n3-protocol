"use client";

import React from "react";
import { useMinerFlow } from "@/hooks/useMinerFlow";
import { SankeyBase } from "./SankeyBase";

const CATEGORY_COLORS: Record<string, string> = {
  miner: "#06b6d4",
  template: "#22c55e",
  owner: "#6366f1",
};

export const MinerFlowSankey = React.memo(function MinerFlowSankey() {
  const { nodes, links, loading, error } = useMinerFlow();

  if (loading) {
    return (
      <div className="text-center text-muted-foreground py-8 animate-pulse">
        Loading miner flow data...
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center text-destructive py-8">
        Error: {error}
      </div>
    );
  }

  return (
    <SankeyBase
      nodes={nodes}
      links={links}
      categoryColors={CATEGORY_COLORS}
      emptyMessage="No share data — miner flow will appear once shares are submitted"
    />
  );
});
