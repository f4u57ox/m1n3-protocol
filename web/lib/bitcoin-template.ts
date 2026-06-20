/**
 * Bitcoin block template utilities (browser-compatible).
 * Ports the Rust coinbase/merkle construction from stratum-server/src/main.rs.
 */

export interface BlockTemplateJson {
  version: number;
  previousblockhash: string;
  transactions: { txid: string }[];
  coinbasevalue: number;
  curtime: number;
  bits: string;
  height: number;
  default_witness_commitment?: string;
}

/** SHA-256d (double SHA-256) using WebCrypto */
async function sha256d(data: Uint8Array): Promise<Uint8Array> {
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const h1 = await crypto.subtle.digest('SHA-256', buf);
  const h2 = await crypto.subtle.digest('SHA-256', h1);
  return new Uint8Array(h2);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function encodeVarInt(buf: number[], value: number) {
  if (value < 0xfd) {
    buf.push(value);
  } else if (value <= 0xffff) {
    buf.push(0xfd, value & 0xff, (value >> 8) & 0xff);
  } else {
    buf.push(0xfe, value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
  }
}

/**
 * Build coinbase1 and coinbase2 matching the stratum server's create_coinbase().
 * coinbase1: version + input + partial script (BIP34 height push)
 * coinbase2: sequence + outputs + locktime  (goes after extranonce bytes)
 */
export function buildCoinbase(
  height: number,
  coinbaseValue: bigint,
  payoutScript: Uint8Array,
  witnessCommitmentHex?: string,
): { cb1: Uint8Array; cb2: Uint8Array } {
  // BIP34: minimal-length LE encoding of height
  const heightBytes: number[] = [];
  let h = height;
  while (h > 0) { heightBytes.push(h & 0xff); h >>>= 8; }
  if (heightBytes.length === 0) heightBytes.push(0);
  if (heightBytes[heightBytes.length - 1] & 0x80) heightBytes.push(0x00);
  const heightLen = heightBytes.length;

  // coinbase1 = version(4) + input_count(1) + prevout_hash(32=0) + prevout_index(4=0xffffffff)
  //           + script_len(1) + height_push_opcode(1) + height_bytes
  const scriptLen = 1 + heightLen + 12; // height_push + height_bytes + 12 extranonce bytes
  const cb1: number[] = [
    // version = 1 LE
    0x01, 0x00, 0x00, 0x00,
    // input count
    0x01,
    // coinbase input txid (32 zeros)
    ...new Array(32).fill(0),
    // vout = 0xffffffff
    0xff, 0xff, 0xff, 0xff,
    // script length
    scriptLen,
    // BIP34 height push
    heightLen,
    ...heightBytes,
  ];

  // coinbase2 = sequence(4=0xffffffff) + output_count + outputs + locktime(4=0)
  const cb2: number[] = [0xff, 0xff, 0xff, 0xff]; // sequence

  const hasWitness = witnessCommitmentHex && witnessCommitmentHex.length > 0;
  cb2.push(hasWitness ? 0x02 : 0x01); // output count

  // Output 1: mining reward
  for (let i = 0; i < 8; i++) cb2.push(Number((coinbaseValue >> BigInt(i * 8)) & 0xffn));
  encodeVarInt(cb2, payoutScript.length);
  cb2.push(...payoutScript);

  // Output 2: segwit witness commitment (value = 0)
  if (hasWitness) {
    const commitment = hexToBytes(witnessCommitmentHex!);
    for (let i = 0; i < 8; i++) cb2.push(0); // value = 0
    encodeVarInt(cb2, commitment.length);
    cb2.push(...commitment);
  }

  // locktime = 0
  cb2.push(0x00, 0x00, 0x00, 0x00);

  return { cb1: new Uint8Array(cb1), cb2: new Uint8Array(cb2) };
}

/**
 * Compute stratum merkle branches from the block template tx list.
 * Each branch is the sibling hash at that level of the merkle tree.
 * The coinbase tx (controlled by the miner via extranonce) is the first leaf.
 */
export async function computeMerkleBranches(txids: string[]): Promise<Uint8Array[]> {
  const branches: Uint8Array[] = [];

  // Convert txids from display order (reversed) to internal byte order
  let hashes: Uint8Array[] = txids.map((txid) => {
    const b = hexToBytes(txid);
    return b.slice().reverse();
  });

  while (hashes.length > 0) {
    branches.push(hashes[0]);
    hashes = hashes.slice(1);
    if (hashes.length === 0) break;

    const nextLevel: Uint8Array[] = [];
    for (let i = 0; i < hashes.length; i += 2) {
      const a = hashes[i];
      const b = hashes[i + 1] ?? hashes[i]; // duplicate last if odd
      const combined = new Uint8Array(64);
      combined.set(a, 0);
      combined.set(b, 32);
      nextLevel.push(await sha256d(combined));
    }
    hashes = nextLevel;
  }

  return branches;
}

/**
 * Parse and validate a getblocktemplate JSON string.
 * Returns the parsed object or throws with a user-friendly error message.
 */
export function parseBlockTemplateJson(raw: string): BlockTemplateJson {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON — paste the raw output of bitcoin-cli getblocktemplate');
  }
  const t = obj as Record<string, unknown>;
  const required = ['version', 'previousblockhash', 'transactions', 'coinbasevalue', 'curtime', 'bits', 'height'];
  for (const k of required) {
    if (!(k in t)) throw new Error(`Missing field: ${k}`);
  }
  return t as unknown as BlockTemplateJson;
}

/**
 * Decode a hex scriptPubKey string into bytes, with a friendly error.
 * Accepts e.g. "0014{20-byte-hash}" or "5120{32-byte-key}".
 */
export function decodeScriptPubKey(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error('scriptPubKey must be an even-length hex string (e.g. 0014... or 5120...)');
  }
  const bytes = hexToBytes(clean);
  // P2WPKH: 0x0014 + 20 bytes = 22 bytes
  // P2TR:   0x5120 + 32 bytes = 34 bytes
  // P2PKH:  0x76a914 + 20 bytes + 0x88ac = 25 bytes
  if (bytes.length < 4) throw new Error('scriptPubKey too short');
  return bytes;
}
