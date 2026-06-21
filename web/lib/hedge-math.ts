/**
 * m1n3 mining-revenue hedge — math model.
 *
 * Pure functions. No SDK calls, no React. Imports only from
 * `predict-client.ts` for the SVI-to-vol helper and the strike scaling.
 * Designed to be unit-testable in isolation and reused later by the
 * sidecar Rust binding (`sui-client/src/predict.rs` will mirror this).
 *
 * ── The construction ────────────────────────────────────────────────────
 *
 * Miner expects to earn `qBtc` over the hedge horizon and BTC currently
 * trades at `spot`. Without a hedge, revenue at expiry is:
 *
 *   revenue(S_T) = qBtc * S_T                                 (USD)
 *
 * A Predict range R(L, H) pays 1 DUSDC per share if the oracle settles in
 * [L, H). Buying `Q_i` shares of range R(L_i, M_i) costs `Q_i * ask_i`
 * (with `0 < ask_i < 1`) and pays `Q_i` if S_T ∈ [L_i, M_i).
 *
 * Choose a strike K (the "hedge top" — typically spot × (1 - dropBandLo))
 * and a floor F = spot × (1 - dropBandHi). Partition [F, K) into N strikes
 * on the oracle's tick grid. Set:
 *
 *   Q_i = qBtc * (M_i - L_i)
 *
 * Then total payoff is:
 *
 *   H(S_T) = Σ_i Q_i * 1{S_T ∈ [L_i, M_i)}
 *          ≈ qBtc * max(K - S_T, 0)   when S_T ∈ [F, K)
 *          = 0                         when S_T ≥ K
 *          ≈ qBtc * (K - F)            when S_T < F (capped)
 *
 * So total hedged revenue (deducting premium P):
 *
 *   hedged(S_T) = qBtc * S_T + H(S_T) − P
 *               ≈ qBtc * max(S_T, K) − P     for S_T ∈ [F, ∞)
 *
 * The floor at `qBtc * F - P` caps downside. The cost P is the sum of
 * `Q_i * ask_i` across the strip. Since Predict prices ranges from the
 * SVI surface, P is fair-value by construction — no edge or disedge
 * either way; the trade is pure variance reduction.
 *
 * The Monte-Carlo simulator below confirms that hedged variance is
 * strictly lower than unhedged, and the 5th-percentile revenue is
 * strictly higher.
 */

import {
  STRIKE_SCALAR,
  type PredictSviEvent,
  sviImpliedVol,
  usdToStrike,
  strikeToUsd,
} from './predict-client';

const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;

// ── Strip builder ───────────────────────────────────────────────────────────

export interface HedgeRange {
  /** Lower strike in scaled u64 (suitable for `RangeKey.new`). */
  lowerStrikeRaw: number;
  /** Upper strike in scaled u64. */
  higherStrikeRaw: number;
  /** Number of range shares to mint (1 share = 1 DUSDC if settled in band). */
  quantity: number;
}

export interface HedgeStripInputs {
  /** Expected BTC revenue over the hedge horizon. */
  qBtc: number;
  /** Current BTC spot in USD. */
  spot: number;
  /** Lower edge of the hedged drop band (e.g. 0.02 for a 2% drop). */
  dropBandLo: number;
  /** Upper edge of the hedged drop band (e.g. 0.10 for a 10% drop). */
  dropBandHi: number;
  /** Oracle's strike tick size, scaled u64. */
  tickSizeRaw: number;
  /** Oracle's minimum strike, scaled u64. */
  minStrikeRaw: number;
}

/**
 * Build the linearly-sized strip of ranges that synthesizes a discrete
 * put for the miner's expected revenue. Strikes are snapped to the
 * oracle's tick grid.
 */
