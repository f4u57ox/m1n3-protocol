//! m1n3 Stratum Server
//!
//! A high-performance Stratum v1 server that:
//! - Accepts miner connections
//! - Gets block templates from Bitcoin Core
//! - Validates shares locally
//! - Registers each fresh template as a Sui object
//!
//! ## Operator vs buyer mode (one binary, two roles)
//!
//! Template registration dispatches off `--pool-admin-cap` (env var
//! `POOL_ADMIN_CAP`):
//!
//! - **Operator mode** (cap set): calls `pool::register_template`. The
//!   server's signer must own the cap; resulting `Template.owner =
//!   SUI_ADDRESS` (the operator wallet).
//! - **Buyer mode** (cap empty): calls `pool::register_template_public`,
//!   splitting the per-template `PERMISSIONLESS_TEMPLATE_FEE_MIST`
//!   (0.01 SUI) off the gas coin. Resulting `Template.owner =
//!   SUI_ADDRESS` (the buyer wallet). Pair with `miner-sidecar
//!   --hashpower-buy-order-id` to drain a `BuyerHashpowerOrder<QuoteT>`
//!   on every share — see `pool.move`'s buyer-template lane section.
//!
//! Either mode auto-rotates templates as bitcoind sees new tips. The
//! `--override-template-id` flag pins a single Template as the only
//! job (no rotation) — useful for tests and known-job replays.
//!
//! Usage (operator):
//!   stratum-server --bitcoin-rpc http://user:pass@127.0.0.1:8332 \
//!     --pool-admin-cap 0x... --sui-address <OPERATOR> --port 3333

use anyhow::{Context, Result};
use clap::Parser;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::net::tcp::OwnedWriteHalf;
use tokio::sync::{Mutex, RwLock};
use tokio::task::JoinSet;
use tracing::{error, info, warn};

mod stratum;
mod bitcoin_rpc;
mod sui_submit;
mod sui_queries;
mod template_selector;
mod miner_submit;

use stratum::*;
use bitcoin_rpc::BitcoinRpc;
use sui_submit::SuiSubmitter;
use miner_submit::{BatchMsg, MinerShare, MinerSubmitter, miner_batch_flusher};
use template_selector::{TemplateSelectionMode, TemplateSelector};

/// Number of shards for the submitted_shares duplicate detection set.
/// Each shard has its own Mutex for fine-grained concurrent access.
const SHARE_SHARDS: usize = 16;

/// Maximum entries per shard before we log a warning (Phase 4B bound).
const MAX_PER_SHARD: usize = 100_000;

#[derive(Parser, Debug)]
#[command(name = "stratum-server")]
#[command(about = "m1n3 Stratum Server — connects miners to the Sui pool")]
struct Args {
    /// Bitcoin Core RPC URL (e.g., http://user:pass@127.0.0.1:8332)
    /// Leave empty in pooled/decentralized mode to skip Bitcoin connection.
    #[arg(long, default_value = "")]
    bitcoin_rpc: String,

    /// Port to listen on for miner connections
    #[arg(long, short, default_value = "3333")]
    port: u16,

    /// m1n3 Sui package ID (0x…)
    #[arg(long)]
    sui_package: String,

    /// Pool shared object ID (0x…)
    #[arg(long, default_value = "")]
    pool_object: String,

    /// Initial difficulty for miners
    #[arg(long, default_value = "4096")]
    initial_difficulty: u64,

    /// Target shares per minute across ALL miners (global p2pool-style vardiff)
    #[arg(long, default_value = "10")]
    target_shares_per_min: u64,

    /// Pool payout address as hex-encoded scriptPubKey
    /// Examples: P2WPKH="0014<20-byte-hash>", P2TR="5120<32-byte-key>", P2PKH="76a914<20-byte-hash>88ac"
    #[arg(long, default_value = "")]
    pool_address: String,

    /// Idle timeout in seconds (disconnect miners with no activity)
    #[arg(long, default_value = "300")]
    idle_timeout: u64,

    /// Mempool refresh interval in seconds (how often to create new jobs from mempool changes)
    #[arg(long, default_value = "30")]
    mempool_refresh_secs: u64,

    /// Enable decentralized pool mode (miners select templates from on-chain)
    #[arg(long, default_value_t = false)]
    decentralized: bool,

    /// Sui RPC URL
    #[arg(long, default_value = "http://127.0.0.1:9000")]
    sui_rpc_url: String,

    /// StakingRegistry object ID (required for decentralized mode)
    #[arg(long)]
    staking_registry: Option<String>,

    /// Default template selection mode: stake, shares, combined
    #[arg(long, default_value = "stake")]
    default_selection: String,

    /// Template cache refresh interval in seconds
    #[arg(long, default_value = "5")]
    template_cache_secs: u64,

    /// Enable lightweight mode (no MiningShare NFTs created, ~60-70% gas savings)
    #[arg(long, default_value_t = false)]
    lightweight: bool,

    /// Path to Sui keystore file
    #[arg(long, default_value = "~/.sui/sui_config/sui.keystore")]
    sui_keystore: String,

    /// Sui address to use from keystore (defaults to first key)
    #[arg(long)]
    sui_address: Option<String>,

    /// Pool admin cap object ID (required for template registration)
    #[arg(long, default_value = "")]
    pool_admin_cap: String,

    /// ShareDedupRegistry shared object ID (required for solo mode)
    #[arg(long, default_value = "")]
    dedup_registry: String,

    /// Solo mode: path to the miner's Sui keystore for trustless share submission.
    /// When set, accepted shares are submitted directly to Sui signed by this keypair.
    /// Leave empty to disable (pool mode — use the miner sidecar instead).
    #[arg(long, default_value = "")]
    miner_keypair: String,

    /// Solo mode: max shares per Sui transaction (1–32)
    #[arg(long, default_value = "16")]
    miner_batch_size: usize,

    /// Solo mode: flush the batch after this many milliseconds even if not full
    #[arg(long, default_value = "30000")]
    miner_batch_timeout_ms: u64,

    /// Gas budget per transaction (MIST)
    #[arg(long, default_value = "10000000")]
    gas_budget: u64,

    /// HTTP port for /health and /metrics endpoints (0 = disabled)
    #[arg(long, default_value = "9091")]
    metrics_port: u16,

    /// Buyer-template lane: pin a specific on-chain Template as the
    /// always-active mining job. The stratum-server fetches its fields
    /// once at startup, builds a MiningJob from them, and serves THAT
    /// job to every connecting miner — no bitcoind polling, no
    /// auto-rotation, no operator template registration.
    ///
    /// The Avalon mines this template's bytes; the sidecar (in buyer
    /// mode) submits the resulting shares against the matching
    /// HashpowerBuyOrder via `pool::submit_share_for_pay`. Restart with
    /// a fresh Template id when the buyer publishes a newer one.
    #[arg(long, default_value = "")]
    override_template_id: String,
}

/// Combined share tracking: timestamps + last share time (Phase 1B)
struct ShareTracker {
    /// Sliding window of accepted share timestamps (for global vardiff)
    timestamps: VecDeque<std::time::Instant>,
    /// Tracks when any share was last accepted (for drought detection)
    last_share_time: std::time::Instant,
}

/// Shared server state
pub struct ServerState {
    /// Bitcoin RPC client (None in pooled mode — no Bitcoin node needed)
    pub bitcoin: Option<BitcoinRpc>,
    /// Current job being mined (Phase 4A: Arc)
    pub current_job: RwLock<Option<Arc<MiningJob>>>,
    /// All recent jobs by job_id (Phase 4A: Arc values)
    pub jobs: RwLock<HashMap<String, Arc<MiningJob>>>,
    /// Job ID counter
    pub job_counter: RwLock<u64>,
    /// Connected miners
    pub miners: RwLock<HashMap<SocketAddr, MinerState>>,
    /// Sui submitter
    pub sui: SuiSubmitter,
    /// Initial difficulty
    pub initial_difficulty: u64,
    /// Current prev_block_hash (to detect new blocks)
    pub current_prev_hash: RwLock<Option<[u8; 32]>>,
    /// Global difficulty (P2Pool-style: same for all miners)
    pub global_difficulty: RwLock<u64>,
    /// Target shares per minute (global)
    pub target_shares_per_min: u64,
    /// Pool payout scriptPubKey (decoded from --pool-address hex)
    pub pool_address_script: Vec<u8>,
    /// Sharded submitted share keys for duplicate detection (Phase 1A)
    submitted_shares: [Mutex<HashSet<String>>; SHARE_SHARDS],
    /// Idle timeout in seconds
    pub idle_timeout: u64,
    /// Minimum seconds between mempool-driven job updates
    pub mempool_refresh_secs: u64,
    /// Serializes lazy template registrations to prevent double-registration
    pub template_registration_lock: Mutex<()>,
    /// Last known on-chain pool minimum difficulty (for bidirectional sync)
    pub last_pool_min_difficulty: RwLock<u64>,
    /// On-chain template PDA of the job immediately before the current one.
    /// Kept active so miners can still submit stale shares against the previous coinbase2.
    /// Deactivated together with the current PDA when a new Bitcoin block arrives.
    pub previous_template_pda: RwLock<Option<String>>,
    /// Combined share tracker: timestamps + last_share_time (Phase 1B)
    share_tracker: Mutex<ShareTracker>,
    /// Pre-registered template IDs for eager registration (Phase 3B)
    pub template_ids: RwLock<HashMap<String, String>>,

    // === Decentralized pool mode ===
    /// Whether decentralized mode is enabled
    pub decentralized_mode: bool,
    /// Template selector for decentralized mode
    pub template_selector: Option<TemplateSelector>,
    /// Default selection mode for miners who don't specify one
    pub default_selection_mode: TemplateSelectionMode,
    /// Per-miner preferences (connection-specific)
    pub miner_preferences: RwLock<HashMap<SocketAddr, TemplateSelectionMode>>,

    /// Lightweight mode: validate shares but don't create NFTs (~60-70% gas savings)
    pub lightweight_mode: bool,

    /// Solo mode: channel to the miner batch flusher (None = pool mode / sidecar)
    pub miner_tx: Option<tokio::sync::mpsc::UnboundedSender<BatchMsg>>,

    // ── Metrics ──────────────────────────────────────────────────────────────
    pub shares_accepted_total: AtomicU64,
    pub shares_rejected_total: AtomicU64,
    pub start_time: std::time::Instant,
    pub last_template_at: RwLock<Option<std::time::Instant>>,
    pub metrics_port: u16,
}

/// State for a connected miner
pub struct MinerState {
    pub worker_name: String,
    pub sui_address: Option<String>,
    pub shares_submitted: u64,
    pub extranonce1: String,
    /// Writer handle for pushing notifications to this miner
    pub writer: Arc<Mutex<OwnedWriteHalf>>,
    /// Per-miner difficulty (at least global_min_difficulty)
    pub difficulty: u64,
    /// Per-miner sliding window of share timestamps for vardiff
    pub share_timestamps: VecDeque<std::time::Instant>,
    /// Exponentially-weighted hashrate estimate (H/s)
    pub estimated_hashrate: f64,
    /// Timestamp of last accepted share
    pub last_share_time: Option<std::time::Instant>,
    /// Template selection mode for this miner (decentralized mode)
    pub selection_mode: TemplateSelectionMode,
    /// Current template ID this miner is mining (decentralized mode)
    pub current_template_id: Option<String>,
}

