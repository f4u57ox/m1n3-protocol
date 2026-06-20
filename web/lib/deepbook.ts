/**
 * DeepBookV3 taker helpers.
 *
 * Only the **taker / swap path** is built in this file — it's the path
 * that doesn't require a BalanceManager (`swap_exact_base_for_quote` and
 * `swap_exact_quote_for_base`). Limit orders (which need a BalanceManager)
 * live in a follow-up.
 *
 * Pool discovery uses DeepBookV3's registry: each `Pool<BASE, QUOTE>` is
 * a *shared* object whose ID is stored under a dynamic field keyed by the
 * unordered `{base, quote}` pair on the registry. We read it via the Sui
 * GraphQL/JSON-RPC `getDynamicFieldObject` flow.
 */
import type { Transaction, Argument } from '@mysten/sui/transactions';
import { activeDeepBookConfig, activeNetwork, type QuoteToken } from './quote-tokens';

/** Broad PTB-arg union — matches whatever `tx.moveCall` accepts. */
type TxArg = Argument | ReturnType<Transaction['object']>;

export type DeepBookSwapDirection = 'buy-base' | 'sell-base';

/**
 * Buy `base` (HashShare) by paying `quote`. Caller supplies a Coin<QUOTE>
 * object with at least `quoteAmount` units. Slippage-guarded by `minBase`.
 */
export function swapBuyBase(
  txb: Transaction,
  opts: {
    pool: string;
    baseType: string;
    quoteType: string;
    quoteCoinArg: TxArg;
    minBase: bigint;
    deepCoinId?: string;
  },
) {
  const cfg = mustHaveDeepBook();
  const deepCoin = opts.deepCoinId
    ? txb.object(opts.deepCoinId)
    : txb.moveCall({
        target: '0x2::coin::zero',
        typeArguments: [deepTypeForNetwork()],
      });

  const [baseOut, quoteOut, deepLeft] = txb.moveCall({
    target: `${cfg.packageId}::pool::swap_exact_quote_for_base`,
    typeArguments: [opts.baseType, opts.quoteType],
    arguments: [
      txb.object(opts.pool),
      opts.quoteCoinArg,
      deepCoin,
      txb.pure.u64(opts.minBase),
      txb.object('0x6'), // Clock
    ],
  });
  return { baseOut, quoteOut, deepLeft };
}

/**
 * Sell `base` (HashShare) for `quote`. Caller supplies a Coin<BASE>.
 */
export function swapSellBase(
  txb: Transaction,
  opts: {
    pool: string;
    baseType: string;
    quoteType: string;
    baseCoinArg: TxArg;
    minQuote: bigint;
    deepCoinId?: string;
  },
) {
  const cfg = mustHaveDeepBook();
  const deepCoin = opts.deepCoinId
    ? txb.object(opts.deepCoinId)
    : txb.moveCall({
        target: '0x2::coin::zero',
        typeArguments: [deepTypeForNetwork()],
      });

  const [baseOut, quoteOut, deepLeft] = txb.moveCall({
    target: `${cfg.packageId}::pool::swap_exact_base_for_quote`,
    typeArguments: [opts.baseType, opts.quoteType],
    arguments: [
      txb.object(opts.pool),
      opts.baseCoinArg,
      deepCoin,
      txb.pure.u64(opts.minQuote),
      txb.object('0x6'),
    ],
  });
  return { baseOut, quoteOut, deepLeft };
}

/**
 * Create a permissionless pool. Costs 100 DEEP (mainnet) or 10 DEEP
 * (testnet). The keeper normally does this; this lets the dapp recover
 * when a (HS, QUOTE) pair has no pool yet.
 */
export function createPermissionlessPool(
  txb: Transaction,
  opts: {
    baseType: string;
    quoteType: string;
    tickSize: bigint;
    lotSize: bigint;
    minSize: bigint;
    /** Whitelisted = no taker fees in DEEP. */
    whitelisted?: boolean;
    /** Stable = different fee curve. */
    stablePool?: boolean;
    /** Caller's DEEP coin object to pay the pool-creation fee. */
    deepFeeCoinId: string;
  },
) {
  const cfg = mustHaveDeepBook();
  txb.moveCall({
    target: `${cfg.packageId}::pool::create_permissionless_pool`,
    typeArguments: [opts.baseType, opts.quoteType],
    arguments: [
      txb.object(cfg.registryId),
      txb.pure.u64(opts.tickSize),
      txb.pure.u64(opts.lotSize),
      txb.pure.u64(opts.minSize),
      txb.object(opts.deepFeeCoinId),
    ],
  });
}

/* ─── DEEP coin type (network-specific) ─────────────────────────────── */

function deepTypeForNetwork(): string {
  const net = activeNetwork();
  if (net === 'mainnet') {
    return '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP';
  }
  // testnet
  return '0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP';
}

function mustHaveDeepBook() {
  const cfg = activeDeepBookConfig();
  if (!cfg) {
    throw new Error(
      `DeepBookV3 is not deployed on ${activeNetwork()}. Switch the dapp to mainnet or testnet.`,
    );
  }
  return cfg;
}

/* ─── Tiny utilities used by the pool-lookup hook ────────────────────── */

/**
 * Sort two type tags the way DeepBook's registry stores its
 * `PoolKey` — bytewise ascending, so `Pool<A,B>` is keyed under the
 * unordered `{A, B}` regardless of caller's argument order.
 */
export function sortTypePair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** Used to render a quick pool symbol pair like `HS000 · DBUSDC`. */
export function pairLabel(hs: string, q: QuoteToken): string {
  return `${hs} · ${q.symbol}`;
}
