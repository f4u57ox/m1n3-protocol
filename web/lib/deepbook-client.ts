"use client";

/**
 * `@mysten/deepbook-v3` SDK factory.
 *
 * Builds a `DeepBookClient` per (network, signer-address) pair so the SDK's
 * BalanceManager / placeLimitOrder / accountOpenOrders methods become
 * available to UI code without each call site reconstructing the client.
 *
 * The SDK ships with `testnetPools` / `testnetCoins` / `mainnetPools` /
 * `mainnetCoins` maps for the headline DeepBook markets. Our HS_NNN×QUOTE
 * pools are permissionlessly created by the trustless-keeper and *not* in
 * those maps. `registerCustomPool` extends the per-network pool map on
 * the fly when we discover a pool via events.
 *
 * Reference: https://github.com/MystenLabs/deepbook-sandbox/blob/main/sandbox/dashboard/src/hooks/use-deepbook-client.ts
 */

import { useMemo } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit";
import {
  DeepBookClient,
  type Coin,
  type CoinMap,
  type DeepBookClientOptions,
  type Pool,
  type PoolMap,
  mainnetCoins,
  mainnetPools,
  testnetCoins,
  testnetPools,
} from "@mysten/deepbook-v3";
import { suiClient } from "./sui-client";
import { DEEPBOOK_V3, activeNetwork, type QuoteToken } from "./quote-tokens";

/** Pool key used internally by the SDK to identify a market. We standardise
 *  on `"HS_NNN_QUOTE"` (e.g. `"HS_000_DBUSDC"`) for our pools. */
export type HashSharePoolKey = string;

/** Coin key used internally by the SDK to identify a coin (e.g. `"SUI"`,
 *  `"DBUSDC"`, `"HS_000"`). */
export type DBCoinKey = string;

/** Singleton, per-network. Built lazily so SSR doesn't try to instantiate. */
const clientCache = new WeakMap<object, DeepBookClient>();
const customPools = new Map<string, Pool>();
const customCoins = new Map<string, Coin>();

function baseCoinMap(): CoinMap {
  const net = activeNetwork();
  return net === "mainnet"
    ? mainnetCoins
    : net === "testnet"
      ? testnetCoins
      : {};
}

function basePoolMap(): PoolMap {
  const net = activeNetwork();
  return net === "mainnet"
    ? mainnetPools
    : net === "testnet"
      ? testnetPools
      : {};
}

/** Register a custom (base, quote) pool with the SDK at runtime. Idempotent. */
export function registerCustomPool(
  poolKey: HashSharePoolKey,
  poolId: string,
  baseCoinKey: DBCoinKey,
  quoteCoinKey: DBCoinKey,
): void {
  customPools.set(poolKey, {
    address: poolId,
    baseCoin: baseCoinKey,
    quoteCoin: quoteCoinKey,
  });
}

/** Register a coin (HS_NNN or a quote) that isn't in the SDK's bundled map. */
export function registerCustomCoin(coinKey: DBCoinKey, coin: Coin): void {
  customCoins.set(coinKey, coin);
}

/** Convenience: derive a stable pool key + register a HashShare/quote pair. */
export function registerHashSharePool(
  poolId: string,
  hashShareTypeTag: string,
  hashShareLabel: string,
  quote: QuoteToken,
): HashSharePoolKey {
  const baseKey = hashShareLabel.toUpperCase();
  const quoteKey = quote.symbol.toUpperCase();
  const poolKey = `${baseKey}_${quoteKey}`;
  registerCustomCoin(baseKey, {
    address: hashShareTypeTag.split("::")[0]!,
    type: hashShareTypeTag,
    scalar: 1,
  });
  registerCustomCoin(quoteKey, {
    address: quote.type.split("::")[0]!,
    type: quote.type,
    scalar: 10 ** quote.decimals,
  });
  registerCustomPool(poolKey, poolId, baseKey, quoteKey);
  return poolKey;
}

/**
 * React hook returning a memoized `DeepBookClient` for the connected wallet.
 *
 * Returns `null` if no wallet is connected or if DeepBookV3 isn't deployed
 * on the active network (e.g. devnet).
 */
export function useDeepBookClient(): DeepBookClient | null {
  const account = useCurrentAccount();
  const address = account?.address;

  return useMemo(() => {
    if (!address) return null;
    const cfg = DEEPBOOK_V3[activeNetwork()];
    if (!cfg) return null;

    const cacheKey = { address, network: activeNetwork() };
    const cached = clientCache.get(cacheKey);
    if (cached) return cached;

    const coins: CoinMap = { ...baseCoinMap() };
    for (const [k, v] of customCoins) coins[k] = v;
    const pools: PoolMap = { ...basePoolMap() };
    for (const [k, v] of customPools) pools[k] = v;

    const net = activeNetwork();
    const dbClient = new DeepBookClient({
      // The SDK accepts any ClientWithCoreApi-compatible client. Our
      // SuiJsonRpcClient satisfies the interface — cast keeps TS happy
      // without dragging the full type chain into this file.
      client: suiClient as unknown as DeepBookClientOptions["client"],
      address,
      network: (net === "mainnet" ? "mainnet" : "testnet") as
        | "mainnet"
        | "testnet",
      coins,
      pools,
      packageIds: {
        DEEPBOOK_PACKAGE_ID: cfg.packageId,
        REGISTRY_ID: cfg.registryId,
        DEEP_TREASURY_ID: cfg.deepTreasuryId,
      } as unknown as DeepBookClientOptions["packageIds"],
    });
    clientCache.set(cacheKey, dbClient);
    return dbClient;
    // `address` changes when the user reconnects; everything else is process-stable.
  }, [address]);
}