/// A mining job derived from a Bitcoin block template
#[derive(Clone, Debug)]
pub struct MiningJob {
    pub job_id: String,
    pub height: u64,
    pub prev_block_hash: [u8; 32],
    pub coinbase1: Vec<u8>,
    pub coinbase2: Vec<u8>,
    pub merkle_branches: Vec<[u8; 32]>,
    pub version: u32,
    pub nbits: u32,
    pub ntime: u32,
    pub clean_jobs: bool,
    // For Sui template registration
    pub merkle_root_base: [u8; 32],
    pub template_registered: bool,
    /// Sui template object ID (set after registration)
    pub sui_template_id: Option<String>,
    /// Minimum time from GBT (for ntime validation)
    pub mintime: u64,
    /// Current time from GBT (for ntime validation)
    pub curtime: u64,
    /// Whether coinbase includes a witness commitment
    pub has_witness_commitment: bool,
    /// Raw transaction data (hex) for block assembly
    pub transaction_data: Vec<String>,
    /// Whether the on-chain template needs updating (merkle branches changed)
    pub needs_template_update: bool,
    /// Monotonically increasing version counter per (height, creator) pair.
    /// seq=0 is the initial registration; each mempool update increments it.
    /// Encoded in the template PDA seeds so each version gets its own on-chain account.
    pub template_seq: u64,
}

/// Hash a share key to select a shard index (Phase 1A)
fn shard_index(key: &str) -> usize {
    // Simple hash: sum bytes mod SHARE_SHARDS
    let sum: usize = key.bytes().map(|b| b as usize).sum();
    sum % SHARE_SHARDS
}

/// Create the initial array of 16 empty Mutex<HashSet> shards
fn create_share_shards() -> [Mutex<HashSet<String>>; SHARE_SHARDS] {
    // Can't use array::from_fn with Mutex, so use explicit init
    [
        Mutex::new(HashSet::new()), Mutex::new(HashSet::new()),
        Mutex::new(HashSet::new()), Mutex::new(HashSet::new()),
        Mutex::new(HashSet::new()), Mutex::new(HashSet::new()),
        Mutex::new(HashSet::new()), Mutex::new(HashSet::new()),
        Mutex::new(HashSet::new()), Mutex::new(HashSet::new()),
        Mutex::new(HashSet::new()), Mutex::new(HashSet::new()),
        Mutex::new(HashSet::new()), Mutex::new(HashSet::new()),
        Mutex::new(HashSet::new()), Mutex::new(HashSet::new()),
    ]
}

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("stratum_server=info".parse().unwrap()),
        )
        .init();

    let args = Args::parse();

    // Resolve Bitcoin RPC URL: env var preferred over CLI arg to keep credentials out of the process list.
    let bitcoin_rpc_url: String = if let Ok(env_url) = std::env::var("BITCOIN_RPC_URL") {
        env_url
    } else if !args.bitcoin_rpc.is_empty() {
        if args.bitcoin_rpc.contains('@') {
            warn!(
                "SECURITY: Bitcoin RPC credentials are visible in the process list (ps/proc). \
                 Use the BITCOIN_RPC_URL environment variable instead of --bitcoin-rpc."
            );
        }
        args.bitcoin_rpc.clone()
    } else {
        String::new()
    };

    // Parse pool address scriptPubKey from hex
    let pool_address_script = if args.pool_address.is_empty() {
        warn!("No --pool-address specified! Coinbase outputs will be UNSPENDABLE (all-zero P2PKH)");
        Vec::new()
    } else {
        hex::decode(&args.pool_address)
            .expect("--pool-address must be valid hex-encoded scriptPubKey")
    };

    info!("Starting m1n3 Stratum Server");
    if !bitcoin_rpc_url.is_empty() {
        info!("Bitcoin RPC: {}", bitcoin_rpc_url.split('@').last().unwrap_or(&bitcoin_rpc_url));
    } else {
        info!("Bitcoin RPC: not configured");
    }
    info!("Listening port: {}", args.port);
    info!("Initial difficulty: {}", args.initial_difficulty);
    info!("Sui package: {}", args.sui_package);
    info!("Pool object: {}", args.pool_object);
    if !pool_address_script.is_empty() {
        info!("Pool address script: {} ({} bytes)", args.pool_address, pool_address_script.len());
    }
    info!("Mempool refresh interval: {}s", args.mempool_refresh_secs);
    if args.decentralized {
        info!("Decentralized mode: ENABLED");
        info!("Default selection: {}", args.default_selection);
        info!("Template cache interval: {}s", args.template_cache_secs);
    }
    if args.lightweight {
        info!("Lightweight mode: ENABLED (no MiningShare NFTs, ~60-70% gas savings)");
    }
    // Verify SHA256d implementation with Bitcoin block #1 header
    {
        let block1_header = hex::decode(
            "0100000006226e46111a0b59caaf126043eb5bbf28c34f3a5e332a1fc7b2b73cf188910f\
             6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b\
             dae5494dffff7f2002000000"
        ).unwrap();
        let h1 = Sha256::digest(&block1_header);
        let h2: [u8; 32] = Sha256::digest(&h1).into();
        info!("SHA256d test: input_len={}, hash={}", block1_header.len(), hex::encode(&h2));
        assert_eq!(block1_header.len(), 80, "Block header must be 80 bytes");
        info!("SHA256d test vector verified (80-byte header hashes correctly)");
    }

    // Initialize Bitcoin RPC (optional in pooled/decentralized mode)
    let bitcoin = if bitcoin_rpc_url.is_empty() {
        if !args.decentralized {
            error!("Bitcoin RPC URL is required in solo mode. Set BITCOIN_RPC_URL or use --bitcoin-rpc.");
            anyhow::bail!("Bitcoin RPC URL required in solo mode");
        }
        info!("Pooled mode: no Bitcoin RPC configured, will mine on-chain templates only");
        None
    } else {
        let btc = BitcoinRpc::new(&bitcoin_rpc_url)?;
        match btc.get_blockchain_info().await {
            Ok(info) => {
                info!("Connected to Bitcoin node: chain={}, blocks={}", info.chain, info.blocks);
                Some(btc)
            }
            Err(e) => {
                if args.decentralized {
                    warn!("Bitcoin RPC unavailable ({}), running in pure pooled mode", e);
                    None
                } else {
                    error!("Failed to connect to Bitcoin node: {}", e);
                    error!("Make sure Bitcoin Core is running with -server and RPC credentials are correct");
                    return Err(e);
                }
            }
        }
    };

    // Initialize Sui submitter
    let sui = SuiSubmitter::new(
        args.sui_package.clone(),
        args.pool_object.clone(),
        args.sui_rpc_url.clone(),
        args.sui_keystore.clone(),
        args.sui_address.clone(),
    )
    .await
    .with_admin_cap(&args.pool_admin_cap);
    if !args.pool_admin_cap.is_empty() {
        info!("Pool admin cap: {}", args.pool_admin_cap);
    }

    // Initialize template selector for decentralized mode
    let (decentralized_mode, template_selector, default_selection_mode) = if args.decentralized {
        let staking_registry_id = args.staking_registry
            .as_ref()
            .expect("--staking-registry is required for decentralized mode");

        let selector = TemplateSelector::new(
            args.sui_rpc_url.clone(),
            args.sui_package.clone(),
            staking_registry_id.clone(),
            std::time::Duration::from_secs(args.template_cache_secs),
        );

        let default_mode = match args.default_selection.to_lowercase().as_str() {
            "stake" => TemplateSelectionMode::ByStake,
            "shares" => TemplateSelectionMode::ByShares,
            "combined" => TemplateSelectionMode::Combined,
            _ => TemplateSelectionMode::ByStake,
        };

        (true, Some(selector), default_mode)
    } else {
        (false, None, TemplateSelectionMode::Default)
    };

    // Create server state
    let mut state = Arc::new(ServerState {
        bitcoin,
        current_job: RwLock::new(None),
        jobs: RwLock::new(HashMap::new()),
        job_counter: RwLock::new(0),
        miners: RwLock::new(HashMap::new()),
        sui,
        initial_difficulty: args.initial_difficulty,
        current_prev_hash: RwLock::new(None),
        global_difficulty: RwLock::new(args.initial_difficulty),
        target_shares_per_min: args.target_shares_per_min,
        pool_address_script,
        submitted_shares: create_share_shards(),
        idle_timeout: args.idle_timeout,
        mempool_refresh_secs: args.mempool_refresh_secs,
        template_registration_lock: Mutex::new(()),
        last_pool_min_difficulty: RwLock::new(args.initial_difficulty),
        previous_template_pda: RwLock::new(None),
        share_tracker: Mutex::new(ShareTracker {
            timestamps: VecDeque::new(),
            last_share_time: std::time::Instant::now(),
        }),
        template_ids: RwLock::new(HashMap::new()),
        decentralized_mode,
        template_selector,
        default_selection_mode,
        miner_preferences: RwLock::new(HashMap::new()),
        lightweight_mode: args.lightweight,
        miner_tx: None, // filled in below if --miner-keypair is set
        shares_accepted_total: AtomicU64::new(0),
        shares_rejected_total: AtomicU64::new(0),
        start_time: std::time::Instant::now(),
        last_template_at: RwLock::new(None),
        metrics_port: args.metrics_port,
    });

    // Solo mode: start miner batch flusher if --miner-keypair was provided
    if !args.miner_keypair.is_empty() {
        match MinerSubmitter::new(
            &args.sui_package,
            &args.pool_object,
            &args.dedup_registry,
            &args.sui_rpc_url,
            &args.miner_keypair,
            args.gas_budget,
        ).await {
            Err(e) => {
                error!("Failed to create miner submitter: {}", e);
                anyhow::bail!("--miner-keypair error: {}", e);
            }
            Ok(submitter) => {
                info!("Solo mode: shares will be submitted with miner keypair");
                let (miner_tx, miner_rx) = tokio::sync::mpsc::unbounded_channel::<BatchMsg>();
                // SAFETY: Arc<ServerState> is already built; we use get_mut before cloning
                // We must set miner_tx before spawning tasks that use state.
                Arc::get_mut(&mut state).unwrap().miner_tx = Some(miner_tx);
                let batch_size = args.miner_batch_size;
                let timeout_ms = args.miner_batch_timeout_ms;
                tokio::spawn(miner_batch_flusher(submitter, miner_rx, batch_size, timeout_ms));
            }
        }
    }

    // Start job updater task.
    //  • Buyer-template lane (--override-template-id): one-shot job from
    //    an on-chain buyer Template. No polling, no rotation.
    //  • Solo mode (--bitcoin-rpc + no override): job_updater polls bitcoind.
    //  • Decentralized mode: pooled_job_updater scans on-chain templates.
    if !args.override_template_id.is_empty() {
        let state_clone = state.clone();
        let tid = args.override_template_id.clone();
        let rpc = args.sui_rpc_url.clone();
        let pkg = args.sui_package.clone();
        tokio::spawn(async move {
            override_job_updater(state_clone, tid, rpc, pkg).await;
        });
    } else if state.bitcoin.is_some() {
        let state_clone = state.clone();
        tokio::spawn(async move {
            job_updater(state_clone).await;
        });
    } else if state.decentralized_mode {
        let state_clone = state.clone();
        tokio::spawn(async move {
            pooled_job_updater(state_clone).await;
        });
    } else {
        error!("No Bitcoin RPC and not in decentralized mode — no job source available");
        anyhow::bail!("No job source: provide --bitcoin-rpc or use --decentralized");
    }

    // Start difficulty sync loop (polls pool contract for miner difficulties)
    let state_clone = state.clone();
    tokio::spawn(async move {
        difficulty_sync_loop(state_clone).await;
    });

    // Start global vardiff loop (P2Pool-style: adjusts difficulty for all miners)
    let state_clone = state.clone();
    tokio::spawn(async move {
        global_vardiff_loop(state_clone).await;
    });

    // Start template cache refresher for decentralized mode
    if state.decentralized_mode {
        let state_clone = state.clone();
        let cache_interval = args.template_cache_secs;
        tokio::spawn(async move {
            template_cache_refresher(state_clone, cache_interval).await;
        });
    }

    // Start metrics HTTP server
    if state.metrics_port > 0 {
        let state_clone = state.clone();
        let mport = state.metrics_port;
        tokio::spawn(async move {
            if let Err(e) = metrics_http_server(state_clone, mport).await {
                error!("Metrics HTTP server error: {}", e);
            }
        });
        info!("Metrics endpoint: http://0.0.0.0:{}/metrics", state.metrics_port);
    }

    // Start TCP listener
    let addr = format!("0.0.0.0:{}", args.port);
    let listener = TcpListener::bind(&addr).await?;
    info!("Stratum server listening on {}", addr);
    info!("");
    info!("=== Connect your miner to: stratum+tcp://127.0.0.1:{} ===", args.port);
    if state.decentralized_mode {
        info!("Username format: <sui_address>.<worker_name>.<selection_mode>");
        info!("Selection modes: stake, shares, combined, c:<creator_address>");
        info!("Examples:");
        info!("  0xabc...def.rig1.stake    - Mine highest staked template");
        info!("  0xabc...def.rig1.shares   - Mine most shares template");
        info!("  0xabc...def.rig1.combined - Mine highest combined score");
        info!("  0xabc...def.rig1.c:0x456  - Mine specific creator's template");
        info!("  0xabc...def.rig1          - Use default ({})", state.default_selection_mode.description());
    } else {
        info!("Username format: <sui_address>.<worker_name>");
        info!("Example: 0xebdc5b83f1d4d3922c714c3a28f55101f691105c5d11fa9c82441e54e93cd506.rig1");
    }
    info!("");

    // Accept connections
    loop {
        let (socket, addr) = listener.accept().await?;
        info!("New connection from {}", addr);

        let state = state.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_miner(socket, addr, state).await {
                error!("Miner {} error: {}", addr, e);
            }
            info!("Miner {} disconnected", addr);
        });
    }
}

