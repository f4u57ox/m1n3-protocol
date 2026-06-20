//! m1n3 trustless keeper bot.
//!
//! Subscribes to three on-chain events emitted by the m1n3 package:
//!
//!   1. `pool::BlockFound` — emitted by `pool::submit_share` when an accepted
//!      share's SHA-256d header hash meets the network difficulty. Carries
//!      `claim_id`, the address of the frozen `BlockFoundClaim` proof object.
//!      The keeper submits `pool::open_round_accumulator_from_claim(pool,
//!      claim, clock)` — no PoolAdminCap, no caller discretion.
//!
//!   2. `hashi_pool::HashibDepositConfirmed` (or whatever the integration
//!      layer signals) — once the Hashi committee has CONFIRMED the deposit
//!      for a closed round, the keeper submits
//!      `hashi_rewards::open_and_fund_round_batch(registry, vault,
//!      round_history, deposit_record, clock)`. Funds flow from vault → batch;
//!      miners then call `claim_reward<BTC>` to redeem their share.
//!
//!   3. `hash_share_registry::SlotBoundToRound` — emitted the first time a
//!      miner mints `Coin<HS_NNN>` for a new round. The keeper creates a
//!      DeepBookV3 permissionless `Pool<HS_NNN, QuoteCoin>` so secondary
//!      market trading can start immediately. Defaults to dry-run if any
//!      DeepBook flag is missing — the on-chain HashShare mint still works
//!      without this loop, miners just have no DeepBook venue.
//!
//! The keeper holds no privileged keys. The only thing it needs is gas in a
//! signer to land the PTBs. Anyone — a miner, a watcher, a public dashboard
//! — can run their own copy. As long as at least one keeper is online, the
//! pipeline keeps running.
//!
//! Run:
//!   cargo run --release -p trustless-keeper -- \
//!     --rpc-url https://fullnode.devnet.sui.io:443 \
//!     --package-id 0x… --pool-id 0x… --registry-id 0x… --vault-id 0x… \
//!     --hashi-pool-config 0x…
//!
//! The signing identity comes from your `sui client` active address /
//! keystore — the keeper shells out to `sui client ptb` to keep secrets
//! out of the binary. Drop in a sui-sdk signer later if desired.

use anyhow::{anyhow, bail, Context, Result};
use clap::Parser;
use serde::Deserialize;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tracing::{info, warn};

#[derive(Parser, Debug, Clone)]
#[command(name = "trustless-keeper", about = "m1n3 permissionless round-close + reward-fund keeper")]
struct Args {
    /// Sui JSON-RPC fullnode URL.
    #[arg(long, default_value = "https://fullnode.devnet.sui.io:443")]
    rpc_url: String,

    /// m1n3 published package ID.
    #[arg(long)]
    package_id: String,

    /// Pool shared object ID (mutated by open_round_accumulator_from_claim).
    #[arg(long)]
    pool_id: String,

    /// HashiRewardRegistry shared object ID.
    #[arg(long)]
    registry_id: String,

    /// HashiVault<BTC> shared object ID. MUST be the shared variant
    /// (created via `hashi_vault::create_shared`) so we can pass &mut.
    #[arg(long)]
    vault_id: String,

    /// hBTC / BTC coin type used by the vault and reward batches.
    #[arg(long)]
    hbtc_coin_type: String,

    /// HashiPoolConfig shared object — used to look up BlockDepositRecord IDs by round.
    #[arg(long)]
    hashi_pool_config: String,

    /// HashShareRegistry shared object ID. If set, the keeper auto-calls
    /// `bind_slot_to_round(registry, current_round)` whenever the active
    /// round has no binding yet (the bootstrap step). Optional — leave
    /// unset to disable.
    #[arg(long)]
    hash_share_registry_id: Option<String>,

    /// Polling interval in seconds.
    #[arg(long, default_value_t = 15)]
    poll_seconds: u64,

    /// Gas budget for each submitted PTB.
    #[arg(long, default_value_t = 200_000_000)]
    gas_budget: u64,

    /// Dry-run: print what would be sent, don't sign or submit.
    #[arg(long)]
    dry_run: bool,

    // ── DeepBook integration (optional) ─────────────────────────────────────
    //
    // All four DeepBook flags must be set for the SlotBoundToRound tick to
    // submit pool-creation PTBs. Otherwise it logs dry-run text and exits
    // the loop body — the rest of the keeper keeps running.

