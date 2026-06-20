// Bitcoin utility functions for stratum-work style template display

/**
 * Decode the ASCII portion of a coinbase1 scriptSig.
 *
 * Coinbase1 layout (from create_coinbase in the stratum server):
 *   version(4) + input_count(1) + null_prevout(32) + prevout_index(4) +
 *   script_len(1) + BIP34_push(1) + height_bytes(N) + extranonce_placeholder...
 *
 * The scriptSig starts at byte 41 (after version+input_count+prevout).
 * First byte is script_len, then BIP34 height push, then the rest is
 * miner tag / ASCII data (until extranonce which is appended separately).
 *
 * Since coinbase1 ends right before extranonce, everything after the BIP34
 * height push in the scriptSig is the ASCII tag.
 */
export function decodeCoinbaseAscii(coinbase1Hex: string): string {
  if (!coinbase1Hex || coinbase1Hex.length < 84) return '';

  // Parse hex to bytes
  const bytes = hexToBytes(coinbase1Hex);
  if (bytes.length < 42) return '';

  // scriptSig starts at offset 41 (version:4 + inputCount:1 + nullPrevout:32 + prevoutIdx:4)
  const scriptLen = bytes[41];
  if (!scriptLen || scriptLen === 0) return '';

  const scriptStart = 42; // byte after script_len
  const scriptEnd = Math.min(scriptStart + scriptLen, bytes.length);

  // BIP34: first byte is the push length for height bytes
  const heightPushLen = bytes[scriptStart];
  if (heightPushLen === undefined) return '';

  // Skip BIP34 height push (1 byte opcode + N height bytes)
  const asciiStart = scriptStart + 1 + heightPushLen;
  if (asciiStart >= scriptEnd) return '';

  // Convert remaining scriptSig bytes to printable ASCII
  const asciiBytes = bytes.slice(asciiStart, scriptEnd);
  let result = '';
  for (const b of asciiBytes) {
    // Printable ASCII range: 0x20-0x7E
    if (b >= 0x20 && b <= 0x7e) {
      result += String.fromCharCode(b);
    } else {
      result += '.';
    }
  }

  // Truncate to 80 chars
  return result.length > 80 ? result.slice(0, 80) : result;
}

/**
 * Compute the first transaction ID from merkle branches.
 * branch[0] is the txid of the first non-coinbase tx in display byte order
 * (reversed from on-chain internal storage, already flipped in sui-queries.ts).
 */
export function computeFirstTransaction(merkleBranches: string[]): string {
  if (!merkleBranches || merkleBranches.length === 0) {
    return 'empty block';
  }

  const branch0 = merkleBranches[0];
  if (!branch0 || branch0.length < 64) return 'invalid';

  return branch0;
}

/**
 * Generate a deterministic HSL color from a merkle branch hash.
 * Uses the first 3 bytes to derive hue, saturation, and lightness.
 */
export function getMerkleColor(branchHex: string): string {
  if (!branchHex || branchHex.length < 6) return 'hsl(0, 0%, 50%)';

  const b0 = parseInt(branchHex.slice(0, 2), 16);
  const b1 = parseInt(branchHex.slice(2, 4), 16);
  const b2 = parseInt(branchHex.slice(4, 6), 16);

  const hue = Math.round((b0 / 255) * 360);
  const sat = 50 + Math.round((b1 / 255) * 30); // 50-80%
  const lit = 35 + Math.round((b2 / 255) * 20); // 35-55%

  return `hsl(${hue}, ${sat}%, ${lit}%)`;
}

/**
 * Format a Unix timestamp (ntime) to "HH:MM:SS" format.
 */