/// Poll Bitcoin Core for new blocks and mempool changes.
/// - New block: create local job + notify miners (clean_jobs=true)
/// - Same block, different merkle root: create local job + notify miners
/// - Same block, same merkle root: skip
/// Templates are pre-registered eagerly when a new job is created (Phase 3B).
async fn job_updater(state: Arc<ServerState>) {
    // Poll every 1 second for new blocks, reduces stale work (M1)
    let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(1));

    // Track last mempool-driven update; seed in the past so the first update fires immediately
    let mut last_merkle_update = tokio::time::Instant::now()
        - tokio::time::Duration::from_secs(state.mempool_refresh_secs);

    loop {
        interval.tick().await;

        let bitcoin = match state.bitcoin.as_ref() {
            Some(btc) => btc,
            None => {
                // No Bitcoin RPC — this function should not be running in pooled mode
                warn!("job_updater called without Bitcoin RPC, stopping");
                return;
            }
        };

        let template = match bitcoin.get_block_template().await {
            Ok(t) => t,
            Err(e) => {
                warn!("Bitcoin RPC unavailable (retry in 10s): {}", e);
                // Keep miners working on current template while Core is unreachable.
                tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;
                continue;
            }
        };

        // Parse prev_block_hash
        let mut prev_block_hash = [0u8; 32];
        if hex::decode_to_slice(&template.previousblockhash, &mut prev_block_hash).is_err() {
            warn!("Failed to parse previousblockhash");
            continue;
        }
        prev_block_hash.reverse();

        let is_new_block = {
            let current = state.current_prev_hash.read().await;
            match *current {
                Some(hash) => hash != prev_block_hash,
                None => true,
            }
        };

        if !is_new_block {
            // Throttle: skip mempool-driven updates until refresh interval has elapsed
            let elapsed = last_merkle_update.elapsed();
            if elapsed < tokio::time::Duration::from_secs(state.mempool_refresh_secs) {
                continue;
            }

            // Same block - check if merkle root changed (new transactions in mempool)
            let new_branches = match calculate_merkle_branches(&template) {
                Ok(b) => b,
                Err(_) => continue,
            };

            let merkle_changed = {
                let current_job = state.current_job.read().await;
                match current_job.as_ref() {
                    Some(job) => job.merkle_branches != new_branches,
                    None => true,
                }
            };

            if !merkle_changed {
                continue;
            }

            // Merkle changed — register a new template PDA (seq+1) and issue a new job_id.
            // The old job stays in state.jobs so miners can still submit stale shares against
            // the old template PDA without any on-chain data changing under them.
            last_merkle_update = tokio::time::Instant::now();

            let (coinbase1, coinbase2) = match create_coinbase(&template, &state.pool_address_script) {
                Ok(cb) => cb,
                Err(_) => continue,
            };
            let merkle_root_base = calculate_merkle_root(&coinbase1, &coinbase2, &[0u8; 12], &new_branches);
            let ntime = template.curtime as u32;

            let new_job_id = {
                let mut counter = state.job_counter.write().await;
                *counter += 1;
                format!("{:08x}", *counter)
            };

            let current_job = state.current_job.read().await;
            if let Some(ref job) = *current_job {
                let new_seq = job.template_seq + 1;
                let mut updated = (**job).clone();
                updated.job_id = new_job_id;
                updated.template_seq = new_seq;
                updated.merkle_branches = new_branches;
                updated.coinbase1 = coinbase1;
                updated.coinbase2 = coinbase2;
                updated.merkle_root_base = merkle_root_base;
                updated.ntime = ntime;
                updated.needs_template_update = false;
                updated.clean_jobs = false;
                // Reset sui_template_id — will be set after registration below
                updated.sui_template_id = None;

                // Shift current PDA into the "previous" slot before we overwrite current_job.
                let old_tpda = job.sui_template_id.clone();
                drop(current_job);

                info!("Merkle update height={}, seq={}, job_id={}, branches={}",
                    updated.height, new_seq, updated.job_id, updated.merkle_branches.len());

                // 1. Flush queued shares against the current on-chain template while
                //    the old job is still in state.jobs (local validation stays consistent).
                if let Some(ref tx) = state.miner_tx {
                    let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();
                    let _ = tx.send(BatchMsg::FlushAndWait(done_tx));
                    let _ = done_rx.await;
                }

                // 2. Register a fresh template PDA for the new coinbase2 + branches.
                //    If registration fails AFTER its internal retries, skip the
                //    publish + notify entirely: pushing a `mining.notify` with an
                //    empty `template_pda[9]` would make the sidecar silently drop
                //    every share against this job (`stratum_proxy.rs:567`,
                //    `template_id not tracked — dropped`) because the job never
                //    gets inserted into the sidecar's tracking map. Miners keep
                //    hashing on the previous job — `state.jobs` retains the
                //    last 10 entries, so the prior job_id stays accept-able
                //    well past the next ~30 s mempool-poll retry.
                match state.sui.register_template(&updated).await {
                    Ok(new_tpda) => {
                        info!("New template PDA registered: {} (seq={})", new_tpda, new_seq);
                        updated.sui_template_id = Some(new_tpda);
                    }
                    Err(e) => {
                        warn!(
                            "Template registration failed (seq={}); SKIPPING notify — \
                             miners continue with prior job until next attempt: {}",
                            new_seq, e
                        );
                        continue;
                    }
                }

                // 3. Shift: old current → previous (kept active for stale-share acceptance).
                *state.previous_template_pda.write().await = old_tpda;

                // 4. Publish the new job. Old job stays in state.jobs so miners can
                //    continue submitting stale shares with the old job_id.
                let updated = Arc::new(updated);
                {
                    let mut jobs = state.jobs.write().await;
                    jobs.insert(updated.job_id.clone(), updated.clone());
                    // Trim to keep at most 10 jobs (stale share window)
                    while jobs.len() > 10 {
                        if let Some(oldest) = jobs.keys().min().cloned() { jobs.remove(&oldest); }
                    }
                }
                *state.current_job.write().await = Some(updated.clone());

                *state.last_template_at.write().await = Some(std::time::Instant::now());
                notify_all_miners(&state, &updated).await;
            }
            continue;
        }

        // New block - create a fresh job with new job_id
        match create_new_job_from_template(&state, template).await {
            Ok(mut job) => {
                job.clean_jobs = true;

                info!("NEW BLOCK height={}, job_id={}, branches={}",
                    job.height, job.job_id, job.merkle_branches.len());
                if let Some(ref tx) = state.miner_tx {
                    let _ = tx.send(BatchMsg::Flush);
                }
                *state.current_prev_hash.write().await = Some(job.prev_block_hash);
                // Clear all 16 shards of duplicate share tracking on new block (Phase 1A)
                for shard in &state.submitted_shares {
                    shard.lock().await.clear();
                }

                // Reset mempool timer
                last_merkle_update = tokio::time::Instant::now();

                // Deactivate all active template PDAs (current + previous) and reset round.
                // Fire-and-forget — does not block miner notification.
                {
                    let old_tpda = state.current_job.read().await
                        .as_ref()
                        .and_then(|j| j.sui_template_id.clone());
                    // Take (and clear) the previous slot — new block resets everything.
                    let prev_tpda = state.previous_template_pda.write().await.take();

                    let state2 = state.clone();
                    tokio::spawn(async move {
                        if let Some(tpda) = old_tpda {
                            if let Err(e) = state2.sui.deactivate_template(&tpda).await {
                                warn!("Failed to deactivate current template {}: {}", tpda, e);
                            }
                        }
                        if let Some(tpda) = prev_tpda {
                            if let Err(e) = state2.sui.deactivate_template(&tpda).await {
                                warn!("Failed to deactivate previous template {}: {}", tpda, e);
                            }
                        }
                        // Round close on-chain is driven trustlessly by the
                        // keeper observing BlockFound events — no PTB from
                        // here. Template deactivation above is the only
                        // round-rotation step the stratum-server still owns.
                    });
                }

                // Register template on Sui so shares can be attributed.
                // Same guarantee as the merkle-only-update path above: if
                // the registration's internal retries all fail, skip publish
                // + notify so the ASIC's `mining.notify` never carries an
                // empty `template_pda[9]` — that would make every share
                // against this job get silently dropped at the sidecar's
                // `template_id not tracked` branch. The prior NEW-BLOCK job
                // stays in `state.jobs`; miners continue against it until
                // bitcoind polls again.
                match state.sui.register_template(&job).await {
                    Ok(tpda) => {
                        info!("Template registered on Sui: {}", tpda);
                        job.sui_template_id = Some(tpda);
                    }
                    Err(e) => {
                        warn!(
                            "Template registration failed on NEW BLOCK; SKIPPING notify — \
                             miners continue with prior job until next attempt: {}",
                            e
                        );
                        continue;
                    }
                }

                // Wrap in Arc (Phase 4A)
                let job = Arc::new(job);

                // Add to jobs map with cleanup of old jobs (keep max 10)
                {
                    let mut jobs = state.jobs.write().await;
                    jobs.insert(job.job_id.clone(), job.clone());
                    while jobs.len() > 10 {
                        if let Some(oldest_key) = jobs.keys().min().cloned() {
                            jobs.remove(&oldest_key);
                        } else {
                            break;
                        }
                    }
                }
                *state.current_job.write().await = Some(job.clone());

                // Notify miners of new job
                *state.last_template_at.write().await = Some(std::time::Instant::now());
                notify_all_miners(&state, &job).await;
            }
            Err(e) => warn!("Failed to create job: {}", e),
        }
    }
}

