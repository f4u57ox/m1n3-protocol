"use client";

import { useMemo, useState } from "react";
import type { TemplateData } from "@/lib/types";
import {
  truncateAddress,
  formatM1N3,
  timeAgo,
  solscanAccount,
} from "@/lib/utils";
import {
  decodeCoinbaseAscii,
  computeFirstTransaction,
  reverseHex,
  formatNtimeFull,
  parseCoinbaseHeight,
  decodeNbits,
  formatDifficulty,
  parseCoinbase,
  reconstructCoinbaseHex,
  type ParsedOutput,
} from "@/lib/bitcoin-utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { MerkleTreeViz } from "./MerkleTreeViz";

interface TemplateCardProps {
  template: TemplateData;
}

export function TemplateCard({ template: t }: TemplateCardProps) {
  const coinbaseAscii = decodeCoinbaseAscii(t.coinbase1);
  const firstTx = computeFirstTransaction(t.merkleBranches);
  const isEmptyBlock = firstTx === "empty block";

  // Prev block hash: stored in internal byte order, reverse for display.
  const prevHashDisplay = t.prevBlockHash
    ? reverseHex(t.prevBlockHash)
    : "";

  const nbitsDecoded = useMemo(() => decodeNbits(t.nbits), [t.nbits]);
  const bip34Height = useMemo(
    () => parseCoinbaseHeight(t.coinbase1),
    [t.coinbase1],
  );
  const heightsAgree = bip34Height !== null && bip34Height === t.height;

  const parsedCb = useMemo(() => {
    if (!t.coinbase1 || !t.coinbase2) return null;
    return parseCoinbase(reconstructCoinbaseHex(t.coinbase1, t.coinbase2));
  }, [t.coinbase1, t.coinbase2]);

  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-6">
        {/* Block Header 80-byte structure strip */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>Block Header Structure (80 bytes)</span>
              <Badge variant={t.isActive ? "default" : "secondary"}>
                {t.isActive ? "Active" : "Inactive"}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* Byte-proportional strip. Widths are the actual byte-ratios of
                the 80-byte block header: 4/80, 32/80, 32/80, 4/80, 4/80, 4/80
                = 5/40/40/5/5/5 (sums to 100%). Each cell shows just the short
                form (8-char hex / 64-char hex); long-form values live below. */}
            <div className="flex border rounded divide-x text-center text-[10px] overflow-hidden bg-muted/20">
              <HeaderSeg
                widthPct={5}
                title="Version"
                bytes={4}
                shortValue={`0x${t.version.toString(16).padStart(8, "0")}`}
                tooltip="Block version field. Modified by miners via BIP320 version-rolling to expand the nonce search space."
                mono
              />
              <HeaderSeg
                widthPct={40}
                title="Prev Block Hash"
                bytes={32}
                shortValue={prevHashDisplay || "—"}
                tooltip="The hash of the parent block in display order (byte-reversed from internal storage)."
                mono
                allowWrap
              />
              <HeaderSeg
                widthPct={40}
                title="Merkle Root"
                bytes={32}
                shortValue="[computed per share]"
                tooltip="Merkle root of the block's transactions. Depends on the miner's extranonce choice — only known per share."
                italicMuted
              />
              <HeaderSeg
                widthPct={5}
                title="Time"
                bytes={4}
                shortValue={t.ntime ? t.ntime.toString(16).padStart(8, "0") : "—"}
                tooltip={`Block timestamp in unix seconds. Decoded: ${t.ntime ? formatNtimeFull(t.ntime) : "N/A"}`}
                mono
              />
              <HeaderSeg
                widthPct={5}
                title="nBits"
                bytes={4}
                shortValue={t.nbits.toString(16).padStart(8, "0")}
                tooltip={`Compact-form difficulty target. Decoded difficulty: ${formatDifficulty(nbitsDecoded.difficulty)} · target = 0x${nbitsDecoded.targetHex.slice(0, 16)}…`}
                mono
              />
              <HeaderSeg
                widthPct={5}
                title="Nonce"
                bytes={4}
                shortValue="[computed]"
                tooltip="The 4-byte nonce a miner iterates to find a valid PoW hash. Not part of the template — added per share."
                italicMuted
              />
            </div>
          </CardContent>
        </Card>

        {/* Header Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle>Block Header Fields</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field
                label="Height"
                value={t.height.toLocaleString()}
                hint={
                  bip34Height === null
                    ? "BIP-34 coinbase height not parseable"
                    : heightsAgree
                      ? `✓ BIP-34 coinbase height agrees (${bip34Height.toLocaleString()})`
                      : `✗ BIP-34 coinbase height disagrees (${bip34Height.toLocaleString()})`
                }
              />
              <FieldLink
                label="Owner"
                value={truncateAddress(t.owner)}
                href={solscanAccount(t.owner)}
                mono
              />
              <Field
                label="Version"
                value={`0x${t.version.toString(16).padStart(8, "0")}`}
                mono
              />
              <Field
                label="nBits (difficulty target)"
                value={`0x${t.nbits.toString(16).padStart(8, "0")}`}
                mono
                hint={`Difficulty ≈ ${formatDifficulty(nbitsDecoded.difficulty)}, target = 0x${nbitsDecoded.targetHex.slice(0, 20)}…`}
              />
              <Field
                label="Ntime (block timestamp)"
                value={
                  t.ntime
                    ? `${formatNtimeFull(t.ntime)}  (0x${t.ntime.toString(16).padStart(8, "0")})`
                    : "N/A"
                }
                mono
              />
              <Field label="Share Count" value={t.shareCount.toLocaleString()} />
              <Field
                label="Previous Block Hash"
                value={prevHashDisplay || "(empty)"}
                mono
                full
                hint="Display order (byte-reversed from internal)"
              />
              <Field
                label="Staked"
                value={`${t.stakedAmount ? formatM1N3(t.stakedAmount) : "0"} m1n3`}
              />
              <Field
                label="Registered"
                value={
                  t.createdAtMs
                    ? `${new Date(t.createdAtMs).toLocaleString()} (${timeAgo(t.createdAtMs)})`
                    : "N/A"
                }
              />
            </div>
          </CardContent>
        </Card>

        {/* Coinbase Transaction Details */}
        <Card>
          <CardHeader>
            <CardTitle>Coinbase Transaction Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {parsedCb ? (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="space-y-4">
                  <SubCard title="General Tx Fields">
                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <KV
                        label="Tx Version"
                        value={String(parsedCb.txVersion)}
                      />
                      <KV
                        label="Input Sequence"
                        value={
                          parsedCb.inputSequence !== null
                            ? `0x${parsedCb.inputSequence.toString(16).padStart(8, "0")}`
                            : "N/A"
                        }
                        mono
                      />
                      <KV label="Locktime" value={String(parsedCb.locktime)} />
                      <KV
                        label="Outputs"
                        value={String(parsedCb.outputs.length)}
                      />
                      {parsedCb.witnessCommitmentNonce && (
                        <KV
                          label="Witness Commitment Nonce"
                          value={parsedCb.witnessCommitmentNonce}
                          mono
                          full
                        />
                      )}
                    </div>
                  </SubCard>
                  <SubCard title="ScriptSig Data">
                    <div className="space-y-3 text-xs">
                      {bip34Height !== null && (
                        <KV
                          label="Parsed Height (BIP-34)"
                          value={bip34Height.toLocaleString()}
                        />
                      )}
                      {coinbaseAscii && (
                        <div>
                          <p className="text-muted-foreground mb-1">
                            ASCII tag (miner)
                          </p>
                          <code className="block font-mono bg-primary/10 text-primary p-2 rounded-md break-all">
                            {coinbaseAscii}
                          </code>
                        </div>
                      )}
                    </div>
                  </SubCard>
                </div>
                <OutputsCard
                  outputs={parsedCb.outputs}
                  totalSats={parsedCb.totalOutputSats}
                />
              </div>
            ) : (
              <p className="text-muted-foreground text-sm italic">
                Could not parse coinbase transaction.
              </p>
            )}

            {/* First Transaction (non-coinbase) */}
            <div>
              <p className="text-sm text-muted-foreground mb-1">
                First Transaction (txid of first non-coinbase tx)
              </p>
              {isEmptyBlock ? (
                <p className="text-sm italic text-muted-foreground">
                  Empty block (no non-coinbase transactions)
                </p>
              ) : (
                <a
                  href={`https://mempool.space/tx/${firstTx}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-xs font-mono bg-muted p-3 rounded-md break-all text-primary hover:underline"
                >
                  {firstTx}
                </a>
              )}
            </div>

            {/* Raw coinbase parts */}
            <div>
              <p className="text-sm text-muted-foreground mb-1">
                Coinbase1 (before extranonce)
              </p>
              <code className="block text-xs font-mono bg-muted p-3 rounded-md break-all text-muted-foreground">
                {t.coinbase1 || "(empty)"}
              </code>
            </div>
            <div>
              <p className="text-sm text-muted-foreground mb-1">
                Coinbase2 (after extranonce)
              </p>
              <code className="block text-xs font-mono bg-muted p-3 rounded-md break-all text-muted-foreground">
                {t.coinbase2 || "(empty)"}
              </code>
            </div>
          </CardContent>
        </Card>

        {/* Merkle Tree */}
        <Card>
          <CardHeader>
            <CardTitle>
              Merkle Branches ({t.merkleBranches.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {t.merkleBranches.length > 0 ? (
              <MerkleTreeViz branches={t.merkleBranches} />
            ) : (
              <p className="text-muted-foreground text-sm">
                No merkle branches — empty block (coinbase only)
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </TooltipProvider>
  );
}

function Field({
  label,
  value,
  mono,
  full,
  hint,
}: {
  label: string;
  value: string;
  mono?: boolean;
  full?: boolean;
  hint?: string;
}) {
  return (
    <div className={full ? "md:col-span-2" : ""}>
      <p className="text-sm text-muted-foreground">
        {label}
        {hint && (
          <span className="ml-1 text-xs text-muted-foreground/60">
            — {hint}
          </span>
        )}
      </p>
      <p className={`text-sm font-medium ${mono ? "font-mono" : ""} break-all`}>
        {value}
      </p>
    </div>
  );
}

function HeaderSeg({
  widthPct,
  title,
  bytes,
  shortValue,
  tooltip,
  mono,
  italicMuted,
  allowWrap,
}: {
  widthPct: number;
  title: string;
  bytes: number;
  shortValue: string;
  tooltip: string;
  mono?: boolean;
  italicMuted?: boolean;
  allowWrap?: boolean;
}) {
  return (
    <div
      className="py-2 px-1.5 flex flex-col items-center justify-between min-w-0"
      style={{ width: `${widthPct}%`, flex: `0 0 ${widthPct}%` }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="font-semibold underline decoration-dotted cursor-help leading-tight">
            {title}
          </div>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{tooltip}</TooltipContent>
      </Tooltip>
      <div className="text-muted-foreground text-[9px] mt-0.5">
        ({bytes} bytes)
      </div>
      <div
        className={`mt-1 w-full ${mono ? "font-mono" : ""} ${italicMuted ? "italic text-muted-foreground" : ""} ${allowWrap ? "break-all" : "truncate"}`}
        title={shortValue}
      >
        {shortValue}
      </div>
    </div>
  );
}

function SubCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border rounded p-3 bg-muted/10">
      <div className="text-sm font-semibold text-center pb-2 mb-3 border-b">
        {title}
      </div>
      {children}
    </div>
  );
}

function KV({
  label,
  value,
  mono,
  full,
}: {
  label: string;
  value: string;
  mono?: boolean;
  full?: boolean;
}) {
  return (
    <div className={full ? "col-span-2" : ""}>
      <div className="text-muted-foreground mb-0.5">{label}</div>
      <div
        className={`p-1.5 border rounded bg-card/80 ${mono ? "font-mono" : ""} break-all`}
      >
        {value}
      </div>
    </div>
  );
}

function OutputsCard({
  outputs,
  totalSats,
}: {
  outputs: ParsedOutput[];
  totalSats: number;
}) {
  const [showRaw, setShowRaw] = useState(false);
  return (
    <div className="border rounded p-3 bg-muted/10">
      <div className="flex items-center justify-between pb-2 mb-3 border-b">
        <div className="text-sm font-semibold">Outputs (vout)</div>
        <label className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={showRaw}
            onChange={(e) => setShowRaw(e.target.checked)}
            className="accent-primary"
          />
          Show raw hex
        </label>
      </div>
      <div className="space-y-2 text-xs">
        {outputs.length === 0 ? (
          <p className="italic text-muted-foreground">No outputs found.</p>
        ) : (
          outputs.map((o, i) => (
            <OutputRow key={i} idx={i} out={o} showRaw={showRaw} />
          ))
        )}
      </div>
      <div className="mt-3 pt-3 border-t text-xs">
        <div className="text-muted-foreground mb-0.5">
          Total Output Value (BTC)
        </div>
        <div className="p-1.5 border rounded font-mono bg-card/80">
          {(totalSats / 1e8).toFixed(8)}
        </div>
      </div>
    </div>
  );
}

function OutputRow({
  idx,
  out,
  showRaw,
}: {
  idx: number;
  out: ParsedOutput;
  showRaw: boolean;
}) {
  const btc = (out.valueSats / 1e8).toFixed(8);
  return (
    <div className="p-2 border rounded font-mono text-[11px] bg-card/60">
      <div className="flex items-center justify-between mb-1">
        <span className="font-semibold">#{idx}</span>
        <span className="uppercase text-[9px] tracking-wider text-muted-foreground">
          {out.kind === "address"
            ? out.addressType
            : out.kind === "nulldata"
              ? `OP_RETURN${out.decoded?.protocol && out.decoded.protocol !== "Unknown" ? ` · ${out.decoded.protocol}` : ""}`
              : "unknown"}
        </span>
      </div>
      {out.kind === "address" && (
        <div className="break-all">{out.address}</div>
      )}
      {out.kind === "nulldata" && (
        <div className="break-all text-muted-foreground">
          {out.dataHex || "(no data)"}
        </div>
      )}
      <div className="mt-1 text-muted-foreground">
        {btc} BTC ({out.valueSats.toLocaleString()} sats)
      </div>
      {showRaw && (
        <div className="mt-1 pt-1 border-t border-border/40 text-muted-foreground break-all">
          {out.hex}
        </div>
      )}
    </div>
  );
}

function FieldLink({
  label,
  value,
  href,
  mono,
}: {
  label: string;
  value: string;
  href: string;
  mono?: boolean;
}) {
  return (
    <div>
      <p className="text-sm text-muted-foreground">{label}</p>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={`text-sm font-medium hover:underline ${mono ? "font-mono" : ""} break-all`}
      >
        {value}
      </a>
    </div>
  );
}
