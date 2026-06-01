"use client";

import { useTheme } from "next-themes";
import { ExternalLink, RefreshCw, AlertCircle, Layers } from "lucide-react";
import { usePoolTemplates } from "@/hooks/usePoolTemplates";
import type { JobTemplate, PoolStats } from "@/hooks/usePoolTemplates";

// ── Color helpers ─────────────────────────────────────────────────────────────

function merkleColor(hex: string, dark: boolean): string {
  if (!hex || hex.length < 6) return dark ? "#1e1e2e" : "#e5e7eb";
  const n = parseInt(hex.slice(0, 6), 16);
  const hue = n % 360;
  const sat = 55 + (n % 20);
  const lit = dark ? 28 + (n % 14) : 74 + (n % 14);
  return `hsl(${hue}, ${sat}%, ${lit}%)`;
}

function merkleText(hex: string, dark: boolean): string {
  if (!hex || hex.length < 6) return dark ? "#6b7280" : "#374151";
  const n = parseInt(hex.slice(0, 6), 16);
  const hue = n % 360;
  const sat = 70 + (n % 15);
  const lit = dark ? 72 + (n % 15) : 22 + (n % 12);
  return `hsl(${hue}, ${sat}%, ${lit}%)`;
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmtJobId(id: string): string {
  return `#${id}`;
}

function fmtTimestamp(ms: string): string {
  const n = parseInt(ms);
  if (!n) return "—";
  const d = new Date(n);
  return d.toLocaleTimeString("en-US", {
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

function fmtNBits(n: string): string {
  const v = parseInt(n);
  if (!v) return "—";
  return "0x" + v.toString(16).padStart(8, "0");
}

function fmtVersion(n: string): string {
  const v = parseInt(n);
  if (!v) return "—";
  return "0x" + v.toString(16).padStart(8, "0");
}

function fmtNTime(n: string): string {
  const v = parseInt(n);
  if (!v) return "—";
  const d = new Date(v * 1000);
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function fmtReward(mist: string): string {
  const v = parseInt(mist);
  if (!v) return "—";
  const sui = v / 1_000_000_000;
  return sui.toFixed(sui < 0.01 ? 6 : 3) + " SUI";
}

function truncateAddr(addr: string, len = 6): string {
  if (!addr || addr.length < 14) return addr;
  return `${addr.slice(0, len + 2)}…${addr.slice(-4)}`;
}

function fmtTreasury(mist: string): string {
  const v = parseInt(mist);
  if (!v) return "0 SUI";
  const sui = v / 1_000_000_000;
  return sui.toFixed(4) + " SUI";
}

// ── Prev Hash Cell ────────────────────────────────────────────────────────────
// Stratum prevhash bytes are reversed relative to the Bitcoin display hash.
// Reverse the 32-byte array so leading zeros (difficulty indicator) appear first.

function PrevHashDisplay({ hex }: { hex: string }) {
  if (!hex || hex.length < 4) return <span className="text-muted-foreground">—</span>;

  // Reverse bytes → Bitcoin display order
  const pairs = hex.match(/.{2}/g) ?? [];
  const reversed = [...pairs].reverse().join("");

  // Count leading zeros (pairs of "00")
  let leadingZeroChars = 0;
  for (let i = 0; i < reversed.length; i++) {
    if (reversed[i] === "0") leadingZeroChars++;
    else break;
  }

  const zeros = reversed.slice(0, leadingZeroChars);
  // Show first 16 chars total, rest is truncated
  const visible = reversed.slice(leadingZeroChars, 16);
  const full = reversed;

  return (
    <span title={full} className="cursor-default">
      <span className="leading-zero-glow">{zeros}</span>
      <span className="text-foreground">{visible}</span>
      <span className="text-muted-foreground opacity-50">…</span>
    </span>
  );
}

// ── Pool stats banner ─────────────────────────────────────────────────────────

function PoolStatsBanner({ pool }: { pool: PoolStats }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-xs text-muted-foreground">
      <span>
        <span className="opacity-50">{"{ "}</span>
        <span className="text-foreground">pool</span>
        <span className="opacity-50">{" : "}</span>
        <span
          title={pool.poolId}
          className="cursor-default text-foreground"
        >
          {truncateAddr(pool.poolId, 8)}
        </span>
        <span className="opacity-50">{" }"}</span>
      </span>
      <span>
        <span className="opacity-50">{"{ "}</span>
        <span className="text-foreground">operator</span>
        <span className="opacity-50">{" : "}</span>
        <span title={pool.operator} className="cursor-default">
          {truncateAddr(pool.operator, 8)}
        </span>
        <span className="opacity-50">{" }"}</span>
      </span>
      <span>
        <span className="opacity-50">{"{ "}</span>
        <span className="text-foreground">shares</span>
        <span className="opacity-50">{" : "}</span>
        <span className="text-foreground">{pool.totalShares}</span>
        <span className="opacity-50">{" }"}</span>
      </span>
      <span>
        <span className="opacity-50">{"{ "}</span>
        <span className="text-foreground">difficulty</span>
        <span className="opacity-50">{" : "}</span>
        <span className="text-foreground">{pool.difficulty}</span>
        <span className="opacity-50">{" }"}</span>
      </span>
    </div>
  );
}

// ── Table row ─────────────────────────────────────────────────────────────────

function JobRow({
  job,
  maxBranches,
  dark,
}: {
  job: JobTemplate;
  maxBranches: number;
  dark: boolean;
}) {
  const cells: React.ReactNode[] = [];
  for (let i = 0; i < maxBranches; i++) {
    const branch = job.merkleBranches[i];
    if (branch) {
      cells.push(
        <td
          key={i}
          style={{
            backgroundColor: merkleColor(branch, dark),
            color: merkleText(branch, dark),
          }}
          className="px-2 py-1 font-mono text-[11px] whitespace-nowrap border-r border-border/30"
          title={branch}
        >
          {branch.slice(0, 7)}
        </td>
      );
    } else {
      cells.push(
        <td
          key={i}
          className="px-2 py-1 text-muted-foreground/20 border-r border-border/30 text-[11px]"
        >
          ·
        </td>
      );
    }
  }

  return (
    <tr className="border-b border-border/50 hover:bg-accent/40 transition-colors group">
      {/* Job ID */}
      <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground whitespace-nowrap border-r border-border/30 sticky left-0 bg-card group-hover:bg-accent/40 transition-colors z-10">
        {fmtJobId(job.jobId)}
      </td>

      {/* Posted timestamp */}
      <td className="px-3 py-1.5 font-mono text-xs whitespace-nowrap border-r border-border/30">
        <div className="text-foreground tabular-nums">{fmtTimestamp(job.timestampMs)}</div>
        <div className="text-muted-foreground text-[10px]">{fmtDate(job.timestampMs)}</div>
      </td>

      {/* Prev Hash */}
      <td className="px-3 py-1.5 font-mono text-xs whitespace-nowrap border-r border-border/30">
        <PrevHashDisplay hex={job.prevHash} />
      </td>

      {/* Coinbase ASCII */}
      <td
        className="px-3 py-1.5 font-mono text-xs whitespace-nowrap border-r border-border/30 max-w-[180px] overflow-hidden text-ellipsis"
        title={job.coinbaseAscii}
      >
        <span className="text-foreground">{job.coinbaseAscii || <span className="text-muted-foreground">—</span>}</span>
      </td>

      {/* Version */}
      <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground whitespace-nowrap border-r border-border/30 tabular-nums">
        {fmtVersion(job.version)}
      </td>

      {/* nBits */}
      <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground whitespace-nowrap border-r border-border/30 tabular-nums">
        {fmtNBits(job.nBits)}
      </td>

      {/* nTime */}
      <td className="px-3 py-1.5 font-mono text-xs whitespace-nowrap border-r border-border/30 tabular-nums text-foreground">
        {fmtNTime(job.nTime)}
      </td>

      {/* Merkle branches */}
      {cells}

      {/* Tx link */}
      <td className="px-3 py-1.5 whitespace-nowrap">
        {job.txDigest ? (
          <a
            href={`https://suiexplorer.com/txblock/${job.txDigest}?network=devnet`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground transition-colors"
            title={job.txDigest}
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

export function PoolTemplatesTable() {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const { data, isLoading, error, refetch, isFetching } = usePoolTemplates();

  const jobs = data?.jobs ?? [];
  const pool = data?.pool;
  const maxBranches = jobs.reduce((m, j) => Math.max(m, j.merkleBranches.length), 0);

  // ── Loading state ─────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <div className="h-6 w-96 animate-pulse rounded bg-muted" />
        <div className="overflow-hidden rounded-lg border border-border">
          {[...Array(8)].map((_, i) => (
            <div
              key={i}
              className="flex gap-3 border-b border-border/50 px-4 py-2.5"
            >
              <div
                className="h-4 animate-pulse rounded bg-muted"
                style={{ width: `${40 + (i * 17) % 80}px` }}
              />
              <div className="h-4 w-24 animate-pulse rounded bg-muted" />
              <div className="h-4 w-36 animate-pulse rounded bg-muted" />
              <div className="h-4 w-28 animate-pulse rounded bg-muted" />
              <div className="h-4 w-20 animate-pulse rounded bg-muted" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── Error / not configured ────────────────────────────────────────────────
  if (error) {
    const isUnconfigured = error.message.includes("not configured");
    return (
      <div className="flex flex-col items-center gap-4 py-24 text-center">
        <AlertCircle className="h-10 w-10 text-muted-foreground/40" />
        <div>
          <p className="font-mono text-sm text-foreground">
            {isUnconfigured ? "Pool not configured" : "Failed to load templates"}
          </p>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {isUnconfigured
              ? "Set POOL_OBJECT_ID and PACKAGE_ID in your environment"
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

  // ── Empty state ───────────────────────────────────────────────────────────
  if (jobs.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        {pool && <PoolStatsBanner pool={pool} />}
        <div className="flex flex-col items-center gap-4 py-24 text-center rounded-lg border border-border">
          <Layers className="h-10 w-10 text-muted-foreground/30" />
          <p className="font-mono text-sm text-muted-foreground">No job templates on-chain yet</p>
        </div>
      </div>
    );
  }

  // ── Table ─────────────────────────────────────────────────────────────────
  const merkleHeaders = Array.from({ length: maxBranches }, (_, i) => (
    <th
      key={i}
      className="px-2 py-2 font-mono text-[11px] font-medium text-muted-foreground whitespace-nowrap border-r border-border/30 text-left"
    >
      Merk.{i}
    </th>
  ));

  return (
    <div className="flex flex-col gap-3">
      {/* Stats banner */}
      {pool && <PoolStatsBanner pool={pool} />}

      {/* Table header row */}
      <div className="flex items-center justify-between">
        <p className="font-mono text-xs text-muted-foreground">
          {jobs.length} template{jobs.length !== 1 ? "s" : ""} · auto-refreshes every 30s
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

      {/* Scrollable table */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <th className="px-3 py-2 font-mono text-xs font-medium text-muted-foreground whitespace-nowrap border-r border-border/30 text-left sticky left-0 bg-muted/30 z-10">
                Job
              </th>
              <th className="px-3 py-2 font-mono text-xs font-medium text-muted-foreground whitespace-nowrap border-r border-border/30 text-left">
                Posted
              </th>
              <th className="px-3 py-2 font-mono text-xs font-medium text-muted-foreground whitespace-nowrap border-r border-border/30 text-left">
                Prev Hash
              </th>
              <th className="px-3 py-2 font-mono text-xs font-medium text-muted-foreground whitespace-nowrap border-r border-border/30 text-left">
                Coinbase
              </th>
              <th className="px-3 py-2 font-mono text-xs font-medium text-muted-foreground whitespace-nowrap border-r border-border/30 text-left">
                Version
              </th>
              <th className="px-3 py-2 font-mono text-xs font-medium text-muted-foreground whitespace-nowrap border-r border-border/30 text-left">
                nBits
              </th>
              <th className="px-3 py-2 font-mono text-xs font-medium text-muted-foreground whitespace-nowrap border-r border-border/30 text-left">
                nTime
              </th>
              {merkleHeaders}
              <th className="px-3 py-2 font-mono text-xs font-medium text-muted-foreground whitespace-nowrap text-left">
                Tx
              </th>
            </tr>
          </thead>
          <tbody className="bg-card">
            {jobs.map(job => (
              <JobRow
                key={job.jobId}
                job={job}
                maxBranches={maxBranches}
                dark={dark}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
