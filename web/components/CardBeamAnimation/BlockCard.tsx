import React from "react";

export interface BlockCardData {
  height: number;
  blockHash: string;
  headerHex?: string;
  type?: "registered" | "mined" | "template";

  // Header fields (registered + mined)
  version?: number;
  ntime?: number;
  nbits?: number;
  nonce?: number;
  merkleRoot?: string;

  // Template-specific (Stratum fields)
  coinbaseTag?: string;     // ASCII miner tag decoded from coinbase1 (e.g., "Foundry USA Pool")
  coinbaseHex?: string;     // Truncated coinbase1 hex for display
  extranonce?: string;      // extranonce1 hex (e.g., "7a9f3b21")
  shareCount?: number;      // shares submitted against this template
  minerAddress?: string;    // Sui address for individual miners
  powCommitted?: number;    // PoW committed (shares)
  m1n3Staked?: number;      // M1N3 staked (8 decimals)

  // Registered-specific
  nodesParticipated?: number;

  // Mined-specific
  difficultyTarget?: string;
  difficultyAchieved?: string;
  totalShares?: number;
  difficulty?: number;      // human-readable difficulty
  blockSize?: number;       // block size bytes
  weight?: number;          // block weight WU
  nTx?: number;             // tx count
}

interface BlockCardProps extends BlockCardData {
  cardSize?: number;
}

const TYPE_STYLES = {
  registered: { dot: "bg-green-500", label: "Registered" },
  mined:      { dot: "bg-orange-500", label: "Mined" },
  template:   { dot: "bg-blue-500",   label: "Template" },
} as const;

/** Count leading '0' characters in the block hash */
function countLeadingZeros(hash: string): number {
  let count = 0;
  for (const ch of hash) {
    if (ch === "0") count++;
    else break;
  }
  return count;
}

/** Format version as hex like 0x20000000 */
function versionHex(v: number): string {
  return "0x" + v.toString(16).padStart(8, "0");
}

/** Format nonce as decimal */
function formatNonce(n: number): string {
  return n.toLocaleString();
}

/** Format nbits as hex */
function nbitsHex(n: number): string {
  return "0x" + n.toString(16).padStart(8, "0");
}

