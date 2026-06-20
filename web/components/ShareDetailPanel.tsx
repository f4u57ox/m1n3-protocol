"use client";

import type { HeaderSegment } from "@/lib/types";
import { reverseHex, formatNtimeFull } from "@/lib/bitcoin-utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface BlockHeaderPanelProps {
  headerHex: string | null;
  segments: HeaderSegment[];
  height: number;
  blockHash: string;
}

export function ShareDetailPanel({
  headerHex,
  segments,
  height,
  blockHash,
}: BlockHeaderPanelProps) {
  if (!headerHex || headerHex.length !== 160) return null;

  // Parse field values from header hex (all little-endian)
  const versionHex = headerHex.slice(0, 8);
  const version = parseInt(reverseHex(versionHex), 16);

  const prevHashHex = headerHex.slice(8, 72);
  const prevHashDisplay = reverseHex(prevHashHex);

  const merkleRootHex = headerHex.slice(72, 136);
  const merkleRootDisplay = reverseHex(merkleRootHex);

  const ntimeHex = headerHex.slice(136, 144);
  const ntime = parseInt(reverseHex(ntimeHex), 16);

  const nbitsHex = headerHex.slice(144, 152);
  const nbits = parseInt(reverseHex(nbitsHex), 16);

  const nonceHex = headerHex.slice(152, 160);
  const nonce = parseInt(reverseHex(nonceHex), 16);

  const blockHashDisplay = reverseHex(blockHash);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">
          Block Header Detail
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Key fields */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Height" value={`#${height.toLocaleString()}`} />
          <Field
            label="Version"
            value={`0x${version.toString(16).padStart(8, "0")}`}
            mono
          />
          <Field label="nTime" value={formatNtimeFull(ntime)} mono />
          <Field
            label="nBits"
            value={`0x${nbits.toString(16).padStart(8, "0")}`}
            mono
          />
          <Field
            label="Nonce"
            value={`${nonce.toLocaleString()} (0x${nonce.toString(16).padStart(8, "0")})`}
            mono
          />
        </div>

        {/* Block Hash */}
        <div>
          <p className="text-xs text-muted-foreground mb-1">
            Block Hash (display order)
          </p>
          <code className="block text-xs font-mono bg-muted p-2 rounded break-all">
            {blockHashDisplay}
          </code>
        </div>

        {/* Previous Block Hash */}
        <div>
          <p className="text-xs text-muted-foreground mb-1">
            Previous Block Hash
          </p>
          <code className="block text-xs font-mono bg-muted p-2 rounded break-all">
            {prevHashDisplay}
          </code>
        </div>

        {/* Merkle Root */}
        <div>
          <p className="text-xs text-muted-foreground mb-1">Merkle Root</p>
          <code className="block text-xs font-mono bg-muted p-2 rounded break-all">
            {merkleRootDisplay}
          </code>
        </div>

        {/* Full 80-byte header with colored segments */}
        <div>
          <p className="text-xs text-muted-foreground mb-1">
            Raw 80-byte Header ({headerHex.length / 2} bytes)
          </p>
          <div className="bg-muted p-2 rounded font-mono text-xs break-all leading-relaxed">
            {segments.map((seg, i) => (
              <span
                key={i}
                title={`${seg.label}: bytes ${seg.startByte}-${seg.startByte + seg.length - 1} | ${seg.description}`}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                {seg.hex}
              </span>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={`text-sm font-medium break-all ${mono ? "font-mono" : ""}`}
      >
        {value}
      </p>
    </div>
  );
}
