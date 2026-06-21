/**
 * Quote tokens supported as the "you pay / you receive" counterparty to
 * HashShares — **network-aware**.
 *
 * The in-house `hash_share_market` Move module is hard-coded to **SUI** as
 * the quote currency. For everything else, trading routes through
 * **DeepBookV3** (taker `swap_exact_amount` for the Swap tab; full
 * `place_limit_order` flow via BalanceManager for the Limit tab).
 *
 * Source-of-record for testnet IDs:
 *   https://github.com/MystenLabs/ts-sdks/blob/main/packages/deepbook-v3/src/utils/constants.ts
 * Mainnet IDs from the user-supplied deepbook.tech contract page.
 */
import { SUI_NETWORK } from './constants';

export type Network = 'mainnet' | 'testnet' | 'devnet';

type DeepBookConfig = {
  packageId: string;
  registryId: string;
  /** Required as a payment-token arg on `place_limit_order` etc. */
  deepTreasuryId: string;
};

export const DEEPBOOK_V3: Record<Network, DeepBookConfig | null> = {
  mainnet: {
    packageId:
      '0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497',
    registryId:
      '0xaf16199a2dff736e9f07a845f23c5da6df6f756eddb631aed9d24a93efc4549d',
    // (DEEP treasury on mainnet — used for taker fee. Same address as below.)
    deepTreasuryId:
      '0x032abf8948dda67a271bcc18e776dbbcfb0d58c8d288a700ff0d5521e57a1ffe',
  },
  testnet: {
    packageId:
      '0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c',
    registryId:
      '0x7c256edbda983a2cd6f946655f4bf3f00a41043993781f8674a7046e8c0e11d1',
    deepTreasuryId:
      '0x69fffdae0075f8f71f4fa793549c11079266910e8905169845af1f5d00e09dcb',
  },
  // DeepBookV3 has never been deployed on devnet — the integration is
  // there but every tx will fail with package-not-found until the dapp
  // is repointed at testnet or mainnet.
  devnet: null,
};

export type QuoteToken = {
  symbol: string;
  /** Fully-qualified Sui Move type. */
  type: string;
  /** Coin's decimal places. */
  decimals: number;
  /**
   * Routing for swap/limit actions:
   * - `m1n3-market`: existing `hash_share_market` PTBs (SUI only).
   * - `deepbook`: DeepBookV3 pool created on-demand by the keeper.
   * - `predict`: not a marketplace quote — only used as the Predict
   *   protocol's quote-asset for hedging on `/hedge`. Never shown in
   *   the marketplace selector.
   */
  routing: 'm1n3-market' | 'deepbook' | 'predict';
  /** Short note rendered in the dropdown. */
  note?: string;
};

/**
 * Per-network quote sets. SUI is always present (it routes through the
 * in-house market, which is the same regardless of network). Other coins
 * are mirrored from DeepBookV3's own coin registry on each network so
 * the pool-lookup math (`Pool<HS_NNN, QUOTE>`) is honest.
 */
const MAINNET_QUOTES: QuoteToken[] = [
  {
    // Mainnet's in-house HashShare market is USDC-quoted (the v4 republish
    // hardcodes Circle's native USDC as the `MarketFeePool<USDC>`). The
    // generic `<T, QuoteT>` refactor of `hash_share_market` lets the same
    // module serve SUI on testnet and USDC here without code drift.
    symbol: 'USDC',
    type: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
    decimals: 6,
    routing: 'm1n3-market',
    note: 'native · live',
  },
  {
    // SUI on mainnet routes through a DeepBookV3 HS/SUI pool if one
    // exists. Without a registered pool the order book reads empty —
    // we don't have an in-house SUI-quoted market on mainnet by design.
    symbol: 'SUI',
    type: '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
    decimals: 9,
    routing: 'deepbook',
    note: 'via DeepBookV3',
  },
  {
    symbol: 'DEEP',
    type: '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP',
    decimals: 6,
    routing: 'deepbook',
    note: 'via DeepBookV3',
  },
  {
    symbol: 'ETH',
    type: '0xd0e89b2af5e4910726fbcd8b8dd37bb79b29e5f83f7491bca830e94f7f226d29::eth::ETH',
    decimals: 8,
    routing: 'deepbook',
    note: 'via DeepBookV3',
  },
  {
    symbol: 'WAL',
    type: '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL',
    decimals: 9,
    routing: 'deepbook',
    note: 'via DeepBookV3',
  },
  {
    symbol: 'IKA',
    type: '0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA',
    decimals: 9,
    routing: 'deepbook',
    note: 'via DeepBookV3',
  },
];

