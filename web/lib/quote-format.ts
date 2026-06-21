/**
 * Quote-decimals-aware price formatting + parsing.
 *
 * The HashShare market's `price_per_unit_mist` is a u64 in base units
 * of whichever quote coin the market is parameterized by — `MIST` (1e-9
 * SUI) on SUI-quoted markets, `µUSDC` (1e-6 USDC) on the mainnet USDC
 * market. The UI works in decimal-shifted values like `0.000017 USDC`;
 * these helpers handle the round-trip.
 *
 * Source-of-record for `QuoteToken` is `web/lib/quote-tokens.ts`.
 */

import type { QuoteToken } from "./quote-tokens";

/**
 * Human-readable name for the smallest representable unit of `quote`.
 * Used as the back-compat fallback label when we render the raw u64
 * base-unit value next to a decimal display (e.g. "17 µUSDC" next to
 * "0.000017 USDC").
 *
 * - SUI keeps its conventional "MIST" naming (testnet/devnet markets).
 * - 6-decimal stables (USDC, USDT, DUSDC, …) prefix with "µ".
 * - 9-decimal coins prefix with "n" (rare).
 * - Everything else falls back to a generic `<SYM>@10^-N` annotation.
 */
export function baseUnitLabel(quote: QuoteToken): string {
  if (quote.symbol === "SUI") return "MIST";
  if (quote.decimals === 6) return `µ${quote.symbol}`;
  if (quote.decimals === 9) return `n${quote.symbol}`;
  return `${quote.symbol}@10^-${quote.decimals}`;
}

/**
 * Render a u64 price in the quote's base units as a decimal-shifted
 * string suffixed with the quote symbol. Trailing zeros in the
 * fractional part are stripped, so `17` µUSDC ⇒ "0.000017 USDC", not
 * "0.000017000000 USDC".
 */
export function formatPriceInQuote(
  priceBaseUnits: bigint,
  quote: QuoteToken,
): string {
  const dec = quote.decimals;
  if (dec === 0) return `${priceBaseUnits.toString()} ${quote.symbol}`;
  const factor = BigInt(10) ** BigInt(dec);
  const whole = priceBaseUnits / factor;
  const frac = priceBaseUnits % factor;
  if (frac === 0n) return `${whole.toString()} ${quote.symbol}`;
  const fracPadded = frac
    .toString()
    .padStart(dec, "0")
    .replace(/0+$/, "");
  return `${whole.toString()}.${fracPadded} ${quote.symbol}`;
}

/**
 * Inverse of `formatPriceInQuote`: parse a user-entered decimal string
 * (`"0.000017"`) into the u64 base-unit value the on-chain market
 * expects (`17n`). Returns `null` on parse failure so callers can show
 * an inline validation error.
 *
 * Rejects:
 *   - Empty / whitespace-only strings.
 *   - Strings containing anything but ASCII digits and at most one `.`.
 *   - Scientific notation (e.g. `"1e-6"`).
 *   - Negative values.
 *   - Fractional parts longer than `quote.decimals` (would truncate).
 *
 * Note: `"."` and `".5"` parse to base units of the fractional part
 * (i.e. `parseQuoteAmount(".5", USDC) === 500_000n`). Empty whole part
 * is treated as zero.
 */
export function parseQuoteAmount(
  decimalString: string,
  quote: QuoteToken,
): bigint | null {
  const trimmed = decimalString.trim();
  if (trimmed === "" || trimmed === ".") return null;
  if (!/^\d*\.?\d*$/.test(trimmed)) return null;
  const [wholeRaw = "", fracRaw = ""] = trimmed.split(".");
  if (fracRaw.length > quote.decimals) return null;
  const whole = wholeRaw === "" ? "0" : wholeRaw;
  const fracPadded = fracRaw.padEnd(quote.decimals, "0");
  const combined = whole + fracPadded;
  try {
    return BigInt(combined);
  } catch {
    return null;
  }
}
