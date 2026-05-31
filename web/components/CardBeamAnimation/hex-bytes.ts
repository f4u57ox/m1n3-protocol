export interface HexFragment {
  char: string;
  col: number;
  row: number;
  /** Scatter offset X in px (±60) */
  dx: number;
  /** Scatter offset Y in px (±60) */
  dy: number;
  /** Scatter rotation in deg (±15) */
  rot: number;
  /** Base opacity at full scatter (0.06-0.14) */
  baseOpacity: number;
}

/** Deterministic PRNG seeded from a hex string */
function seededRng(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  }
  return () => {
    h = (Math.imul(h ^ (h >>> 16), 0x45d9f3b) + 0x9e3779b9) | 0;
    return ((h >>> 0) / 0x100000000);
  };
}

/**
 * Generate a hex byte grid from a block hash.
 * If `headerHex` (80-byte block header as hex) is provided, those bytes are
 * repeated to fill. Otherwise, deterministic pseudo-random bytes are generated.
 *
 * Returns a string like "4a 3f b2 c1 ..." with rows separated by newlines.
 */
export function generateHexBytes(
  blockHash: string,
  cols: number,
  rows: number,
  headerHex?: string,
): string {
  const totalBytes = cols * rows;

  let bytes: string[];

  if (headerHex && headerHex.length >= 2) {
    // Parse real header bytes and repeat to fill
    const raw: string[] = [];
    const clean = headerHex.replace(/\s/g, "").toLowerCase();
    for (let i = 0; i + 1 < clean.length; i += 2) {
      raw.push(clean.slice(i, i + 2));
    }
    bytes = [];
    for (let i = 0; i < totalBytes; i++) {
      bytes.push(raw[i % raw.length]);
    }
  } else {
    // Deterministic pseudo-random from block hash
    const rng = seededRng(blockHash);
    bytes = [];
    for (let i = 0; i < totalBytes; i++) {
      const b = Math.floor(rng() * 256);
      bytes.push(b.toString(16).padStart(2, "0"));
    }
  }

  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    const start = r * cols;
    lines.push(bytes.slice(start, start + cols).join(" "));
  }
  return lines.join("\n");
}

/**
 * Compute how many hex byte columns and rows fit in a card.
 * Each byte takes ~3ch (2 hex chars + 1 space). Monospace at 9px ~= 5.4px/ch.
 */
export function hexDimensions(cardWidth: number, cardHeight: number) {
  const charWidth = 5.4;
  const lineHeight = 13;
  const padding = 8;
  const cols = Math.floor((cardWidth - padding * 2) / (charWidth * 3));
  const rows = Math.floor((cardHeight - padding * 2) / lineHeight);
  return { cols: Math.max(1, cols), rows: Math.max(1, rows) };
}

/**
 * Generate hex fragment data for scatter animation.
 * Each fragment has a deterministic scatter offset, rotation, and opacity.
 */
export function generateHexFragments(
  blockHash: string,
  cols: number,
  rows: number,
  scatterRadius: number = 200,
  headerHex?: string,
): HexFragment[] {
  const rng = seededRng(blockHash);
  const fragments: HexFragment[] = [];

  // Pre-parse real header bytes if available
  let realBytes: string[] | null = null;
  if (headerHex && headerHex.length >= 2) {
    const clean = headerHex.replace(/\s/g, "").toLowerCase();
    realBytes = [];
    for (let i = 0; i + 1 < clean.length; i += 2) {
      realBytes.push(clean.slice(i, i + 2));
    }
  }

  let byteIdx = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const char = realBytes
        ? realBytes[byteIdx % realBytes.length]
        : Math.floor(rng() * 256).toString(16).padStart(2, "0");
      byteIdx++;

      fragments.push({
        char,
        col: c,
        row: r,
        // Scatter offsets always from seeded RNG for deterministic animation
        dx: (rng() - 0.5) * scatterRadius * 2,
        dy: (rng() - 0.5) * scatterRadius * 2,
        rot: (rng() - 0.5) * 60,       // ±30deg
        baseOpacity: 0.06 + rng() * 0.08, // 0.06-0.14
      });
    }
  }

  return fragments;
}