export function formatNtime(ntime: number): string {
  if (!ntime || ntime === 0) return '--:--:--';
  const date = new Date(ntime * 1000);
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Byte-reverse a hex string (internal byte order → display order).
 * Bitcoin block hashes and txids are displayed in reverse byte order.
 */
export function reverseHex(hex: string): string {
  const bytes = hex.match(/.{2}/g);
  if (!bytes) return hex;
  return bytes.reverse().join('');
}

/**
 * Format a full ntime as both time and date: "2025-01-15 14:32:07"
 */
export function formatNtimeFull(ntime: number): string {
  if (!ntime || ntime === 0) return 'N/A';
  const date = new Date(ntime * 1000);
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Parse the BIP34 block height from coinbase1 scriptSig.
 */
export function parseCoinbaseHeight(coinbase1Hex: string): number | null {
  if (!coinbase1Hex || coinbase1Hex.length < 88) return null;
  const bytes = hexToBytes(coinbase1Hex);
  if (bytes.length < 44) return null;

  // scriptSig starts at offset 42 (after version:4+count:1+prevout:36+scriptLen:1)
  const heightPushLen = bytes[42];
  if (!heightPushLen || heightPushLen > 4) return null;

  let height = 0;
  for (let i = 0; i < heightPushLen; i++) {
    height |= (bytes[43 + i] ?? 0) << (8 * i);
  }
  return height;
}

// ---------------------------------------------------------------------------
// Block header reconstruction & decomposition
// ---------------------------------------------------------------------------

import type { HeaderSegment } from './types';

/**
 * Encode a u32 value as a 4-byte little-endian hex string (8 chars).
 */
export function u32ToLeHex(val: number): string {
  const buf = new ArrayBuffer(4);
  const view = new DataView(buf);
  view.setUint32(0, val >>> 0, true); // true = little-endian
  const bytes = new Uint8Array(buf);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Reconstruct the 80-byte (160 hex char) block header from a mining share.
 *
 * Layout:
 *   [0-3]   Version      (4B LE)
 *   [4-35]  PrevHash     (32B, internal byte order from template)
 *   [36-67] MerkleRoot   (32B, from share)
 *   [68-71] nTime        (4B LE)
 *   [72-75] nBits        (4B LE)
 *   [76-79] Nonce        (4B LE)
 */
export function reconstructHeaderHex(
  share: {
    version: number;
    prevBlockHash: string;
    merkleRoot: string;
    ntime: number;
    nonce: number;
  },
  nbits: number,
): string {
  const version = u32ToLeHex(share.version);
  const prevHash = share.prevBlockHash.padEnd(64, '0');
  const merkleRoot = share.merkleRoot.padEnd(64, '0');
  const ntime = u32ToLeHex(share.ntime);
  const nbitsHex = u32ToLeHex(nbits);
  const nonce = u32ToLeHex(share.nonce);

  return version + prevHash + merkleRoot + ntime + nbitsHex + nonce;
}

/**
 * Decompose a 160-char header hex into labeled segments with source attribution.
 *
 * `templateVersion` is the base version from the template.
 * `shareVersion` is the miner's version (may include BIP320 rolled bits).
 */
export function decomposeHeader(
  headerHex: string,
  templateVersion: number,
  shareVersion: number,
): HeaderSegment[] {
  // Determine if the miner modified version bits
  const versionModified = templateVersion !== shareVersion;
  const versionSource: 'template' | 'miner' = versionModified
    ? 'miner'
    : 'template';

  return [
    {
      startByte: 0,
      length: 4,
      label: 'Version',
      hex: headerHex.slice(0, 8),
      source: versionSource,
      description: versionModified
        ? 'Version with BIP320 rolled bits (miner-modified)'
        : 'Block version (from template)',
    },
    {
      startByte: 4,
      length: 32,
      label: 'PrevHash',
      hex: headerHex.slice(8, 72),
      source: 'template',
      description: 'Previous block hash (static from template)',
    },
    {
      startByte: 36,
      length: 32,
      label: 'MerkleRoot',
      hex: headerHex.slice(72, 136),
      source: 'miner',
      description:
        'Merkle root (unique per share — varies with extranonce)',
    },
    {
      startByte: 68,
      length: 4,
      label: 'nTime',
      hex: headerHex.slice(136, 144),
      source: 'miner',
      description: 'Block timestamp (miner may adjust)',
    },
    {
      startByte: 72,
      length: 4,
      label: 'nBits',
      hex: headerHex.slice(144, 152),
      source: 'template',
      description: 'Difficulty target (static from template)',
    },
    {
      startByte: 76,
      length: 4,
      label: 'Nonce',
      hex: headerHex.slice(152, 160),
      source: 'miner',
      description: 'Nonce (unique per share)',
    },
  ];
}

/**
 * Decompose a 160-char block header hex into 6 labeled field segments.
 * Used for the Phase 1 block registration byte map.
 */
export function decomposeBlockHeader(headerHex: string): HeaderSegment[] {
  return [
    {
      startByte: 0,
      length: 4,
      label: 'Version',
      hex: headerHex.slice(0, 8),
      description: 'Block version (4B little-endian)',
    },
    {
      startByte: 4,
      length: 32,
      label: 'PrevHash',
      hex: headerHex.slice(8, 72),
      description: 'Previous block hash (32B internal byte order)',
    },
    {
      startByte: 36,
      length: 32,
      label: 'MerkleRoot',
      hex: headerHex.slice(72, 136),
      description: 'Merkle root of all transactions (32B)',
    },
    {
      startByte: 68,
      length: 4,
      label: 'nTime',
      hex: headerHex.slice(136, 144),
      description: 'Block timestamp (4B little-endian, unix seconds)',
    },
    {
      startByte: 72,
      length: 4,
      label: 'nBits',
      hex: headerHex.slice(144, 152),
      description: 'Difficulty target in compact form (4B little-endian)',
    },
    {
      startByte: 76,
      length: 4,
      label: 'Nonce',
      hex: headerHex.slice(152, 160),
      description: 'Nonce that produces valid PoW hash (4B little-endian)',
    },
  ];
}

/**
 * Generate N visually distinct colors using golden-ratio HSL spacing.
 * Returns array of HSL color strings.
 */
export function generateMinerColors(count: number): string[] {
  const colors: string[] = [];
  const goldenAngle = 137.508; // degrees
  for (let i = 0; i < count; i++) {
    const hue = (i * goldenAngle) % 360;
    colors.push(`hsl(${Math.round(hue)}, 70%, 55%)`);
  }
  return colors;
}

// ---------------------------------------------------------------------------
// nBits → target / difficulty
// ---------------------------------------------------------------------------

/**
 * Decode the compact nBits encoding into a 256-bit target hex string and a
 * floating-point difficulty (relative to difficulty-1 = 0x00000000ffff…).
 */
export function decodeNbits(nbits: number): { targetHex: string; difficulty: number } {
  const exp = (nbits >>> 24) & 0xff;
  const mant = nbits & 0xffffff;
  // target = mantissa * 256^(exp - 3)
  // Build as a 32-byte big-endian hex string.
  const shift = exp - 3;
  let hex = mant.toString(16).padStart(6, "0");
  if (shift > 0) hex = hex + "00".repeat(shift);
  // Pad to 64 hex chars (32 bytes)
  if (hex.length > 64) {
    hex = hex.slice(hex.length - 64);
  } else {
    hex = hex.padStart(64, "0");
  }

  // Difficulty-1 target = 0x00000000ffff0000000000000000000000000000000000000000000000000000
  // difficulty = D1 / current_target. Use BigInt for precision, then convert.
  const D1 = BigInt(
    "0x00000000ffff0000000000000000000000000000000000000000000000000000",
  );
  const current = BigInt("0x" + hex);
  let difficulty = 0;
  if (current > 0n) {
    // Compute as float via two BigInt divisions to keep mantissa+exponent.
    // difficulty = D1 / current. Use Number on a scaled ratio.
    const scale = 1_000_000n;
    const ratio = (D1 * scale) / current;
    difficulty = Number(ratio) / Number(scale);
  }
  return { targetHex: hex, difficulty };
}

/**
 * Pretty-print a difficulty number with K/M/G/T/P/E suffixes.
 */
export function formatDifficulty(d: number): string {
  if (!isFinite(d) || d <= 0) return "0";
  const units = ["", "K", "M", "G", "T", "P", "E", "Z"];
  let i = 0;
  let v = d;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toFixed(v < 10 ? 3 : v < 100 ? 2 : 1)}${units[i]}`;
}

// ---------------------------------------------------------------------------
// Coinbase transaction parser (uses bitcoinjs-lib)
// ---------------------------------------------------------------------------

import { Transaction, address as btcAddress, networks, script as btcScript } from "bitcoinjs-lib";

export type ParsedOutput =
  | {
      kind: "address";
      addressType: "p2pkh" | "p2sh" | "p2wpkh" | "p2wsh" | "p2tr";
      address: string;
      valueSats: number;
      hex: string;
    }
  | {
      kind: "nulldata";
      valueSats: number;
      dataHex: string;
      hex: string;
      decoded?: { protocol: string; detail?: string };
    }
  | {
      kind: "unknown";
      valueSats: number;
      hex: string;
    };

export interface ParsedCoinbase {
  txVersion: number;
  inputSequence: number | null;
  locktime: number;
  witnessCommitmentNonce: string | null;
  outputs: ParsedOutput[];
  totalOutputSats: number;
}

/**
 * Reconstruct the full coinbase tx hex from template parts + a synthesized
 * extranonce stub of EXACTLY the size the template's coinbase scriptSig
 * declares. coinbase1 ends mid-scriptSig (declared-len byte at offset 41,
 * then partial scriptSig bytes); extranonce fills the gap before coinbase2
 * appends the trailing scriptSig + sequence + outputs + witness + locktime.
 *
 * If the gap can't be derived (truncated/empty input) the caller's
 * `fallbackLen` is used.
 */
export function reconstructCoinbaseHex(
  coinbase1: string,
  coinbase2: string,
  fallbackLen: number = 8,
): string {
  const gap = inferExtranonceGap(coinbase1);
  const len = gap !== null ? gap : fallbackLen;
  return coinbase1 + "00".repeat(len) + coinbase2;
}

/**
 * Derive the number of extranonce bytes (extranonce1 + extranonce2) that
 * the template expects between coinbase1 and coinbase2. Returns null if
 * coinbase1 is malformed.
 */
export function inferExtranonceGap(coinbase1Hex: string): number | null {
  if (!coinbase1Hex) return null;
  const bytes = hexToBytes(coinbase1Hex);
  if (bytes.length < 42) return null;
  const declared = bytes[41]; // scriptSig length
  if (declared === undefined) return null;
  const scriptSigBytesPresent = bytes.length - 42; // bytes after the length prefix
  const gap = declared - scriptSigBytesPresent;
  return gap >= 0 ? gap : null;
}

/**
 * Parse a coinbase tx hex into the fields stratum-work's BlockTemplateCard
 * shows: tx version, input sequence, locktime, witness commitment nonce,
 * and decoded outputs (vout).
 */
export function parseCoinbase(cbHex: string): ParsedCoinbase | null {
  try {
    const tx = Transaction.fromHex(cbHex);
    const outputs: ParsedOutput[] = tx.outs.map((o) => {
      const valueSats = Number(o.value);
      const scriptHex = Buffer.from(o.script).toString("hex");
      // OP_RETURN (0x6a) → nulldata
      if (o.script.length > 0 && o.script[0] === 0x6a) {
        // Extract the payload after the OP_RETURN opcode. The next byte(s)
        // are a push opcode (0x4c/0x4d/0x4e + len, or 1-75 direct).
        let dataHex = "";
        const rest = o.script.slice(1);
        if (rest.length > 0) {
          const op = rest[0];
          if (op >= 1 && op <= 75) {
            dataHex = Buffer.from(rest.slice(1, 1 + op)).toString("hex");
          } else if (op === 0x4c && rest.length >= 2) {
            const l = rest[1];
            dataHex = Buffer.from(rest.slice(2, 2 + l)).toString("hex");
          } else if (op === 0x4d && rest.length >= 3) {
            const l = rest[1] | (rest[2] << 8);
            dataHex = Buffer.from(rest.slice(3, 3 + l)).toString("hex");
          } else {
            dataHex = Buffer.from(rest).toString("hex");
          }
        }
        return {
          kind: "nulldata",
          valueSats,
          dataHex,
          hex: scriptHex,
          decoded: decodeOpReturn(dataHex),
        };
      }
      const detected = detectAddress(o.script);
      if (detected) {
        return {
          kind: "address",
          addressType: detected.type,
          address: detected.address,
          valueSats,
          hex: scriptHex,
        };
      }
      return { kind: "unknown", valueSats, hex: scriptHex };
    });

    const totalOutputSats = outputs.reduce((s, o) => s + o.valueSats, 0);
    const cbInput = tx.ins[0];
    const witnessCommitmentNonce = (() => {
      if (!tx.hasWitnesses() || !cbInput) return null;
      // bitcoinjs-lib stores witness on the input; bip141 coinbase witness is
      // exactly one element of 32 bytes.
      const w = (cbInput as unknown as { witness?: Uint8Array[] }).witness;
      if (w && w.length > 0 && w[0].length === 32) {
        return Buffer.from(w[0]).toString("hex");
      }
      return null;
    })();

    return {
      txVersion: tx.version,
      inputSequence: cbInput ? cbInput.sequence : null,
      locktime: tx.locktime,
      witnessCommitmentNonce,
      outputs,
      totalOutputSats,
    };
  } catch {
    return null;
  }
}

function detectAddress(
  scriptBuf: Uint8Array,
): { type: "p2pkh" | "p2sh" | "p2wpkh" | "p2wsh" | "p2tr"; address: string } | null {
  // Classify by canonical script shape so we get a stable type label even
  // when bitcoinjs returns a generic bech32m address.
  const len = scriptBuf.length;
  // P2PKH: OP_DUP OP_HASH160 14 <20> OP_EQUALVERIFY OP_CHECKSIG (25 bytes)
  let type: "p2pkh" | "p2sh" | "p2wpkh" | "p2wsh" | "p2tr" | null = null;
  if (
    len === 25 &&
    scriptBuf[0] === 0x76 &&
    scriptBuf[1] === 0xa9 &&
    scriptBuf[2] === 0x14 &&
    scriptBuf[23] === 0x88 &&
    scriptBuf[24] === 0xac
  ) {
    type = "p2pkh";
  } else if (
    len === 23 &&
    scriptBuf[0] === 0xa9 &&
    scriptBuf[1] === 0x14 &&
    scriptBuf[22] === 0x87
  ) {
    type = "p2sh";
  } else if (len === 22 && scriptBuf[0] === 0x00 && scriptBuf[1] === 0x14) {
    type = "p2wpkh";
  } else if (len === 34 && scriptBuf[0] === 0x00 && scriptBuf[1] === 0x20) {
    type = "p2wsh";
  } else if (len === 34 && scriptBuf[0] === 0x51 && scriptBuf[1] === 0x20) {
    type = "p2tr";
  }
  if (!type) return null;
  try {
    const addr = btcAddress.fromOutputScript(scriptBuf, networks.bitcoin);
    return { type, address: addr };
  } catch {
    return null;
  }
}

/**
 * Best-effort OP_RETURN protocol identification for the small set commonly
 * found in mainnet coinbases. Extend as needed.
 */
function decodeOpReturn(dataHex: string): { protocol: string; detail?: string } | undefined {
  if (!dataHex) return undefined;
  // BIP141 witness commitment: 36 bytes starting with 0xaa21a9ed
  if (dataHex.startsWith("aa21a9ed") && dataHex.length === 8 + 64) {
    return { protocol: "Segwit Commitment", detail: dataHex.slice(8) };
  }
  // RSK / Rootstock: ASCII "RSKBLOCK:" prefix in the payload
  const asAscii = (() => {
    try {
      return Buffer.from(dataHex, "hex").toString("utf8");
    } catch {
      return "";
    }
  })();
  if (asAscii.startsWith("RSKBLOCK:")) return { protocol: "Rootstock" };
  if (asAscii.startsWith("HATHOR")) return { protocol: "Hathor" };
  if (asAscii.startsWith("SYS_BLOCK")) return { protocol: "Syscoin" };
  if (asAscii.startsWith("EXSAT")) return { protocol: "exSat" };
  // CoreDAO marker: starts with 0x434f5245 ("CORE")
  if (dataHex.startsWith("434f5245")) return { protocol: "CoreDAO" };
  return { protocol: "Unknown" };
}

// btcScript is intentionally imported to keep an explicit dependency lock; not
// re-exported because the decoder above does the parsing directly.
void btcScript;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return bytes;
}