/// Buyer-template lane: pin a single on-chain Template as the active
/// job. No bitcoind, no rotation. Lifecycle:
///   1. Fetch the Template's fields from Sui via sui_queries::fetch_template.
///   2. Build a MiningJob, push into state.current_job.
///   3. Broadcast to all currently-connected miners via notify_all_miners.
///   4. Sit. Never refresh.
/// Operator restarts the stratum with a new --override-template-id when
/// the buyer publishes an updated Template.
async fn override_job_updater(
    state: Arc<ServerState>,
    template_id: String,
    rpc_url: String,
    package_id: String,
) {
    info!(
        "override_job_updater: pinning buyer Template {} as the sole job source",
        template_id
    );
    let querier = match sui_queries::SuiTemplateQuerier::new_async(rpc_url, package_id).await {
        Ok(q) => q,
        Err(e) => {
            error!("override_job_updater: SuiClient init failed: {}", e);
            return;
        }
    };
    let template_data = match querier.fetch_template(&template_id).await {
        Ok(t) => t,
        Err(e) => {
            error!(
                "override_job_updater: cannot fetch Template {}: {}",
                template_id, e
            );
            return;
        }
    };
    info!(
        "override_job_updater: fetched template height={} owner={} branches={}",
        template_data.height,
        template_data.owner,
        template_data.merkle_branches.len()
    );

    let job_id = {
        let mut counter = state.job_counter.write().await;
        *counter += 1;
        format!("{:08x}", *counter)
    };
    let job = create_mining_job_from_template_object(job_id, &template_data);
    let job_arc = Arc::new(job.clone());
    {
        let mut current = state.current_job.write().await;
        *current = Some(job_arc.clone());
    }
    {
        let mut jobs = state.jobs.write().await;
        jobs.insert(job.job_id.clone(), job_arc);
    }
    info!(
        "override_job_updater: broadcasting job {} to currently-connected miners",
        job.job_id
    );
    notify_all_miners(&state, &job).await;

    // ASIC firmware (Avalon Nano, Bitaxe, …) enforces a STALE_JOB_TIMEOUT
    // — typically 60–90 s — and reconnects when no `mining.notify` arrives
    // in that window. The miner reads the lack of refresh as "connection
    // dead." We re-broadcast the SAME job every 30 s with the same
    // `job_id` and the same content; the miner reads it as a heartbeat
    // and continues hashing. The buyer's template is frozen, so there's
    // nothing new to publish — just keep ASIC firmware happy.
    //
    // When the operator wants a FRESH template (e.g. bitcoind sees a new
    // tip), they restart the stratum process with a new
    // `--override-template-id`. No hot-swap path is provided in this
    // override mode.
    let mut tick = tokio::time::interval(tokio::time::Duration::from_secs(30));
    // Skip the first tick (we just broadcast above).
    tick.tick().await;
    loop {
        tick.tick().await;
        let heartbeat = {
            let current = state.current_job.read().await;
            current.as_ref().map(|j| (**j).clone())
        };
        if let Some(j) = heartbeat {
            notify_all_miners(&state, &j).await;
        }
    }
}

/// Create a MiningJob from on-chain TemplateObjectData (for pooled mode).
/// The template was registered by a solo operator — pooled miners mine against it.
fn create_mining_job_from_template_object(
    job_id: String,
    template: &sui_queries::TemplateObjectData,
) -> MiningJob {
    // Convert prev_block_hash: Vec<u8> -> [u8; 32]
    let mut prev_block_hash = [0u8; 32];
    if template.prev_block_hash.len() == 32 {
        prev_block_hash.copy_from_slice(&template.prev_block_hash);
    }

    // Convert merkle_branches: Vec<Vec<u8>> -> Vec<[u8; 32]>
    let merkle_branches: Vec<[u8; 32]> = template
        .merkle_branches
        .iter()
        .filter_map(|b| {
            if b.len() == 32 {
                let mut arr = [0u8; 32];
                arr.copy_from_slice(b);
                Some(arr)
            } else {
                None
            }
        })
        .collect();

    // Compute merkle_root_base from coinbase1/coinbase2 + empty extranonce (12 bytes)
    let merkle_root_base = calculate_merkle_root(
        &template.coinbase1,
        &template.coinbase2,
        &[0u8; 12],
        &merkle_branches,
    );

    MiningJob {
        job_id,
        height: template.height,
        prev_block_hash,
        coinbase1: template.coinbase1.clone(),
        coinbase2: template.coinbase2.clone(),
        merkle_branches,
        version: template.version,
        nbits: template.nbits,
        ntime: template.ntime,
        clean_jobs: true,
        merkle_root_base,
        template_registered: true,
        sui_template_id: Some(template.template_id.clone()),
        mintime: 0,            // Relaxed validation in pooled mode
        curtime: template.ntime as u64,
        has_witness_commitment: false, // Unknown from on-chain data
        transaction_data: vec![],      // No block assembly capability in pooled mode
        needs_template_update: false,
        template_seq: 0,
    }
}

/// Pooled mode job updater: discovers templates on-chain and distributes to miners.
/// Polls every 5 seconds via TemplateSelector.
async fn pooled_job_updater(state: Arc<ServerState>) {
    let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(5));
    let mut current_template_id: Option<String> = None;
    let mut current_height: u64 = 0;

    // Wait for initial template cache refresh
    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

    loop {
        interval.tick().await;

        let selector = match state.template_selector.as_ref() {
            Some(s) => s,
            None => {
                warn!("pooled_job_updater: no template selector available");
                tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;
                continue;
            }
        };

        // Select best template using the default selection mode
        let template_id = match selector.select_template(&state.default_selection_mode).await {
            Some(id) => id,
            None => {
                // No templates available — try ByStake as fallback
                match selector.select_template(&TemplateSelectionMode::ByStake).await {
                    Some(id) => id,
                    None => {
                        info!("POOLED: No active templates on-chain, waiting...");
                        continue;
                    }
                }
            }
        };

        // Skip if same template as current
        if current_template_id.as_deref() == Some(&template_id) {
            continue;
        }

        // Fetch full template data
        let template_data = match selector.get_template_data(&template_id).await {
            Ok(data) => data,
            Err(e) => {
                warn!("POOLED: Failed to fetch template {}: {}", template_id, e);
                continue;
            }
        };

        // Detect height change (new Bitcoin block)
        let is_new_block = template_data.height != current_height;

        if is_new_block {
            info!("POOLED: New block height={}, template={}", template_data.height, template_id);
            // Update prev_block_hash tracking
            let mut prev_block_hash = [0u8; 32];
            if template_data.prev_block_hash.len() == 32 {
                prev_block_hash.copy_from_slice(&template_data.prev_block_hash);
            }
            *state.current_prev_hash.write().await = Some(prev_block_hash);

            // Clear duplicate share tracking
            for shard in &state.submitted_shares {
                shard.lock().await.clear();
            }
            current_height = template_data.height;
        } else {
            info!("POOLED: Template change at height={}, new template={}", template_data.height, template_id);
        }

        // Create a new job_id
        let job_id = {
            let mut counter = state.job_counter.write().await;
            *counter += 1;
            format!("{:08x}", *counter)
        };

        // Create MiningJob from on-chain template
        let mut job = create_mining_job_from_template_object(job_id.clone(), &template_data);
        job.clean_jobs = is_new_block;

        // Pre-populate template_ids — no registration needed, template already on-chain
        state.template_ids.write().await.insert(job_id.clone(), template_id.clone());

        // Wrap in Arc
        let job = Arc::new(job);

        // Add to jobs map with cleanup
        {
            let mut jobs = state.jobs.write().await;
            jobs.insert(job.job_id.clone(), job.clone());
            while jobs.len() > 10 {
                if let Some(oldest_key) = jobs.keys().min().cloned() {
                    jobs.remove(&oldest_key);
                } else {
                    break;
                }
            }
        }
        *state.current_job.write().await = Some(job.clone());
        current_template_id = Some(template_id);

        // Notify miners of new job
        notify_all_miners(&state, &job).await;
    }
}

/// Poll pool contract every 10s, update miner difficulties
async fn difficulty_sync_loop(state: Arc<ServerState>) {
    let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(10));

    loop {
        interval.tick().await;

        // Query pool state from Sui
        let pool_state = match state.sui.query_pool_state().await {
            Ok(ps) => ps,
            Err(e) => {
                warn!("Failed to query pool state: {}", e);
                continue;
            }
        };

        info!(
            "Pool state: global_min_diff={}, round={}, chain_height={}",
            pool_state.global_min_difficulty, pool_state.current_round, pool_state.chain_height
        );

        // Bidirectional sync: track on-chain min and adjust accordingly
        let pool_min = pool_state.global_min_difficulty;
        let mut last_min = state.last_pool_min_difficulty.write().await;
        let mut global_diff = state.global_difficulty.write().await;

        if pool_min != *last_min {
            if *global_diff < pool_min {
                // On-chain min increased — raise to match
                info!("Pool min increased: global_diff {} -> {}", *global_diff, pool_min);
                *global_diff = pool_min;
            } else if pool_min < *last_min {
                // On-chain min decreased — lower proportionally
                let new_diff = (*global_diff as u128 * pool_min as u128 / *last_min as u128) as u64;
                let new_diff = new_diff.max(state.initial_difficulty);
                info!("Pool min decreased: global_diff {} -> {}", *global_diff, new_diff);
                *global_diff = new_diff;
            }
            *last_min = pool_min;
            let diff_to_push = *global_diff;
            drop(global_diff);
            drop(last_min);
            set_difficulty_all_miners(&state, diff_to_push).await;
        } else {
            drop(global_diff);
            drop(last_min);
        }
    }
}

