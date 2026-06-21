//! m1n3 Miner Sidecar
//!
//! Runs alongside standard mining software (cgminer, BFGMiner, BitAxe, etc.) as a
//! Stratum v1 proxy. Mining software connects to the sidecar; the sidecar connects
//! upstream to the pool's stratum server.
//!
//! When the stratum server accepts a share, the sidecar submits it directly to Sui
//! using the miner's own keypair — the pool operator never touches the submission
//! and cannot redirect work attribution.
//!
//! Usage:
//!   miner-sidecar \
//!     --stratum-host 127.0.0.1:3333 \
//!     --listen-port 3334 \
//!     --sui-keystore ~/.sui/sui_config/sui.keystore \
//!     --sui-rpc https://fullnode.devnet.sui.io:443 \
//!     --sui-package <PACKAGE_ID> \
//!     --pool-object <POOL_OBJECT_ID> \
//!     --dedup-registry <DEDUP_REGISTRY_ID>

use anyhow::Result;
use clap::Parser;
use tracing::info;

mod price_feeder;
mod slot_watcher;
mod stratum_proxy;
mod sui_sender;

#[derive(Parser, Debug)]
#[command(name = "miner-sidecar")]
#[command(about = "m1n3 miner sidecar — trustless Stratum v1 proxy with direct Sui submission")]
pub struct Args {
    /// Stratum server address to connect to upstream
    #[arg(long, default_value = "127.0.0.1:3333")]
    pub stratum_host: String,

    /// Local port for mining software to connect to
    #[arg(long, short, default_value = "3334")]
    pub listen_port: u16,

    /// Path to the miner's Sui keystore file
    #[arg(long, default_value = "~/.sui/sui_config/sui.keystore")]
    pub sui_keystore: String,

    /// Sui RPC URL
    #[arg(long, default_value = "http://127.0.0.1:9000")]
    pub sui_rpc: String,

    /// m1n3 Sui package ID (0x…)
    #[arg(long)]
    pub sui_package: String,

    /// Pool shared object ID (0x…)
    #[arg(long)]
    pub pool_object: String,

    /// ShareDedupRegistry shared object ID (0x…)
    #[arg(long)]
    pub dedup_registry: String,

    /// MinerRoundRegistry shared object ID (0x…). Required on the
    /// post-trustless-cleanup package — `create_round_stats` takes it as
    /// `&mut MinerRoundRegistry`. The submission flow aborts at MRS
    /// creation if not provided.
    #[arg(long)]
    pub miner_round_registry: Option<String>,

    /// Max shares per Sui transaction (1–32)
    #[arg(long, default_value = "16")]
    pub batch_size: usize,

    /// Flush batch after this many milliseconds even if not full
    #[arg(long, default_value = "5000")]
    pub batch_timeout_ms: u64,

    /// Gas budget per transaction (MIST)
    #[arg(long, default_value = "10000000")]
    pub gas_budget: u64,

    // ── Optional HashShare mint ─────────────────────────────────────────
    //
    // When the registry flag is set, every share submitted via the sidecar
    // is also wrapped into `Coin<T>` in the same PTB. Default fee is taken
    // by the protocol on-chain (1%). The Coin lands in the miner's wallet
    // and can be traded on /marketplace or DeepBook.
    //
    // The sidecar subscribes to `SlotBoundToRound` events emitted by the
    // registry and hot-swaps the active mint config whenever a new slot is
    // bound — no restart needed when the round rotates to a new HS_NNN.
    //
    // Manual overrides (`--hashshare-treasury-cap` + `--hashshare-type`)
    // pin the initial config so minting can start before the next
    // `SlotBoundToRound` fires. They are otherwise unnecessary.

    /// HashShareRegistry shared object ID. Required to enable minting.
    #[arg(long)]
    pub hashshare_registry: Option<String>,

    /// Initial shared TreasuryCap<HS_NNN>. Optional — the slot watcher
    /// will overwrite this once a `SlotBoundToRound` event is observed.
    #[arg(long)]
    pub hashshare_treasury_cap: Option<String>,

    /// Initial Move type string for the HashShare coin
    /// (e.g. `0x…::hs_000::HS_000`). Optional — overwritten on next bind.
    #[arg(long)]
    pub hashshare_type: Option<String>,

    /// How often (seconds) to poll for new `SlotBoundToRound` events.
    #[arg(long, default_value = "10")]
    pub slot_poll_seconds: u64,

    // ── Auto-sell (post-batch) ──────────────────────────────────────────
    //
    // After every successful share batch (and HashShare mint), if
    // --auto-sell-price-mist is > 0 the sidecar follows up with a single
    // `hash_share_market::place_sell_order` for the miner's entire
    // HashShare inventory at the configured floor price. The order is
    // owned by the miner and can be cancelled / re-priced from the dapp.
    //
    //   --auto-sell-price-mist 1000          # 1000 MIST per HashShare unit
    //   --auto-sell-expires-ms  0            # never expires (0 = no expiry)
    //
    // Set --auto-sell-price-mist 0 (or omit) to disable.

    /// MIST price per HashShare unit. 0 disables auto-sell.
    #[arg(long, default_value = "0")]
    pub auto_sell_price_mist: u64,

