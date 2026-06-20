"use client";

import React, { useRef, useEffect, useState, useCallback, useMemo } from "react";
import * as d3 from "d3";
import { sankey, sankeyLinkHorizontal } from "d3-sankey";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SankeyNodeData {
  name: string;
  category: string;
  color?: string;
  fullAddress?: string;
  shareCount?: number;
  stakedAmount?: number;
}

export interface SankeyLinkData {
  source: number;
  target: number;
  value: number;
}

export interface SankeyBaseProps {
  nodes: SankeyNodeData[];
  links: SankeyLinkData[];
  categoryColors: Record<string, string>;
  minHeight?: number;
  maxHeight?: number;
  emptyMessage?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const SankeyBase = React.memo(function SankeyBase({
  nodes,
  links,
  categoryColors,
  minHeight = 300,
  maxHeight = 800,
  emptyMessage = "No data for Sankey visualization",
}: SankeyBaseProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const prevDataRef = useRef<string>("");

  // Compute dynamic height based on node count
  const computedHeight = useMemo(
    () => Math.min(maxHeight, Math.max(minHeight, nodes.length * 36 + 60)),
    [nodes.length, minHeight, maxHeight],
  );

  // Track container width via ResizeObserver
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const ro = new ResizeObserver((entries) => {
      const { width } = entries[0].contentRect;
      if (width > 0) setDimensions({ width, height: computedHeight });
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [computedHeight]);

  // Tooltip helpers
  const showTooltip = useCallback(
    (evt: MouseEvent, node: any) => {
      const tip = tooltipRef.current;
      const container = containerRef.current;
      if (!tip || !container) return;

      const rect = container.getBoundingClientRect();
      const x = evt.clientX - rect.left + 12;
      const y = evt.clientY - rect.top - 10;

      let html = `<div class="font-semibold text-xs mb-1">${node.name}</div>`;
      if (node.fullAddress) {
        html += `<div class="text-[10px] text-muted-foreground font-mono break-all">${node.fullAddress}</div>`;
      }
      if (node.shareCount != null) {
        html += `<div class="text-[10px] mt-0.5">Shares: <span class="font-medium">${node.shareCount}</span></div>`;
      }
      if (node.stakedAmount != null && node.stakedAmount > 0) {
        html += `<div class="text-[10px]">Staked: <span class="font-medium">${(node.stakedAmount / 1e9).toFixed(2)} M1N3</span></div>`;
      }

      tip.innerHTML = html;
      tip.style.left = `${x}px`;
      tip.style.top = `${y}px`;
      tip.style.opacity = "1";
      tip.style.pointerEvents = "none";
    },
    []
  );

  const hideTooltip = useCallback(() => {
    const tip = tooltipRef.current;
    if (tip) tip.style.opacity = "0";
  }, []);

  // Main D3 render
  useEffect(() => {
    if (
      !svgRef.current ||
      !containerRef.current ||
      nodes.length === 0 ||
      dimensions.width === 0
    )
      return;

    const { width } = dimensions;
    const height = computedHeight;

    // Fingerprint the data to decide whether to animate
    const dataKey = `${nodes.length}:${links.length}:${nodes.map((n) => n.name).join(",")}`;
    const dataChanged = dataKey !== prevDataRef.current;
    prevDataRef.current = dataKey;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    svg.attr("width", width).attr("height", height);

    const nodeColorFn = (node: SankeyNodeData) =>
      node.color ?? categoryColors[node.category] ?? "#888";

    // ---- Sankey layout ----
    const sankeyLayout = sankey<SankeyNodeData, SankeyLinkData>()
      .nodeId((d: any) => d.index)
      .nodeWidth(16)
      .nodePadding(16)
      .extent([
        [1, 5],
        [width - 1, height - 5],
      ]);

    const sankeyData = sankeyLayout({
      nodes: nodes.map((d) => ({ ...d })),
      links: links.map((d) => ({ ...d })),
    });

    // ---- Zoomable group ----
    const g = svg.append("g");

    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 4])
      .on("zoom", (event) => {
        g.attr("transform", event.transform);
      });

    svg.call(zoom);

    // ---- Links ----
    const linkGroup = g
      .append("g")
      .attr("fill", "none")
      .attr("stroke-opacity", 0.3);

    const linkPaths = linkGroup
      .selectAll("path")
      .data(sankeyData.links)
      .join("path")
      .attr("d", sankeyLinkHorizontal())
      .attr("stroke", (d: any) => nodeColorFn(d.source))
      .attr("stroke-width", (d: any) => Math.max(1, d.width));

    // Animate links via stroke-dashoffset (only on data change, not resize)
    if (dataChanged) {
      linkPaths.each(function () {
        const path = this as SVGPathElement;
        const len = path.getTotalLength();
        d3.select(path)
          .attr("stroke-dasharray", len)
          .attr("stroke-dashoffset", len)
          .transition()
          .duration(800)
          .ease(d3.easeCubicOut)
          .attr("stroke-dashoffset", 0);
      });
    }

    // ---- Nodes ----
    const nodeGroup = g
      .append("g")
      .selectAll("g")
      .data(sankeyData.nodes)
      .join("g")
      .style("opacity", dataChanged ? 0 : 1);

    // Fade nodes in (only on data change)
    if (dataChanged) {
      nodeGroup
        .transition()
        .duration(600)
        .delay((_d: any, i: number) => i * 30)
        .style("opacity", 1);
    }

    // Rects
    nodeGroup
      .append("rect")
      .attr("x", (d: any) => d.x0)
      .attr("y", (d: any) => d.y0)
      .attr("height", (d: any) => Math.max(d.y1 - d.y0, 1))
      .attr("width", (d: any) => d.x1 - d.x0)
      .attr("fill", (d: any) => nodeColorFn(d))
      .attr("rx", 2)
      .style("cursor", "pointer");

    // Labels
    nodeGroup
      .append("text")
      .attr("x", (d: any) => (d.x0 < width / 2 ? d.x1 + 6 : d.x0 - 6))
      .attr("y", (d: any) => (d.y1 + d.y0) / 2)
      .attr("dy", "0.35em")
      .attr("text-anchor", (d: any) =>
        d.x0 < width / 2 ? "start" : "end"
      )
      .text((d: any) => d.name)
      .attr("fill", "currentColor")
      .attr("font-size", "10px")
      .attr("font-family", "monospace")
      .style("pointer-events", "none");

    // ---- Hover-highlight ----
    nodeGroup
      .on("mouseenter", function (event: MouseEvent, d: any) {
        // Dim unconnected links
        linkPaths
          .transition()
          .duration(200)
          .attr("stroke-opacity", (l: any) =>
            l.source === d || l.target === d ? 0.7 : 0.08
          );
        showTooltip(event, d);
      })
      .on("mousemove", function (event: MouseEvent, d: any) {
        showTooltip(event, d);
      })
      .on("mouseleave", function () {
        linkPaths
          .transition()
          .duration(200)
          .attr("stroke-opacity", 0.3);
        hideTooltip();
      });
  }, [
    nodes,
    links,
    categoryColors,
    dimensions,
    computedHeight,
    showTooltip,
    hideTooltip,
  ]);

  if (nodes.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-8">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full overflow-hidden relative">
      <svg
        ref={svgRef}
        className="w-full"
        style={{ height: computedHeight }}
      />
      {/* Tooltip */}
      <div
        ref={tooltipRef}
        className="absolute z-50 rounded-md border bg-popover px-3 py-2 shadow-md transition-opacity duration-150"
        style={{ opacity: 0, pointerEvents: "none" }}
      />
    </div>
  );
});