/// Global vardiff loop (P2Pool-style).
/// Monitors the global share rate across all miners and adjusts difficulty
/// so that the pool receives approximately `target_shares_per_min` shares per minute.
async fn global_vardiff_loop(state: Arc<ServerState>) {
    // Wait a bit before first adjustment to let shares accumulate
    tokio::time::sleep(tokio::time::Duration::from_secs(30)).await;

    let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(5));
    // Sliding window size: 120 seconds
    const WINDOW_SECS: f64 = 120.0;

    loop {
        interval.tick().await;

        let now = std::time::Instant::now();
        let target_rate = state.target_shares_per_min as f64 / 60.0; // shares per second

        // Prune old entries and count shares in window (Phase 1B: single lock)
        let (shares_in_window, drought_secs) = {
            let mut tracker = state.share_tracker.lock().await;
            // Remove entries older than WINDOW_SECS
            while let Some(front) = tracker.timestamps.front() {
                if now.duration_since(*front).as_secs_f64() > WINDOW_SECS {
                    tracker.timestamps.pop_front();
                } else {
                    break;
                }
            }
            let count = tracker.timestamps.len();
            let drought = now.duration_since(tracker.last_share_time).as_secs();
            (count, drought)
        };

        if shares_in_window < 4 {
            // Drought detection
            let has_miners = !state.miners.read().await.is_empty();

            if has_miners && drought_secs > 120 {
                let current_diff = *state.global_difficulty.read().await;
                let new_diff = (current_diff / 2).max(state.initial_difficulty);
                if new_diff < current_diff {
                    info!(
                        "Drought detected ({}s no shares): difficulty {} -> {}",
                        drought_secs, current_diff, new_diff
                    );
                    *state.global_difficulty.write().await = new_diff;
                    state.share_tracker.lock().await.last_share_time = now; // reset cooldown
                    set_difficulty_all_miners(&state, new_diff).await;
                }
            }
            continue;
        }

        let actual_rate = shares_in_window as f64 / WINDOW_SECS;
        let current_diff = *state.global_difficulty.read().await;

        let ratio = actual_rate / target_rate;

        let new_diff = if ratio < 0.67 || ratio > 1.5 {
            let clamped_ratio = ratio.clamp(0.5, 2.0);
            let adjusted = (current_diff as f64 * clamped_ratio) as u64;
            adjusted.clamp(state.initial_difficulty, u64::MAX)
        } else {
            current_diff // Inside dead zone, no change
        };

        if new_diff != current_diff {
            info!(
                "Global vardiff: {} -> {} (rate={:.2}/s, target={:.2}/s, window_shares={}, ratio={:.2})",
                current_diff, new_diff, actual_rate, target_rate, shares_in_window, ratio
            );
            *state.global_difficulty.write().await = new_diff;
            set_difficulty_all_miners(&state, new_diff).await;
        }
    }
}


/// Background task to refresh the template cache for decentralized mode.
async fn template_cache_refresher(state: Arc<ServerState>, interval_secs: u64) {
    let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(interval_secs));

    // Initial refresh
    if let Some(ref selector) = state.template_selector {
        if let Err(e) = selector.refresh_cache().await {
            warn!("Initial template cache refresh failed: {}", e);
        }
    }

    loop {
        interval.tick().await;

        if let Some(ref selector) = state.template_selector {
            match selector.refresh_cache().await {
                Ok(()) => {
                    let stats = selector.get_stats().await;
                    info!(
                        "Template cache: {} active/{} total templates, {} creators",
                        stats.active_templates, stats.total_templates, stats.unique_creators
                    );

                    let leaders = selector.get_leaders().await;
                    if let Some((id, stake)) = leaders.by_stake {
                        info!("  Stake leader: {}... ({})", &id[..16], stake);
                    }
                    if let Some((id, shares)) = leaders.by_shares {
                        info!("  Shares leader: {}... ({})", &id[..16], shares);
                    }
                }
                Err(e) => {
                    warn!("Template cache refresh failed: {}", e);
                }
            }
        }
    }
}

/// Push mining.set_difficulty to all connected miners.
/// Phase 2B: Two-phase — update fields under write lock, drop lock, send concurrently.
async fn set_difficulty_all_miners(state: &ServerState, new_floor: u64) {
    let safe_floor = if new_floor < 1 { 1 } else { new_floor };

    // Phase 1: Update difficulty fields and collect writer handles under write lock
    let send_list: Vec<(SocketAddr, Arc<Mutex<OwnedWriteHalf>>, Vec<u8>)> = {
        let mut miners = state.miners.write().await;
        let mut list = Vec::with_capacity(miners.len());
        for (addr, miner) in miners.iter_mut() {
            if miner.difficulty < safe_floor {
                miner.difficulty = safe_floor;
            }
            let miner_diff = miner.difficulty;
            let notify = StratumNotification {
                id: serde_json::Value::Null,
                method: "mining.set_difficulty".to_string(),
                params: vec![serde_json::json!(miner_diff as f64)],
            };
            if let Ok(json) = serde_json::to_string(&notify) {
                let mut buf = json.into_bytes();
                buf.push(b'\n');
                list.push((*addr, miner.writer.clone(), buf));
            }
        }
        list
    };
    // Write lock is dropped here

    // Phase 2: Send concurrently
    let miner_count = send_list.len();
    let mut join_set = JoinSet::new();
    for (addr, writer, buf) in send_list {
        join_set.spawn(async move {
            let mut w = writer.lock().await;
            if let Err(e) = w.write_all(&buf).await {
                error!("Failed to send set_difficulty to {}: {}", addr, e);
                return;
            }
            let _ = w.flush().await;
        });
    }
    while join_set.join_next().await.is_some() {}
    info!("Pushed difficulty floor {} to {} miner(s)", safe_floor, miner_count);
}

/// Create a new mining job from an already-fetched block template
async fn create_new_job_from_template(state: &ServerState, template: bitcoin_rpc::BlockTemplate) -> Result<MiningJob> {
    let mut job_id_counter = state.job_counter.write().await;
    *job_id_counter += 1;
    let job_id = format!("{:08x}", *job_id_counter);

    // Parse previous block hash
    let prev_hash_hex = &template.previousblockhash;
    let mut prev_block_hash = [0u8; 32];
    hex::decode_to_slice(prev_hash_hex, &mut prev_block_hash)?;
    prev_block_hash.reverse();

    // Create coinbase transaction
    let has_witness_commitment = template.default_witness_commitment
        .as_ref()
        .map_or(false, |s| !s.is_empty());
    let (coinbase1, coinbase2) = create_coinbase(&template, &state.pool_address_script)?;

    // Calculate merkle branches from transactions
    let merkle_branches = calculate_merkle_branches(&template)?;

    // Calculate base merkle root (with empty extranonce — 12 bytes: 4 en1 + 8 en2)
    let merkle_root_base = calculate_merkle_root(&coinbase1, &coinbase2, &[0u8; 12], &merkle_branches);

    // Collect raw transaction data for block assembly
    let transaction_data: Vec<String> = template.transactions.iter()
        .map(|tx| tx.data.clone())
        .collect();

    Ok(MiningJob {
        job_id,
        height: template.height,
        prev_block_hash,
        coinbase1,
        coinbase2,
        merkle_branches,
        version: template.version as u32,
        nbits: u32::from_str_radix(&template.bits, 16)?,
        ntime: template.curtime as u32,
        clean_jobs: true,
        merkle_root_base,
        template_registered: false,
        sui_template_id: None,
        mintime: template.mintime,
        curtime: template.curtime,
        has_witness_commitment,
        transaction_data,
        needs_template_update: false,
        template_seq: 0,
    })
}

/// Create coinbase transaction parts (C1: witness commitment, C2: pool address)
fn create_coinbase(
    template: &bitcoin_rpc::BlockTemplate,
    pool_address_script: &[u8],
) -> Result<(Vec<u8>, Vec<u8>)> {
    // BIP34: encode height as minimal-length little-endian integer
    let height_bytes = {
        let raw = template.height.to_le_bytes();
        let mut len = 8;
        while len > 1 && raw[len - 1] == 0 {
            len -= 1;
        }
        let mut bytes = raw[..len].to_vec();
        if bytes.last().map(|b| b & 0x80 != 0).unwrap_or(false) {
            bytes.push(0x00);
        }
        bytes
    };
    let height_len = height_bytes.len();

    // Determine payout script
    let payout_script = if pool_address_script.is_empty() {
        let mut script = Vec::with_capacity(25);
        script.extend_from_slice(&[0x76, 0xa9, 0x14]);
        script.extend_from_slice(&[0u8; 20]);
        script.extend_from_slice(&[0x88, 0xac]);
        script
    } else {
        pool_address_script.to_vec()
    };

    // Coinbase1: version + input_count + prevout + script_length + BIP34_height
    let mut coinbase1 = Vec::new();
    coinbase1.extend_from_slice(&1u32.to_le_bytes());
    coinbase1.push(1);
    coinbase1.extend_from_slice(&[0u8; 32]);
    coinbase1.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]);
    let script_len = 1 + height_len + 12;
    coinbase1.push(script_len as u8);
    coinbase1.push(height_len as u8);
    coinbase1.extend_from_slice(&height_bytes);

    // Coinbase2: sequence + outputs + locktime
    let mut coinbase2 = Vec::new();
    coinbase2.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]);

    let has_witness = template.default_witness_commitment
        .as_ref()
        .map_or(false, |s| !s.is_empty());
    let output_count: u8 = if has_witness { 2 } else { 1 };
    coinbase2.push(output_count);

    // Output 1: payout to pool address
    coinbase2.extend_from_slice(&template.coinbasevalue.to_le_bytes());
    encode_script_len(&mut coinbase2, payout_script.len());
    coinbase2.extend_from_slice(&payout_script);

    // Output 2: witness commitment
    if let Some(ref commitment_hex) = template.default_witness_commitment {
        if !commitment_hex.is_empty() {
            let commitment = hex::decode(commitment_hex)
                .context("Failed to decode default_witness_commitment hex")?;
            coinbase2.extend_from_slice(&0u64.to_le_bytes());
            encode_script_len(&mut coinbase2, commitment.len());
            coinbase2.extend_from_slice(&commitment);
        }
    }

    coinbase2.extend_from_slice(&[0u8; 4]);

    Ok((coinbase1, coinbase2))
}

/// Encode a script length as Bitcoin varint
fn encode_script_len(buf: &mut Vec<u8>, len: usize) {
    if len < 0xfd {
        buf.push(len as u8);
    } else if len <= 0xffff {
        buf.push(0xfd);
        buf.extend_from_slice(&(len as u16).to_le_bytes());
    } else {
        buf.push(0xfe);
        buf.extend_from_slice(&(len as u32).to_le_bytes());
    }
}

