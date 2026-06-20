'use client';

import { useQuery } from '@tanstack/react-query';

/**
 * Bitcoin hashprice, derived from on-chain difficulty rather than from
 * mempool.space's 3-day rolling hashrate average.
 *
 * Math
 * ────
 * The protocol target is one block every 600 s, so:
 *
 *     network_hashrate (H/s) = difficulty × 2^32 / 600
 *
 * That's the *exact* instantaneous value Bitcoin's retarget pins to —
 * `currentHashrate` from explorer APIs is a rolling average and lags real
 * network changes by ~3 days. Deriving from difficulty matches what miners
 * actually compete against right now.
 *
 *     hashprice ($/PH/day)
 *       = (block_subsidy × blocks_per_day × btc_price_usd) / network_hashrate_PH
 *       = (block_subsidy × blocks_per_day × btc_price_usd × 600 × 1e15)
 *         / (difficulty × 2^32)
 *
 * Constants below are the post-2024-halving subsidy (3.125 BTC) and the
 * ~144 blocks/day target.
 */

const BLOCK_SUBSIDY_BTC = 3.125;
const BLOCKS_PER_DAY = 144;
const TARGET_BLOCK_TIME_SEC = 600;
const TWO_POW_32 = 4_294_967_296;
const PH = 1e15;
const SATS_PER_BTC = 1e8;
const BLOCK_SUBSIDY_SATS = BLOCK_SUBSIDY_BTC * SATS_PER_BTC; // 312_500_000

interface HashpriceResponse {
  /** $ / PH / day, derived from difficulty. */
  hashprice: number;
  btcPrice: number;
  /** SUI price in USD — used to convert fair share value into MIST. */
  suiPrice: number;
  /** Network hashrate in H/s, computed from `difficulty × 2^32 / 600`. */
  derivedNetworkHashrate: number;
  networkDifficulty: number;
  /**
   * Fair PPS value of one *difficulty-1* share, in sats. By construction
   * `block_reward_sats / network_difficulty` because difficulty is exactly
   * the average number of Δ-1 shares needed to find a block.
   *
   * At current values this is sub-microsat, so we also surface the
   * per-MΔ (mega-difficulty = 10^6 Δ-1) value for display.
   */
  satsPerDelta: number;
  satsPerMegaDelta: number;
  usdPerMegaDelta: number;
  /**
   * Reference limit-order price for the SUI quote: MIST per HashShare unit,
   * computed from the fair PPS value and the live SUI price. A HashShare
   * unit corresponds to one difficulty-1 share of work.
   */
  fairMistPerShareUnit: number;
  updatedAt: string;
}

async function fetchHashprice(): Promise<HashpriceResponse> {
  const [priceRes, diffRes] = await Promise.all([
    fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,sui&vs_currencies=usd',
    ),
    fetch('https://mempool.space/api/v1/mining/hashrate/3d'),
  ]);

  if (!priceRes.ok) throw new Error(`CoinGecko responded ${priceRes.status}`);
  if (!diffRes.ok)
    throw new Error(`mempool.space responded ${diffRes.status}`);

  const priceData = await priceRes.json();
  const diffData = await diffRes.json();

  const btcPrice: number = priceData.bitcoin?.usd;
  const suiPrice: number = priceData.sui?.usd ?? 0;
  const networkDifficulty: number = diffData.currentDifficulty ?? 0;
  if (!networkDifficulty) {
    throw new Error('Could not parse currentDifficulty');
  }
  if (!btcPrice) throw new Error('Could not parse BTC price');

  const derivedNetworkHashrate =
    (networkDifficulty * TWO_POW_32) / TARGET_BLOCK_TIME_SEC; // H/s
  const networkHashratePh = derivedNetworkHashrate / PH;
  const dailyRevenueUsd = BLOCK_SUBSIDY_BTC * BLOCKS_PER_DAY * btcPrice;
  const hashprice = dailyRevenueUsd / networkHashratePh;

  // PPS share value: block_reward_sats / difficulty = sats per Δ-1 share
  const satsPerDelta = BLOCK_SUBSIDY_SATS / networkDifficulty;
  const satsPerMegaDelta = satsPerDelta * 1e6;
  const usdPerMegaDelta = satsPerMegaDelta * (btcPrice / SATS_PER_BTC);

  // Reference price for a SUI-quoted limit order:
  //   fair_value_usd_per_share = satsPerDelta × btc_price / 1e8
  //   fair_mist_per_share     = fair_value_usd / sui_price × 1e9
  const usdPerShareUnit = satsPerDelta * (btcPrice / SATS_PER_BTC);
  const fairMistPerShareUnit =
    suiPrice > 0 ? (usdPerShareUnit / suiPrice) * 1e9 : 0;

  return {
    hashprice,
    btcPrice,
    suiPrice,
    derivedNetworkHashrate,
    networkDifficulty,
    satsPerDelta,
    satsPerMegaDelta,
    usdPerMegaDelta,
    fairMistPerShareUnit,
    updatedAt: new Date().toISOString(),
  };
}

export function useHashprice() {
  const { data, isLoading, error } = useQuery<HashpriceResponse>({
    queryKey: ['bitcoin', 'hashprice', 'from-difficulty'],
    queryFn: fetchHashprice,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  return {
    hashprice: data?.hashprice ?? null,
    btcPrice: data?.btcPrice ?? null,
    suiPrice: data?.suiPrice ?? null,
    networkHashrate: data?.derivedNetworkHashrate ?? null,
    networkDifficulty: data?.networkDifficulty ?? null,
    /** Sats per difficulty-1 share. Standard PPS fair value. */
    satsPerDelta: data?.satsPerDelta ?? null,
    /** Sats per million Δ-1 shares — the readable display unit. */
    satsPerMegaDelta: data?.satsPerMegaDelta ?? null,
    /** USD equivalent of the above (sats × btcPrice / 1e8 × 1e6 Δ). */
    usdPerMegaDelta: data?.usdPerMegaDelta ?? null,
    /** Reference limit-order price: MIST per HashShare unit (SUI quote). */
    fairMistPerShareUnit: data?.fairMistPerShareUnit ?? null,
    loading: isLoading,
    error: error?.message ?? null,
  };
}