    /// DeepBookV3 package ID. Mainnet / testnet / devnet each have their own.
    #[arg(long)]
    deepbook_package_id: Option<String>,

    /// DeepBookV3 `Registry` shared object ID.
    #[arg(long)]
    deepbook_registry_id: Option<String>,

    /// Quote-coin type for the HashShare DeepBook pair (e.g. USDC). Format:
    /// `0x<pkg>::<module>::<TYPE>`.
    #[arg(long)]
    deepbook_quote_coin_type: Option<String>,

    /// Object ID of a DEEP coin to pay the permissionless creation fee.
    /// The keeper's signer must own this coin.
    #[arg(long)]
    deepbook_deep_coin_id: Option<String>,

    /// DeepBookV3 tick size for the HashShare pair.
    #[arg(long, default_value_t = 1)]
    deepbook_tick_size: u64,

    /// DeepBookV3 lot size for the HashShare pair (smallest tradeable qty).
    #[arg(long, default_value_t = 1)]
    deepbook_lot_size: u64,

    /// DeepBookV3 minimum order size for the HashShare pair.
    #[arg(long, default_value_t = 1)]
    deepbook_min_size: u64,
}

#[derive(Debug, Deserialize)]
struct RpcResponse<T> {
    result: Option<T>,
    error: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct EventPage {
    data: Vec<SuiEvent>,
}

#[derive(Debug, Deserialize)]
struct SuiEvent {
    #[serde(rename = "type")]
    #[allow(dead_code)]
    ty: String,
    #[serde(rename = "parsedJson")]
    parsed: serde_json::Value,
    /// Event envelope contains `id: { txDigest, eventSeq }`.
    id: SuiEventId,
}

#[derive(Debug, Deserialize)]
struct SuiEventId {
    #[serde(rename = "txDigest")]
    tx_digest: String,
    #[serde(rename = "eventSeq")]
    #[allow(dead_code)]
    event_seq: String,
}

#[derive(Debug, Deserialize)]
struct TxBlock {
    #[serde(rename = "objectChanges", default)]
    object_changes: Vec<ObjectChange>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ObjectChange {
    Created {
        #[serde(rename = "objectId")]
        object_id: String,
        #[serde(rename = "objectType")]
        object_type: String,
    },
    #[serde(other)]
    Other,
}

#[derive(Clone)]
struct Keeper {
    args: Args,
    http: reqwest::Client,
    /// Claim IDs the keeper has already submitted (avoid double-spend retries).
    seen_claims: Arc<Mutex<HashSet<String>>>,
    seen_round_funds: Arc<Mutex<HashSet<u64>>>,
    seen_slot_pools: Arc<Mutex<HashSet<String>>>, // cap_id of the bound slot
    seen_bound_rounds: Arc<Mutex<HashSet<u64>>>, // rounds the keeper has called bind for
}

impl Keeper {
    fn new(args: Args) -> Self {
        Self {
            args,
            http: reqwest::Client::new(),
            seen_claims: Arc::new(Mutex::new(HashSet::new())),
            seen_round_funds: Arc::new(Mutex::new(HashSet::new())),
            seen_slot_pools: Arc::new(Mutex::new(HashSet::new())),
            seen_bound_rounds: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    async fn rpc<T: for<'de> Deserialize<'de>>(&self, body: serde_json::Value) -> Result<T> {
        let resp: RpcResponse<T> = self
            .http
            .post(&self.args.rpc_url)
            .json(&body)
            .send()
            .await?
            .json()
            .await
            .context("rpc body not valid JSON")?;
        if let Some(e) = resp.error {
            bail!("rpc error: {}", e);
        }
        resp.result.ok_or_else(|| anyhow!("rpc returned neither result nor error"))
    }

    async fn query_events(&self, ty: &str, limit: u64) -> Result<EventPage> {
        let body = serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "suix_queryEvents",
            "params": [{ "MoveEventType": ty }, null, limit, true],
        });
        self.rpc::<EventPage>(body).await
    }

