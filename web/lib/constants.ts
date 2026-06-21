// m1n3 dashboard constants — Sui package IDs and network configuration.

/** m1n3_v4 Sui package ID — current (upgraded) `published-at` on mainnet. */
export const PACKAGE_ID =
  process.env.NEXT_PUBLIC_PACKAGE_ID ??
  '0x8377b3f15d11eb6debf1afba251e1c275cd130e0ca48ba86b88f953324ae0605';

/** m1n3_v4 original package ID — used as the event-type prefix (immutable after publish). */
export const ORIGINAL_PACKAGE_ID =
  process.env.NEXT_PUBLIC_ORIGINAL_PACKAGE_ID ??
  '0xdf7cc2d80454cd56818e58e727b48beb2f8c441fcf6e4f46fd2282d24427a895';

/**
 * Origin package id for the **V1** buyer-template lane structs/events
 * (HashpowerBuyOrder, DerivedTemplate, HashpowerBuyOrderPlaced, …).
 * These were first declared in the v2 upgrade and — per Sui Move's
 * type-origin rule — their type tags stay bound to that package id
 * forever, even after v3+ upgrades. Used for event filters and object
 * type-prefix matching on /orders.
 *
 * Falls back to PACKAGE_ID for first-publish networks (testnet/devnet)
 * where the lane was published in the original.
 */
export const HASHPOWER_LANE_PACKAGE_ID =
  process.env.NEXT_PUBLIC_HASHPOWER_LANE_PACKAGE_ID ??
  process.env.NEXT_PUBLIC_PACKAGE_ID ??
  '';

/**
 * Origin package id for the **V2** buyer-BOUND lane structs/events
 * (`BuyerHashpowerOrder`, `BuyerHashpowerOrderPlaced`, …). These were
 * first declared in the v4 upgrade — orders are no longer pinned to a
 * specific Template; they bind to the buyer's address and accept shares
 * against any template the buyer owns.
 *
 * Defaults to PACKAGE_ID so on testnet/devnet (single-publish) the V2
 * structs live in the original package and discovery still works.
 */
export const HASHPOWER_LANE_V2_PACKAGE_ID =
  process.env.NEXT_PUBLIC_HASHPOWER_LANE_V2_PACKAGE_ID ??
  process.env.NEXT_PUBLIC_PACKAGE_ID ??
  '';

/** Sui RPC URL — defaults to the public mainnet fullnode. */
export const SUI_RPC_URL =
  process.env.NEXT_PUBLIC_SUI_RPC_URL ?? 'https://fullnode.mainnet.sui.io:443';

/** Sui network name. */
export const SUI_NETWORK = process.env.NEXT_PUBLIC_SUI_NETWORK ?? 'mainnet';

/** Pool shared object ID — set after publish. */
export const POOL_OBJECT_ID = process.env.NEXT_PUBLIC_POOL_OBJECT_ID ?? '';

/** PoolAdminCap object ID — held by the operator wallet for admin entries. */
export const POOL_ADMIN_CAP_ID = process.env.NEXT_PUBLIC_POOL_ADMIN_CAP_ID ?? '';

/** HashiRewardRegistry shared object ID — set after publish. */
export const HASHI_REWARD_REGISTRY_ID =
  process.env.NEXT_PUBLIC_HASHI_REWARD_REGISTRY_ID ?? '';

/** HashiPoolConfig shared object ID — set after the operator runs hashi_pool::initialize. */
export const HASHI_POOL_CONFIG_ID =
  process.env.NEXT_PUBLIC_HASHI_POOL_CONFIG_ID ?? '';

/** ShareDedupRegistry shared object ID — set after publish. */
export const SHARE_DEDUP_REGISTRY_ID =
  process.env.NEXT_PUBLIC_SHARE_DEDUP_REGISTRY_ID ?? '';

/** Number of decimal places for the M1N3 token. */
export const M1N3_DECIMALS = 8;

/** Staleness threshold: 4× the 30s target share interval = 120s. */
export const STALENESS_THRESHOLD_MS = 30_000 * 4;
