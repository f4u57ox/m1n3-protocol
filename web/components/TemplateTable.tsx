"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useTemplates } from "@/hooks/useTemplates";
import { truncateAddress, formatHex } from "@/lib/utils";
import {
  decodeCoinbaseAscii,
  getMerkleColor,
  formatNtime,
} from "@/lib/bitcoin-utils";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ArrowUpDown, ExternalLink, Columns3, ChevronRight, FileCode2 } from "lucide-react";
import type { TemplateData } from "@/lib/types";
import { TemplateCard } from "./TemplateCard";
import { suiscanTx } from "@/lib/utils";

type SortKey = keyof TemplateData;
type SortDir = "asc" | "desc";

// Maximum number of individual merkle branch columns to display
const MAX_MERKLE_COLS = 13;

// All toggleable column keys
type ColumnKey =
  | "owner"
  | "height"
  | "coinbaseAscii"
  | "timeReceived"
  | "ntime"
  | "merkle"
  | "coinbaseRaw"
  | "shares"
  | "status";

const COLUMN_LABELS: Record<ColumnKey, string> = {
  owner: "Node",
  height: "Height",
  coinbaseAscii: "Coinbase Script",
  timeReceived: "Time Received",
  ntime: "Ntime",
  merkle: "Merkle Branches",
  coinbaseRaw: "Coinbase Raw",
  shares: "Shares",
  status: "Status",
};

const DEFAULT_VISIBLE: Set<ColumnKey> = new Set([
  "owner",
  "height",
  "ntime",
  "merkle",
  "shares",
  "status",
]);

