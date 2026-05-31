'use client';

import { useQuery } from '@tanstack/react-query';

interface HashpriceResponse {
  hashprice: number;
  difficultyPrice: number;
  btcPrice: number;
  networkHashrate: number;
  networkDifficulty: number;
  updatedAt: string;
}

async function fetchHashprice(): Promise<HashpriceResponse> {
  const [priceRes, hashrateRes] = await Promise.all([
    fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
    ),
    fetch('https://mempool.space/api/v1/mining/hashrate/3d'),
  ]);

  if (!priceRes.ok) throw new Error(`CoinGecko responded ${priceRes.status}`);
  if (!hashrateRes.ok)
    throw new Error(`mempool.space responded ${hashrateRes.status}`);

  const priceData = await priceRes.json();
  const hashrateData = await hashrateRes.json();

  const btcPrice: number = priceData.bitcoin.usd;
  const networkHashrate: number =
    hashrateData.currentHashrate ??
    hashrateData.hashrates?.at(-1)?.avgHashrate;
  const networkDifficulty: number = hashrateData.currentDifficulty ?? 0;

  if (!networkHashrate) throw new Error('Could not parse network hashrate');

  // hashprice = (block_reward * blocks_per_day * btc_price) / (hashrate in PH/s)
  const hashprice = (3.125 * 144 * btcPrice) / (networkHashrate / 1e15);

  // difficultyPrice = PPS value of 1T-difficulty share = blockReward * btcPrice * (1T / networkDifficulty)
  const difficultyPrice = networkDifficulty > 0 ? (3.125 * btcPrice) / (networkDifficulty / 1e12) : 0;

  return {
    hashprice,
    difficultyPrice,
    btcPrice,
    networkHashrate,
    networkDifficulty,
    updatedAt: new Date().toISOString(),
  };
}

export function useHashprice() {
  const { data, isLoading, error } = useQuery<HashpriceResponse>({
    queryKey: ['bitcoin', 'hashprice'],
    queryFn: fetchHashprice,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  return {
    hashprice: data?.hashprice ?? null,
    difficultyPrice: data?.difficultyPrice ?? null,
    btcPrice: data?.btcPrice ?? null,
    networkHashrate: data?.networkHashrate ?? null,
    networkDifficulty: data?.networkDifficulty ?? null,
    loading: isLoading,
    error: error?.message ?? null,
  };
}
