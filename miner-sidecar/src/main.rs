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