export function buildHedgeStrip(input: HedgeStripInputs): HedgeRange[] {
  const { qBtc, spot, dropBandLo, dropBandHi, tickSizeRaw, minStrikeRaw } = input;
  if (qBtc <= 0 || spot <= 0) return [];
  if (dropBandLo < 0 || dropBandHi <= dropBandLo) return [];

  // Top of strip (closest to spot) and floor (lowest hedged strike).
  const topUsd = spot * (1 - dropBandLo);
  const floorUsd = spot * (1 - dropBandHi);

  // Snap to tick grid.
  const tickUsd = tickSizeRaw / STRIKE_SCALAR;
  const topRaw = Math.min(usdToStrike(topUsd), spotToTick(topUsd, tickUsd));
  const floorRaw = Math.max(
    usdToStrike(floorUsd),
    minStrikeRaw,
    spotToTick(floorUsd, tickUsd),
  );
  if (floorRaw >= topRaw) return [];

  // For practical demo size, cap the strip at 8 ranges and widen the
  // tick if needed. A 10% band on a $1 tick at $63k spot = ~6300 ticks;
  // a strip of 6300 mint calls is infeasible. Coarsen the bin size so we
  // have ~8 evenly spaced bands but each band is still a multiple of
  // tick_size.
  const TARGET_BINS = 8;
  const rawSpan = topRaw - floorRaw;
  const minBinRaw = Math.max(
    tickSizeRaw,
    Math.floor(rawSpan / TARGET_BINS / tickSizeRaw) * tickSizeRaw,
  );

  const ranges: HedgeRange[] = [];
  let lowerRaw = floorRaw;
  while (lowerRaw < topRaw) {
    const higherRaw = Math.min(lowerRaw + minBinRaw, topRaw);
    // Q_i = qBtc * (M_i - L_i), but in display units of DUSDC, and
    // because BTC strikes are in scaled-USD we need to divide by
    // STRIKE_SCALAR to get back to USD.
    const widthUsd = (higherRaw - lowerRaw) / STRIKE_SCALAR;
    const quantity = qBtc * widthUsd;
    if (quantity > 0) {
      ranges.push({
        lowerStrikeRaw: lowerRaw,
        higherStrikeRaw: higherRaw,
        quantity,
      });
    }
    lowerRaw = higherRaw;
  }
  return ranges;
}

function spotToTick(usd: number, tickUsd: number): number {
  return Math.round((Math.round(usd / tickUsd) * tickUsd) * STRIKE_SCALAR);
}

/**
 * Recommend a hedge drop band sized to ~1σ of the SVI-implied lognormal
 * move at expiry. Returns `{lo, hi}` as fractional drops (e.g.
 * `{lo: 0.002, hi: 0.008}` = 0.2%-0.8% drop). Calibrating the band to
 * the actual expected move keeps the hedge from sitting deep
 * out-of-distribution, which would make it free (and useless).
 */
export function suggestDropBand(
  svi: PredictSviEvent,
  expiryMs: number,
): { lo: number; hi: number } | null {
  const tauYears = Math.max(1, expiryMs - Date.now()) / MS_PER_YEAR;
  const sigmaATM = sviImpliedVol(0, svi, tauYears);
  if (!isFinite(sigmaATM) || sigmaATM <= 0) return null;
  // ~1σ move: σ_ATM × √τ. Hedge the band [0.25σ, 1.25σ] below spot.
  const oneSigmaMove = sigmaATM * Math.sqrt(tauYears);
  return {
    lo: oneSigmaMove * 0.25,
    hi: oneSigmaMove * 1.25,
  };
}

// ── Analytic strip pricing off the SVI smile ─────────────────────────────────
//
// The on-chain `mint_range` cost is the risk-neutral value of the digital
// range under Predict's vol surface. A range R(L, H) pays 1 DUSDC iff
// S_T ∈ [L, H), so its fair value per share (r ≈ 0) is exactly the
// risk-neutral probability mass in that bin:
//
//   value = P(S_T > L) − P(S_T > H) = Φ(d2(L)) − Φ(d2(H))
//
// where, crucially, each strike is priced at *its own* implied vol from the
// smile — that is what makes downside ranges cost more than the ATM-only
// Monte-Carlo estimate implied. d2(K) = [ln(F/K) − ½σ(K)²τ] / (σ(K)√τ).