export function TemplateTable({ excludeId }: { excludeId?: string } = {}) {
  const { templates: allTemplates, loading, error } = useTemplates();
  const templates = useMemo(
    () => (excludeId ? allTemplates.filter((t) => t.id !== excludeId) : allTemplates),
    [allTemplates, excludeId],
  );
  const [sortKey, setSortKey] = useState<SortKey>("createdAtMs");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [filter, setFilter] = useState("");
  const [visibleCols, setVisibleCols] =
    useState<Set<ColumnKey>>(DEFAULT_VISIBLE);
  const [showColMenu, setShowColMenu] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const sorted = useMemo(() => {
    let filtered = templates;
    if (filter) {
      const q = filter.toLowerCase();
      filtered = templates.filter(
        (t) =>
          t.id.toLowerCase().includes(q) ||
          t.owner.toLowerCase().includes(q) ||
          t.height.toString().includes(q)
      );
    }

    return [...filtered].sort((a, b) => {
      const aVal = a[sortKey];
      const bVal = b[sortKey];
      if (typeof aVal === "number" && typeof bVal === "number") {
        return sortDir === "asc" ? aVal - bVal : bVal - aVal;
      }
      const aStr = String(aVal);
      const bStr = String(bVal);
      return sortDir === "asc"
        ? aStr.localeCompare(bStr)
        : bStr.localeCompare(aStr);
    });
  }, [templates, sortKey, sortDir, filter]);

  // Compute max merkle branches across all visible templates
  const maxBranches = useMemo(() => {
    let max = 0;
    for (const t of sorted) {
      if (t.merkleBranches.length > max) max = t.merkleBranches.length;
    }
    return Math.min(max, MAX_MERKLE_COLS);
  }, [sorted]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const toggleCol = (key: ColumnKey) => {
    setVisibleCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const isVisible = (key: ColumnKey) => visibleCols.has(key);

  if (loading) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground">
        Loading templates...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border bg-destructive/10 p-8 text-center text-destructive">
        Error: {error}
      </div>
    );
  }

  const SortableHead = ({
    children,
    sortBy,
    className,
  }: {
    children: React.ReactNode;
    sortBy: SortKey;
    className?: string;
  }) => (
    <TableHead
      className={`cursor-pointer select-none hover:bg-muted/50 ${className ?? ""}`}
      onClick={() => toggleSort(sortBy)}
    >
      <div className="flex items-center gap-1 whitespace-nowrap">
        {children}
        <ArrowUpDown className="h-3 w-3 text-muted-foreground" />
      </div>
    </TableHead>
  );

  // Count total visible columns for empty state colspan
  let totalCols = 0;
  if (isVisible("owner")) totalCols++;
  if (isVisible("height")) totalCols++;
  if (isVisible("coinbaseAscii")) totalCols++;
  if (isVisible("timeReceived")) totalCols++;
  if (isVisible("ntime")) totalCols++;
  if (isVisible("merkle")) totalCols += maxBranches || 1;
  if (isVisible("coinbaseRaw")) totalCols++;
  if (isVisible("shares")) totalCols++;
  if (isVisible("status")) totalCols++;
  totalCols++; // link column

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <input
          type="text"
          placeholder="Filter by ID, owner, or height..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="flex h-9 rounded-md border bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring w-72"
        />
        <span className="text-sm text-muted-foreground">
          {sorted.length} template{sorted.length !== 1 ? "s" : ""}
        </span>

        {/* Column visibility toggle */}
        <div className="relative ml-auto">
          <button
            onClick={() => setShowColMenu((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-muted/50"
          >
            <Columns3 className="h-3.5 w-3.5" />
            Columns
          </button>
          {showColMenu && (
            <div className="absolute right-0 z-50 mt-1 w-48 rounded-md border bg-popover p-2 shadow-md">
              {(Object.keys(COLUMN_LABELS) as ColumnKey[]).map((key) => (
                <label
                  key={key}
                  className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted/50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={isVisible(key)}
                    onChange={() => toggleCol(key)}
                    className="rounded"
                  />
                  {COLUMN_LABELS[key]}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <div className="overflow-x-auto">
          <TooltipProvider delayDuration={200}>
            <Table>
              <TableHeader>
                <TableRow>
                  {isVisible("owner") && (
                    <TableHead className="sticky left-0 z-10 bg-background whitespace-nowrap">
                      Node
                    </TableHead>
                  )}
                  {isVisible("height") && (
                    <SortableHead
                      sortBy="height"
                      className="sticky left-[100px] z-10 bg-background"
                    >
                      Height
                    </SortableHead>
                  )}
                  {isVisible("coinbaseAscii") && (
                    <TableHead className="whitespace-nowrap">
                      Coinbase Script
                    </TableHead>
                  )}
                  {isVisible("timeReceived") && (
                    <SortableHead sortBy="createdAtMs">
                      Time Received
                    </SortableHead>
                  )}
                  {isVisible("ntime") && (
                    <SortableHead sortBy="ntime">Ntime</SortableHead>
                  )}
                  {isVisible("merkle") &&
                    Array.from({ length: maxBranches }, (_, i) => (
                      <TableHead
                        key={`mh-${i}`}
                        className="whitespace-nowrap text-center text-xs"
                      >
                        M{i}
                      </TableHead>
                    ))}
                  {isVisible("coinbaseRaw") && (
                    <TableHead className="whitespace-nowrap">
                      Coinbase Raw
                    </TableHead>
                  )}
                  {isVisible("shares") && (
                    <SortableHead sortBy="shareCount">Shares</SortableHead>
                  )}
                  {isVisible("status") && (
                    <TableHead className="whitespace-nowrap">Status</TableHead>
                  )}
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={totalCols}
                      className="text-center text-muted-foreground py-8"
                    >
                      No templates found
                    </TableCell>
                  </TableRow>
                ) : (
                  sorted.flatMap((t) => {
                    const coinbaseAscii = decodeCoinbaseAscii(t.coinbase1);
                    const isExpanded = expandedId === t.id;
                    const toggle = () =>
                      setExpandedId((cur) => (cur === t.id ? null : t.id));

                    return [
                      <TableRow
                        key={t.id}
                        onClick={toggle}
                        data-state={isExpanded ? "expanded" : undefined}
                        className="cursor-pointer hover:bg-muted/40 data-[state=expanded]:bg-muted/60"
                      >
                        {/* Owner */}
                        {isVisible("owner") && (
                          <TableCell className="sticky left-0 z-10 bg-background font-mono text-xs">
                            <span className="inline-flex items-center gap-1">
                              <ChevronRight
                                className={`h-3 w-3 text-muted-foreground transition-transform ${isExpanded ? "rotate-90" : ""}`}
                              />
                              {truncateAddress(t.owner)}
                            </span>
                          </TableCell>
                        )}

                        {/* Height */}
                        {isVisible("height") && (
                          <TableCell className="sticky left-[100px] z-10 bg-background font-mono font-medium">
                            {t.height.toLocaleString()}
                          </TableCell>
                        )}

                        {/* Coinbase Script (ASCII) */}
                        {isVisible("coinbaseAscii") && (
                          <TableCell className="font-mono text-xs max-w-[200px] truncate">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="cursor-default">
                                  {coinbaseAscii || (
                                    <span className="text-muted-foreground italic">
                                      n/a
                                    </span>
                                  )}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="bottom" className="max-w-md font-mono text-xs break-all">
                                {coinbaseAscii || "No ASCII data in coinbase"}
                              </TooltipContent>
                            </Tooltip>
                          </TableCell>
                        )}

                        {/* Time Received */}
                        {isVisible("timeReceived") && (
                          <TableCell className="text-muted-foreground whitespace-nowrap text-xs">
                            {t.createdAtMs
                              ? new Date(t.createdAtMs).toLocaleTimeString(
                                  "en-US",
                                  {
                                    hour12: false,
                                    hour: "2-digit",
                                    minute: "2-digit",
                                    second: "2-digit",
                                  }
                                )
                              : "--:--:--"}
                          </TableCell>
                        )}

                        {/* Ntime */}
                        {isVisible("ntime") && (
                          <TableCell className="font-mono text-xs whitespace-nowrap">
                            {formatNtime(t.ntime)}
                          </TableCell>
                        )}

                        {/* Merkle branches (individual color-coded columns) */}
                        {isVisible("merkle") &&
                          Array.from({ length: maxBranches }, (_, i) => {
                            const branch = t.merkleBranches[i];
                            if (!branch) {
                              return (
                                <TableCell
                                  key={`m-${t.id}-${i}`}
                                  className="text-center text-muted-foreground"
                                >
                                  -
                                </TableCell>
                              );
                            }
                            const color = getMerkleColor(branch);
                            const displayBranch = branch;
                            return (
                              <TableCell
                                key={`m-${t.id}-${i}`}
                                className="text-center px-1"
                              >
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span
                                      className="inline-block rounded px-1.5 py-0.5 font-mono text-xs text-white cursor-default"
                                      style={{ backgroundColor: color }}
                                    >
                                      {displayBranch.slice(0, 6)}
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent side="bottom" className="font-mono text-xs break-all max-w-md">
                                    {displayBranch}
                                  </TooltipContent>
                                </Tooltip>
                              </TableCell>
                            );
                          })}

                        {/* Coinbase Raw */}
                        {isVisible("coinbaseRaw") && (
                          <TableCell className="font-mono text-xs max-w-[140px] truncate">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="cursor-default">
                                  {formatHex(t.coinbase1, 20)}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="bottom" className="font-mono text-xs break-all max-w-lg">
                                {t.coinbase1}
                              </TooltipContent>
                            </Tooltip>
                          </TableCell>
                        )}

                        {/* Shares */}
                        {isVisible("shares") && (
                          <TableCell>
                            {t.shareCount.toLocaleString()}
                          </TableCell>
                        )}

                        {/* Status */}
                        {isVisible("status") && (
                          <TableCell>
                            <Badge
                              variant={t.isActive ? "default" : "secondary"}
                            >
                              {t.isActive ? "Active" : "Inactive"}
                            </Badge>
                          </TableCell>
                        )}

                        {/* Links — deep-link to template detail page +
                            external tx links: template registration + most
                            recent share submission on suiscan. */}
                        <TableCell>
                          <div className="inline-flex items-center gap-2">
                            <Link
                              href={`/template/${t.id}`}
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center text-sm text-primary hover:underline"
                              aria-label="Open template detail page"
                              title="Open template detail page"
                            >
                              <FileCode2 className="h-3 w-3" />
                            </Link>
                            {t.registrationDigest ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <a
                                    href={suiscanTx(t.registrationDigest)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="inline-flex items-center text-sm text-emerald-400 hover:underline"
                                    aria-label="View registration tx on suiscan"
                                  >
                                    <ExternalLink className="h-3 w-3" />
                                  </a>
                                </TooltipTrigger>
                                <TooltipContent side="left" className="font-mono text-[10px]">
                                  Registration tx
                                </TooltipContent>
                              </Tooltip>
                            ) : (
                              <ExternalLink className="h-3 w-3 text-muted-foreground/30" />
                            )}
                            {t.lastShareDigest ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <a
                                    href={suiscanTx(t.lastShareDigest)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="inline-flex items-center text-sm text-sky-400 hover:underline"
                                    aria-label="View latest share-submission tx on suiscan"
                                  >
                                    <ExternalLink className="h-3 w-3" />
                                  </a>
                                </TooltipTrigger>
                                <TooltipContent side="left" className="font-mono text-[10px]">
                                  Last share submission tx
                                </TooltipContent>
                              </Tooltip>
                            ) : (
                              <ExternalLink className="h-3 w-3 text-muted-foreground/30" />
                            )}
                          </div>
                        </TableCell>
                      </TableRow>,
                      isExpanded ? (
                        <TableRow
                          key={`${t.id}-detail`}
                          className="hover:bg-transparent"
                        >
                          <TableCell
                            colSpan={totalCols}
                            className="p-0 bg-background"
                          >
                            <div className="p-4 border-t border-border/60">
                              <TemplateCard template={t} />
                            </div>
                          </TableCell>
                        </TableRow>
                      ) : null,
                    ];
                  })
                )}
              </TableBody>
            </Table>
          </TooltipProvider>
        </div>
      </div>
    </div>
  );
}
