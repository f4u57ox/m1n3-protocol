"use client";

import { ExternalLink, RefreshCw, AlertCircle, CheckCircle2 } from "lucide-react";
import { useShares } from "@/hooks/useShares";
import type { ShareEvent } from "@/hooks/useShares";

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmtTimestamp(ms: string): string {
  const n = parseInt(ms);
  if (!n) return "—";
  return new Date(n).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function fmtDate(ms: string): string {
  const n = parseInt(ms);
  if (!n) return "";
  return new Date(n).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function truncateAddr(addr: string, len = 6): string {
  if (!addr || addr.length < 14) return addr;
  return `${addr.slice(0, len + 2)}…${addr.slice(-4)}`;
}

function fmtNonce(n: string): string {
  const v = parseInt(n);
  if (isNaN(v)) return n;
  return "0x" + v.toString(16).padStart(8, "0");
}

// ── Row ───────────────────────────────────────────────────────────────────────

function ShareRow({ share, index }: { share: ShareEvent; index: number }) {
  return (
    <tr className="border-b border-border/50 hover:bg-accent/40 transition-colors group">
      {/* Index */}
      <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground/50 whitespace-nowrap border-r border-border/30 tabular-nums">
        {index + 1}
      </td>

      {/* Timestamp */}
      <td className="px-3 py-1.5 font-mono text-xs whitespace-nowrap border-r border-border/30">
        <div className="text-foreground tabular-nums">{fmtTimestamp(share.timestampMs)}</div>
        <div className="text-muted-foreground text-[10px]">{fmtDate(share.timestampMs)}</div>
      </td>

      {/* Worker */}
      <td
        className="px-3 py-1.5 font-mono text-xs whitespace-nowrap border-r border-border/30 text-foreground"
        title={share.worker}
      >
        {truncateAddr(share.worker, 8)}
      </td>

      {/* Job ID */}
      <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground whitespace-nowrap border-r border-border/30 tabular-nums">
        #{share.jobId}
      </td>

      {/* Nonce */}
      <td className="px-3 py-1.5 font-mono text-xs text-foreground whitespace-nowrap border-r border-border/30 tabular-nums">
        {fmtNonce(share.nonce)}
      </td>

      {/* Difficulty */}
      <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground whitespace-nowrap border-r border-border/30 tabular-nums">
        {parseInt(share.difficulty).toLocaleString()}
      </td>

      {/* Status */}
      <td className="px-3 py-1.5 whitespace-nowrap border-r border-border/30">
        <span className="flex items-center gap-1 font-mono text-xs text-emerald-500">
          <CheckCircle2 className="h-3 w-3" />
          accepted
        </span>
      </td>

      {/* Tx link */}
      <td className="px-3 py-1.5 whitespace-nowrap">
        {share.txDigest ? (
          <a
            href={`https://suiexplorer.com/txblock/${share.txDigest}?network=devnet`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground transition-colors"
            title={share.txDigest}
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <span className="text-muted-foreground/30">—</span>
        )}
      </td>
    </tr>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function SharesTable() {
  const { data, isLoading, error, refetch, isFetching } = useShares();
  const shares = data?.shares ?? [];

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <div className="h-6 w-64 animate-pulse rounded bg-muted" />
        <div className="overflow-hidden rounded-lg border border-border">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="flex gap-3 border-b border-border/50 px-4 py-2.5">
              <div className="h-4 w-8 animate-pulse rounded bg-muted" />
              <div className="h-4 w-20 animate-pulse rounded bg-muted" />
              <div className="h-4 w-32 animate-pulse rounded bg-muted" />
              <div className="h-4 w-12 animate-pulse rounded bg-muted" />
              <div className="h-4 w-24 animate-pulse rounded bg-muted" />
              <div className="h-4 w-16 animate-pulse rounded bg-muted" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    const isUnconfigured = error.message.includes("not configured");
    return (
      <div className="flex flex-col items-center gap-4 py-24 text-center">
        <AlertCircle className="h-10 w-10 text-muted-foreground/40" />
        <div>
          <p className="font-mono text-sm text-foreground">
            {isUnconfigured ? "Package not configured" : "Failed to load shares"}
          </p>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {isUnconfigured
              ? "Set PACKAGE_ID in your environment"
              : error.message}
          </p>
        </div>
        {!isUnconfigured && (
          <button
            onClick={() => refetch()}
            className="mt-2 flex items-center gap-2 rounded-md border border-border px-3 py-1.5 font-mono text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <RefreshCw className="h-3 w-3" />
            Retry
          </button>
        )}
      </div>
    );
  }

  if (shares.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-24 text-center rounded-lg border border-border">
        <CheckCircle2 className="h-10 w-10 text-muted-foreground/30" />
        <p className="font-mono text-sm text-muted-foreground">No shares on-chain yet</p>
        <p className="font-mono text-xs text-muted-foreground/60">
          Shares appear here once the bridge accepts and records them
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <p className="font-mono text-xs text-muted-foreground">
          {shares.length} share{shares.length !== 1 ? "s" : ""} · auto-refreshes every 15s
        </p>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-40"
        >
          <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <th className="px-3 py-2 font-mono text-xs font-medium text-muted-foreground whitespace-nowrap border-r border-border/30 text-left w-8">
                #
              </th>
              <th className="px-3 py-2 font-mono text-xs font-medium text-muted-foreground whitespace-nowrap border-r border-border/30 text-left">
                Time
              </th>
              <th className="px-3 py-2 font-mono text-xs font-medium text-muted-foreground whitespace-nowrap border-r border-border/30 text-left">
                Worker
              </th>
              <th className="px-3 py-2 font-mono text-xs font-medium text-muted-foreground whitespace-nowrap border-r border-border/30 text-left">
                Job
              </th>
              <th className="px-3 py-2 font-mono text-xs font-medium text-muted-foreground whitespace-nowrap border-r border-border/30 text-left">
                Nonce
              </th>
              <th className="px-3 py-2 font-mono text-xs font-medium text-muted-foreground whitespace-nowrap border-r border-border/30 text-left">
                Difficulty
              </th>
              <th className="px-3 py-2 font-mono text-xs font-medium text-muted-foreground whitespace-nowrap border-r border-border/30 text-left">
                Status
              </th>
              <th className="px-3 py-2 font-mono text-xs font-medium text-muted-foreground whitespace-nowrap text-left">
                Tx
              </th>
            </tr>
          </thead>
          <tbody className="bg-card">
            {shares.map((share, i) => (
              <ShareRow key={`${share.txDigest}-${i}`} share={share} index={i} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
