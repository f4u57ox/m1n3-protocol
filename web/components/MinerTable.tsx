"use client";

import { useState, useMemo } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  truncateAddress,
  solscanAccount,
  timeAgo,
  formatDifficulty,
  formatHashrate,
} from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { STALENESS_THRESHOLD_MS } from "@/lib/constants";
import type { MinerStatsData } from "@/lib/types";

type SortKey = keyof MinerStatsData;
type SortDir = "asc" | "desc";

interface MinerTableProps {
  miners: MinerStatsData[];
}

/** True when a miner hasn't submitted a share in > staleness threshold. */
function isStale(miner: MinerStatsData): boolean {
  if (miner.lastShareTimeMs === 0) return false;
  return Date.now() - miner.lastShareTimeMs > STALENESS_THRESHOLD_MS;
}

export function MinerTable({ miners }: MinerTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("totalShares");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const sorted = useMemo(() => {
    const copy = [...miners];
    copy.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "number" && typeof bv === "number") {
        return sortDir === "asc" ? av - bv : bv - av;
      }
      return sortDir === "asc"
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return copy;
  }, [miners, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function sortIndicator(key: SortKey) {
    if (sortKey !== key) return "";
    return sortDir === "asc" ? " \u2191" : " \u2193";
  }

  if (miners.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground space-y-2">
        <p>No miners active yet</p>
        <p className="text-sm">
          Miners appear here once they connect and submit their first share.{" "}
          <a href="/info?tab=setup" className="text-primary hover:underline">
            See the Setup guide to get started.
          </a>
        </p>
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead
            className="cursor-pointer select-none"
            onClick={() => toggleSort("address")}
          >
            Address{sortIndicator("address")}
          </TableHead>
          <TableHead className="text-center">
            Status
            <InfoTooltip text="Active = submitted a share recently. Stale = no shares for an extended period" />
          </TableHead>
          <TableHead className="text-center">
            Mode
            <InfoTooltip text="Solo = uses own template. Pooled = uses another node runner's template" />
          </TableHead>
          <TableHead
            className="cursor-pointer select-none text-right"
            onClick={() => toggleSort("totalShares")}
          >
            Total Shares{sortIndicator("totalShares")}
            <InfoTooltip text="Total proof-of-work shares submitted across all rounds" />
          </TableHead>
          <TableHead
            className="cursor-pointer select-none text-right"
            onClick={() => toggleSort("blocksFound")}
          >
            Blocks Found{sortIndicator("blocksFound")}
            <InfoTooltip text="Bitcoin blocks this miner has found" />
          </TableHead>
          <TableHead
            className="cursor-pointer select-none text-right"
            onClick={() => toggleSort("estimatedHashrate")}
          >
            Hashrate{sortIndicator("estimatedHashrate")}
            <InfoTooltip text="Estimated computing power based on share submission rate" />
          </TableHead>
          <TableHead
            className="cursor-pointer select-none text-right"
            onClick={() => toggleSort("lastShareTimeMs")}
          >
            Last Active{sortIndicator("lastShareTimeMs")}
            <InfoTooltip text="Time since most recent share submission" />
          </TableHead>
          <TableHead
            className="cursor-pointer select-none text-right"
            onClick={() => toggleSort("currentRoundWork")}
          >
            Round Work{sortIndicator("currentRoundWork")}
            <InfoTooltip text="Shares submitted in the current round only" />
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((miner) => {
          const stale = isStale(miner);
          return (
            <TableRow key={miner.address} className={stale ? "opacity-60" : ""}>
              <TableCell className="font-mono text-xs">
                <a
                  href={solscanAccount(miner.address)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  {truncateAddress(miner.address)}
                </a>
              </TableCell>
              <TableCell className="text-center">
                {stale ? (
                  <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-yellow-500/10 text-yellow-600 dark:text-yellow-400">
                    Stale
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-green-500/10 text-green-600 dark:text-green-400">
                    Active
                  </span>
                )}
              </TableCell>
              <TableCell className="text-center">
                {miner.miningMode === "solo" ? (
                  <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-green-500/10 text-green-600 dark:text-green-400">
                    Solo
                  </span>
                ) : miner.miningMode === "pooled" ? (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400 cursor-help">
                          Pooled
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Template by {truncateAddress(miner.templateOwner ?? "")}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-gray-500/10 text-gray-600 dark:text-gray-400">
                    —
                  </span>
                )}
              </TableCell>
              <TableCell className="text-right">
                {miner.totalShares.toLocaleString()}
              </TableCell>
              <TableCell className="text-right">
                {miner.blocksFound.toLocaleString()}
              </TableCell>
              <TableCell className="text-right">
                {miner.estimatedHashrate > 0
                  ? formatHashrate(miner.estimatedHashrate)
                  : "\u2014"}
              </TableCell>
              <TableCell className="text-right">
                {miner.lastShareTimeMs > 0 ? timeAgo(miner.lastShareTimeMs) : "\u2014"}
              </TableCell>
              <TableCell className="text-right">
                {miner.currentRoundWork.toLocaleString()}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