/** Format unix timestamp to compact date string */
function formatNtime(t: number): string {
  const d = new Date(t * 1000);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

/** Truncate coinbase hex to "03a7...7279" style if longer than ~20 chars */
function formatCoinbaseHex(hex: string): string {
  if (hex.length <= 20) return hex;
  return hex.slice(0, 8) + "..." + hex.slice(-8);
}

/** Format share count */
function formatShares(n: number): string {
  return n.toLocaleString();
}

/** Format M1N3 staked (base units with 8 decimals) */
function formatM1n3(amount: number): string {
  return (amount / 1e8).toLocaleString() + " M1N3";
}

/** Truncate Sui address to 0x7a9f...e7f8 */
function truncateSuiAddress(addr: string): string {
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

/** Format difficulty to human-readable (e.g. "119.12T", "220.76G") */
function formatDifficulty(d: number): string {
  if (d >= 1e12) return (d / 1e12).toFixed(2) + "T";
  if (d >= 1e9) return (d / 1e9).toFixed(2) + "G";
  if (d >= 1e6) return (d / 1e6).toFixed(2) + "M";
  if (d >= 1e3) return (d / 1e3).toFixed(2) + "K";
  return d.toFixed(2);
}

/** Format byte size to human-readable */
function formatByteSize(bytes: number): string {
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(2) + " MB";
  if (bytes >= 1e3) return (bytes / 1e3).toFixed(2) + " KB";
  return bytes + " B";
}

/** Format weight to kWU */
function formatWeight(wu: number): string {
  return (wu / 1e3).toLocaleString(undefined, { maximumFractionDigits: 0 }) + " kWU";
}

/** Truncate hash to "4967a0...ef5301" style */
function truncateHash(hash: string): string {
  if (hash.length <= 14) return hash;
  return hash.slice(0, 6) + "..." + hash.slice(-6);
}

/** Render block hash with green leading zeros */
function HashWithZeros({ hash, small }: { hash: string; small: boolean }) {
  const zeroCount = countLeadingZeros(hash);
  const zeros = hash.slice(0, zeroCount);
  const rest = hash.slice(zeroCount);

  if (small) {
    // Truncated display
    const truncLen = 20;
    const truncZeros = zeros.slice(0, Math.min(zeroCount, truncLen));
    const truncRest = rest.slice(0, Math.max(0, truncLen - zeroCount));
    return (
      <span className="font-mono text-[8px] leading-tight break-all">
        <span className="leading-zero-glow">{truncZeros}</span>
        <span className="text-muted-foreground/50">{truncRest}...</span>
      </span>
    );
  }

  return (
    <span className="font-mono text-[9px] leading-tight break-all">
      <span className="leading-zero-glow">{zeros}</span>
      <span className="text-muted-foreground/40">{rest}</span>
    </span>
  );
}

function BlockCard({
  height,
  blockHash,
  headerHex,
  version,
  ntime,
  nbits,
  nonce,
  merkleRoot,
  type = "registered",
  cardSize = 280,
  coinbaseTag,
  coinbaseHex,
  extranonce,
  shareCount,
  minerAddress,
  powCommitted,
  m1n3Staked,
  nodesParticipated,
  difficultyTarget,
  difficultyAchieved,
  totalShares,
  difficulty,
  blockSize,
  weight,
  nTx,
}: BlockCardProps) {
  const typeStyle = TYPE_STYLES[type];
  const size = cardSize;

  const small = size <= 180;

  return (
    <>
      {/* Card background — opacity controlled directly by animation loop */}
      <div
        className="absolute inset-0 rounded-lg border border-border/30 bg-card/30"
        style={{ zIndex: 0 }}
        data-card-bg
      />

      {/* Normal face — revealed after the beam */}
      <div
        className={`card-beam-bytes absolute inset-0 rounded-lg border border-border/60 bg-card/80 overflow-hidden flex flex-col ${small ? "p-2.5" : "p-3.5"}`}
        style={{ zIndex: 2 }}
        data-card-normal
      >
        {small ? (
          /* ── Small card (≤180px) — dense data layout ── */
          <>
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-bold tabular-nums font-mono text-card-foreground">
                #{height.toLocaleString()}
              </span>
            </div>

            <div className="mt-0.5">
              <HashWithZeros hash={blockHash} small />
            </div>

            <div className="border-t border-border/20 mt-1 pt-0.5 flex-1 flex flex-col gap-0.5 overflow-hidden">
              {type === "template" && (
                <>
                  <SmallFieldRow label="pool" value={minerAddress ? "Solo miner" : (coinbaseTag ?? "")} />
                  {minerAddress != null && <SmallFieldRow label="miner" value={truncateSuiAddress(minerAddress)} />}
                  {coinbaseHex != null && <SmallFieldRow label="cb1" value={formatCoinbaseHex(coinbaseHex)} />}
                  {extranonce != null && <SmallFieldRow label="xnonce" value={extranonce} />}
                  {powCommitted != null && <SmallFieldRow label="PoW" value={formatShares(powCommitted)} />}
                  {m1n3Staked != null && <SmallFieldRow label="staked" value={formatM1n3(m1n3Staked)} />}
                  {shareCount != null && <SmallFieldRow label="shares" value={formatShares(shareCount)} />}
                </>
              )}
              {type === "registered" && (
                <>
                  {version != null && <SmallFieldRow label="ver" value={versionHex(version)} />}
                  {merkleRoot != null && <SmallFieldRow label="merkle" value={truncateHash(merkleRoot)} />}
                  {ntime != null && <SmallFieldRow label="ntime" value={formatNtime(ntime).slice(0, 16)} />}
                  {nbits != null && <SmallFieldRow label="nbits" value={nbitsHex(nbits)} />}
                  {nonce != null && <SmallFieldRow label="nonce" value={formatNonce(nonce)} />}
                  {nodesParticipated != null && <SmallFieldRow label="nodes" value={formatShares(nodesParticipated)} />}
                </>
              )}
              {type === "mined" && (
                <>
                  {version != null && <SmallFieldRow label="ver" value={versionHex(version)} />}
                  {merkleRoot != null && <SmallFieldRow label="merkle" value={truncateHash(merkleRoot)} />}
                  {ntime != null && <SmallFieldRow label="ntime" value={formatNtime(ntime).slice(0, 16)} />}
                  {nonce != null && <SmallFieldRow label="nonce" value={formatNonce(nonce)} />}
                  {difficulty != null && <SmallFieldRow label="diff" value={formatDifficulty(difficulty)} />}
                  {blockSize != null && weight != null && (
                    <SmallFieldRow label="size" value={`${formatByteSize(blockSize)} / ${formatWeight(weight)}`} />
                  )}
                  {nTx != null && <SmallFieldRow label="txs" value={formatShares(nTx)} />}
                  {difficultyTarget != null && <SmallFieldRow label="target" value={difficultyTarget} />}
                  {difficultyAchieved != null && <SmallFieldRow label="actual" value={difficultyAchieved} />}
                  {totalShares != null && <SmallFieldRow label="shares" value={formatShares(totalShares)} />}
                </>
              )}
            </div>

            <div className="flex items-center gap-1 mt-auto pt-0.5 border-t border-border/20">
              <div className={`h-1 w-1 rounded-full ${typeStyle.dot} animate-pulse`} />
              <span className="text-[7px] text-muted-foreground uppercase tracking-wider">
                {typeStyle.label}
              </span>
            </div>
          </>
        ) : (
          /* ── Large card (280px) ── */
          <>
            {/* Top row: #height */}
            <div className="flex items-baseline justify-between">
              <span />
              <span className="text-2xl font-bold tabular-nums font-mono text-card-foreground flex-shrink-0">
                #{height.toLocaleString()}
              </span>
            </div>

            {/* Block hash with green leading zeros */}
            <div className="mt-1.5">
              <HashWithZeros hash={blockHash} small={false} />
            </div>

            {/* Type-specific fields */}
            <div className="mt-2 flex flex-col gap-1 border-t border-border/20 pt-1.5 overflow-hidden">
              {type === "template" && (
                <>
                  <FieldRow label="pool" value={minerAddress ? "Solo miner" : (coinbaseTag ?? "")} />
                  {minerAddress != null && <FieldRow label="miner" value={truncateSuiAddress(minerAddress)} />}
                  {coinbaseHex != null && <FieldRow label="cb1" value={formatCoinbaseHex(coinbaseHex)} />}
                  {extranonce != null && <FieldRow label="xnonce" value={extranonce} />}
                  {powCommitted != null && <FieldRow label="PoW" value={formatShares(powCommitted)} />}
                  {m1n3Staked != null && <FieldRow label="staked" value={formatM1n3(m1n3Staked)} />}
                  {shareCount != null && <FieldRow label="shares" value={formatShares(shareCount)} />}
                </>
              )}
              {type === "registered" && (
                <>
                  {version != null && <FieldRow label="ver" value={versionHex(version)} />}
                  {merkleRoot != null && <FieldRow label="merkle" value={truncateHash(merkleRoot)} />}
                  {ntime != null && <FieldRow label="ntime" value={formatNtime(ntime)} />}
                  {nbits != null && <FieldRow label="nbits" value={nbitsHex(nbits)} />}
                  {nonce != null && <FieldRow label="nonce" value={formatNonce(nonce)} />}
                  {nodesParticipated != null && <FieldRow label="nodes" value={formatShares(nodesParticipated)} />}
                </>
              )}
              {type === "mined" && (
                <>
                  {version != null && <FieldRow label="ver" value={versionHex(version)} />}
                  {merkleRoot != null && <FieldRow label="merkle" value={truncateHash(merkleRoot)} />}
                  {ntime != null && <FieldRow label="ntime" value={formatNtime(ntime)} />}
                  {nonce != null && <FieldRow label="nonce" value={formatNonce(nonce)} />}
                  {difficulty != null && <FieldRow label="diff" value={formatDifficulty(difficulty)} />}
                  {blockSize != null && weight != null && (
                    <FieldRow label="size" value={`${formatByteSize(blockSize)} / ${formatWeight(weight)}`} />
                  )}
                  {nTx != null && <FieldRow label="txs" value={formatShares(nTx)} />}
                  {difficultyTarget != null && <FieldRow label="target" value={difficultyTarget} />}
                  {difficultyAchieved != null && <FieldRow label="actual" value={difficultyAchieved} />}
                  {totalShares != null && <FieldRow label="shares" value={formatShares(totalShares)} />}
                </>
              )}
            </div>

            {/* Type badge */}
            <div className="flex items-center gap-1.5 mt-auto pt-1.5 border-t border-border/20">
              <div className={`h-1.5 w-1.5 rounded-full ${typeStyle.dot} animate-pulse`} />
              <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
                {typeStyle.label}
              </span>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[8px] uppercase tracking-wider text-muted-foreground/50 w-10 shrink-0">
        {label}
      </span>
      <span className="font-mono text-[9px] tabular-nums text-card-foreground/70 truncate">
        {value}
      </span>
    </div>
  );
}

function SmallFieldRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1" style={{ lineHeight: "9px" }}>
      <span className="text-[7px] uppercase tracking-wider text-muted-foreground/60 w-8 shrink-0">
        {label}
      </span>
      <span className="font-mono text-[8px] tabular-nums text-card-foreground/80 truncate">
        {value}
      </span>
    </div>
  );
}

export default React.memo(BlockCard);