const TESTNET_QUOTES: QuoteToken[] = [
  {
    symbol: 'SUI',
    type: '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
    decimals: 9,
    routing: 'm1n3-market',
    note: 'native · live',
  },
  {
    // Circle's official testnet USDC (not DBUSDC). This is what the testnet
    // faucet / CCTP issues. Verified on-chain via `sui client balance` after
    // funding the m1n3 wallet on 2026-06-19.
    symbol: 'USDC',
    type: '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC',
    decimals: 6,
    routing: 'deepbook',
    note: 'Circle · official',
  },
  {
    symbol: 'DBUSDC',
    type: '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC',
    decimals: 6,
    routing: 'deepbook',
    note: 'DeepBook USDC',
  },
  {
    symbol: 'DBTC',
    type: '0x6502dae813dbe5e42643c119a6450a518481f03063febc7e20238e43b6ea9e86::dbtc::DBTC',
    decimals: 8,
    routing: 'deepbook',
    note: 'DeepBook BTC',
  },
  {
    symbol: 'DBUSDT',
    type: '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDT::DBUSDT',
    decimals: 6,
    routing: 'deepbook',
    note: 'DeepBook USDT',
  },
  {
    symbol: 'DEEP',
    type: '0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP',
    decimals: 6,
    routing: 'deepbook',
    note: 'DeepBook native',
  },
  {
    symbol: 'WAL',
    type: '0x9ef7676a9f81937a52ae4b2af8d511a28a0b080477c0c2db40b0ab8882240d76::wal::WAL',
    decimals: 9,
    routing: 'deepbook',
    note: 'Walrus',
  },
  {
    // DeepBook Predict's testnet quote asset. Not the same coin as
    // Circle USDC or DBUSDC. Faucet via https://tally.so/r/Xx102L.
    // Used exclusively by the /hedge flow.
    symbol: 'DUSDC',
    type: '0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC',
    decimals: 6,
    routing: 'predict',
    note: 'Predict quote',
  },
];

const DEVNET_QUOTES: QuoteToken[] = [
  {
    symbol: 'SUI',
    type: '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
    decimals: 9,
    routing: 'm1n3-market',
    note: 'native · live',
  },
  // Non-SUI quotes on devnet have no DeepBook to route through.
];

const network = (SUI_NETWORK as Network) || 'devnet';

const ALL_QUOTES: QuoteToken[] =
  network === 'mainnet'
    ? MAINNET_QUOTES
    : network === 'testnet'
      ? TESTNET_QUOTES
      : DEVNET_QUOTES;

/// Quotes shown in the /marketplace selector — Predict quote assets
/// like DUSDC are excluded because they aren't real HashShare markets.
export const QUOTE_TOKENS: QuoteToken[] = ALL_QUOTES.filter(
  (t) => t.routing !== 'predict',
);

/// Look up any registered quote (including Predict-only ones).
export function findQuoteToken(symbol: string): QuoteToken | undefined {
  return ALL_QUOTES.find((t) => t.symbol === symbol);
}

export function activeDeepBookConfig(): DeepBookConfig | null {
  return DEEPBOOK_V3[network];
}

export function activeNetwork(): Network {
  return network;
}
