"use client";

import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
} from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import {
  findManagerForOwner,
  getManagerPositionsSummary,
  type PredictManagerSummary,
  type PredictPositionsSummary,
} from "@/lib/predict-client";
import { activePredictConfig } from "@/lib/predict-constants";

/**
 * Find-or-create flow for the connected wallet's `PredictManager`.
 * Mirrors the shape of `useBalanceManager` for DeepBookV3.
 *
 * - `manager` — current manager (if any).
 * - `positions` — open positions + ranges (when manager exists).
 * - `createManager()` — builds + signs `predict::create_manager` PTB.
 *
 * Predict's manager is a *shared* object (the dapp-kit balance manager
 * is also shared in DeepBook v3); discovery happens via the indexer.
 */
export function usePredictManager() {
  const account = useCurrentAccount();
  const address = account?.address ?? null;
  const cfg = activePredictConfig();
  const qc = useQueryClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const managerQuery = useQuery<PredictManagerSummary | null>({
    queryKey: ["predict-manager", address, cfg?.predictObjectId],
    enabled: !!cfg && !!address,
    staleTime: 30_000,
    queryFn: async () => (address ? findManagerForOwner(address) : null),
  });

  const managerId = managerQuery.data?.manager_id ?? null;

  const positionsQuery = useQuery<PredictPositionsSummary>({
    queryKey: ["predict-positions", managerId],
    enabled: !!managerId,
    refetchInterval: 30_000,
    staleTime: 15_000,
    queryFn: () => getManagerPositionsSummary(managerId!),
  });

  const createManager = useCallback(async () => {
    if (!cfg) throw new Error("Predict not deployed on this network");
    if (!address) throw new Error("No wallet connected");
    const tx = new Transaction();
    tx.moveCall({
      target: `${cfg.packageId}::predict::create_manager`,
      arguments: [],
    });
    const r = await signAndExecute({
      transaction: tx as unknown as Parameters<
        typeof signAndExecute
      >[0]["transaction"],
    });
    // Invalidate so the indexer re-fetch picks up the new manager.
    await qc.invalidateQueries({ queryKey: ["predict-manager", address] });
    return { digest: r.digest };
  }, [cfg, address, signAndExecute, qc]);

  return useMemo(
    () => ({
      manager: managerQuery.data ?? null,
      managerId,
      positions: positionsQuery.data ?? null,
      isLoading: managerQuery.isLoading || positionsQuery.isLoading,
      error: managerQuery.error ?? positionsQuery.error ?? null,
      createManager,
      refetch: () => {
        managerQuery.refetch();
        positionsQuery.refetch();
      },
    }),
    [managerQuery, positionsQuery, managerId, createManager],
  );
}
