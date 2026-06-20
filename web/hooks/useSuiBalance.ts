"use client";

import { useSuiClientQuery } from "@mysten/dapp-kit";

/**
 * Wallet's SUI balance in MIST (1 SUI = 1_000_000_000 MIST).
 *
 * Returns `0n` while loading or disconnected so callers can render
 * unconditional totals.
 *
 * `useSuiClientQuery` is dapp-kit's wrapper around React Query — it'll refetch
 * on `enabled` flip and on any explicit `.refetch()`. We use a short stale
 * time so a refetch after a swap surfaces the new balance quickly.
 */
export function useSuiBalance(owner: string | undefined) {
  const q = useSuiClientQuery(
    "getBalance",
    { owner: owner ?? "", coinType: "0x2::sui::SUI" },
    {
      enabled: !!owner,
      refetchInterval: 10_000,
      staleTime: 5_000,
    },
  );

  const mist = q.data?.totalBalance ? BigInt(q.data.totalBalance) : 0n;

  return {
    mist,
    isLoading: q.isLoading,
    refetch: q.refetch,
  };
}