/// Calculate merkle branches from block template transactions.
fn calculate_merkle_branches(template: &bitcoin_rpc::BlockTemplate) -> Result<Vec<[u8; 32]>> {
    let mut branches = Vec::new();

    let mut hashes: Vec<[u8; 32]> = template
        .transactions
        .iter()
        .filter_map(|tx| {
            let mut hash = [0u8; 32];
            if hex::decode_to_slice(&tx.txid, &mut hash).is_ok() {
                hash.reverse();
                Some(hash)
            } else {
                None
            }
        })
        .collect();

    while !hashes.is_empty() {
        branches.push(hashes[0]);

        hashes = hashes[1..].to_vec();
        if hashes.is_empty() {
            break;
        }

        let mut new_hashes = Vec::new();
        for chunk in hashes.chunks(2) {
            let mut combined = Vec::with_capacity(64);
            combined.extend_from_slice(&chunk[0]);
            combined.extend_from_slice(if chunk.len() > 1 { &chunk[1] } else { &chunk[0] });
            let h1 = Sha256::digest(&combined);
            let hash: [u8; 32] = Sha256::digest(&h1).into();
            new_hashes.push(hash);
        }
        hashes = new_hashes;
    }

    Ok(branches)
}

/// Calculate merkle root given coinbase and branches
fn calculate_merkle_root(
    coinbase1: &[u8],
    coinbase2: &[u8],
    extranonce: &[u8],
    branches: &[[u8; 32]],
) -> [u8; 32] {
    let mut coinbase = Vec::new();
    coinbase.extend_from_slice(coinbase1);
    coinbase.extend_from_slice(extranonce);
    coinbase.extend_from_slice(coinbase2);

    let hash1 = Sha256::digest(&coinbase);
    let mut coinbase_hash: [u8; 32] = Sha256::digest(&hash1).into();

    for branch in branches {
        let mut hasher = Sha256::new();
        hasher.update(&coinbase_hash);
        hasher.update(branch);
        let first = hasher.finalize();
        coinbase_hash = Sha256::digest(&first).into();
    }

    coinbase_hash
}

/// Notify all connected miners of a new job, including per-miner difficulty.
/// Phase 2A: Two-phase — collect writer handles + pre-built buffers under read lock,
/// then drop lock and send concurrently via JoinSet.
async fn notify_all_miners(state: &ServerState, job: &MiningJob) {
    // Phase 1: Collect data under read lock
    let send_list: Vec<(SocketAddr, Arc<Mutex<OwnedWriteHalf>>, Vec<u8>)> = {
        let miners = state.miners.read().await;
        let miner_count = miners.len();

        if miner_count == 0 {
            info!("No miners connected to notify for job {}", job.job_id);
            return;
        }

        info!("Notifying {} miner(s) of new job {}", miner_count, job.job_id);

        let mut list = Vec::with_capacity(miner_count);
        for (addr, miner) in miners.iter() {
            // Pre-build the complete buffer: difficulty notification + job notification
            let mut buf = Vec::new();

            // Difficulty notification
            let safe_diff = if miner.difficulty < 1 { 1 } else { miner.difficulty };
            let diff_notify = StratumNotification {
                id: serde_json::Value::Null,
                method: "mining.set_difficulty".to_string(),
                params: vec![serde_json::json!(safe_diff as f64)],
            };
            if let Ok(diff_json) = serde_json::to_string(&diff_notify) {
                buf.extend_from_slice(diff_json.as_bytes());
                buf.push(b'\n');
            }

            // Job notification
            let notify = create_job_notification(job, &miner.extranonce1);
            if let Ok(notify_json) = serde_json::to_string(&notify) {
                buf.extend_from_slice(notify_json.as_bytes());
                buf.push(b'\n');
            }

            list.push((*addr, miner.writer.clone(), buf));
        }
        list
    };
    // Read lock dropped here

    // Phase 2: Send concurrently
    let mut join_set = JoinSet::new();
    for (addr, writer, buf) in send_list {
        join_set.spawn(async move {
            let mut w = writer.lock().await;
            if let Err(e) = w.write_all(&buf).await {
                error!("Failed to send notification to {}: {}", addr, e);
                return;
            }
            if let Err(e) = w.flush().await {
                error!("Failed to flush to {}: {}", addr, e);
            }
        });
    }
    while join_set.join_next().await.is_some() {}
}

/// Handle a single miner connection
async fn handle_miner(
    socket: TcpStream,
    addr: SocketAddr,
    state: Arc<ServerState>,
) -> Result<()> {
    let (reader, writer) = socket.into_split();
    let writer = Arc::new(Mutex::new(writer));
    let mut reader = BufReader::new(reader);
    let mut line = String::new();

    // Initialize miner state
    let extranonce1 = format!("{:08x}", rand::random::<u32>());
    {
        let initial_diff = *state.global_difficulty.read().await;
        let mut miners = state.miners.write().await;
        miners.insert(addr, MinerState {
            worker_name: String::new(),
            sui_address: None,
            shares_submitted: 0,
            extranonce1: extranonce1.clone(),
            writer: writer.clone(),
            difficulty: initial_diff,
            share_timestamps: VecDeque::new(),
            estimated_hashrate: 0.0,
            last_share_time: None,
            selection_mode: state.default_selection_mode.clone(),
            current_template_id: None,
        });
    }

    let idle_timeout = tokio::time::Duration::from_secs(state.idle_timeout);

    loop {
        line.clear();
        let read_result = tokio::time::timeout(idle_timeout, reader.read_line(&mut line)).await;
        let bytes_read = match read_result {
            Ok(Ok(n)) => n,
            Ok(Err(e)) => return Err(e.into()),
            Err(_) => {
                warn!("Miner {} timed out (no data for {}s)", addr, state.idle_timeout);
                break;
            }
        };
        if bytes_read == 0 {
            break;
        }

        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        // Parse JSON-RPC request
        let request: StratumRequest = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(e) => {
                warn!("Invalid JSON from {}: {}", addr, e);
                continue;
            }
        };

        // Handle request
        let (response, new_difficulty) = handle_stratum_request(&request, &state, addr, &extranonce1).await;

        // Phase 1D: Pre-build complete response buffer before locking writer
        {
            let mut buf = Vec::new();
            let response_json = serde_json::to_string(&response)?;
            buf.extend_from_slice(response_json.as_bytes());
            buf.push(b'\n');

            if let Some(new_diff) = new_difficulty {
                let safe_diff = if new_diff < 1 { 1 } else { new_diff };
                let diff_notify = StratumNotification {
                    id: serde_json::Value::Null,
                    method: "mining.set_difficulty".to_string(),
                    params: vec![serde_json::json!(safe_diff as f64)],
                };
                let diff_json = serde_json::to_string(&diff_notify)?;
                buf.extend_from_slice(diff_json.as_bytes());
                buf.push(b'\n');
            }

            let mut w = writer.lock().await;
            w.write_all(&buf).await?;
            w.flush().await?;
        }

        // If this was a subscribe, also send difficulty and first job
        if request.method == "mining.subscribe" {
            let mut buf = Vec::new();

            let current_diff = {
                let miners = state.miners.read().await;
                miners.get(&addr).map(|m| m.difficulty).unwrap_or(*state.global_difficulty.read().await)
            };
            let safe_diff = if current_diff < 1 { 1 } else { current_diff };
            let diff_notify = StratumNotification {
                id: serde_json::Value::Null,
                method: "mining.set_difficulty".to_string(),
                params: vec![serde_json::json!(safe_diff as f64)],
            };
            let diff_json = serde_json::to_string(&diff_notify)?;
            buf.extend_from_slice(diff_json.as_bytes());
            buf.push(b'\n');

            if let Some(job) = state.current_job.read().await.as_ref() {
                let notify = create_job_notification(job, &extranonce1);
                let notify_json = serde_json::to_string(&notify)?;
                buf.extend_from_slice(notify_json.as_bytes());
                buf.push(b'\n');
            }

            let mut w = writer.lock().await;
            w.write_all(&buf).await?;
            w.flush().await?;
        }

        // M2: If this was mining.configure, send mining.set_version_mask notification
        if request.method == "mining.configure" {
            let mask_notify = StratumNotification {
                id: serde_json::Value::Null,
                method: "mining.set_version_mask".to_string(),
                params: vec![serde_json::json!(format!("{:08x}", VERSION_ROLLING_MASK))],
            };
            let mask_json = serde_json::to_string(&mask_notify)?;
            let mut buf = mask_json.into_bytes();
            buf.push(b'\n');

            let mut w = writer.lock().await;
            w.write_all(&buf).await?;
            w.flush().await?;
        }

        // If this was mining.authorize and miner has Sui address, send mining.set_extranonce
        if request.method == "mining.authorize" {
            let miner_info = {
                let miners = state.miners.read().await;
                miners.get(&addr).map(|m| (m.sui_address.clone(), m.extranonce1.clone()))
            };
            if let Some((Some(_sol_addr), new_extranonce1)) = miner_info {
                let mut buf = Vec::new();

                let set_extranonce = StratumNotification {
                    id: serde_json::Value::Null,
                    method: "mining.set_extranonce".to_string(),
                    params: vec![serde_json::json!(new_extranonce1), serde_json::json!(8)],
                };
                let json = serde_json::to_string(&set_extranonce)?;
                buf.extend_from_slice(json.as_bytes());
                buf.push(b'\n');
                info!("Sent mining.set_extranonce: {} (derived from Sui address)", new_extranonce1);

                if let Some(job) = state.current_job.read().await.as_ref() {
                    let notify = create_job_notification(job, &new_extranonce1);
                    let notify_json = serde_json::to_string(&notify)?;
                    buf.extend_from_slice(notify_json.as_bytes());
                    buf.push(b'\n');
                }

                let mut w = writer.lock().await;
                w.write_all(&buf).await?;
                w.flush().await?;
            }
        }
    }

    // Clean up miner state
    {
        let mut miners = state.miners.write().await;
        miners.remove(&addr);
    }

    // Clean up miner preferences (decentralized mode)
    if state.decentralized_mode {
        state.miner_preferences.write().await.remove(&addr);
    }

    Ok(())
}

