"use client";

import { useQuery } from "@tanstack/react-query";
import {
  filterActiveBtcOracles,
  getOracleState,
  listPredictOracles,
  type PredictOracleState,
  type PredictOracleSummary,
} from "@/lib/predict-client";
import { activePredictConfig } from "@/lib/predict-constants";

/**
 * List of active BTC oracles available for hedging. Sorted by expiry
 * ascending. Refetches every 30 s — oracles roll on sub-hour cadence so
 * "the soonest active oracle" changes frequently.
 */
export function useActiveBtcOracles() {
  const cfg = activePredictConfig();
  return useQuery<PredictOracleSummary[]>({
    queryKey: ["predict-oracles", "btc-active", cfg?.predictObjectId],
    enabled: !!cfg,
    refetchInterval: 30_000,
    staleTime: 15_000,
    queryFn: async () => {
      const all = await listPredictOracles();
      return filterActiveBtcOracles(all);
    },
  });
}

/**
 * Full state (latest_price + latest_svi + ask_bounds) for a single oracle.
 * Refetches every 10 s for live price ticking.
 */
export function useOracleState(oracleId: string | undefined) {
  return useQuery<PredictOracleState>({
    queryKey: ["predict-oracle-state", oracleId],
    enabled: !!oracleId,
    refetchInterval: 10_000,
    staleTime: 5_000,
    queryFn: () => getOracleState(oracleId!),
  });
}