    /// Find the frozen RoundHistory object ID for a given round, via the
    /// `RoundClosed` event's tx → objectChanges. Walks the event's tx digest,
    /// finds the created `pool::RoundHistory` object, returns its ID.
    async fn find_round_history(&self, round_id: u64) -> Result<Option<String>> {
        let ty = format!("{}::pool::RoundClosed", self.args.package_id);
        let page = self.query_events(&ty, 100).await?;
        for e in page.data {
            let rid = e
                .parsed
                .get("round_id")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<u64>().ok());
            if rid != Some(round_id) {
                continue;
            }
            let digest = e.id.tx_digest;
            let body = serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "sui_getTransactionBlock",
                "params": [digest, { "showObjectChanges": true }],
            });
            let tx: TxBlock = self.rpc(body).await?;
            for c in tx.object_changes {
                if let ObjectChange::Created { object_id, object_type } = c {
                    if object_type.contains("::pool::RoundHistory") {
                        return Ok(Some(object_id));
                    }
                }
            }
        }
        Ok(None)
    }

    /// Spawn the loops. They run forever.
    async fn run(self) -> Result<()> {
        let me1 = self.clone();
        let me2 = self.clone();
        let me3 = self.clone();
        let me4 = self.clone();
        let interval = Duration::from_secs(self.args.poll_seconds);

        tokio::spawn(async move {
            loop {
                if let Err(e) = me1.tick_block_found().await {
                    warn!("block-found tick error: {:?}", e);
                }
                tokio::time::sleep(interval).await;
            }
        });

        tokio::spawn(async move {
            loop {
                if let Err(e) = me3.tick_slot_bound().await {
                    warn!("slot-bound tick error: {:?}", e);
                }
                tokio::time::sleep(interval).await;
            }
        });

        // Auto-bind: ensure the current pool round has a HashShare slot
        // bound. Idempotent — `bind_slot_to_round` is a no-op once the
        // round already has a binding. Skipped entirely when
        // --hash-share-registry-id is not provided.
        if self.args.hash_share_registry_id.is_some() {
            tokio::spawn(async move {
                loop {
                    if let Err(e) = me4.tick_auto_bind().await {
                        warn!("auto-bind tick error: {:?}", e);
                    }
                    tokio::time::sleep(interval).await;
                }
            });
        }

        loop {
            if let Err(e) = me2.tick_deposit_confirmed().await {
                warn!("deposit-confirmed tick error: {:?}", e);
            }
            tokio::time::sleep(interval).await;
        }
    }

    async fn tick_block_found(&self) -> Result<()> {
        let ty = format!("{}::pool::BlockFound", self.args.package_id);
        let page = self.query_events(&ty, 20).await?;
        for e in page.data {
            let claim_id = match e.parsed.get("claim_id").and_then(|v| v.as_str()) {
                Some(s) => s.to_string(),
                None => continue, // pre-trustless event; skip
            };
            {
                let mut s = self.seen_claims.lock().await;
                if s.contains(&claim_id) { continue; }
                s.insert(claim_id.clone());
            }
            info!("BlockFound observed — opening accumulator from claim {}", claim_id);
            if let Err(e) = self.open_accumulator(&claim_id).await {
                warn!("open_accumulator failed: {:?}", e);
            }
        }
        Ok(())
    }

    async fn tick_deposit_confirmed(&self) -> Result<()> {
        let ty = format!("{}::hashi_pool::HashibDepositConfirmed", self.args.package_id);
        let page = self.query_events(&ty, 20).await?;
        for e in page.data {
            let round_id = match e.parsed.get("round_id").and_then(|v| v.as_str()).and_then(|s| s.parse::<u64>().ok()) {
                Some(r) => r,
                None => continue,
            };
            {
                let mut s = self.seen_round_funds.lock().await;
                if s.contains(&round_id) { continue; }
                s.insert(round_id);
            }
            info!("HashibDepositConfirmed observed — funding round {}", round_id);

            let history = match self.find_round_history(round_id).await? {
                Some(h) => h,
                None => { warn!("no RoundHistory for round {}", round_id); continue; }
            };
            let deposit_record = match e.parsed.get("record_id").and_then(|v| v.as_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            if let Err(e) = self.fund_round(round_id, &history, &deposit_record).await {
                warn!("fund_round({}) failed: {:?}", round_id, e);
            }
        }
        Ok(())
    }

    /// Read `pool.current_round` and call `bind_slot_to_round` if no
    /// binding exists yet. This is the bootstrap step that lets the
    /// sidecar's mint PTBs (which require the slot bound) succeed for
    /// the very first share of a round.
    async fn tick_auto_bind(&self) -> Result<()> {
        let registry_id = match self.args.hash_share_registry_id.as_deref() {
            Some(id) => id,
            None => return Ok(()), // disabled
        };

        let current_round = self.read_current_round().await?;
        {
            let s = self.seen_bound_rounds.lock().await;
            if s.contains(&current_round) {
                return Ok(());
            }
        }

        if self.has_round_binding(registry_id, current_round).await? {
            // Already bound on-chain — register locally so we skip next tick.
            self.seen_bound_rounds.lock().await.insert(current_round);
            return Ok(());
        }

        info!(
            "Auto-bind: round {} has no HashShare binding — calling bind_slot_to_round",
            current_round
        );
        if let Err(e) = self.bind_slot(registry_id, current_round).await {
            warn!("bind_slot({}) failed: {:?}", current_round, e);
            return Ok(()); // retry next tick
        }
        self.seen_bound_rounds.lock().await.insert(current_round);
        Ok(())
    }

    async fn read_current_round(&self) -> Result<u64> {
        let body = serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "sui_getObject",
            "params": [self.args.pool_id, { "showContent": true }],
        });
        let v: serde_json::Value = self.rpc(body).await?;
        let round = v.pointer("/data/content/fields/current_round")
            .and_then(|x| x.as_str())
            .and_then(|s| s.parse::<u64>().ok())
            .or_else(|| v.pointer("/data/content/fields/current_round").and_then(|x| x.as_u64()))
            .ok_or_else(|| anyhow!("pool current_round missing"))?;
        Ok(round)
    }

    async fn has_round_binding(&self, registry_id: &str, round_id: u64) -> Result<bool> {
        // Fastest read: query the SlotBoundToRound events page, scan for round_id.
        // We don't have a direct DF read helper here and dynamic-field lookup
        // would require knowing the table key encoding — events are cheaper.
        let ty = format!("{}::hash_share_registry::SlotBoundToRound", self.args.package_id);
        let page = self.query_events(&ty, 50).await?;
        for e in page.data {
            let rid = e.parsed.get("round_id")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<u64>().ok());
            if rid == Some(round_id) {
                let _ = registry_id; // suppress unused warning if logic changes
                return Ok(true);
            }
        }
        Ok(false)
    }

    async fn bind_slot(&self, registry_id: &str, round_id: u64) -> Result<()> {
        let cmd = format!(
            "sui client ptb \\
  --move-call {pkg}::hash_share_registry::bind_slot_to_round \\
    @{reg} {round}u64 \\
  --gas-budget {gas} --json",
            pkg = self.args.package_id,
            reg = registry_id,
            round = round_id,
            gas = self.args.gas_budget,
        );
        if self.args.dry_run {
            info!("[dry-run] {}", cmd);
            return Ok(());
        }
        Self::run_shell(&cmd).await
    }

    async fn open_accumulator(&self, claim_id: &str) -> Result<()> {
        let cmd = format!(
            "sui client ptb \\
  --move-call {pkg}::pool::open_round_accumulator_from_claim @{pool} @{claim} @0x6 \\
  --gas-budget {gas} --json",
            pkg = self.args.package_id,
            pool = self.args.pool_id,
            claim = claim_id,
            gas = self.args.gas_budget,
        );
        if self.args.dry_run {
            info!("[dry-run] {}", cmd);
            return Ok(());
        }
        Self::run_shell(&cmd).await
    }

    async fn fund_round(&self, round_id: u64, round_history: &str, deposit_record: &str) -> Result<()> {
        let cmd = format!(
            "sui client ptb \\
  --move-call {pkg}::hashi_rewards::open_and_fund_round_batch<{coin}> \\
    @{registry} @{vault} @{round_history} @{deposit_record} @0x6 \\
  --gas-budget {gas} --json",
            pkg = self.args.package_id,
            coin = self.args.hbtc_coin_type,
            registry = self.args.registry_id,
            vault = self.args.vault_id,
            round_history = round_history,
            deposit_record = deposit_record,
            gas = self.args.gas_budget,
        );
        if self.args.dry_run {
            info!("[dry-run] would fund round {} with: {}", round_id, cmd);
            return Ok(());
        }
        Self::run_shell(&cmd).await
    }

    // ── SlotBoundToRound → DeepBook pool creation ─────────────────────────

    /// Watch `hash_share_registry::SlotBoundToRound` events. For each new
    /// slot binding, derive the HashShare coin type and submit a DeepBookV3
    /// `create_permissionless_pool` PTB. Dry-runs when any deepbook_* flag
    /// is missing.
    async fn tick_slot_bound(&self) -> Result<()> {
        let ty = format!("{}::hash_share_registry::SlotBoundToRound", self.args.package_id);
        let page = self.query_events(&ty, 20).await?;
        for e in page.data {
            let cap_id = match e.parsed.get("cap_id").and_then(|v| v.as_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            {
                let mut s = self.seen_slot_pools.lock().await;
                if s.contains(&cap_id) { continue; }
                s.insert(cap_id.clone());
            }

            // Label is a vector<u8>; serialized as an array of numbers in
            // parsedJson. Decode to ASCII like "HS000".
            let label = e.parsed.get("label").and_then(parse_byte_array);
            let label = match label {
                Some(s) => s,
                None => {
                    warn!("SlotBoundToRound missing or malformed label; skipping");
                    continue;
                }
            };
            let round_id = e.parsed.get("round_id")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<u64>().ok());

            // Parse "HS000" → slot index 0 → module hs_000, type HS_000.
            let hs_type = match label_to_hashshare_type(&self.args.package_id, &label) {
                Some(t) => t,
                None => {
                    warn!("could not derive HashShare type from label {}", label);
                    continue;
                }
            };

            info!(
                "SlotBoundToRound observed (round={:?}, label={}, cap={}). HS type = {}",
                round_id, label, cap_id, hs_type,
            );
            if let Err(e) = self.create_deepbook_pool(&hs_type, &label).await {
                warn!("create_deepbook_pool({}) failed: {:?}", hs_type, e);
            }
        }
        Ok(())
    }

    async fn create_deepbook_pool(&self, hs_type: &str, label: &str) -> Result<()> {
        let (Some(pkg), Some(reg), Some(quote), Some(deep)) = (
            self.args.deepbook_package_id.as_ref(),
            self.args.deepbook_registry_id.as_ref(),
            self.args.deepbook_quote_coin_type.as_ref(),
            self.args.deepbook_deep_coin_id.as_ref(),
        ) else {
            info!(
                "[dry-run] DeepBook flags missing — would create Pool<{}, ?> via DeepBookV3 for slot {}",
                hs_type, label,
            );
            return Ok(());
        };

        let cmd = format!(
            "sui client ptb \\
  --move-call {dbpkg}::pool::create_permissionless_pool<{hs},{quote}> \\
    @{reg} {tick}u64 {lot}u64 {min}u64 @{deep_coin} \\
  --gas-budget {gas} --json",
            dbpkg = pkg,
            hs = hs_type,
            quote = quote,
            reg = reg,
            tick = self.args.deepbook_tick_size,
            lot = self.args.deepbook_lot_size,
            min = self.args.deepbook_min_size,
            deep_coin = deep,
            gas = self.args.gas_budget,
        );

        if self.args.dry_run {
            info!("[dry-run] {}", cmd);
            return Ok(());
        }
        Self::run_shell(&cmd).await
    }

    async fn run_shell(cmd: &str) -> Result<()> {
        let out = tokio::process::Command::new("bash")
            .arg("-c")
            .arg(cmd)
            .output()
            .await
            .context("spawn sui client")?;
        if !out.status.success() {
            bail!("sui client failed: {}", String::from_utf8_lossy(&out.stderr));
        }
        info!("✓ {}", String::from_utf8_lossy(&out.stdout).lines().last().unwrap_or(""));
        Ok(())
    }
}

/// Decode a `vector<u8>` field parsed by sui_getEvents into a String.
/// `parsedJson` represents Move vector<u8> as a JSON array of integers
/// 0..255 OR sometimes as a base64 string depending on RPC version;
/// try both.
fn parse_byte_array(v: &serde_json::Value) -> Option<String> {
    if let Some(arr) = v.as_array() {
        let bytes: Option<Vec<u8>> = arr.iter().map(|x| x.as_u64().map(|n| n as u8)).collect();
        return bytes.and_then(|b| String::from_utf8(b).ok());
    }
    v.as_str().map(|s| s.to_string())
}

/// Map a slot label like "HS000" to its fully-qualified Move type string.
/// Module names follow `hs_NNN`, types follow `HS_NNN`.
fn label_to_hashshare_type(package_id: &str, label: &str) -> Option<String> {
    if !label.starts_with("HS") { return None; }
    let num = &label[2..];
    if num.is_empty() || !num.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(format!("{}::hs_{}::HS_{}", package_id, num, num))
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env().add_directive("trustless_keeper=info".parse()?))
        .init();
    let args = Args::parse();
    info!("trustless-keeper starting, polling every {}s", args.poll_seconds);
    Keeper::new(args).run().await
}
