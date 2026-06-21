"use client";

import { useMemo, useState } from "react";
import type { TemplateData } from "@/lib/types";
import {
  decodeCoinbaseAscii,
  getMerkleColor,
  parseCoinbaseHeight,
  reverseHex,
} from "@/lib/bitcoin-utils";
import { truncateAddress, suiscanObject, suiscanTx, timeAgo } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { TemplateCard } from "./TemplateCard";
import { ChevronDown, ExternalLink, FileCode2 } from "lucide-react";

/**
 * Featured-template hero. The latest template renders as a Bitcoin-block
 * silhouette; the full `TemplateCard` detail is hidden behind a toggle on
 * the square itself. Collapsed by default so the page leads with the
 * compact, visual summary and the detail is one click away.
 */
export function FeaturedTemplate({ template: t }: { template: TemplateData }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className={`grid gap-4 ${
        expanded
          ? "lg:grid-cols-[minmax(260px,300px)_1fr] xl:grid-cols-[320px_1fr]"
          : "lg:grid-cols-[minmax(260px,300px)] xl:grid-cols-[320px]"
      }`}
    >
      <BlockSquare
        template={t}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
      />
      {expanded && (
        <div className="min-w-0">
          <TemplateCard template={t} />
        </div>
      )}
    </div>
  );
}

function BlockSquare({
  template: t,
  expanded,
  onToggle,
}: {
  template: TemplateData;
  expanded: boolean;
  onToggle: () => void;
}) {
  const coinbaseAscii = useMemo(
    () => decodeCoinbaseAscii(t.coinbase1),
    [t.coinbase1],
  );
  const bip34Height = useMemo(
    () => parseCoinbaseHeight(t.coinbase1),
    [t.coinbase1],
  );
  const prevTail = t.prevBlockHash ? reverseHex(t.prevBlockHash).slice(-12) : "";

  // 4×4 grid of merkle squares for the "transaction tray" visualization.
  // Fill empties with muted slots so the geometry stays a perfect square.
  const branches = t.merkleBranches.slice(0, 16);
  const emptySlots = Math.max(0, 16 - branches.length);

  return (
    <div
      className={`group relative flex aspect-square w-full cursor-pointer flex-col overflow-hidden rounded-2xl border-2 bg-card/70 p-4 shadow-[0_8px_32px_-12px_rgba(0,0,0,0.5)] backdrop-blur transition-colors hover:border-primary/50 sm:p-5 ${
        expanded ? "border-primary" : "border-border"
      }`}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      aria-label={expanded ? "Collapse template details" : "Expand template details"}
    >
      {/* Subtle block-lattice background */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, currentColor 0 1px, transparent 1px 12px), repeating-linear-gradient(90deg, currentColor 0 1px, transparent 1px 12px)",
        }}
      />

      {/* Header: chain height + status */}
      <div className="relative flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-[9px] uppercase tracking-[0.3em] text-muted-foreground">
            Latest template
          </p>
          <h2 className="mt-1 font-mono text-2xl font-bold leading-none sm:text-3xl">
            #{t.height.toLocaleString()}
          </h2>
          {prevTail && (
            <p className="mt-1 font-mono text-[9px] text-muted-foreground/70">
              prev …{prevTail}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Badge variant={t.isActive ? "default" : "secondary"}>
            {t.isActive ? "Active" : "Historic"}
          </Badge>
          <span
            aria-hidden
            className={`inline-flex h-5 w-5 items-center justify-center rounded-full border border-border/60 bg-background/60 transition-transform ${
              expanded ? "rotate-180" : ""
            }`}
            title={expanded ? "Hide details" : "Show details"}
          >
            <ChevronDown className="h-3 w-3" />
          </span>
        </div>
      </div>

      {/* Merkle "tx tray" — 4×4 grid of branch tiles. Each tile shows its
          index (M0…M15) and the first 3 bytes of the branch hash so the
          square reads as data, not abstract decoration. Background color
          stays as the per-hash hue from getMerkleColor() so visual
          identity carries over to the templates table's M0…Mn columns. */}
      <div
        className="relative my-3 grid flex-1 grid-cols-4 gap-1"
        aria-label={`${t.merkleBranches.length} merkle branches`}
      >
        {branches.map((b, i) => (
          <div
            key={i}
            className="flex flex-col items-center justify-center overflow-hidden rounded-[3px] border border-border/30 font-mono text-white"
            style={{
              backgroundColor: getMerkleColor(b),
              textShadow: "0 1px 2px rgba(0,0,0,0.55)",
            }}
            title={`M${i}: ${b.slice(0, 16)}…`}
          >
            <span className="text-[8px] uppercase tracking-wider opacity-80 leading-none">
              M{i}
            </span>
            <span className="mt-0.5 text-[9px] sm:text-[10px] leading-none">
              {b.slice(0, 6)}
            </span>
          </div>
        ))}
        {Array.from({ length: emptySlots }, (_, i) => (
          <div
            key={`empty-${i}`}
            className="flex items-center justify-center rounded-[3px] bg-muted/15 font-mono text-[8px] text-muted-foreground/40"
            aria-hidden
          >
            ·
          </div>
        ))}
      </div>

      {/* Facts strip */}
      <div className="relative space-y-1 font-mono text-[10px] sm:text-[11px]">
        <Row label="Shares">{t.shareCount.toLocaleString()}</Row>
        <Row label="Branches">{t.merkleBranches.length}</Row>
        {bip34Height !== null && (
          <Row label="BIP-34">
            <span
              className={
                bip34Height === t.height
                  ? "text-emerald-400"
                  : "text-rose-400"
              }
            >
              {bip34Height.toLocaleString()}{" "}
              {bip34Height === t.height ? "✓" : "✗"}
            </span>
          </Row>
        )}
        <Row label="Registered">{timeAgo(t.createdAtMs)}</Row>
        <Row label="Operator">
          <a
            href={suiscanObject(t.owner)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-foreground hover:underline"
          >
            {truncateAddress(t.owner)}
          </a>
        </Row>
        {coinbaseAscii && (
          <Row label="Tag">
            <span className="inline-block max-w-[140px] truncate align-bottom text-foreground">
              {coinbaseAscii.slice(0, 22)}
            </span>
          </Row>
        )}
      </div>

      {/* Footer links */}
      <div className="relative mt-3 flex items-center justify-between border-t border-border/40 pt-2.5">
        <a
          href={`/template/${t.id}`}
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.2em] text-primary hover:underline"
          title="Open template detail page"
        >
          <FileCode2 className="h-3 w-3" />
          Detail
        </a>
        <div className="flex items-center gap-2 font-mono text-[10px]">
          {t.registrationDigest && (
            <a
              href={suiscanTx(t.registrationDigest)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-emerald-400 hover:underline"
              title="View registration tx on suiscan"
            >
              <ExternalLink className="h-3 w-3" />
              reg
            </a>
          )}
          {t.lastShareDigest && (
            <a
              href={suiscanTx(t.lastShareDigest)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-sky-400 hover:underline"
              title="View latest share submission tx on suiscan"
            >
              <ExternalLink className="h-3 w-3" />
              share
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[9px] uppercase tracking-[0.18em] text-muted-foreground/70">
        {label}
      </span>
      <span className="truncate text-right">{children}</span>
    </div>
  );
}
