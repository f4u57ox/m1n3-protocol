'use client';

import { useSuiClientQuery } from '@mysten/dapp-kit';

/**
 * Owned `Coin<T>` objects for an arbitrary coin type.
 *
 * Returns the raw object IDs (used to merge + split when spending) and a
 * single aggregated balance in base units. Both are bigints in this layer
 * to avoid precision loss.
 *
 * Pass through any Sui coin type — used by `DeepBookSwapPanel` to spend
 * non-SUI quote tokens like DBUSDC / DBTC / DEEP.
 */
export function useQuoteCoins(
  owner: string | undefined,
  coinType: string | undefined,
) {
  const enabled = !!(owner && coinType);

  const q = useSuiClientQuery(
    'getCoins',
    { owner: owner ?? '', coinType: coinType ?? '', limit: 50 },
    {
      enabled,
      refetchInterval: 10_000,
      staleTime: 5_000,
    },
  );

  const ids = (q.data?.data ?? []).map((c) => c.coinObjectId);
  const balance = (q.data?.data ?? []).reduce(
    (acc, c) => acc + BigInt(c.balance),
    0n,
  );

  return {
    /** The Move coin type the hook was queried for. Useful when several
     * consumers share the same `useQuoteCoins` instance and need to
     * decide whether their action targets the same coin type. */
    coinType,
    ids,
    balance,
    isLoading: q.isLoading,
    refetch: q.refetch,
  };
}
