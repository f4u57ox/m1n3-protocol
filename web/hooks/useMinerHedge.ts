"use client";

import { useMemo } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit";
import { useMiners } from "@/hooks/useMiners";
import { useHashprice } from "@/hooks/useHashprice";
import {
  useActiveBtcOracles,
  useOracleState,
} from "@/hooks/usePredictOracles";
import {
  buildHedgeStrip,
  buildPayoffCurve,
  priceStripFromSvi,
  simulateHedgePnl,
  suggestDropBand,
  summarizeHedge,
  type HedgeRange,
  type HedgeSummary,
  type PayoffPoint,
  type SimulationResult,
  type StripPricing,
} from "@/lib/hedge-math";
import { strikeToUsd } from "@/lib/predict-client";

/** Everything one drop-band choice produces, ready for the dashboard. */
export interface HedgeBuild {
  strip: HedgeRange[];
  /** Per-range + total premium priced off the live SVI smile. */
  pricing: StripPricing;
  /** Miner-legible cost/benefit summary (null for degenerate strips). */
  summary: HedgeSummary | null;
  /** Hedged-vs-unhedged revenue across settlement prices. */
  payoff: PayoffPoint[];
  /** Monte-Carlo distribution (null for degenerate strips). */
  sim: SimulationResult | null;
}

export interface MinerRevenueProjection {
  /** Miner address resolved from the connected wallet. */
  address: string | null;
  /** Current estimated hashrate in TH/s. */
  hashrateThs: number;
  /** Live BTC price (USD/BTC). */
  btcPrice: number;
  /** Live hashprice ($/TH/day). */
  hashpriceUsdPerThDay: number;
  /** Expected BTC over the chosen horizon (the oracle's expiry). */
  qBtc: number;
  /** Expected USD over the same horizon = qBtc × btcPrice. */
  expectedUsd: number;
}

export interface UseMinerHedgeResult {
  projection: MinerRevenueProjection;
  oracleId: string | null;
  spot: number;
  expiryMs: number;
  /// Recommended drop band from SVI (or null when SVI unavailable).
  suggestedBand: { lo: number; hi: number } | null;
  /// BTC forward at the oracle horizon (USD), from the live price event.
  forward: number;
  /// The strip, smile-priced premium, summary, payoff curve and MC result
  /// for the current drop-band choice. `null` until oracle state is ready;
  /// otherwise always returns a `HedgeBuild` (strip may be empty).
  build:
    | ((params: { dropBandLo: number; dropBandHi: number }) => HedgeBuild)
    | null;
  /// Loading / error state for the whole compute path.
  isLoading: boolean;
  error: Error | null;
}

const MS_PER_DAY = 86_400_000;

/**
 * Compute the connected miner's expected BTC revenue over the soonest
 * active oracle's horizon, expose helpers that build hedge strips and
 * run the Monte-Carlo simulation against the live SVI.
 *
 * The hook is *pure* on top of `useMiners` + `useHashprice` + the
 * Predict-server queries — it doesn't itself sign or submit anything.
 * `HedgePlacement.tsx` is the component that turns the strip into a PTB.
 */