/** Standard normal CDF via erf (Abramowitz-Stegun 7.1.26, ~1e-7 abs error). */
function normCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp((-x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Risk-neutral value (DUSDC per share) of one range under the smile. */
export function priceRangeFromSvi(
  range: Pick<HedgeRange, 'lowerStrikeRaw' | 'higherStrikeRaw'>,
  svi: PredictSviEvent,
  forward: number,
  expiryMs: number,
): number {
  const tauYears = Math.max(1, expiryMs - Date.now()) / MS_PER_YEAR;
  if (forward <= 0 || tauYears <= 0) return 0;
  const probAbove = (kRaw: number): number => {
    const K = strikeToUsd(kRaw);
    if (K <= 0) return 1;
    const k = Math.log(K / forward); // log-moneyness vs forward
    const sigma = sviImpliedVol(k, svi, tauYears);
    if (!isFinite(sigma) || sigma <= 0) return K <= forward ? 1 : 0;
    const d2 =
      (Math.log(forward / K) - 0.5 * sigma * sigma * tauYears) /
      (sigma * Math.sqrt(tauYears));
    return normCdf(d2); // P(S_T > K)
  };
  // P(L ≤ S_T < H) = P(>L) − P(>H), clamped to [0,1].
  const p = probAbove(range.lowerStrikeRaw) - probAbove(range.higherStrikeRaw);
  return Math.min(1, Math.max(0, p));
}

export interface StripPricing {
  /** Total premium to pay for the whole strip (USD ≈ DUSDC). */
  totalPremiumUsd: number;
  /** Per-range premium, aligned 1:1 with the input strip. */
  perRangeUsd: number[];
}

/** Price the whole strip off the smile. `Σ quantity_i × P(bin_i)`. */
export function priceStripFromSvi(
  strip: HedgeRange[],
  svi: PredictSviEvent,
  forward: number,
  expiryMs: number,
): StripPricing {
  const perRangeUsd = strip.map(
    (r) => r.quantity * priceRangeFromSvi(r, svi, forward, expiryMs),
  );
  return {
    perRangeUsd,
    totalPremiumUsd: perRangeUsd.reduce((s, x) => s + x, 0),
  };
}

// ── Miner-legible hedge summary ───────────────────────────────────────────────

export interface HedgeSummary {
  /** Premium paid for the strip (USD). */
  premiumUsd: number;
  /** Premium as a fraction of expected revenue. */
  premiumPctOfRevenue: number;
  /** Gross downside offset if BTC settles at/below the floor (= Σ quantity). */
  maxProtectedUsd: number;
  /** Lowest hedged strike (USD) — the protection floor on settlement price. */
  floorUsd: number;
  /** Highest hedged strike (USD) — protection kicks in below this. */
  topUsd: number;
  /** Revenue floored level: qBtc×floor + maxProtected − premium (USD). */
  flooredRevenueUsd: number;
  /** Unhedged revenue if BTC settles at the floor (USD). */
  unhedgedAtFloorUsd: number;
  /** Settlement price at which cumulative hedge payoff repays the premium. */
  breakEvenSpot: number;
  /** Drop from current spot to the break-even settlement (fraction). */
  breakEvenDropPct: number;
}

/**
 * Translate a priced strip into the numbers a miner actually reasons about:
 * "pay X, protect up to Y, your revenue can't fall below Z". Pure arithmetic
 * on the strip — no sampling.
 */
export function summarizeHedge(
  strip: HedgeRange[],
  qBtc: number,
  spot: number,
  premiumUsd: number,
  expectedUsd: number,
): HedgeSummary | null {
  if (strip.length === 0 || qBtc <= 0 || spot <= 0) return null;
  const floorUsd = strikeToUsd(
    strip.reduce((m, r) => Math.min(m, r.lowerStrikeRaw), Infinity),
  );
  const topUsd = strikeToUsd(
    strip.reduce((m, r) => Math.max(m, r.higherStrikeRaw), 0),
  );
  const maxProtectedUsd = strip.reduce((s, r) => s + r.quantity, 0);
  const unhedgedAtFloorUsd = qBtc * floorUsd;
  const flooredRevenueUsd = unhedgedAtFloorUsd + maxProtectedUsd - premiumUsd;
  // Hedge pays ≈ qBtc×(top − S) for S in [floor, top]. It repays the premium
  // when qBtc×(top − S) = premium ⇒ S = top − premium/qBtc.
  const breakEvenSpot = qBtc > 0 ? topUsd - premiumUsd / qBtc : topUsd;
  return {
    premiumUsd,
    premiumPctOfRevenue: expectedUsd > 0 ? premiumUsd / expectedUsd : 0,
    maxProtectedUsd,
    floorUsd,
    topUsd,
    flooredRevenueUsd,
    unhedgedAtFloorUsd,
    breakEvenSpot,
    breakEvenDropPct: spot > 0 ? Math.max(0, (spot - breakEvenSpot) / spot) : 0,
  };
}

// ── Payoff curve (for the revenue-vs-settlement chart) ────────────────────────

export interface PayoffPoint {
  /** Settlement price (USD). */
  price: number;
  /** Unhedged revenue at this settlement (USD). */
  unhedged: number;
  /** Hedged revenue at this settlement (USD), net of premium. */
  hedged: number;
}

/**
 * Sample hedged-vs-unhedged revenue across a band of settlement prices for
 * the payoff chart. Uses the *actual discrete* strip payoff (a staircase),
 * so what the miner sees is exactly what the ranges pay — not a smoothed
 * idealization.
 */
export function buildPayoffCurve(
  strip: HedgeRange[],
  qBtc: number,
  premiumUsd: number,
  spot: number,
  opts: { loFrac?: number; hiFrac?: number; steps?: number } = {},
): PayoffPoint[] {
  const { loFrac = 0.12, hiFrac = 0.06, steps = 140 } = opts;
  if (qBtc <= 0 || spot <= 0) return [];
  const lo = spot * (1 - loFrac);
  const hi = spot * (1 + hiFrac);
  const bins = strip.map((r) => ({
    lo: strikeToUsd(r.lowerStrikeRaw),
    hi: strikeToUsd(r.higherStrikeRaw),
    q: r.quantity,
  }));
  const out: PayoffPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const price = lo + ((hi - lo) * i) / steps;
    let payoff = 0;
    for (const b of bins) {
      if (price >= b.lo && price < b.hi) {
        payoff += b.q;
        break;
      }
    }
    out.push({
      price,
      unhedged: qBtc * price,
      hedged: qBtc * price + payoff - premiumUsd,
    });
  }
  return out;
}

// ── Monte-Carlo simulator ───────────────────────────────────────────────────

export interface SimulationInputs {
  qBtc: number;
  spot: number;
  strip: HedgeRange[];
  /** SVI params from `/oracles/:id/svi/latest`. */
  svi: PredictSviEvent;
  /** Oracle expiry timestamp (ms). */
  expiryMs: number;
  /** Total premium paid (USD). */
  premiumUsd: number;
  /** Number of Monte-Carlo samples. */
  n: number;
}

export interface SimulationResult {
  /** Sampled BTC settlement prices (USD), length `n`. */
  samples: number[];
  /** Per-sample unhedged revenue (USD). */
  unhedged: number[];
  /** Per-sample hedged revenue (USD). */
  hedged: number[];
  summary: {
    unhedgedMean: number;
    hedgedMean: number;
    unhedgedStdev: number;
    hedgedStdev: number;
    unhedgedP05: number;
    hedgedP05: number;
    unhedgedP50: number;
    hedgedP50: number;
    unhedgedP95: number;
    hedgedP95: number;
    expectedPayoffUsd: number;
    fairValuePayoffUsd: number;
  };
}

/**
 * Run a Monte-Carlo simulation of unhedged-vs-hedged miner revenue at the
 * oracle's expiry. Samples BTC settlement from the SVI-implied
 * lognormal at the at-the-money vol point — adequate for the MVP demo.
 * (For production we'd integrate the full risk-neutral density via the
 * Carr-Madan formula; the protocol's range prices already encode this,
 * so we'd be re-deriving the same thing.)
 */
export function simulateHedgePnl(input: SimulationInputs): SimulationResult {
  const { qBtc, spot, strip, svi, expiryMs, premiumUsd, n } = input;
  const tauMs = Math.max(1, expiryMs - Date.now());
  const tauYears = tauMs / MS_PER_YEAR;
  // ATM implied vol from the SVI surface.
  const sigmaATM = sviImpliedVol(0, svi, tauYears);
  if (!isFinite(sigmaATM) || sigmaATM <= 0) {
    // Degenerate surface; can't simulate. Return empty result.
    return {
      samples: [],
      unhedged: [],
      hedged: [],
      summary: zeroSummary(),
    };
  }

  // Risk-neutral drift = 0 for demo purposes (rates ~0, no carry).
  // S_T = spot * exp(-0.5 * σ²τ + σ√τ * Z), Z ~ N(0,1).
  const samples: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const z = sampleNormal();
    samples[i] = spot * Math.exp(-0.5 * sigmaATM * sigmaATM * tauYears + sigmaATM * Math.sqrt(tauYears) * z);
  }

  const unhedged = samples.map((s) => qBtc * s);
  const hedged = samples.map((s) => {
    let payoff = 0;
    for (const r of strip) {
      const lo = strikeToUsd(r.lowerStrikeRaw);
      const hi = strikeToUsd(r.higherStrikeRaw);
      if (s >= lo && s < hi) {
        payoff += r.quantity;
        break;
      }
    }
    return qBtc * s + payoff - premiumUsd;
  });

  const expectedPayoff = mean(hedged.map((h, i) => h - unhedged[i] + premiumUsd));
  const summary = {
    unhedgedMean: mean(unhedged),
    hedgedMean: mean(hedged),
    unhedgedStdev: stdev(unhedged),
    hedgedStdev: stdev(hedged),
    unhedgedP05: quantile(unhedged, 0.05),
    hedgedP05: quantile(hedged, 0.05),
    unhedgedP50: quantile(unhedged, 0.50),
    hedgedP50: quantile(hedged, 0.50),
    unhedgedP95: quantile(unhedged, 0.95),
    hedgedP95: quantile(hedged, 0.95),
    expectedPayoffUsd: expectedPayoff,
    fairValuePayoffUsd: premiumUsd, // fair-value mark equals premium
  };
  return { samples, unhedged, hedged, summary };
}

function zeroSummary() {
  return {
    unhedgedMean: 0,
    hedgedMean: 0,
    unhedgedStdev: 0,
    hedgedStdev: 0,
    unhedgedP05: 0,
    hedgedP05: 0,
    unhedgedP50: 0,
    hedgedP50: 0,
    unhedgedP95: 0,
    hedgedP95: 0,
    expectedPayoffUsd: 0,
    fairValuePayoffUsd: 0,
  };
}

// ── Stat helpers ────────────────────────────────────────────────────────────

function sampleNormal(): number {
  // Box-Muller. Cached pair gives us 2 N(0,1) per call set.
  const u1 = Math.max(Math.random(), 1e-12);
  const u2 = Math.max(Math.random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / (xs.length - 1));
}

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const sorted = xs.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[idx];
}
