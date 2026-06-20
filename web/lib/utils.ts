import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { M1N3_DECIMALS, SUI_NETWORK } from './constants';

/** SuiScan link for a transaction digest. */
export function suiscanTx(digest: string): string {
  return `https://suiscan.xyz/${SUI_NETWORK}/tx/${digest}`;
}

/** SuiScan link for an object or account address. */
export function suiscanObject(address: string): string {
  return `https://suiscan.xyz/${SUI_NETWORK}/object/${address}`;
}

/** SuiScan link for an account address. */
export function suiscanAccount(address: string): string {
  return `https://suiscan.xyz/${SUI_NETWORK}/account/${address}`;
}

/** @deprecated Use suiscanTx instead */
export const solscanTx = suiscanTx;
/** @deprecated Use suiscanAccount instead */
export const solscanAccount = suiscanAccount;

/**
 * Merge Tailwind CSS classes with clsx.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Truncate a Sui hex address to "0xabcd...efgh".
 */
export function truncateAddress(addr: string, chars = 6): string {
  if (!addr) return '';
  if (addr.length <= chars * 2 + 2) return addr;
  return `${addr.slice(0, chars + 2)}...${addr.slice(-chars)}`;
}

/**
 * Truncate a hex string to at most `maxLen` characters, appending "..." if
 * it exceeds that length.
 */
export function formatHex(hex: string, maxLen = 16): string {
  if (!hex) return '';
  if (hex.length <= maxLen) return hex;
  return `${hex.slice(0, maxLen)}...`;
}

/**
 * Format a raw M1N3 base-unit amount into a human-readable string with commas.
 *
 * Example: `formatM1N3(1_234_500_000_000)` => `"12,345.00"` (with 8 decimals)
 */
export function formatM1N3(amount: number): string {
  const value = amount / 10 ** M1N3_DECIMALS;
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Format a difficulty value into a human-readable string.
 *
 * Renders large difficulties with K / M / G / T suffixes.
 */
export function formatDifficulty(diff: number): string {
  if (diff >= 1e12) return `${(diff / 1e12).toFixed(2)}T`;
  if (diff >= 1e9) return `${(diff / 1e9).toFixed(2)}G`;
  if (diff >= 1e6) return `${(diff / 1e6).toFixed(2)}M`;
  if (diff >= 1e3) return `${(diff / 1e3).toFixed(2)}K`;
  return String(diff);
}

/**
 * Relative time string: "5s ago", "2m ago", "1h ago", "3d ago".
 *
 * @param ms - Timestamp in milliseconds (epoch).
 */
export function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0) return 'just now';

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Convert Bitcoin compact-target (nbits) to a full 256-bit hex target string.
 *
 * nbits layout: 0xEEMMMMMMM
 *   - EE      = exponent byte (number of bytes in the full target)
 *   - MMMMMM  = 3-byte mantissa
 *
 * target = mantissa * 2^(8*(exponent - 3))
 */
export function nbitsToTarget(nbits: number): string {
  const exponent = (nbits >>> 24) & 0xff;
  const mantissa = nbits & 0x00ffffff;

  if (mantissa === 0 || exponent === 0) return '0'.repeat(64);

  // Build a byte array of length 32 (256 bits), big-endian.
  const target = new Uint8Array(32);

  // The mantissa occupies 3 bytes starting at position (32 - exponent).
  const offset = 32 - exponent;
  if (offset >= 0 && offset < 32) {
    target[offset] = (mantissa >> 16) & 0xff;
  }
  if (offset + 1 >= 0 && offset + 1 < 32) {
    target[offset + 1] = (mantissa >> 8) & 0xff;
  }
  if (offset + 2 >= 0 && offset + 2 < 32) {
    target[offset + 2] = mantissa & 0xff;
  }

  return Array.from(target)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Format a hashrate value into a human-readable string with appropriate units.
 *
 * @param h - Hashrate in H/s
 */
export function formatHashrate(h: number): string {
  if (h >= 1e18) return `${(h / 1e18).toFixed(2)} EH/s`;
  if (h >= 1e15) return `${(h / 1e15).toFixed(2)} PH/s`;
  if (h >= 1e12) return `${(h / 1e12).toFixed(2)} TH/s`;
  if (h >= 1e9) return `${(h / 1e9).toFixed(2)} GH/s`;
  if (h >= 1e6) return `${(h / 1e6).toFixed(2)} MH/s`;
  if (h >= 1e3) return `${(h / 1e3).toFixed(2)} KH/s`;
  return `${h.toFixed(2)} H/s`;
}

// ---------------------------------------------------------------------------
// Per-address deterministic coloring for Sankey diagrams
// ---------------------------------------------------------------------------

const ADDRESS_PALETTE = [
  "#818cf8", "#f472b6", "#22d3ee", "#a78bfa", "#fb923c",
  "#34d399", "#f87171", "#38bdf8", "#fbbf24", "#c084fc",
];

function djb2Hash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function addressColor(address: string): string {
  return ADDRESS_PALETTE[djb2Hash(address) % ADDRESS_PALETTE.length];
}