/// Handle a Stratum request
/// Returns (response, optional_new_difficulty)
async fn handle_stratum_request(
    request: &StratumRequest,
    state: &ServerState,
    addr: SocketAddr,
    extranonce1: &str,
) -> (StratumResponse, Option<u64>) {
    match request.method.as_str() {
        "mining.subscribe" => {
            info!("Miner {} subscribed", addr);
            (StratumResponse {
                id: request.id.clone(),
                result: Some(serde_json::json!([
                    [["mining.notify", "subscription_id"], ["mining.set_difficulty", "subscription_id"]],
                    extranonce1,
                    8  // extranonce2 size
                ])),
                error: None,
            }, None)
        }

        "mining.authorize" => {
            let (username, _password) = parse_authorize_params(&request.params);
            info!("Miner {} authorized as {}", addr, username);

            // Parse Sui address from username (before the "."). Accepts:
            //   - 0x-prefixed 66-char hex Sui address
            let addr_part = username.split('.').next().unwrap_or("").to_string();
            let sui_address = if addr_part.starts_with("0x") && addr_part.len() == 66 {
                Some(addr_part.clone())
            } else {
                None
            };

            if let Some(ref addr_str) = sui_address {
                info!("Miner Sui address: {}", addr_str);
                let derived_en1 = derive_extranonce1_from_sui_address(addr_str);
                info!("Derived extranonce1: {} (from Sui address)", derived_en1);
            } else {
                warn!("No valid Sui address in username, shares won't be submitted on-chain");
            }

            // Parse template selection mode
            let selection_mode = if state.decentralized_mode {
                let mode = TemplateSelectionMode::parse_from_worker_name(&username);
                if mode != TemplateSelectionMode::Default {
                    info!("Miner {} selection mode: {}", addr, mode.description());
                } else {
                    info!("Miner {} using default selection: {}", addr, state.default_selection_mode.description());
                }
                if mode == TemplateSelectionMode::Default {
                    state.default_selection_mode.clone()
                } else {
                    mode
                }
            } else {
                TemplateSelectionMode::Default
            };

            // Update miner state
            {
                let mut miners = state.miners.write().await;
                if let Some(miner) = miners.get_mut(&addr) {
                    miner.worker_name = username.clone();
                    if let Some(ref addr_str) = sui_address {
                        miner.extranonce1 = derive_extranonce1_from_sui_address(addr_str);
                    }
                    miner.sui_address = sui_address;
                    miner.selection_mode = selection_mode.clone();
                }
            }

            if state.decentralized_mode {
                state.miner_preferences.write().await.insert(addr, selection_mode);
            }

            (StratumResponse {
                id: request.id.clone(),
                result: Some(serde_json::json!(true)),
                error: None,
            }, None)
        }

        "mining.submit" => {
            let share = parse_submit_params(&request.params);
            info!(
                "Share from {}: job={}, en2={}, nonce={}, ntime={}, version_bits={:?}",
                addr, share.job_id, share.extranonce2, share.nonce, share.ntime, share.version_bits
            );

            match validate_and_submit_share(state, addr, &share).await {
                Ok((true, new_diff)) => {
                    info!("Share accepted from {}", addr);
                    (StratumResponse {
                        id: request.id.clone(),
                        result: Some(serde_json::json!(true)),
                        error: None,
                    }, new_diff)
                }
                Ok((false, _)) => {
                    warn!("Share rejected from {}: below difficulty", addr);
                    (StratumResponse {
                        id: request.id.clone(),
                        result: None,
                        error: Some(serde_json::json!([23, "Low difficulty share"])),
                    }, None)
                }
                Err(e) => {
                    error!("Share error from {}: {}", addr, e);
                    (StratumResponse {
                        id: request.id.clone(),
                        result: None,
                        error: Some(serde_json::json!([20, e.to_string()])),
                    }, None)
                }
            }
        }

        "mining.configure" => {
            info!("Miner {} requested mining.configure", addr);
            (StratumResponse {
                id: request.id.clone(),
                result: Some(serde_json::json!({
                    "version-rolling": true,
                    "version-rolling.mask": format!("{:08x}", VERSION_ROLLING_MASK)
                })),
                error: None,
            }, None)
        }

        "mining.suggest_difficulty" => {
            info!("Miner {} suggested difficulty (ignored, using vardiff)", addr);
            (StratumResponse {
                id: request.id.clone(),
                result: Some(serde_json::json!(true)),
                error: None,
            }, None)
        }

        "mining.extranonce.subscribe" => {
            (StratumResponse {
                id: request.id.clone(),
                result: Some(serde_json::json!(true)),
                error: None,
            }, None)
        }

        _ => {
            warn!("Unknown method from {}: {}", addr, request.method);
            (StratumResponse {
                id: request.id.clone(),
                result: None,
                error: Some(serde_json::json!([20, "Unknown method"])),
            }, None)
        }
    }
}

/// Parse authorize parameters
fn parse_authorize_params(params: &[serde_json::Value]) -> (String, String) {
    let username = params.first()
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let password = params.get(1)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    (username, password)
}

/// Version rolling mask (bits 13-28, standard BIP320)
const VERSION_ROLLING_MASK: u32 = 0x1fffe000;

/// Parsed share submission
struct ShareSubmission {
    worker: String,
    job_id: String,
    extranonce2: String,
    ntime: String,
    nonce: String,
    version_bits: Option<u32>,
}

/// Parse submit parameters
fn parse_submit_params(params: &[serde_json::Value]) -> ShareSubmission {
    let version_bits = params.get(5)
        .and_then(|v| v.as_str())
        .and_then(|s| u32::from_str_radix(s, 16).ok());

    ShareSubmission {
        worker: params.first().and_then(|v| v.as_str()).unwrap_or("").to_string(),
        job_id: params.get(1).and_then(|v| v.as_str()).unwrap_or("").to_string(),
        extranonce2: params.get(2).and_then(|v| v.as_str()).unwrap_or("").to_string(),
        ntime: params.get(3).and_then(|v| v.as_str()).unwrap_or("").to_string(),
        nonce: params.get(4).and_then(|v| v.as_str()).unwrap_or("").to_string(),
        version_bits,
    }
}

/// Validate share parameters
fn validate_share_params(share: &ShareSubmission) -> Result<()> {
    if share.job_id.is_empty() {
        anyhow::bail!("Empty job_id");
    }
    if share.extranonce2.is_empty() {
        anyhow::bail!("Empty extranonce2");
    }
    if share.ntime.is_empty() {
        anyhow::bail!("Empty ntime");
    }
    if share.nonce.is_empty() {
        anyhow::bail!("Empty nonce");
    }
    let en2_bytes = hex::decode(&share.extranonce2)
        .map_err(|_| anyhow::anyhow!("Invalid extranonce2 hex"))?;
    if en2_bytes.len() != 8 {
        anyhow::bail!("extranonce2 must be 8 bytes, got {}", en2_bytes.len());
    }
    if u32::from_str_radix(&share.ntime, 16).is_err() {
        anyhow::bail!("Invalid ntime hex");
    }
    if u32::from_str_radix(&share.nonce, 16).is_err() {
        anyhow::bail!("Invalid nonce hex");
    }
    Ok(())
}


/// Validate share and submit to Sui if valid
/// Returns Ok((accepted, new_difficulty_if_changed))
async fn validate_and_submit_share(
    state: &ServerState,
    addr: SocketAddr,
    share: &ShareSubmission,
) -> Result<(bool, Option<u64>)> {
    validate_share_params(share)?;

    // Look up the job (Phase 4A: Arc clone is ~1ns)
    let job = {
        let jobs = state.jobs.read().await;
        jobs.get(&share.job_id)
            .context(format!("Unknown job ID: {}", share.job_id))?
            .clone()
    };

    // Get miner state
    let (miner_extranonce1, current_difficulty) = {
        let miners = state.miners.read().await;
        let miner = miners.get(&addr).context("Unknown miner")?;
        (miner.extranonce1.clone(), miner.difficulty)
    };

    // H3: Validate ntime bounds
    let ntime = u32::from_str_radix(&share.ntime, 16)?;
    if (ntime as u64) < job.mintime {
        anyhow::bail!("time-too-old: ntime {} < mintime {}", ntime, job.mintime);
    }
    if (ntime as u64) > job.curtime + 7200 {
        anyhow::bail!("time-too-new: ntime {} > curtime+7200 {}", ntime, job.curtime + 7200);
    }

    // M3: Validate version rolling mask
    if let Some(vbits) = share.version_bits {
        if (vbits & !VERSION_ROLLING_MASK) != 0 {
            anyhow::bail!("bad-version: version bits {:08x} outside allowed mask {:08x}", vbits, VERSION_ROLLING_MASK);
        }
    }

    // Phase 1A: Sharded duplicate share detection — lock only one shard
    let share_key = format!("{}:{}:{}:{}:{:?}:{}",
        share.job_id, miner_extranonce1, share.extranonce2,
        share.ntime, share.version_bits, share.nonce);
    {
        let idx = shard_index(&share_key);
        let mut shard = state.submitted_shares[idx].lock().await;
        // Phase 4B: Bound check
        if shard.len() >= MAX_PER_SHARD {
            warn!("Share shard {} at capacity ({}), duplicate detection may miss", idx, MAX_PER_SHARD);
        }
        if !shard.insert(share_key) {
            anyhow::bail!("duplicate: share already submitted");
        }
    }

    // Build extranonce
    let extranonce1 = hex::decode(&miner_extranonce1)?;
    let extranonce2 = hex::decode(&share.extranonce2)?;
    let mut extranonce = Vec::new();
    extranonce.extend_from_slice(&extranonce1);
    extranonce.extend_from_slice(&extranonce2);

    // Calculate merkle root
    let merkle_root = calculate_merkle_root(
        &job.coinbase1,
        &job.coinbase2,
        &extranonce,
        &job.merkle_branches,
    );

    // Build block header
    let nonce = u32::from_str_radix(&share.nonce, 16)?;
    let actual_version = if let Some(vbits) = share.version_bits {
        (job.version & !VERSION_ROLLING_MASK) | (vbits & VERSION_ROLLING_MASK)
    } else {
        job.version
    };

    let mut header = [0u8; 80];
    header[0..4].copy_from_slice(&actual_version.to_le_bytes());
    header[4..36].copy_from_slice(&job.prev_block_hash);
    header[36..68].copy_from_slice(&merkle_root);
    header[68..72].copy_from_slice(&ntime.to_le_bytes());
    header[72..76].copy_from_slice(&job.nbits.to_le_bytes());
    header[76..80].copy_from_slice(&nonce.to_le_bytes());

    info!(
        "Header(80B): {} | version={:08x} ntime={:08x} nbits={:08x} nonce={:08x}",
        hex::encode(&header), actual_version, ntime, job.nbits, nonce
    );

    // Double SHA256
    let hash1 = Sha256::digest(&header);
    let share_hash: [u8; 32] = Sha256::digest(&hash1).into();

    let mut display_bytes = share_hash;
    display_bytes.reverse();
    let display_hash = hex::encode(&display_bytes);

    // H4: Block-found detection
    let block_target = target_from_nbits(job.nbits);
    if hash_le_target(&share_hash, &block_target) {
        info!("!!! BLOCK FOUND !!! hash={} height={}", display_hash, job.height);
        if let Some(ref bitcoin) = state.bitcoin {
            match assemble_block(&header, &job.coinbase1, &extranonce, &job.coinbase2,
                                 job.has_witness_commitment, &job.transaction_data) {
                Ok(block_hex) => {
                    info!("Submitting block ({} bytes hex) to Bitcoin network...", block_hex.len());
                    match bitcoin.submit_block(&block_hex).await {
                        Ok(()) => info!("BLOCK ACCEPTED by Bitcoin node! height={}", job.height),
                        Err(e) => error!("submitblock FAILED: {} — block may still propagate via Sui", e),
                    }
                }
                Err(e) => error!("Failed to assemble block: {}", e),
            }
        } else {
            warn!("BLOCK FOUND in pooled mode — no Bitcoin node to submit to. On-chain contract will detect via share validation.");
        }
    }

    // Check share difficulty
    let difficulty = calculate_difficulty_from_hash(&share_hash);
    info!("Share hash: {}, difficulty: {}, target: {}, version: {:08x}",
        display_hash, difficulty, current_difficulty, actual_version);

    if difficulty < current_difficulty {
        state.shares_rejected_total.fetch_add(1, Ordering::Relaxed);
        return Ok((false, None));
    }
    state.shares_accepted_total.fetch_add(1, Ordering::Relaxed);

    // Queue share for Sui submission (solo mode only; pool mode uses sidecar)
    if let Some(ref tx) = state.miner_tx {
        match job.sui_template_id.as_deref() {
            Some(tpda) => {
                let _ = tx.send(BatchMsg::Share {
                    template_pda: tpda.to_string(),
                    share: MinerShare { extranonce2: extranonce2.clone(), ntime, nonce, version: actual_version },
                });
            }
            None => warn!("Share accepted but template not yet registered — Sui submission skipped"),
        }
    }

    // Accept share — update tracking
    {
        let now = std::time::Instant::now();

        // Phase 1B: Single lock for timestamps + last_share_time
        {
            let mut tracker = state.share_tracker.lock().await;
            tracker.timestamps.push_back(now);
            tracker.last_share_time = now;
        }

        // Phase 1C: Pre-read global_difficulty before acquiring miners.write()
        let global_floor = *state.global_difficulty.read().await;

        // Update per-miner state: hashrate estimate + vardiff
        let new_diff = {
            let mut miners = state.miners.write().await;
            if let Some(miner) = miners.get_mut(&addr) {
                miner.shares_submitted += 1;
                miner.share_timestamps.push_back(now);

                // Update hashrate EMA
                if let Some(last) = miner.last_share_time {
                    let interval = now.duration_since(last).as_secs_f64();
                    if interval > 0.0 {
                        let instantaneous = (miner.difficulty as f64) * 4_294_967_296.0 / interval;
                        if miner.estimated_hashrate > 0.0 {
                            miner.estimated_hashrate = miner.estimated_hashrate * 0.8 + instantaneous * 0.2;
                        } else {
                            miner.estimated_hashrate = instantaneous;
                        }
                    }
                }
                miner.last_share_time = Some(now);

                // Per-miner vardiff is disabled: it over-estimates hashrate
                // from rapid-burst acceptance, pushing the per-miner target
                // out of reach of small ASIC hardware (Avalon Nano etc.).
                // Global vardiff (in `global_vardiff_loop`) still adjusts
                // the pool-wide floor, which all miners then track.
                if miner.difficulty != global_floor {
                    miner.difficulty = global_floor;
                    Some(global_floor)
                } else {
                    None
                }
            } else {
                None
            }
        };
        Ok((true, new_diff))
    }
}

