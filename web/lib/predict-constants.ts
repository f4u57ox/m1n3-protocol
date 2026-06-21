/**
 * DeepBook Predict — testnet integration constants.
 *
 * Predict is currently testnet-only. Mainnet IDs will land later via
 * a `MAINNET_PREDICT` entry once the protocol launches there; until
 * then the active config is `TESTNET_PREDICT`. Switching the dapp to
 * any other network disables the hedge flow.
 *
 * Source-of-record: `packages/predict/README.md` on branch
 * `predict-testnet-4-16` of MystenLabs/deepbookv3.
 */

import { SUI_NETWORK } from './constants';
import { findQuoteToken, type QuoteToken } from './quote-tokens';

export type PredictConfig = {
  /** Predict Move package id. */
  packageId: string;
  /** The shared `Predict` protocol object. */
  predictObjectId: string;
  /** Symbol of the accepted quote asset (resolved via `findQuoteToken`). */
  quoteSymbol: string;
  /** Public REST + indexer endpoint base. */
  serverBaseUrl: string;
};

const TESTNET_PREDICT: PredictConfig = {
  packageId:
    '0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138',
  predictObjectId:
    '0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a',
  quoteSymbol: 'DUSDC',
  serverBaseUrl: 'https://predict-server.testnet.mystenlabs.com',
};

/**
 * Resolve the active Predict config for the dapp's current network, or
 * `null` if Predict isn't deployed there.
 */
export function activePredictConfig(): PredictConfig | null {
  if (SUI_NETWORK === 'testnet') return TESTNET_PREDICT;
  return null;
}

/**
 * Return the active quote-asset `QuoteToken` (e.g. DUSDC on testnet)
 * for the Predict deployment, or `null` if unavailable or
 * mis-configured.
 */
export function activePredictQuote(): QuoteToken | null {
  const cfg = activePredictConfig();
  if (!cfg) return null;
  return findQuoteToken(cfg.quoteSymbol) ?? null;
}
