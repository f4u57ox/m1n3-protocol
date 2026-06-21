/**
 * OTC + confidential-transfers — devnet integration constants.
 *
 * Two distinct on-chain surfaces are referenced here:
 *
 *   1. m1n3's own `m1n3_confidential_otc` escrow + `dusdc` pay-leg —
 *      Move modules in `contracts/sources/` published as part of
 *      `m1n3_v4`. Always available on devnet via the package id
 *      configured below.
 *
 *   2. `MystenLabs/confidential-transfers` — devnet-only; the OTC flow
 *      uses it after settle to confidentially wrap the buyer's
 *      received deliverable. The package id is recorded for the
 *      auxiliary wrap step; we don't take a Move dependency on it (see
 *      `docs/otc.md` for the Sui-framework version-skew rationale).
 *
 * Any non-devnet network disables the `/otc` route.
 */

import { SUI_NETWORK, PACKAGE_ID } from './constants';

export type ConfidentialTransfersConfig = {
  /** `contra` Move package id (the confidential-transfers package). */
  packageId: string;
  /** Shared `TokenRegistry` — all wrapped tokens register here. */
  tokenRegistryId: string;
  /** Shared `AccountRegistry` — find-or-create lookup keyed by (sender, coinType). */
  accountRegistryId: string;
};

const DEVNET_CONFIDENTIAL: ConfidentialTransfersConfig = {
  packageId:
    process.env.NEXT_PUBLIC_CONFIDENTIAL_TRANSFERS_PACKAGE ??
    '0xe0f1b22e6064aa9d9fe7612862a4fde5e586c09ea76005b14ee1489e0d70c271',
  tokenRegistryId:
    process.env.NEXT_PUBLIC_CONFIDENTIAL_TOKEN_REGISTRY_ID ?? '',
  accountRegistryId:
    process.env.NEXT_PUBLIC_CONFIDENTIAL_ACCOUNT_REGISTRY_ID ?? '',
};

export function activeConfidentialTransfersConfig(): ConfidentialTransfersConfig | null {
  if (SUI_NETWORK !== 'devnet') return null;
  return DEVNET_CONFIDENTIAL;
}

/**
 * Live `m1n3_confidential_otc` deployment. The pay-leg coin type is
 * the dusdc::DUSDC module shipped in the same Move package.
 */
export type OtcEscrowConfig = {
  /** m1n3_v4 Move package id (holds `m1n3_confidential_otc` + `dusdc`). */
  packageId: string;
  /** Fully-qualified DUSDC coin type. */
  dusdcCoinType: string;
  /** Shared `TreasuryCap<DUSDC>` — anyone can call `dusdc::faucet`. */
  dusdcCapId: string;
};

const DEVNET_OTC: OtcEscrowConfig = {
  packageId:
    process.env.NEXT_PUBLIC_PACKAGE_ID ??
    '0xcb89aa2d259d780d7050a269053f289f27b6448281d4a2a1c418a61e5499f077',
  dusdcCoinType:
    process.env.NEXT_PUBLIC_DUSDC_COIN_TYPE ??
    '0xcb89aa2d259d780d7050a269053f289f27b6448281d4a2a1c418a61e5499f077::dusdc::DUSDC',
  dusdcCapId:
    process.env.NEXT_PUBLIC_DUSDC_CAP_ID ??
    '0x1b7d1727b395c5e21fb655692566f9aad0435aaeb7d07768ed9c1990890d37a3',
};

export function activeOtcEscrowConfig(): OtcEscrowConfig | null {
  if (SUI_NETWORK !== 'devnet') return null;
  return DEVNET_OTC;
}

/**
 * Per-asset metadata for the OTC asset selector.
 *
 * `isQuote` partitions assets into "deliverables" (HashShares — what a
 * miner mints from the round) and "quotes" (DUSDC — the pay leg).
 * SUI is omitted from the OTC selector deliberately: it can't be
 * confidentially wrapped (no TreasuryCap), and pricing the deliverable
 * in volatile SUI was confusing in user testing.
 */
export type OtcAsset = {
  symbol: string;
  decimals: number;
  /** Fully-qualified `<pkg>::<module>::<TYPE>`. */
  coinType: string;
  /** True if the asset is the "pay-with" leg. */
  isQuote: boolean;
};

export function activeOtcAssets(): OtcAsset[] {
  const cfg = activeOtcEscrowConfig();
  if (!cfg) return [];
  const hashShares: OtcAsset[] = Array.from({ length: 8 }, (_, i) => {
    const slot = i.toString().padStart(3, '0');
    return {
      symbol: `HS_${slot}`,
      decimals: 0,
      coinType: `${cfg.packageId}::hs_${slot}::HS_${slot}`,
      isQuote: false,
    };
  });
  return [
    ...hashShares,
    {
      symbol: 'DUSDC',
      decimals: 6,
      coinType: cfg.dusdcCoinType,
      isQuote: true,
    },
  ];
}

/** Exported for the OTC components — short alias for the active config. */
export { PACKAGE_ID };
