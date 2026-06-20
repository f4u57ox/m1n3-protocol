"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { ChevronDown } from "lucide-react";
import { PoolStats } from "@/components/PoolStats";
import { RecentShares } from "@/components/RecentShares";
import { MinerTable } from "@/components/MinerTable";
import { useMiners } from "@/hooks/useMiners";
import { useTemplates } from "@/hooks/useTemplates";

const SankeyDiagram = dynamic(
  () => import("@/components/SankeyDiagram").then((m) => ({ default: m.SankeyDiagram })),
  { ssr: false, loading: () => <div className="h-64 animate-pulse bg-muted rounded-lg" /> },
);
const MinerFlowSankey = dynamic(
  () => import("@/components/MinerFlowSankey").then((m) => ({ default: m.MinerFlowSankey })),
  { ssr: false, loading: () => <div className="h-64 animate-pulse bg-muted rounded-lg" /> },
);
const TemplateTable = dynamic(
  () => import("@/components/TemplateTable").then((m) => ({ default: m.TemplateTable })),
  { loading: () => <div className="h-48 animate-pulse bg-muted rounded-lg" /> },
);

export function PoolOverviewTab() {
  const { miners, loading: minersLoading } = useMiners();
  const { templates, loading: templatesLoading } = useTemplates();
  const [templateFlowOpen, setTemplateFlowOpen] = useState(false);
  const [minerFlowOpen, setMinerFlowOpen] = useState(false);

  return (
    <div className="space-y-6">
      <PoolStats />

      {templatesLoading ? (
        <div className="rounded-lg border bg-card p-6 text-center text-muted-foreground animate-pulse">
          Loading template data...
        </div>
      ) : (
        <div className="rounded-lg border bg-card p-4">
          <button
            type="button"
            className="flex w-full items-center gap-2 text-left"
            onClick={() => setTemplateFlowOpen(!templateFlowOpen)}
          >
            <ChevronDown className={`h-5 w-5 transition-transform ${templateFlowOpen ? "" : "-rotate-90"}`} />
            <div>
              <h2 className="text-lg font-semibold">Template Flow</h2>
              <p className="text-sm text-muted-foreground">
                Visualize how node runners create templates and structure their merkle branches for miners
              </p>
            </div>
          </button>
          {templateFlowOpen && (
            <div className="mt-3">
              <SankeyDiagram templates={templates} />
            </div>
          )}
        </div>
      )}

      <div className="rounded-lg border bg-card p-4">
        <button
          type="button"
          className="flex w-full items-center gap-2 text-left"
          onClick={() => setMinerFlowOpen(!minerFlowOpen)}
        >
          <ChevronDown className={`h-5 w-5 transition-transform ${minerFlowOpen ? "" : "-rotate-90"}`} />
          <div>
            <h2 className="text-lg font-semibold">Miner Share Flow</h2>
            <p className="text-sm text-muted-foreground">
              See how mining shares flow from miners to templates and which node runners receive work
            </p>
          </div>
        </button>
        {minerFlowOpen && (
          <div className="mt-3">
            <MinerFlowSankey />
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <RecentShares />
        <div>
          <h2 className="text-lg font-semibold">Active Miners</h2>
          <p className="text-sm text-muted-foreground mb-3">
            Miners currently connected and submitting shares to the pool
          </p>
          {minersLoading ? (
            <div className="rounded-lg border bg-card p-6 text-center text-muted-foreground animate-pulse">
              Loading miners...
            </div>
          ) : (
            <MinerTable miners={miners} />
          )}
        </div>
      </div>

      <TemplateTable />
    </div>
  );
}