    /// Auto-sell order expiry, Unix milliseconds. 0 = no expiry.
    #[arg(long, default_value = "0")]
    pub auto_sell_expires_ms: u64,

    // ── Peg-to-market sell pricing (overrides --auto-sell-price-mist) ────
    //
    // When --auto-sell-peg is set, the sidecar computes a target price from
    // the live orderbook each batch:
    //
    //   target = anchor * (1 + offset_bps/10000)
    //
    // …where `anchor` is the best bid (mid|bid|ask). If the miner has an
    // existing live SellOrder, it's topped-up with the new batch's coins
    // and its price retargeted via `update_sell_order_price`. Otherwise
    // a fresh order is placed.
    //
    //   --auto-sell-peg mid           # follow the market mid
    //   --auto-sell-offset-bps -50    # 0.5% below mid
    //   --auto-sell-fallback-mist 1000   # used when orderbook is empty
    //
    // Set --auto-sell-peg "" (empty) to disable.

    /// Orderbook anchor: `mid` | `bid` | `ask`. Empty disables.
    #[arg(long, default_value = "")]
    pub auto_sell_peg: String,

    /// Signed bps offset from the anchor (+100 = +1%, -50 = -0.5%).
    #[arg(long, default_value = "0", allow_hyphen_values = true)]
    pub auto_sell_offset_bps: i32,

    /// Fallback floor in MIST/unit when the orderbook gives no anchor.
    /// 0 means "skip the batch when orderbook is empty".
    #[arg(long, default_value = "0")]
    pub auto_sell_fallback_mist: u64,

    // ── Auto-fill resting bids (Mode 3) ───────────────────────────────────
    //
    // When set > 0, the sidecar scans for the best resting BuyOrder above
    // this floor each batch and fills it via `hash_share_market::fill_buy_order`.
    // Requires --market-fee-pool to be set.
    //
    //   --auto-fill-bid-floor-mist 950
    //   --market-fee-pool 0x4d3da2…0bba08f9
    //
    // If no bid matches the floor, the sidecar falls through to the
    // auto-sell path (peg if configured, else fixed-floor).

    /// Minimum acceptable bid price in MIST/unit. 0 disables auto-fill.
    #[arg(long, default_value = "0")]
    pub auto_fill_bid_floor_mist: u64,

    /// Shared `MarketFeePool` object ID. Required when auto-fill is on.
    #[arg(long, default_value = "")]
    pub market_fee_pool: String,

    /// Fully-qualified Move type of the quote coin used by
    /// `hash_share_market` (e.g. `0xdba34672…::usdc::USDC` on mainnet).
    /// Empty defaults to SUI — back-compat with the testnet/devnet
    /// markets that pre-date the `<phantom T, phantom QuoteT>` refactor.
    /// On mainnet this MUST be set to the native USDC type or every
    /// auto-sell / auto-fill PTB will fail with a type-arity error.
    #[arg(long, default_value = "")]
    pub quote_coin_type: String,

    /// Buyer-template lane: when set, every share batch is submitted via
    /// `pool::submit_share_for_pay<QuoteT>` against this
    /// `HashpowerBuyOrder<QuoteT>` instead of the usual `submit_share`.
    /// The resulting `Coin<QuoteT>` is transferred to the miner inside
    /// the PTB. HashShare mint + auto-sell + auto-fill are skipped in
    /// this mode — they're orthogonal to the direct-pay lane.
    ///
    /// `--quote-coin-type` must match the order's `QuoteT` generic;
    /// otherwise the PTB aborts with a type-mismatch.
    #[arg(long, default_value = "")]
    pub hashpower_buy_order_id: String,

    // ── Dynamic auto-sell pricing (off-chain feeder) ─────────────────────
    //
    // When enabled, a background task fetches live BTC/USD spot from
    // `--auto-price-api-url`, reads the latest Template's nbits from this
    // pool's on-chain state, derives the fair-value µUSDC-per-HashShare
    // floor (canonical PPS formula), and feeds it to the auto-sell logic
    // every batch. Overrides `--auto-sell-fallback-mist` when active.
    //
    // The on-chain Pyth-anchored variant is Phase B (see
    // `miner-sidecar/src/price_feeder.rs` header for the migration plan).

    /// Enable the off-chain dynamic auto-sell floor feeder.
    #[arg(long, default_value_t = false)]
    pub auto_price_feeder: bool,

    /// Price API endpoint. Default = CoinGecko's public BTC/USD simple
    /// price feed. Format: `{ "bitcoin": { "usd": N } }`.
    #[arg(
        long,
        default_value = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
    )]
    pub auto_price_api_url: String,

    /// Refresh cadence for the price feeder (seconds). Floored at 15.
    #[arg(long, default_value = "60")]
    pub auto_price_refresh_secs: u64,

    /// Operator markup over the fair-value PPS price, in basis points.
    /// 10_000 = 1.0× (no adjustment). 11_000 = +10%. 9_000 = -10%.
    #[arg(long, default_value = "10000")]
    pub auto_price_multiplier_bps: u64,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("miner_sidecar=info".parse()?),
        )
        .init();

    let args = Args::parse();

    info!(
        "m1n3 miner sidecar starting — listen={} upstream={} package={}",
        args.listen_port, args.stratum_host, args.sui_package
    );

    stratum_proxy::run(args).await
}