/// Calculate standard Bitcoin difficulty from a share hash.
fn calculate_difficulty_from_hash(hash: &[u8; 32]) -> u64 {
    let mut msb_pos: i32 = 31;
    while msb_pos >= 0 && hash[msb_pos as usize] == 0 {
        msb_pos -= 1;
    }

    if msb_pos < 0 {
        return u64::MAX;
    }

    let mut hash_val: u64 = 0;
    let bytes_to_read = 8.min((msb_pos + 1) as usize);
    for i in 0..bytes_to_read {
        hash_val = (hash_val << 8) | (hash[msb_pos as usize - i] as u64);
    }

    if hash_val == 0 {
        return u64::MAX;
    }

    let lsb_pos = msb_pos as i32 - bytes_to_read as i32 + 1;
    let exp = 208 - 8 * lsb_pos;

    if exp >= 0 && exp < 112 {
        let numerator = 0xFFFF_u128 * (1u128 << exp as u32);
        let result = numerator / hash_val as u128;
        if result > u64::MAX as u128 { u64::MAX } else { result as u64 }
    } else if exp >= 112 {
        u64::MAX
    } else {
        let denominator = hash_val as u128 * (1u128 << (-exp) as u32);
        (0xFFFF_u128 / denominator) as u64
    }
}

/// Create a mining.notify notification for a job.
/// Includes sui_template_id as param[9] so miner sidecars can submit
/// shares directly to Sui without routing through the pool operator.
/// Standard mining clients (cgminer, BFGMiner) ignore the extra param.
fn create_job_notification(job: &MiningJob, _extranonce1: &str) -> StratumNotification {
    let mut prev_hash_stratum = job.prev_block_hash;
    for chunk in prev_hash_stratum.chunks_mut(4) {
        chunk.reverse();
    }

    let merkle_branches_hex: Vec<String> = job
        .merkle_branches
        .iter()
        .map(|b| hex::encode(b))
        .collect();

    let template_pda = job.sui_template_id
        .as_deref()
        .unwrap_or("")
        .to_string();

    StratumNotification {
        id: serde_json::Value::Null,
        method: "mining.notify".to_string(),
        params: vec![
            serde_json::json!(job.job_id),
            serde_json::json!(hex::encode(&prev_hash_stratum)),
            serde_json::json!(hex::encode(&job.coinbase1)),
            serde_json::json!(hex::encode(&job.coinbase2)),
            serde_json::json!(merkle_branches_hex),
            serde_json::json!(format!("{:08x}", job.version)),
            serde_json::json!(format!("{:08x}", job.nbits)),
            serde_json::json!(format!("{:08x}", job.ntime)),
            serde_json::json!(job.clean_jobs),
            serde_json::json!(template_pda),  // [9] for miner sidecar
        ],
    }
}

/// Convert compact target (nbits) to full 32-byte target in LE format.
fn target_from_nbits(nbits: u32) -> [u8; 32] {
    let mut target = [0u8; 32];
    let exponent = ((nbits >> 24) & 0xff) as usize;
    let mantissa = nbits & 0x007fffff;

    if exponent == 0 || mantissa == 0 {
        return target;
    }

    if exponent >= 3 {
        let pos = exponent - 3;
        if pos < 32 { target[pos] = (mantissa & 0xff) as u8; }
        if pos + 1 < 32 { target[pos + 1] = ((mantissa >> 8) & 0xff) as u8; }
        if pos + 2 < 32 { target[pos + 2] = ((mantissa >> 16) & 0xff) as u8; }
    } else if exponent == 2 {
        target[0] = ((mantissa >> 8) & 0xff) as u8;
        target[1] = ((mantissa >> 16) & 0xff) as u8;
    } else if exponent == 1 {
        target[0] = ((mantissa >> 16) & 0xff) as u8;
    }

    target
}

/// Compare a hash (LE format) against a target (LE format).
fn hash_le_target(hash: &[u8; 32], target: &[u8; 32]) -> bool {
    for i in (0..32).rev() {
        if hash[i] < target[i] { return true; }
        if hash[i] > target[i] { return false; }
    }
    true
}

/// Assemble a full block for submitblock RPC.
fn assemble_block(
    header: &[u8; 80],
    coinbase1: &[u8],
    extranonce: &[u8],
    coinbase2: &[u8],
    has_witness: bool,
    transaction_data: &[String],
) -> Result<String> {
    let mut block = Vec::new();

    block.extend_from_slice(header);

    let txn_count = 1 + transaction_data.len();
    encode_varint(&mut block, txn_count as u64);

    let mut coinbase_raw = Vec::new();
    coinbase_raw.extend_from_slice(coinbase1);
    coinbase_raw.extend_from_slice(extranonce);
    coinbase_raw.extend_from_slice(coinbase2);

    if has_witness {
        let version = &coinbase_raw[..4];
        let vin_vout = &coinbase_raw[4..coinbase_raw.len() - 4];
        let locktime = &coinbase_raw[coinbase_raw.len() - 4..];

        block.extend_from_slice(version);
        block.push(0x00);
        block.push(0x01);
        block.extend_from_slice(vin_vout);
        block.push(0x01);
        block.push(0x20);
        block.extend_from_slice(&[0u8; 32]);
        block.extend_from_slice(locktime);
    } else {
        block.extend_from_slice(&coinbase_raw);
    }

    for tx_hex in transaction_data {
        let tx_bytes = hex::decode(tx_hex)
            .context("Failed to decode transaction hex")?;
        block.extend_from_slice(&tx_bytes);
    }

    Ok(hex::encode(&block))
}

/// Encode a value as Bitcoin compact varint
fn encode_varint(buf: &mut Vec<u8>, val: u64) {
    if val < 0xfd {
        buf.push(val as u8);
    } else if val <= 0xffff {
        buf.push(0xfd);
        buf.extend_from_slice(&(val as u16).to_le_bytes());
    } else if val <= 0xffffffff {
        buf.push(0xfe);
        buf.extend_from_slice(&(val as u32).to_le_bytes());
    } else {
        buf.push(0xff);
        buf.extend_from_slice(&val.to_le_bytes());
    }
}

/// Derive extranonce1 from a Sui address (0x-prefixed 64-char hex).
/// Uses the first 4 bytes (8 hex chars after the 0x prefix).
fn derive_extranonce1_from_sui_address(sui_address: &str) -> String {
    if sui_address.len() >= 10 && sui_address.starts_with("0x") {
        return sui_address[2..10].to_lowercase();
    }
    format!("{:08x}", rand::random::<u32>())
}

// ─── Metrics HTTP server ──────────────────────────────────────────────────────

async fn metrics_http_server(state: Arc<ServerState>, port: u16) -> anyhow::Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    let listener = TcpListener::bind(format!("0.0.0.0:{}", port)).await?;
    info!("Metrics HTTP listening on :{}", port);
    loop {
        let (mut stream, _) = listener.accept().await?;
        let state = state.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 256];
            let n = stream.read(&mut buf).await.unwrap_or(0);
            if n == 0 { return; }
            let req = std::str::from_utf8(&buf[..n]).unwrap_or("");
            let path = req.split_whitespace().nth(1).unwrap_or("/");

            let body = match path {
                "/health" => build_stratum_health(&state).await,
                "/metrics" => build_stratum_metrics(&state).await,
                _ => r#"{"error":"not found"}"#.to_string(),
            };
            let status = if path == "/health" || path == "/metrics" { "200 OK" } else { "404 Not Found" };
            let resp = format!(
                "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                status, body.len(), body
            );
            let _ = stream.write_all(resp.as_bytes()).await;
        });
    }
}

async fn build_stratum_health(state: &ServerState) -> String {
    let miners = state.miners.read().await.len();
    let last_tpl_secs = state.last_template_at.read().await
        .map(|t| t.elapsed().as_secs())
        .unwrap_or(u64::MAX);
    let status = if last_tpl_secs < 120 { "ok" } else { "stale" };
    format!(
        r#"{{"status":"{}","miners_connected":{},"last_template_secs_ago":{}}}"#,
        status, miners, last_tpl_secs
    )
}

async fn build_stratum_metrics(state: &ServerState) -> String {
    let miners = state.miners.read().await;
    let miner_count = miners.len();
    let pool_hashrate: f64 = miners.values().map(|m| m.estimated_hashrate).sum();
    drop(miners);

    let global_diff = *state.global_difficulty.read().await;
    let accepted = state.shares_accepted_total.load(Ordering::Relaxed);
    let rejected = state.shares_rejected_total.load(Ordering::Relaxed);
    let last_tpl_secs = state.last_template_at.read().await
        .map(|t| t.elapsed().as_secs())
        .unwrap_or(u64::MAX);
    let uptime = state.start_time.elapsed().as_secs();

    format!(
        r#"{{"miners_connected":{},"global_difficulty":{},"shares_accepted_total":{},"shares_rejected_total":{},"estimated_pool_hashrate_ths":{:.4},"last_template_secs_ago":{},"uptime_secs":{}}}"#,
        miner_count, global_diff, accepted, rejected,
        pool_hashrate / 1e12,
        last_tpl_secs, uptime
    )
}
