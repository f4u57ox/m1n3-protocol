"use client";

/**
 * BalanceManager lifecycle for DeepBookV3 limit orders.
 *
 * `BalanceManager` is a shared escrow object the user creates once per
 * wallet; placing a resting limit order moves the relevant Coin into the
 * BM, and unfilled balances stay there until withdrawn. Without one the
 * SDK's `placeLimitOrder` aborts.
 *
 * The chain is the source of truth — `client.deepbook.getBalanceManagerIds`
 * reads them via the DeepBook registry's owner→IDs map. We cache only the
 * user's preferred "active BM" in localStorage so the UI doesn't re-prompt
 * when they own several.
 *
 * Reference pattern: bboerst-free of any copyrighted code; modeled on
 * MystenLabs/deepbook-sandbox `dashboard/src/hooks/use-deepbook-client.ts`.
 */

import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
} from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { useDeepBookClient } from "@/lib/deepbook-client";

const STORAGE_KEY = "m1n3.deepbook.defaultBM";

/** Canonical key the SDK uses to refer to the active BM in PTB builders. */
export const ACTIVE_BM_KEY = "MANAGER_1";

export interface UseBalanceManagerResult {
  /** All on-chain BM IDs owned by the connected wallet. */
  managerIds: string[];
  /** Selected BM id (one of `managerIds`); null if none chosen / connected. */
  activeManagerId: string | null;
  setActiveManagerId: (id: string | null) => void;

  isLoading: boolean;
  error: Error | null;

  /** Tx-issuing helpers (sign + execute). Refresh `managerIds` on success. */
  createBalanceManager: () => Promise<{ digest: string }>;
  deposit: (coinKey: string, amount: number) => Promise<{ digest: string }>;
  withdraw: (
    coinKey: string,
    amount: number,
    recipient?: string,
  ) => Promise<{ digest: string }>;
}

export function useBalanceManager(): UseBalanceManagerResult {
  const account = useCurrentAccount();
  const db = useDeepBookClient();
  const qc = useQueryClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const address = account?.address ?? null;
  const queryKey = useMemo(() => ["deepbook", "bm-ids", address], [address]);

  const { data, isLoading, error } = useQuery<string[], Error>({
    queryKey,
    enabled: !!db && !!address,
    queryFn: async () => {
      if (!db || !address) return [];
      return await db.getBalanceManagerIds(address);
    },
    staleTime: 30_000,
  });
  const managerIds = data ?? [];

  const [activeOverride, setActiveOverride] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(STORAGE_KEY);
  });

  const activeManagerId =
    activeOverride && managerIds.includes(activeOverride)
      ? activeOverride
      : (managerIds[0] ?? null);

  const setActiveManagerId = useCallback((id: string | null) => {
    setActiveOverride(id);
    if (typeof window !== "undefined") {
      if (id) window.localStorage.setItem(STORAGE_KEY, id);
      else window.localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  const createBalanceManager = useCallback(async () => {
    if (!db) throw new Error("DeepBook not available on this network");
    const tx = new Transaction();
    db.balanceManager.createAndShareBalanceManager()(tx);
    const r = await signAndExecute({
      transaction: tx as unknown as Parameters<
        typeof signAndExecute
      >[0]["transaction"],
    });
    await qc.invalidateQueries({ queryKey });
    return { digest: r.digest };
  }, [db, signAndExecute, qc, queryKey]);

  const deposit = useCallback(
    async (coinKey: string, amount: number) => {
      if (!db) throw new Error("DeepBook not available on this network");
      if (!activeManagerId)
        throw new Error("No active BalanceManager — create or select one");
      const tx = new Transaction();
      // The SDK reads `activeManagerId` from its bundled `balanceManagers`
      // map under `ACTIVE_BM_KEY`. We register it inline so the call is
      // self-contained.
      registerBmOnClient(db, ACTIVE_BM_KEY, activeManagerId, address ?? "");
      db.balanceManager.depositIntoManager(
        ACTIVE_BM_KEY,
        coinKey,
        amount,
      )(tx);
      const r = await signAndExecute({
        transaction: tx as unknown as Parameters<
          typeof signAndExecute
        >[0]["transaction"],
      });
      return { digest: r.digest };
    },
    [db, activeManagerId, signAndExecute, address],
  );

  const withdraw = useCallback(
    async (coinKey: string, amount: number, recipient?: string) => {
      if (!db) throw new Error("DeepBook not available on this network");
      if (!activeManagerId)
        throw new Error("No active BalanceManager — create or select one");
      if (!address) throw new Error("No wallet connected");
      const to = recipient ?? address;
      const tx = new Transaction();
      registerBmOnClient(db, ACTIVE_BM_KEY, activeManagerId, address);
      db.balanceManager.withdrawFromManager(
        ACTIVE_BM_KEY,
        coinKey,
        amount,
        to,
      )(tx);
      const r = await signAndExecute({
        transaction: tx as unknown as Parameters<
          typeof signAndExecute
        >[0]["transaction"],
      });
      return { digest: r.digest };
    },
    [db, activeManagerId, signAndExecute, address],
  );

  return {
    managerIds,
    activeManagerId,
    setActiveManagerId,
    isLoading,
    error: error ?? null,
    createBalanceManager,
    deposit,
    withdraw,
  };
}

/**
 * The DeepBookClient instance carries a mutable `balanceManagers` map that
 * its PTB builders read for the on-chain BM id. The SDK doesn't expose a
 * setter, so we patch the field directly — the shape is stable across
 * SDK 1.x. If a future major change makes this private we'll need to
 * fall back to constructing a fresh client per call.
 */
function registerBmOnClient(
  db: ReturnType<typeof useDeepBookClient> extends infer T
    ? Exclude<T, null>
    : never,
  key: string,
  managerId: string,
  ownerAddress: string,
): void {
  type BmMap = Record<
    string,
    { address: string; tradeCap?: string; depositCap?: string; withdrawCap?: string }
  >;
  const config = (db as unknown as { config?: { balanceManagers?: BmMap } })
    .config;
  if (!config) return;
  config.balanceManagers ??= {};
  config.balanceManagers[key] = { address: managerId };
  void ownerAddress; // currently unused but kept for future trade-cap routing
}
