"use client";

import { useMemo } from "react";
import { useRecentShares } from "./useRecentShares";
import { useTemplates } from "./useTemplates";
import { truncateAddress } from "@/lib/utils";
import type { SankeyNodeData, SankeyLinkData } from "@/components/SankeyBase";

/**
 * Aggregates recent shares + templates into a 3-tier Sankey flow:
 *   Miners (left) → Templates (middle) → Templaters/Owners (right)
 */
export function useMinerFlow(shareLimit = 100) {
  const { shares, loading: sharesLoading, error: sharesError } = useRecentShares(shareLimit);
  const { templates, loading: templatesLoading, error: templatesError } = useTemplates();

  const { nodes, links } = useMemo(() => {
    if (shares.length === 0 || templates.length === 0) {
      return { nodes: [] as SankeyNodeData[], links: [] as SankeyLinkData[] };
    }

    // Template lookup: id → template data
    const templateMap = new Map(templates.map((t) => [t.id, t]));

    // Aggregate: (miner, templateId) → { count, totalDifficulty }
    const minerTemplateAgg = new Map<string, { count: number; totalDifficulty: number }>();

    for (const share of shares) {
      const key = `${share.miner}|${share.templateId}`;
      const existing = minerTemplateAgg.get(key);
      if (existing) {
        existing.count += 1;
        existing.totalDifficulty += share.difficultyAchieved;
      } else {
        minerTemplateAgg.set(key, {
          count: 1,
          totalDifficulty: share.difficultyAchieved,
        });
      }
    }

    // Pre-compute total shares per miner (across all templates)
    const minerTotalShares = new Map<string, number>();
    for (const [compositeKey, agg] of minerTemplateAgg) {
      const miner = compositeKey.split("|")[0];
      minerTotalShares.set(miner, (minerTotalShares.get(miner) ?? 0) + agg.count);
    }

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

    // Template → Owner link dedup: "templateNodeIdx|ownerNodeIdx" → summed value
    const templateOwnerLinks = new Map<string, { source: number; target: number; value: number }>();

    for (const [compositeKey, agg] of minerTemplateAgg) {
      const [miner, templateId] = compositeKey.split("|");
      const tmpl = templateMap.get(templateId);
      if (!tmpl) continue;

      // Miner node (left) — use total shares across all templates
      const minerIdx = getOrCreateNode(
        `miner:${miner}`,
        truncateAddress(miner),
        "miner",
        { fullAddress: miner, shareCount: minerTotalShares.get(miner) ?? 0 }
      );

      // Template node (middle)
      const templateIdx = getOrCreateNode(
        `template:${templateId}`,
        `H:${tmpl.height}`,
        "template",
        { shareCount: tmpl.shareCount, stakedAmount: tmpl.stakedAmount }
      );

      // Owner node (right)
      const ownerIdx = getOrCreateNode(
        `owner:${tmpl.owner}`,
        truncateAddress(tmpl.owner),
        "owner",
        { fullAddress: tmpl.owner }
      );

      // Miner → Template link
      links.push({
        source: minerIdx,
        target: templateIdx,
        value: agg.count,
      });

      // Template → Owner link (deduplicated / summed)
      const toKey = `${templateIdx}|${ownerIdx}`;
      const existing = templateOwnerLinks.get(toKey);
      if (existing) {
        existing.value += agg.count;
      } else {
        templateOwnerLinks.set(toKey, {
          source: templateIdx,
          target: ownerIdx,
          value: agg.count,
        });
      }
    }

    // Flatten template→owner links
    for (const link of templateOwnerLinks.values()) {
      links.push(link);
    }

    return { nodes, links };
  }, [shares, templates]);

  return {
    nodes,
    links,
    loading: sharesLoading || templatesLoading,
    error: sharesError || templatesError,
  };
}
