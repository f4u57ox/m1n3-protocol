// OTC escrow link serialization.
//
// After the seller lock_escrows, the page surfaces a URL that encodes
// the on-chain `Escrow` object id. The URL is the bearer credential —
// the buyer pastes it into their wallet's browser and the page resolves
// the on-chain object to show the trade terms. Cancel + status come
// directly from the chain.

export type OtcLinkV1 = {
  v: 1;
  /** Shared `Escrow` object id (set after `lock_escrow`). */
  escrowId: string;
  /** Display hint — fully-qualified deliverable coin type. */
  sellAsset: string;
  /** Display hint — DUSDC coin type. */
  payAsset: string;
};

export function encodeOtcLink(t: OtcLinkV1): string {
  const json = JSON.stringify(t);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeOtcLink(s: string): OtcLinkV1 | null {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = decodeURIComponent(escape(atob(padded)));
    const parsed = JSON.parse(json) as OtcLinkV1;
    if (parsed.v !== 1) return null;
    if (
      typeof parsed.escrowId !== "string" ||
      typeof parsed.sellAsset !== "string" ||
      typeof parsed.payAsset !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function formatAmount(raw: string | bigint, decimals: number): string {
  const v = typeof raw === "bigint" ? raw : BigInt(raw);
  if (decimals === 0) return v.toString();
  const factor = BigInt(10) ** BigInt(decimals);
  const whole = v / factor;
  const frac = v % factor;
  const fracStr = frac
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}

export function parseAmount(decStr: string, decimals: number): bigint | null {
  try {
    const [whole, frac = ""] = decStr.split(".");
    const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
    const all = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
    return BigInt(all || "0");
  } catch {
    return null;
  }
}