export function useMinerHedge(): UseMinerHedgeResult {
  const account = useCurrentAccount();
  const address = account?.address ?? null;

  const { miners } = useMiners();
  const hash = useHashprice();
  const oraclesQ = useActiveBtcOracles();
  const firstOracleId = oraclesQ.data?.[0]?.oracle_id ?? null;
  const oracleStateQ = useOracleState(firstOracleId ?? undefined);

  const projection = useMemo<MinerRevenueProjection>(() => {
    const miner = (miners ?? []).find((m) => m.address === address) ?? null;
    const hashrateThs =
      miner?.estimatedHashrate != null
        ? miner.estimatedHashrate / 1e12
        : 0;
    const btcPrice = hash.btcPrice ?? 0;
    const hashpriceUsdPerThDay = hash.hashprice ?? 0;

    const expiryMs = oraclesQ.data?.[0]?.expiry ?? Date.now();
    const horizonMs = Math.max(0, expiryMs - Date.now());
    const horizonDays = horizonMs / MS_PER_DAY;
    const expectedUsdDaily = hashrateThs * hashpriceUsdPerThDay;
    const expectedUsd = expectedUsdDaily * horizonDays;
    const qBtc = btcPrice > 0 ? expectedUsd / btcPrice : 0;

    return {
      address,
      hashrateThs,
      btcPrice,
      hashpriceUsdPerThDay,
      qBtc,
      expectedUsd,
    };
  }, [address, miners, hash.btcPrice, hash.hashprice, oraclesQ.data]);

  const spot = useMemo(() => {
    const raw = oracleStateQ.data?.latest_price?.spot;
    return raw != null ? strikeToUsd(raw) : 0;
  }, [oracleStateQ.data]);

  // Forward is what ranges are actually priced against; fall back to spot.
  const forward = useMemo(() => {
    const raw = oracleStateQ.data?.latest_price?.forward;
    return raw != null ? strikeToUsd(raw) : spot;
  }, [oracleStateQ.data, spot]);

  const expiryMs = oracleStateQ.data?.oracle.expiry ?? 0;

  const svi = oracleStateQ.data?.latest_svi ?? null;
  const suggestedBand = useMemo(
    () => (svi && expiryMs ? suggestDropBand(svi, expiryMs) : null),
    [svi, expiryMs],
  );

  const build = useMemo(() => {
    if (!oracleStateQ.data || !svi || !spot) return null;
    const tickSizeRaw = oracleStateQ.data.oracle.tick_size;
    const minStrikeRaw = oracleStateQ.data.oracle.min_strike;

    return ({
      dropBandLo,
      dropBandHi,
    }: {
      dropBandLo: number;
      dropBandHi: number;
    }): HedgeBuild => {
      const strip = buildHedgeStrip({
        qBtc: projection.qBtc,
        spot,
        dropBandLo,
        dropBandHi,
        tickSizeRaw,
        minStrikeRaw,
      });
      const emptyPricing: StripPricing = { totalPremiumUsd: 0, perRangeUsd: [] };
      if (strip.length === 0) {
        return {
          strip: [],
          pricing: emptyPricing,
          summary: null,
          payoff: [],
          sim: null,
        };
      }
      // Premium is the analytic risk-neutral value of the strip off the live
      // SVI smile (skew-aware) — the same surface Predict prices `mint_range`
      // against, so it tracks the real on-chain cost far better than an
      // ATM-only Monte-Carlo estimate.
      const pricing = priceStripFromSvi(strip, svi, forward, expiryMs);
      const premiumUsd = pricing.totalPremiumUsd;
      // Single MC pass for the distribution chart, using the honest premium.
      const sim = simulateHedgePnl({
        qBtc: projection.qBtc,
        spot,
        strip,
        svi,
        expiryMs,
        premiumUsd,
        n: 10000,
      });
      sim.summary.fairValuePayoffUsd = premiumUsd;
      const summary = summarizeHedge(
        strip,
        projection.qBtc,
        spot,
        premiumUsd,
        projection.expectedUsd,
      );
      const payoff = buildPayoffCurve(strip, projection.qBtc, premiumUsd, spot);
      return { strip, pricing, summary, payoff, sim };
    };
  }, [
    oracleStateQ.data,
    svi,
    spot,
    forward,
    projection.qBtc,
    projection.expectedUsd,
    expiryMs,
  ]);

  const isLoading =
    !!address &&
    (oraclesQ.isLoading || oracleStateQ.isLoading || hash.btcPrice == null);
  const error =
    (oraclesQ.error as Error | null) ??
    (oracleStateQ.error as Error | null) ??
    null;

  return {
    projection,
    oracleId: firstOracleId,
    spot,
    forward,
    expiryMs,
    suggestedBand,
    build,
    isLoading,
    error,
  };
}
