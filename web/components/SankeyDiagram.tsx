"use client";

import { useMemo } from "react";
import { SankeyBase } from "./SankeyBase";
import type { SankeyNodeData, SankeyLinkData } from "./SankeyBase";
import type { TemplateData } from "@/lib/types";
import { truncateAddress, addressColor } from "@/lib/utils";
import { reverseHex } from "@/lib/bitcoin-utils";

const CATEGORY_COLORS: Record<string, string> = {
  owner: "#6366f1",
  template: "#22c55e",
  branch: "#f59e0b",
};

interface SankeyDiagramProps {
  templates: TemplateData[];
}

/**
 * Template flow Sankey: Owners (left) → Templates (middle) → Merkle Branches (right)
 *
 * Mirrors the design of MinerFlowSankey — consistent link values (share counts),
 * deduplicated edges, and rich tooltip metadata on every node.
 */
export function SankeyDiagram({ templates }: SankeyDiagramProps) {
  const { nodes, links } = useMemo(() => {
    if (templates.length === 0)
      return { nodes: [] as SankeyNodeData[], links: [] as SankeyLinkData[] };

    const nodeMap = new Map<string, number>();
    const nodes: SankeyNodeData[] = [];
    const links: SankeyLinkData[] = [];

    const getOrCreateNode = (
      key: string,
      name: string,
      category: string,
      extra?: Partial<SankeyNodeData>
    ) => {
      if (!nodeMap.has(key)) {
        nodeMap.set(key, nodes.length);
        nodes.push({ name, category, ...extra });
      }
      return nodeMap.get(key)!;
    };

    // Pre-compute totals per owner (shares + stake across all their templates)
    const ownerTotalShares = new Map<string, number>();
    const ownerTotalStaked = new Map<string, number>();
    for (const t of templates) {
      ownerTotalShares.set(
        t.owner,
        (ownerTotalShares.get(t.owner) ?? 0) + t.shareCount
      );
      ownerTotalStaked.set(
        t.owner,
        (ownerTotalStaked.get(t.owner) ?? 0) + (t.stakedAmount ?? 0)
      );
    }

    // Pre-compute branch usage: how many templates reference each branch
    const branchTemplateCount = new Map<string, number>();
    const branchTotalShares = new Map<string, number>();
    for (const t of templates) {
      for (const branch of t.merkleBranches.slice(0, 5)) {
        branchTemplateCount.set(
          branch,
          (branchTemplateCount.get(branch) ?? 0) + 1
        );
        branchTotalShares.set(
          branch,
          (branchTotalShares.get(branch) ?? 0) + t.shareCount
        );
      }
    }

    // Template→Branch link dedup: "templateIdx|branchIdx" → summed value
    const templateBranchLinks = new Map<
      string,
      { source: number; target: number; value: number }
    >();

    for (const t of templates) {
      const value = Math.max(t.shareCount, 1);

      // Owner node (left)
      const ownerColor = addressColor(t.owner);
      const ownerIdx = getOrCreateNode(
        `owner:${t.owner}`,
        truncateAddress(t.owner),
        "owner",
        {
          color: ownerColor,
          fullAddress: t.owner,
          shareCount: ownerTotalShares.get(t.owner) ?? 0,
          stakedAmount: ownerTotalStaked.get(t.owner) ?? 0,
        }
      );

      // Template node (middle) — inherits owner color for visual continuity
      const templateIdx = getOrCreateNode(
        `template:${t.id}`,
        `H:${t.height}`,
        "template",
        {
          color: ownerColor,
          shareCount: t.shareCount,
          stakedAmount: t.stakedAmount,
        }
      );

      // Owner → Template link
      links.push({ source: ownerIdx, target: templateIdx, value });

      // Template → Branch links (first 5, deduplicated)
      const branches = t.merkleBranches.slice(0, 5);
      const perBranchValue = Math.max(value / Math.max(branches.length, 1), 0.1);

      for (const branch of branches) {
        // Reverse to big-endian display order (matches TemplateTable/MerkleTreeViz)
        const displayHash = reverseHex(branch);
        const branchIdx = getOrCreateNode(
          `branch:${branch}`,
          displayHash.slice(0, 12) + "...",
          "branch",
          {
            fullAddress: displayHash,
            shareCount: branchTotalShares.get(branch) ?? 0,
          }
        );

        const linkKey = `${templateIdx}|${branchIdx}`;
        const existing = templateBranchLinks.get(linkKey);
        if (existing) {
          existing.value += perBranchValue;
        } else {
          templateBranchLinks.set(linkKey, {
            source: templateIdx,
            target: branchIdx,
            value: perBranchValue,
          });
        }
      }
    }

    // Flatten deduplicated template→branch links
    for (const link of templateBranchLinks.values()) {
      links.push(link);
    }

    return { nodes, links };
  }, [templates]);

  return (
    <SankeyBase
      nodes={nodes}
      links={links}
      categoryColors={CATEGORY_COLORS}
      emptyMessage="No template data for Sankey visualization"
    />
  );
}
