//! Shared Sui submission client for m1n3 miners.
//!
//! Provides `MinerClient` — a single struct used by both the miner-sidecar
//! and stratum-server solo-mode.  Key design properties:
//!
//! - Object version caching: owned object (version, digest) are updated from
//!   `object_changes` after each transaction, eliminating per-share RPC calls.
//! - Clock version cached once at startup (system object, never changes).
//! - Gas price cached with a 30-second TTL.
//! - Pool `current_round` cached with a 10-second TTL.
//! - Gas coin ref refreshed from `object_changes` after each transaction.
//! - True PTB batching: N shares → 1 transaction, 1 gas payment.
//!
//! ## Two share-submission paths
//!
//! - [`MinerClient::submit_batch`] — standard pool flow: per share, call
//!   `pool::submit_share` and (optionally) chain `hash_share::mint_share_to<T>`
//!   to mint the round's `Coin<HS_NNN>` to the miner.
//! - [`MinerClient::submit_batch_for_buyer_pay`] — buyer-template lane: per
//!   share, call `pool::submit_share_for_buyer_pay<QuoteT>` against the
//!   configured `BuyerHashpowerOrder<QuoteT>` and `TransferObjects` the
//!   returned `Coin<QuoteT>` straight to the miner inside the same PTB. The
//!   sidecar selects this path when `--hashpower-buy-order-id` is set.

use anyhow::{anyhow, Result};
use std::{
    collections::{HashMap, HashSet},
    str::FromStr,
    sync::{atomic::AtomicU64, Arc},
    time::{Duration, Instant},
};
use sui_sdk::{
    rpc_types::{
        EventFilter, ObjectChange, SuiObjectDataFilter, SuiObjectDataOptions,
        SuiObjectResponseQuery, SuiTransactionBlockResponse, SuiTransactionBlockResponseOptions,
    },
    types::{
        base_types::{ObjectDigest, ObjectID, SequenceNumber, SuiAddress},
        crypto::{EncodeDecodeBase64, Signature, Signer, SuiKeyPair},
        object::Owner,
        programmable_transaction_builder::ProgrammableTransactionBuilder,
        transaction::{
            ObjectArg, ProgrammableTransaction, SharedObjectMutability, Transaction, TransactionData,
        },
        transaction_driver_types::ExecuteTransactionRequestType,
        Identifier, TypeTag,
    },
    SuiClient, SuiClientBuilder,
};
use tracing::{info, warn};

const GAS_PRICE_TTL: Duration = Duration::from_secs(30);
const ROUND_TTL: Duration = Duration::from_secs(10);

// ── Public types ─────────────────────────────────────────────────────────────

/// A share accepted by the stratum server, ready to be submitted on-chain.
#[derive(Clone, Debug)]
pub struct PendingShare {
    /// Pool-assigned extranonce1 for this miner connection.
    pub extranonce1: Vec<u8>,
    pub extranonce2: Vec<u8>,
    pub ntime: u32,
    pub nonce: u32,
    pub version: u32,
}

// ── MinerClient ───────────────────────────────────────────────────────────────

/// Optional HashShare-mint configuration. When set on a `MinerClient`,
/// `submit_batch` chains a `hash_share::bind_slot_to_round` (idempotent)
/// followed by `hash_share::mint_share_to<T>` per share in the same PTB.
/// The minted `Coin<T>` lands in the miner's wallet at `MinerClient.address`,
/// 1:1 with the share's difficulty minus the protocol mint fee.
///
/// The operator is responsible for updating these as the on-chain
/// `SlotBoundToRound` advances — a fresh round binds a fresh slot, and
/// `treasury_cap_id` + `hashshare_type` change with each binding. The
/// trustless-keeper's `tick_slot_bound` is the canonical source of truth.
#[derive(Clone, Debug)]
pub struct HashShareMintConfig {
    pub registry_id: ObjectID,
    pub treasury_cap_id: ObjectID,
    pub hashshare_type: TypeTag,
}

impl HashShareMintConfig {
    /// Build a config from string CLI args without exposing sui-sdk types to
    /// downstream binaries.
    pub fn from_strings(
        registry_id: &str,
        treasury_cap_id: &str,
        hashshare_type: &str,
    ) -> Result<Self> {
        Ok(Self {
            registry_id: ObjectID::from_str(registry_id)
                .map_err(|_| anyhow!("Invalid registry_id: {}", registry_id))?,
            treasury_cap_id: ObjectID::from_str(treasury_cap_id)
                .map_err(|_| anyhow!("Invalid treasury_cap_id: {}", treasury_cap_id))?,
            hashshare_type: TypeTag::from_str(hashshare_type)
                .map_err(|e| anyhow!("Invalid hashshare_type {}: {}", hashshare_type, e))?,
        })
    }
}

pub struct MinerClient {
    client: SuiClient,
    keypair: SuiKeyPair,
    address: SuiAddress,
    package_id: ObjectID,
    pool_id: ObjectID,
    dedup_registry_id: Option<ObjectID>,
    /// `miner::MinerRoundRegistry` shared object. After the trustless
    /// cleanup, `create_round_stats` requires this as its first argument so
    /// each (miner, round) pair is deduped. Optional only because the very
    /// old (pre-cleanup) package signature was 2-arg; setting it is required
    /// on the current package.
    miner_round_registry_id: Option<ObjectID>,
    gas_budget: u64,

    // Owned object IDs (stable across the process lifetime)
    miner_stats_id: Option<ObjectID>,
    miner_round_stats_id: Option<ObjectID>,
    current_round: u64,
    // template_id (hex str) → ShareDedup object ID
    share_dedup_ids: HashMap<u64, ObjectID>,

    // Cached (version, digest) per object — updated from object_changes after each tx.
    obj_vers: HashMap<ObjectID, (SequenceNumber, ObjectDigest)>,

    // Gas coin: (object_id, version, digest) — refreshed from object_changes.
    gas_coin: Option<(ObjectID, SequenceNumber, ObjectDigest)>,

    // Gas price with TTL.
    gas_price: u64,
    gas_price_at: Option<Instant>,

    // Pool current_round and current_height with TTL.
    pool_round: u64,
    pool_height: u64,
    pool_round_at: Option<Instant>,

    // Clock's initial_shared_version — read once at startup, never changes.
    clock_ver: Option<SequenceNumber>,

    // Rounds we've already accumulated so we don't double-submit.
    accumulated_rounds: HashSet<u64>,
    // Rate-limit accumulation checks to once per 30s.
    acc_check_at: Option<Instant>,

    // Optional: if set, every share submitted via `submit_batch` is also
    // minted as `Coin<T>` in the same PTB.
    hashshare: Option<HashShareMintConfig>,

    // Optional auto-sell config. When `Some`, the sidecar runs
    // `auto_sell_minted()` after every successful share batch:
    //   - merges all owned Coin<HashShare>
    //   - calls `hash_share_market::place_sell_order` at the configured floor
    auto_sell: Option<AutoSellConfig>,

    // Optional peg-to-market config. Overrides the fixed-floor auto_sell:
    // computes a target price relative to the current best bid / mid / ask
    // each batch, then either tops-up + retargets the miner's existing
    // SellOrder or places a fresh one. See `AutoSellPegConfig`.
    auto_sell_peg: Option<AutoSellPegConfig>,

    // Optional auto-fill-bids config. When set, the sidecar scans the
    // orderbook each batch for the best resting BuyOrder above floor and
    // takes it via `hash_share_market::fill_buy_order`. Falls through to
    // auto_sell (or auto_sell_peg) when no bid meets the floor.
    auto_fill_bid: Option<AutoFillBidConfig>,

    // Shared MarketFeePool object id, used as the `&fee_pool` arg on
    // `fill_buy_order`. Required for auto-fill mode; ignored otherwise.
    market_fee_pool_id: Option<ObjectID>,

    // Quote coin type used by `hash_share_market` after the generic
    // `<phantom T, phantom QuoteT>` refactor. Determines the second type
    // argument on `place_sell_order` / `fill_buy_order` and the type tag
    // appended to `BuyOrder<T, QuoteT>` event scans. Defaults to SUI for
    // back-compat with testnet/devnet; mainnet sets this to native USDC.
    quote_type: TypeTag,

    // Dynamic auto-sell floor override (off-chain feeder, see
    // `miner-sidecar/src/price_feeder.rs`). When set and > 0 this takes
    // precedence over `AutoSellPegConfig.fallback_floor_mist`, letting
    // the sidecar reprice every auto-sell batch against live BTC price +
    // network difficulty. None disables the override and the static
    // config value is used (current behavior). Phase B replaces this
    // with an on-chain Pyth-anchored derivation in Move.
    dynamic_floor_mist: Option<Arc<AtomicU64>>,

    // Optional buyer-template lane configuration. When set, the sidecar
    // calls `pool::submit_share_for_pay<QuoteT>` (or its derived variant)
    // instead of the regular `submit_share` + HashShare mint. Each share
    // drains `price_per_difficulty * difficulty` from the order's budget
    // and the resulting `Coin<QuoteT>` is transferred to the miner inside
    // the same PTB. No HashShare minting, no auto-sell, no round binding
    // beyond what MinerRoundStats already requires.
    hashpower_buy: Option<HashpowerBuyConfig>,
}

/// Buyer-bound (V2) lane config. The sidecar drains the configured
/// `BuyerHashpowerOrder<QuoteT>` per share via
/// `pool::submit_share_for_buyer_pay`. Unlike V1 there is no template
/// binding on the order — any template `T` with `T.owner == order.buyer`
/// can settle a share, so we don't need to resolve / cache an
/// `order.template_id` here. The PTB threads the share's own template
/// id, and the contract enforces owner-equality at submission time.
#[derive(Clone, Debug)]
pub struct HashpowerBuyConfig {
    /// Shared mutable `BuyerHashpowerOrder<QuoteT>` to drain. The
    /// `QuoteT` generic is read from `MinerClient.quote_type` so every
    /// type tag stays in one place.
    pub order_id: ObjectID,
}

impl HashpowerBuyConfig {
    pub fn from_str(order_id: &str) -> Result<Self> {
        Ok(Self {
            order_id: ObjectID::from_str(order_id)
                .map_err(|_| anyhow!("Invalid BuyerHashpowerOrder id: {}", order_id))?,
        })
    }
}

#[derive(Clone, Debug)]
pub struct AutoSellConfig {
    /// MIST price per HashShare unit. 0 disables.
    pub price_per_unit_mist: u64,
    /// 0 = no expiry. Otherwise Unix-ms when the order auto-cancels.
    pub expires_at_ms: u64,
}

/// Peg-to-market price anchor. Resolution is left to the caller — we just
/// pick which point in the orderbook the target price is relative to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PegAnchor {
    /// (best_bid + best_ask) / 2. Falls back to the side that exists when
    /// only one side is present, or to the configured floor when neither.
    Mid,
    /// Highest resting bid. Aggressive — sits at-touch.
    BestBid,
    /// Lowest resting ask minus one tick. Most passive.
    BestAsk,
}

impl std::str::FromStr for PegAnchor {
    type Err = anyhow::Error;
    fn from_str(s: &str) -> Result<Self> {
        match s.to_ascii_lowercase().as_str() {
            "mid" => Ok(Self::Mid),
            "bid" | "best-bid" | "best_bid" => Ok(Self::BestBid),
            "ask" | "best-ask" | "best_ask" => Ok(Self::BestAsk),
            other => Err(anyhow!(
                "unknown peg anchor: {} (use mid|bid|ask)", other
            )),
        }
    }
}

#[derive(Clone, Debug)]
pub struct AutoSellPegConfig {
    pub anchor: PegAnchor,
    /// Signed basis-points offset from the anchor. +100 = +1% above; -50 = -0.5% below.
    pub offset_bps: i32,
    /// Floor in MIST/unit — used if the orderbook is empty so we never
    /// give shares away for free. 0 means "skip the batch when no anchor".
    pub fallback_floor_mist: u64,
    /// 0 = no expiry. Otherwise Unix-ms when the order auto-cancels.
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug)]
pub struct AutoFillBidConfig {
    /// Minimum acceptable bid price in MIST/unit. Bids strictly below this
    /// are skipped and we fall through to auto-sell.
    pub floor_price_mist: u64,
}

impl MinerClient {
    /// Set the `MinerRoundRegistry` shared object id used by
    /// `ensure_round_stats`. Required on the post-trustless-cleanup package.
    pub fn with_miner_round_registry(mut self, id_str: &str) -> Result<Self> {
        if id_str.is_empty() {
            return Ok(self);
        }
        let id = ObjectID::from_str(id_str)
            .map_err(|_| anyhow!("Invalid MinerRoundRegistry ID: {}", id_str))?;
        self.miner_round_registry_id = Some(id);
        Ok(self)
    }

    /// Override the quote coin type used by `place_sell_order` /
    /// `fill_buy_order`. Default is SUI; mainnet sets this to native USDC.
    /// Pass the fully-qualified type (e.g.
    /// `"0xdba34672…::usdc::USDC"`).
    pub fn with_quote_type(mut self, quote_type_str: &str) -> Result<Self> {
        if quote_type_str.is_empty() {
            return Ok(self);
        }
        self.quote_type = TypeTag::from_str(quote_type_str)
            .map_err(|_| anyhow!("Invalid quote type tag: {}", quote_type_str))?;
        Ok(self)
    }

    /// Install a shared atomic holding the dynamic auto-sell floor
    /// (µUSDC per HashShare unit, on mainnet). When set and > 0 this
    /// overrides `AutoSellPegConfig.fallback_floor_mist` on every batch.
    /// A background task in the sidecar updates the atomic from the
    /// fair-value derivation `(block_reward × btc_price) / difficulty`,
    /// so prices track network conditions without restarting the
    /// process. The atomic is set to 0 when the feeder has nothing
    /// fresh — in that case we fall back to the static config.
    pub fn with_dynamic_floor(mut self, floor: Arc<AtomicU64>) -> Self {
        self.dynamic_floor_mist = Some(floor);
        self
    }

    pub async fn new(
        package_id_str: &str,
        pool_id_str: &str,
        dedup_registry_id_str: &str,
        rpc_url: &str,
        keystore_path: &str,
        gas_budget: u64,
    ) -> Result<Self> {
        let package_id = ObjectID::from_str(package_id_str)
            .map_err(|_| anyhow!("Invalid package ID: {}", package_id_str))?;
        let pool_id = ObjectID::from_str(pool_id_str)
            .map_err(|_| anyhow!("Invalid pool object ID: {}", pool_id_str))?;
        let dedup_registry_id = if dedup_registry_id_str.is_empty() {
            None
        } else {
            Some(ObjectID::from_str(dedup_registry_id_str)
                .map_err(|_| anyhow!("Invalid ShareDedupRegistry object ID: {}", dedup_registry_id_str))?)
        };
        let keypair = load_keystore(keystore_path)?;
        let address = SuiAddress::from(&keypair.public());
        let client = SuiClientBuilder::default()
            .build(rpc_url)
            .await
            .map_err(|e| anyhow!("Cannot connect to Sui RPC: {}", e))?;
        info!("MinerClient ready — address={} package={} pool={}",
            address, package_id, pool_id);
        Ok(Self {
            client,
            keypair,
            address,
            package_id,
            pool_id,
            dedup_registry_id,
            miner_round_registry_id: None,
            gas_budget,
            miner_stats_id: None,
            miner_round_stats_id: None,
            current_round: 0,
            share_dedup_ids: HashMap::new(),
            obj_vers: HashMap::new(),
            gas_coin: None,
            gas_price: 0,
            gas_price_at: None,
            pool_round: 0,
            pool_height: 0,
            pool_round_at: None,
            clock_ver: None,
            accumulated_rounds: HashSet::new(),
            acc_check_at: None,
            hashshare: None,
            auto_sell: None,
            auto_sell_peg: None,
            auto_fill_bid: None,
            market_fee_pool_id: None,
            // SUI by default — back-compat with testnet/devnet markets.
            // `with_quote_type` overrides this for USDC-quoted markets
            // (mainnet).
            quote_type: TypeTag::from_str("0x2::sui::SUI")
                .expect("SUI type tag is well-known"),
            dynamic_floor_mist: None,
            hashpower_buy: None,
        })
    }

    pub fn address(&self) -> SuiAddress {
        self.address
    }

    /// Enable per-share HashShare minting in the same PTB as `submit_share`.
    /// See `HashShareMintConfig` for the lifecycle expectations.
    pub fn with_hashshare_mint(mut self, cfg: HashShareMintConfig) -> Self {
        self.hashshare = Some(cfg);
        self
    }

    pub fn clear_hashshare_mint(&mut self) {
        self.hashshare = None;
    }

    /// Set/replace the mint config without consuming self. Used by the
    /// sidecar's slot-bound watcher to hot-swap configs when the registry
    /// rotates to a new HashShare slot.
    pub fn set_hashshare_mint(&mut self, cfg: HashShareMintConfig) {
        self.hashshare = Some(cfg);
    }

    /// Enable post-batch auto-sell. After every successful share batch
    /// the sidecar will call [`MinerClient::auto_sell_minted`] which
    /// merges the miner's HashShare inventory and places a sell order at
    /// the configured floor price.
    pub fn with_auto_sell(mut self, cfg: AutoSellConfig) -> Self {
        self.auto_sell = Some(cfg);
        self
    }

    pub fn set_auto_sell(&mut self, cfg: AutoSellConfig) {
        self.auto_sell = Some(cfg);
    }

    pub fn clear_auto_sell(&mut self) {
        self.auto_sell = None;
    }

    pub fn auto_sell_config(&self) -> Option<&AutoSellConfig> {
        self.auto_sell.as_ref()
    }

    /// Enable peg-to-market sell pricing. Overrides the fixed-floor
    /// [`AutoSellConfig`] when both are set (peg is the more sophisticated
    /// strategy).
    pub fn with_auto_sell_peg(mut self, cfg: AutoSellPegConfig) -> Self {
        self.auto_sell_peg = Some(cfg);
        self
    }
    pub fn set_auto_sell_peg(&mut self, cfg: AutoSellPegConfig) {
        self.auto_sell_peg = Some(cfg);
    }
    pub fn clear_auto_sell_peg(&mut self) {
        self.auto_sell_peg = None;
    }
    pub fn auto_sell_peg_config(&self) -> Option<&AutoSellPegConfig> {
        self.auto_sell_peg.as_ref()
    }

    /// Enable auto-fill-bids mode. The sidecar scans for resting bids
    /// above the floor each batch; if it finds one, fills it via
    /// `hash_share_market::fill_buy_order` and skips the auto-sell path.
    pub fn with_auto_fill_bid(mut self, cfg: AutoFillBidConfig) -> Self {
        self.auto_fill_bid = Some(cfg);
        self
    }
    pub fn set_auto_fill_bid(&mut self, cfg: AutoFillBidConfig) {
        self.auto_fill_bid = Some(cfg);
    }
    pub fn clear_auto_fill_bid(&mut self) {
        self.auto_fill_bid = None;
    }
    pub fn auto_fill_bid_config(&self) -> Option<&AutoFillBidConfig> {
        self.auto_fill_bid.as_ref()
    }

    /// Set the shared `MarketFeePool` object id used by `fill_buy_order`.
    /// Required for auto-fill mode; pass an empty string for legacy modes.
    pub fn with_market_fee_pool(mut self, id_str: &str) -> Result<Self> {
        if id_str.is_empty() {
            return Ok(self);
        }
        let id = ObjectID::from_str(id_str)
            .map_err(|_| anyhow!("Invalid MarketFeePool ID: {}", id_str))?;
        self.market_fee_pool_id = Some(id);
        Ok(self)
    }

    /// Enable the buyer-template lane: every batch drains shares from
    /// the configured `HashpowerBuyOrder<QuoteT>` via
    /// `pool::submit_share_for_pay`. When set, `submit_batch` flips to
    /// the pay-per-share PTB path; HashShare mint / auto-sell / auto-fill
    /// are skipped because they're orthogonal to this lane.
    pub fn with_hashpower_buy_order(mut self, id_str: &str) -> Result<Self> {
        if id_str.is_empty() {
            return Ok(self);
        }
        self.hashpower_buy = Some(HashpowerBuyConfig::from_str(id_str)?);
        Ok(self)
    }

    pub fn set_hashpower_buy_order(&mut self, cfg: HashpowerBuyConfig) {
        self.hashpower_buy = Some(cfg);
    }

    pub fn clear_hashpower_buy_order(&mut self) {
        self.hashpower_buy = None;
    }

    pub fn hashpower_buy_config(&self) -> Option<&HashpowerBuyConfig> {
        self.hashpower_buy.as_ref()
    }

    /// Ensure `MinerStats` exists; create it if missing. Call once at startup.
    pub async fn ensure_registered(&mut self) -> Result<()> {
        if self.miner_stats_id.is_some() {
            return Ok(());
        }
        let stats_type = format!("{}::miner::MinerStats", self.package_id);
        if let Some(id) = self.find_owned_id(&stats_type).await? {
            info!("Miner already registered: MinerStats={}", id);
            self.miner_stats_id = Some(id);
            return Ok(());
        }
        let mut ptb = ProgrammableTransactionBuilder::new();
        // btc_payout_address: empty for now; miner can update via set_btc_payout_address.
        let btc_arg = ptb.pure(Vec::<u8>::new()).map_err(|e| anyhow!("{}", e))?;
        let clock_arg = self.clock_arg(&mut ptb).await?;
        ptb.programmable_move_call(
            self.package_id,
            ident("miner"),
            ident("register_miner"),
            vec![],
            vec![btc_arg, clock_arg],
        );
        let resp = self.exec(ptb.finish()).await?;

        // Extract the new MinerStats ID directly from object_changes — this
        // avoids a race with the indexer which may lag after object creation.
        let id = resp.object_changes.as_ref().and_then(|changes| {
            changes.iter().find_map(|c| {
                if let ObjectChange::Created { object_id, object_type, .. } = c {
                    if object_type.name.as_str() == "MinerStats" {
                        return Some(*object_id);
                    }
                }
                None
            })
        });

        self.update_from_resp(&resp);

        if let Some(id) = id {
            info!("Miner registered: MinerStats={}", id);
            self.miner_stats_id = Some(id);
        } else if let Some(id) = self.find_owned_id(&stats_type).await? {
            info!("Miner registered (via query): MinerStats={}", id);
            self.miner_stats_id = Some(id);
        } else {
            return Err(anyhow!("MinerStats not found after registration"));
        }
        Ok(())
    }

    /// Submit N shares in one PTB — one Sui transaction regardless of batch size.
    ///
    /// Calls `pool::submit_share(template, miner_stats, miner_round_stats, share_dedup,
    ///                          en1, en2, ntime, nonce, version, clock)` for each share.
    /// The Pool object is NOT touched on the hot path; per-share writes land on owned
    /// MinerStats/MinerRoundStats/ShareDedup so different miners' submissions parallelize.
    pub async fn submit_batch(&mut self, batch: &[(String, PendingShare)]) -> Result<String> {
        if batch.is_empty() {
            return Err(anyhow!("Empty batch"));
        }

        // 1. Make sure we have MinerStats, MinerRoundStats for the current round,
        //    and ONE ShareDedup for this round (shared across every Template in
        //    the batch — per-round scoping replaced the older per-template one).
        self.ensure_registered().await?;
        self.fetch_pool_round().await?;
        let round_id = self.pool_round;
        self.ensure_round_stats(round_id).await?;
        self.ensure_share_dedup(round_id).await?;

        let mut unique_templates: Vec<String> =
            batch.iter().map(|(t, _)| t.clone()).collect();
        unique_templates.sort();
        unique_templates.dedup();

        let mut ptb = ProgrammableTransactionBuilder::new();

        // Clock (shared, immutable)
        let clock_arg = self.clock_arg(&mut ptb).await?;

        // MinerStats (owned, mutable)
        let miner_stats_id = self.miner_stats_id
            .ok_or_else(|| anyhow!("miner_stats not set"))?;
        let (ms_ver, ms_dig) = self.get_ver(miner_stats_id).await?;
        let ms_arg = ptb.obj(ObjectArg::ImmOrOwnedObject((miner_stats_id, ms_ver, ms_dig)))
            .map_err(|e| anyhow!("miner_stats arg: {}", e))?;

        // MinerRoundStats (owned, mutable)
        let mrs_id = self.miner_round_stats_id
            .ok_or_else(|| anyhow!("miner_round_stats not set"))?;
        let (mrs_ver, mrs_dig) = self.get_ver(mrs_id).await?;
        let mrs_arg = ptb.obj(ObjectArg::ImmOrOwnedObject((mrs_id, mrs_ver, mrs_dig)))
            .map_err(|e| anyhow!("miner_round_stats arg: {}", e))?;

        // Single ShareDedup arg for the round.
        let dedup_id = *self.share_dedup_ids.get(&round_id)
            .ok_or_else(|| anyhow!("share_dedup not set for round {}", round_id))?;
        let (d_ver, d_dig) = self.get_ver(dedup_id).await?;
        let dedup_arg = ptb.obj(ObjectArg::ImmOrOwnedObject((dedup_id, d_ver, d_dig)))
            .map_err(|e| anyhow!("share_dedup arg: {}", e))?;

        // Per-template Template args (still per-template because each share
        // references its own Template object).
        let mut tpl_args: HashMap<String, sui_sdk::types::transaction::Argument> = HashMap::new();
        for tid in &unique_templates {
            let tpl_obj_id = ObjectID::from_str(tid)
                .map_err(|_| anyhow!("Invalid template ID: {}", tid))?;
            let (tpl_ver, tpl_dig) = self.get_ver(tpl_obj_id).await?;
            let tpl_arg = ptb.obj(ObjectArg::ImmOrOwnedObject((tpl_obj_id, tpl_ver, tpl_dig)))
                .map_err(|e| anyhow!("template arg: {}", e))?;
            tpl_args.insert(tid.clone(), tpl_arg);
        }

        // If HashShare minting is configured, add the registry + cap as PTB
        // args and emit one `bind_slot_to_round` call before the per-share
        // mints. Bind is idempotent — only the first share of a round
        // actually advances the FIFO. `RoundBinding` has `drop`, so the
        // return value falls off the stack automatically.
        //
        // Clone the cfg fields out before any `self.get_ver` calls so the
        // borrow checker is happy.
        let hs_cfg = self.hashshare.clone();
        let hs_args = if let Some(cfg) = hs_cfg {
            // SharedObject args take the *initial_shared_version* — the
            // SequenceNumber at the moment the object was shared, which
            // never changes. Passing the current version makes validators
            // reject the tx and the fullnode bubbles that up as a 504.
            let rv = self.get_initial_shared_ver(cfg.registry_id).await?;
            let registry_arg = ptb.obj(ObjectArg::SharedObject {
                id: cfg.registry_id,
                initial_shared_version: rv,
                mutability: SharedObjectMutability::Mutable,
            }).map_err(|e| anyhow!("hash_share registry arg: {}", e))?;
            let cv = self.get_initial_shared_ver(cfg.treasury_cap_id).await?;
            let cap_arg = ptb.obj(ObjectArg::SharedObject {
                id: cfg.treasury_cap_id,
                initial_shared_version: cv,
                mutability: SharedObjectMutability::Mutable,
            }).map_err(|e| anyhow!("hash_share treasury_cap arg: {}", e))?;
            let round_arg = ptb.pure(round_id)
                .map_err(|e| anyhow!("hash_share round_id arg: {}", e))?;
            ptb.programmable_move_call(
                self.package_id,
                ident("hash_share_registry"),
                ident("bind_slot_to_round"),
                vec![],
                vec![registry_arg, round_arg],
            );
            let recipient_arg = ptb.pure(self.address)
                .map_err(|e| anyhow!("hash_share recipient arg: {}", e))?;
            Some((registry_arg, cap_arg, recipient_arg, cfg.hashshare_type))
        } else {
            None
        };

        // One submit_share per share. If HashShare mint is enabled, chain
        // `mint_share_to<T>(receipt)` right after to consume the receipt
        // and route the resulting Coin to the miner's wallet.
        for (template_id, share) in batch {
            let tpl_arg = *tpl_args.get(template_id).unwrap();

            let en1_arg = ptb.pure(share.extranonce1.clone())
                .map_err(|e| anyhow!("en1 arg: {}", e))?;
            let en2_arg = ptb.pure(share.extranonce2.clone())
                .map_err(|e| anyhow!("en2 arg: {}", e))?;
            let ntime_arg = ptb.pure(share.ntime)
                .map_err(|e| anyhow!("ntime arg: {}", e))?;
            let nonce_arg = ptb.pure(share.nonce)
                .map_err(|e| anyhow!("nonce arg: {}", e))?;
            let ver_arg = ptb.pure(share.version)
                .map_err(|e| anyhow!("ver arg: {}", e))?;

            let receipt = ptb.programmable_move_call(
                self.package_id,
                ident("pool"),
                ident("submit_share"),
                vec![],
                vec![tpl_arg, ms_arg, mrs_arg, dedup_arg,
                     en1_arg, en2_arg, ntime_arg, nonce_arg, ver_arg, clock_arg],
            );

            if let Some((registry_arg, cap_arg, recipient_arg, type_tag)) = &hs_args {
                ptb.programmable_move_call(
                    self.package_id,
                    ident("hash_share"),
                    ident("mint_share_to"),
                    vec![type_tag.clone()],
                    vec![*registry_arg, *cap_arg, receipt, mrs_arg, *recipient_arg],
                );
            }
        }

        // ── Diagnostic pre-flight log ─────────────────────────────────
        //
        // Logs every input that participates in on-chain validation so a
        // failed batch can be triaged from a single log line. Mirrors the
        // same trace we added on the buyer-template lane.
        let unique_templates_csv = unique_templates.join(",");
        info!(
            "submit_share PTB pre-submit — sender={} templates_in_batch=[{}] shares={}",
            self.address,
            unique_templates_csv,
            batch.len()
        );

        let resp = self.exec(ptb.finish()).await?;

        // ── Post-execute status check ─────────────────────────────────
        //
        // `self.exec` returns the response even when the Move call aborts
        // (Sui treats an abort as a "successful tx with Failure status").
        // Without this check the caller silently sees a digest while the
        // share didn't actually land. Surface the abort code as an Err so
        // `flush()` logs the real reason.
        if let Some(eff) = &resp.effects {
            use sui_sdk::rpc_types::{SuiExecutionStatus, SuiTransactionBlockEffectsAPI};
            if let SuiExecutionStatus::Failure { error } = eff.status() {
                return Err(anyhow!(
                    "submit_share aborted on chain: {} (digest: {})",
                    error,
                    resp.digest
                ));
            }
        }

        self.update_from_resp(&resp);
        Ok(resp.digest.to_string())
    }

    // ── Buyer-template lane: drain HashpowerBuyOrder per share ────────────────

    /// Drains `HashpowerBuyOrder<QuoteT>.budget` per share via
    /// `pool::submit_share_for_pay`. The returned `Coin<QuoteT>` is
    /// transferred to the miner inside the same PTB so the wallet
    /// accumulates payouts without any post-batch cleanup. Replaces
    /// `submit_batch` when the client has a `HashpowerBuyConfig` — the
    /// proxy's `flush` loop branches on `hashpower_buy_config().is_some()`.
    pub async fn submit_batch_for_buyer_pay(
        &mut self,
        batch: &[(String, PendingShare)],
    ) -> Result<String> {
        if batch.is_empty() {
            return Err(anyhow!("Empty batch"));
        }

        // Bootstrap owned objects the same way `submit_batch` does. The
        // V2 buyer-bound lane uses MinerRoundStats's existing round_id —
        // there's no separate "buyer round" — so we just accumulate
        // work into whatever round the miner already opened on the pool.
        self.ensure_registered().await?;
        self.fetch_pool_round().await?;
        let round_id = self.pool_round;
        self.ensure_round_stats(round_id).await?;

        // Single per-round dedup — same scoping as the regular pool path.
        // DerivedTemplate inherits round_id from its parent at derivation,
        // so the on-chain `submit_share_for_buyer_pay` check passes against
        // any of the buyer's templates within the round.
        self.ensure_share_dedup(round_id).await?;

        let mut unique_templates: Vec<String> =
            batch.iter().map(|(t, _)| t.clone()).collect();
        unique_templates.sort();
        unique_templates.dedup();

        let order_id = self
            .hashpower_buy
            .as_ref()
            .map(|c| c.order_id)
            .ok_or_else(|| anyhow!("hashpower_buy not configured"))?;

        let mut ptb = ProgrammableTransactionBuilder::new();
        let clock_arg = self.clock_arg(&mut ptb).await?;

        // MinerStats (owned mutable)
        let miner_stats_id = self
            .miner_stats_id
            .ok_or_else(|| anyhow!("miner_stats not set"))?;
        let (ms_ver, ms_dig) = self.get_ver(miner_stats_id).await?;
        let ms_arg = ptb
            .obj(ObjectArg::ImmOrOwnedObject((
                miner_stats_id,
                ms_ver,
                ms_dig,
            )))
            .map_err(|e| anyhow!("miner_stats arg: {}", e))?;

        // MinerRoundStats (owned mutable)
        let mrs_id = self
            .miner_round_stats_id
            .ok_or_else(|| anyhow!("miner_round_stats not set"))?;
        let (mrs_ver, mrs_dig) = self.get_ver(mrs_id).await?;
        let mrs_arg = ptb
            .obj(ObjectArg::ImmOrOwnedObject((mrs_id, mrs_ver, mrs_dig)))
            .map_err(|e| anyhow!("miner_round_stats arg: {}", e))?;

        // Single ShareDedup arg for this round.
        let dedup_id = *self
            .share_dedup_ids
            .get(&round_id)
            .ok_or_else(|| anyhow!("share_dedup not set for round {}", round_id))?;
        let (d_ver, d_dig) = self.get_ver(dedup_id).await?;
        let dedup_arg = ptb
            .obj(ObjectArg::ImmOrOwnedObject((dedup_id, d_ver, d_dig)))
            .map_err(|e| anyhow!("share_dedup arg: {}", e))?;

        // Per-template Template args.
        let mut tpl_args: HashMap<String, sui_sdk::types::transaction::Argument> =
            HashMap::new();
        for tid in &unique_templates {
            let tpl_obj_id = ObjectID::from_str(tid)
                .map_err(|_| anyhow!("Invalid template ID: {}", tid))?;
            let (tpl_ver, tpl_dig) = self.get_ver(tpl_obj_id).await?;
            let tpl_arg = ptb
                .obj(ObjectArg::ImmOrOwnedObject((tpl_obj_id, tpl_ver, tpl_dig)))
                .map_err(|e| anyhow!("template arg: {}", e))?;
            tpl_args.insert(tid.clone(), tpl_arg);
        }

        // BuyerHashpowerOrder<QuoteT> (shared mutable). Take it ONCE
        // per batch — multiple submit_share_for_buyer_pay calls in the
        // same PTB mutate the same Argument.
        let order_iver = self.get_initial_shared_ver(order_id).await?;
        let order_arg = ptb
            .obj(ObjectArg::SharedObject {
                id: order_id,
                initial_shared_version: order_iver,
                mutability: SharedObjectMutability::Mutable,
            })
            .map_err(|e| anyhow!("buyer order arg: {}", e))?;

        // Pre-bake the miner's recipient address.
        let recipient_arg = ptb
            .pure(self.address)
            .map_err(|e| anyhow!("recipient arg: {}", e))?;
        let quote_type = self.quote_type.clone();

        for (template_id, share) in batch {
            let tpl_arg = *tpl_args.get(template_id).unwrap();
            let en1_arg = ptb
                .pure(share.extranonce1.clone())
                .map_err(|e| anyhow!("en1 arg: {}", e))?;
            let en2_arg = ptb
                .pure(share.extranonce2.clone())
                .map_err(|e| anyhow!("en2 arg: {}", e))?;
            let ntime_arg = ptb.pure(share.ntime).map_err(|e| anyhow!("ntime arg: {}", e))?;
            let nonce_arg = ptb.pure(share.nonce).map_err(|e| anyhow!("nonce arg: {}", e))?;
            let ver_arg = ptb.pure(share.version).map_err(|e| anyhow!("ver arg: {}", e))?;

            // submit_share_for_buyer_pay<QuoteT>(template, order, ms, mrs,
            //   dedup, en1, en2, ntime, nonce, version, clock) -> Coin<QuoteT>
            //
            // On-chain assertion: template.owner == order.buyer. Sidecar
            // pre-flight check is unnecessary — the PTB will simply abort
            // if the operator's stratum is feeding us non-buyer-owned
            // templates.
            let coin_out = ptb.programmable_move_call(
                self.package_id,
                ident("pool"),
                ident("submit_share_for_buyer_pay"),
                vec![quote_type.clone()],
                vec![
                    tpl_arg, order_arg, ms_arg, mrs_arg, dedup_arg, en1_arg, en2_arg,
                    ntime_arg, nonce_arg, ver_arg, clock_arg,
                ],
            );

            // Route the Coin<QuoteT> to the miner's wallet within the PTB.
            ptb.command(sui_sdk::types::transaction::Command::TransferObjects(
                vec![coin_out],
                recipient_arg,
            ));
        }

        // ── Diagnostic pre-flight log ─────────────────────────────────
        //
        // Logs every input that participates in the on-chain check so a
        // failed batch can be triaged from a single log line. Specifically
        // this lets us see whether the share's `template_id` was a
        // buyer-owned template (the V2 lane requires `template.owner ==
        // order.buyer` per Move assertion).
        let template_ids_csv = unique_templates.join(",");
        info!(
            "buyer-pay PTB pre-submit — order={} sender={} quote={} templates_in_batch=[{}] shares={}",
            order_id,
            self.address,
            quote_type,
            template_ids_csv,
            batch.len()
        );

        let resp = self.exec(ptb.finish()).await?;

        // ── Post-execute status check ─────────────────────────────────
        //
        // `self.exec` returns the response even when the Move call aborts
        // (Sui treats an abort as a "successful tx with Failure status").
        // Without this check the caller would silently drop the abort
        // reason and just see a digest. Surface it as an Err so the
        // sidecar's `flush()` logs the real reason instead of an opaque
        // success digest.
        if let Some(eff) = &resp.effects {
            use sui_sdk::rpc_types::{SuiExecutionStatus, SuiTransactionBlockEffectsAPI};
            if let SuiExecutionStatus::Failure { error } = eff.status() {
                return Err(anyhow!(
                    "submit_share_for_buyer_pay aborted on chain: {} (digest: {})",
                    error,
                    resp.digest
                ));
            }
        }

        self.update_from_resp(&resp);
        Ok(resp.digest.to_string())
    }

    // ── Auto-sell (post-batch) ────────────────────────────────────────────────

    /// Place a single `hash_share_market::place_sell_order` for the miner's
    /// entire HashShare inventory of the active slot. Returns `None` when
    /// auto-sell is disabled or the wallet holds no HashShares; otherwise
    /// returns the resulting tx digest.
    ///
    /// Called by the sidecar after every successful share batch. Cheap: one
    /// shared-object PTB, no Move calls beyond `place_sell_order`. The order
    /// is owned by the miner so they can cancel/update it from the dapp.
    pub async fn auto_sell_minted(&mut self) -> Result<Option<String>> {
        let cfg = match self.auto_sell.clone() {
            Some(c) if c.price_per_unit_mist > 0 => c,
            _ => return Ok(None),
        };
        let hs_cfg = match self.hashshare.clone() {
            Some(c) => c,
            None => return Ok(None), // no active HashShare slot
        };

        // 1. Read owned Coin<HashShare> objects.
        let hs_type = hs_cfg.hashshare_type.to_string();
        let coins_page = self
            .client
            .coin_read_api()
            .get_coins(self.address, Some(hs_type.clone()), None, Some(50))
            .await
            .map_err(|e| anyhow!("get_coins(HashShare): {}", e))?;

        if coins_page.data.is_empty() {
            return Ok(None);
        }
        let total_units: u64 = coins_page.data.iter().map(|c| c.balance).sum();
        if total_units == 0 {
            return Ok(None);
        }

        // 2. Build PTB: merge all coins into the first, then place_sell_order
        //    with that aggregated coin.
        let mut ptb = ProgrammableTransactionBuilder::new();

        let mut owned_refs: Vec<(ObjectID, SequenceNumber, ObjectDigest)> =
            coins_page
                .data
                .iter()
                .map(|c| (c.coin_object_id, c.version, c.digest))
                .collect();

        let (first_id, first_ver, first_dig) = owned_refs.remove(0);
        let first_arg = ptb
            .obj(ObjectArg::ImmOrOwnedObject((first_id, first_ver, first_dig)))
            .map_err(|e| anyhow!("first coin arg: {}", e))?;

        if !owned_refs.is_empty() {
            let mut tail_args = Vec::with_capacity(owned_refs.len());
            for (oid, ver, dig) in &owned_refs {
                let a = ptb
                    .obj(ObjectArg::ImmOrOwnedObject((*oid, *ver, *dig)))
                    .map_err(|e| anyhow!("tail coin arg: {}", e))?;
                tail_args.push(a);
            }
            ptb.command(sui_sdk::types::transaction::Command::MergeCoins(
                first_arg, tail_args,
            ));
        }

        let price_arg = ptb
            .pure(cfg.price_per_unit_mist)
            .map_err(|e| anyhow!("price arg: {}", e))?;
        let expires_arg = ptb
            .pure(cfg.expires_at_ms)
            .map_err(|e| anyhow!("expires arg: {}", e))?;

        ptb.programmable_move_call(
            self.package_id,
            ident("hash_share_market"),
            ident("place_sell_order"),
            vec![hs_cfg.hashshare_type.clone(), self.quote_type.clone()],
            vec![price_arg, expires_arg, first_arg],
        );

        let resp = self.exec(ptb.finish()).await?;
        self.update_from_resp(&resp);
        Ok(Some(format!(
            "{} ({} units @ {} MIST/unit)",
            resp.digest, total_units, cfg.price_per_unit_mist
        )))
    }

    // ── Auto-fill-best-bid ───────────────────────────────────────────────────
    //
    // Scan the orderbook for resting BuyOrder<HS_NNN> objects, pick the
    // highest-priced one above the floor, and fill it via
    // `hash_share_market::fill_buy_order`. The PTB:
    //   1. Merges all owned HashShare coins into the first.
    //   2. Splits off exactly `min(my_units, order.budget / order.price)`.
    //   3. Calls fill_buy_order(order, fee_pool, coin_to_sell, ctx).
    //
    // The seller receives SUI immediately (no resting order created). Any
    // leftover HashShare inventory stays in the wallet for the next batch
    // — the sidecar's fall-through logic will try auto_sell on it.

    /// Returns `None` when auto-fill is disabled, the wallet holds no
    /// HashShares, or no resting bid meets the floor. Returns
    /// `Some((digest, summary))` on a successful fill.
    pub async fn auto_fill_best_bid(&mut self) -> Result<Option<String>> {
        let cfg = match self.auto_fill_bid.clone() {
            Some(c) => c,
            None => return Ok(None),
        };
        let hs_cfg = match self.hashshare.clone() {
            Some(c) => c,
            None => return Ok(None),
        };
        let fee_pool_id = match self.market_fee_pool_id {
            Some(id) => id,
            None => {
                warn!("auto_fill_best_bid: MarketFeePool not configured (use --market-fee-pool); skipping");
                return Ok(None);
            }
        };

        // 1. Inventory check.
        let hs_type = hs_cfg.hashshare_type.to_string();
        let coins_page = self
            .client
            .coin_read_api()
            .get_coins(self.address, Some(hs_type.clone()), None, Some(50))
            .await
            .map_err(|e| anyhow!("get_coins(HashShare): {}", e))?;
        if coins_page.data.is_empty() {
            return Ok(None);
        }
        let my_total_units: u64 = coins_page.data.iter().map(|c| c.balance).sum();
        if my_total_units == 0 {
            return Ok(None);
        }

        // 2. Discover BuyOrder<HS_NNN> candidates via event scan, then
        //    fetch each object to read current price + budget. Only orders
        //    of the active HS slot's coin type count.
        let want_buyorder_type = format!(
            "{}::hash_share_market::BuyOrder<{}, {}>",
            self.package_id, hs_type, self.quote_type
        );
        let candidates = self
            .find_buy_orders(&want_buyorder_type, &cfg)
            .await?;
        let (order_id, order_iver, price_per_unit, max_units_order_can_fill) =
            match candidates {
                Some(c) => c,
                None => return Ok(None),
            };
        let sell_units = my_total_units.min(max_units_order_can_fill);
        if sell_units == 0 {
            return Ok(None);
        }

        // 3. PTB: merge owned coins, split exact amount, fill_buy_order.
        let mut ptb = ProgrammableTransactionBuilder::new();

        let mut owned_refs: Vec<(ObjectID, SequenceNumber, ObjectDigest)> = coins_page
            .data
            .iter()
            .map(|c| (c.coin_object_id, c.version, c.digest))
            .collect();
        let (first_id, first_ver, first_dig) = owned_refs.remove(0);
        let first_arg = ptb
            .obj(ObjectArg::ImmOrOwnedObject((first_id, first_ver, first_dig)))
            .map_err(|e| anyhow!("first hs coin arg: {}", e))?;
        if !owned_refs.is_empty() {
            let mut tail_args = Vec::with_capacity(owned_refs.len());
            for (oid, ver, dig) in &owned_refs {
                tail_args.push(
                    ptb.obj(ObjectArg::ImmOrOwnedObject((*oid, *ver, *dig)))
                        .map_err(|e| anyhow!("tail hs coin arg: {}", e))?,
                );
            }
            ptb.command(sui_sdk::types::transaction::Command::MergeCoins(
                first_arg, tail_args,
            ));
        }

        // Split off sell_units into a new coin.
        let amount_arg = ptb
            .pure(sell_units)
            .map_err(|e| anyhow!("sell_units arg: {}", e))?;
        let split = ptb.command(sui_sdk::types::transaction::Command::SplitCoins(
            first_arg,
            vec![amount_arg],
        ));
        // `SplitCoins` returns NestedResult; we want index 0.
        let coin_to_sell = sui_sdk::types::transaction::Argument::NestedResult(
            match split {
                sui_sdk::types::transaction::Argument::Result(idx) => idx,
                _ => return Err(anyhow!("SplitCoins did not return Result")),
            },
            0,
        );

        // Order: shared mutable.
        let order_arg = ptb
            .obj(ObjectArg::SharedObject {
                id: order_id,
                initial_shared_version: order_iver,
                mutability: SharedObjectMutability::Mutable,
            })
            .map_err(|e| anyhow!("order arg: {}", e))?;
        let fee_pool_iver = self.get_initial_shared_ver(fee_pool_id).await?;
        let fee_pool_arg = ptb
            .obj(ObjectArg::SharedObject {
                id: fee_pool_id,
                initial_shared_version: fee_pool_iver,
                mutability: SharedObjectMutability::Immutable,
            })
            .map_err(|e| anyhow!("fee_pool arg: {}", e))?;

        ptb.programmable_move_call(
            self.package_id,
            ident("hash_share_market"),
            ident("fill_buy_order"),
            vec![hs_cfg.hashshare_type.clone(), self.quote_type.clone()],
            vec![order_arg, fee_pool_arg, coin_to_sell],
        );

        let resp = self.exec(ptb.finish()).await?;
        self.update_from_resp(&resp);
        Ok(Some(format!(
            "{} (filled {} units @ {} MIST/unit on order {})",
            resp.digest, sell_units, price_per_unit, order_id
        )))
    }

    /// Returns `Some((order_id, initial_shared_version, price, max_units))`
    /// for the highest-priced BuyOrder matching the active HS type whose
    /// price meets the floor; `None` if no candidate.
    async fn find_buy_orders(
        &self,
        want_type: &str,
        cfg: &AutoFillBidConfig,
    ) -> Result<Option<(ObjectID, SequenceNumber, u64, u64)>> {
        // Walk last 100 BuyOrderPlaced events.
        let event_type = format!(
            "{}::hash_share_market::BuyOrderPlaced",
            self.package_id
        );
        let filter = EventFilter::MoveEventType(
            event_type
                .parse()
                .map_err(|e| anyhow!("parse event type: {}", e))?,
        );
        let page = self
            .client
            .event_api()
            .query_events(filter, None, Some(100), true)
            .await
            .map_err(|e| anyhow!("query_events: {}", e))?;

        let mut best: Option<(ObjectID, SequenceNumber, u64, u64)> = None;
        for ev in page.data {
            let order_id_hex = match ev.parsed_json["order_id"].as_str() {
                Some(s) => s,
                None => continue,
            };
            let normalized = if order_id_hex.starts_with("0x") {
                order_id_hex.to_string()
            } else {
                format!("0x{}", order_id_hex)
            };
            let order_id = match ObjectID::from_str(&normalized) {
                Ok(id) => id,
                Err(_) => continue,
            };

            // Fetch object — need type + content.
            let opts = SuiObjectDataOptions::new()
                .with_type()
                .with_content()
                .with_owner();
            let resp = match self
                .client
                .read_api()
                .get_object_with_options(order_id, opts)
                .await
            {
                Ok(r) => r,
                Err(_) => continue,
            };
            let data = match resp.data {
                Some(d) => d,
                None => continue, // deleted / cancelled
            };
            // Type-match the BuyOrder<HS_NNN> generic instance.
            if data
                .type_
                .as_ref()
                .map(|t| t.to_string() != want_type)
                .unwrap_or(true)
            {
                continue;
            }
            // Extract price + remaining budget from move object fields.
            let (price, budget) = match read_buy_order_fields(&data) {
                Some(v) => v,
                None => continue,
            };
            if price < cfg.floor_price_mist || budget == 0 {
                continue;
            }
            let max_units = budget / price;
            if max_units == 0 {
                continue;
            }
            // Read the shared-object initial_shared_version from Owner.
            let iver = match data.owner {
                Some(Owner::Shared { initial_shared_version, .. }) => initial_shared_version,
                _ => continue,
            };
            let candidate = (order_id, iver, price, max_units);
            best = Some(match best {
                None => candidate,
                Some(b) if price > b.2 => candidate,
                Some(b) => b,
            });
        }
        Ok(best)
    }

    // ── Auto-sell peg-to-market ──────────────────────────────────────────────
    //
    // Compute a target price relative to the live orderbook each batch, then
    // either top up the miner's existing SellOrder + retarget its price, or
    // place a fresh one. The active order is discovered by scanning
    // SellOrderPlaced events filtered by `seller == self.address`.

    /// Returns `None` when the peg config is missing, when the wallet holds
    /// no HashShares, or when the orderbook gives us no anchor and there's
    /// no fallback floor. Returns `Some((digest, summary))` on success.
    pub async fn auto_sell_pegged(&mut self) -> Result<Option<String>> {
        let cfg = match self.auto_sell_peg.clone() {
            Some(c) => c,
            None => return Ok(None),
        };
        let hs_cfg = match self.hashshare.clone() {
            Some(c) => c,
            None => return Ok(None),
        };

        // 1. Inventory.
        let hs_type = hs_cfg.hashshare_type.to_string();
        let coins_page = self
            .client
            .coin_read_api()
            .get_coins(self.address, Some(hs_type.clone()), None, Some(50))
            .await
            .map_err(|e| anyhow!("get_coins(HashShare): {}", e))?;
        if coins_page.data.is_empty() {
            return Ok(None);
        }
        let new_units: u64 = coins_page.data.iter().map(|c| c.balance).sum();
        if new_units == 0 {
            return Ok(None);
        }

        // 2. Compute target price from orderbook.
        let want_buy = format!(
            "{}::hash_share_market::BuyOrder<{}, {}>",
            self.package_id, hs_type, self.quote_type
        );
        let want_sell = format!(
            "{}::hash_share_market::SellOrder<{}, {}>",
            self.package_id, hs_type, self.quote_type
        );
        let (best_bid, best_ask) = self
            .scan_orderbook_top(&want_buy, &want_sell)
            .await?;
        let anchor_price = match (cfg.anchor, best_bid, best_ask) {
            (PegAnchor::BestBid, Some(b), _) => b,
            (PegAnchor::BestAsk, _, Some(a)) => a.saturating_sub(1),
            (PegAnchor::Mid, Some(b), Some(a)) => (b + a) / 2,
            (PegAnchor::Mid, Some(b), None) => b,
            (PegAnchor::Mid, None, Some(a)) => a.saturating_sub(1),
            (_, _, _) => 0,
        };
        let target = apply_bps(anchor_price, cfg.offset_bps);
        // Floor selection priority on an empty orderbook:
        //   1. the dynamic atomic (off-chain feeder, live BTC + difficulty)
        //   2. the static fallback in the env-driven config
        //   3. skip the batch if neither is set
        let dynamic_floor = self
            .dynamic_floor_mist
            .as_ref()
            .map(|a| a.load(std::sync::atomic::Ordering::Relaxed))
            .unwrap_or(0);
        let target = if target > 0 {
            target
        } else if dynamic_floor > 0 {
            dynamic_floor
        } else if cfg.fallback_floor_mist > 0 {
            cfg.fallback_floor_mist
        } else {
            warn!("auto_sell_pegged: empty orderbook + no fallback_floor; skipping");
            return Ok(None);
        };

        // 3. Find an existing live SellOrder owned by this miner.
        let existing = self
            .find_my_active_sell_order(&want_sell)
            .await?;

        // 4. Build PTB.
        let mut ptb = ProgrammableTransactionBuilder::new();
        let mut owned_refs: Vec<(ObjectID, SequenceNumber, ObjectDigest)> = coins_page
            .data
            .iter()
            .map(|c| (c.coin_object_id, c.version, c.digest))
            .collect();
        let (first_id, first_ver, first_dig) = owned_refs.remove(0);
        let first_arg = ptb
            .obj(ObjectArg::ImmOrOwnedObject((first_id, first_ver, first_dig)))
            .map_err(|e| anyhow!("first hs coin arg: {}", e))?;
        if !owned_refs.is_empty() {
            let mut tail_args = Vec::with_capacity(owned_refs.len());
            for (oid, ver, dig) in &owned_refs {
                tail_args.push(
                    ptb.obj(ObjectArg::ImmOrOwnedObject((*oid, *ver, *dig)))
                        .map_err(|e| anyhow!("tail hs coin arg: {}", e))?,
                );
            }
            ptb.command(sui_sdk::types::transaction::Command::MergeCoins(
                first_arg, tail_args,
            ));
        }

        if let Some((order_id, order_iver, current_price)) = existing {
            // Top up the existing order with this batch's coins; then
            // retarget price if it drifted by more than 1 MIST/unit.
            let order_arg = ptb
                .obj(ObjectArg::SharedObject {
                    id: order_id,
                    initial_shared_version: order_iver,
                    mutability: SharedObjectMutability::Mutable,
                })
                .map_err(|e| anyhow!("order arg: {}", e))?;
            ptb.programmable_move_call(
                self.package_id,
                ident("hash_share_market"),
                ident("top_up_sell_order"),
                vec![hs_cfg.hashshare_type.clone(), self.quote_type.clone()],
                vec![order_arg, first_arg],
            );
            if current_price != target {
                let price_arg = ptb
                    .pure(target)
                    .map_err(|e| anyhow!("price arg: {}", e))?;
                ptb.programmable_move_call(
                    self.package_id,
                    ident("hash_share_market"),
                    ident("update_sell_order_price"),
                    vec![hs_cfg.hashshare_type.clone(), self.quote_type.clone()],
                    vec![order_arg, price_arg],
                );
            }
            let resp = self.exec(ptb.finish()).await?;
            self.update_from_resp(&resp);
            return Ok(Some(format!(
                "{} (peg {:?}±{}bps → {} MIST/unit · topped order {} with {} units)",
                resp.digest, cfg.anchor, cfg.offset_bps, target, order_id, new_units
            )));
        }

        // No existing order — place fresh.
        let price_arg = ptb
            .pure(target)
            .map_err(|e| anyhow!("price arg: {}", e))?;
        let expires_arg = ptb
            .pure(cfg.expires_at_ms)
            .map_err(|e| anyhow!("expires arg: {}", e))?;
        ptb.programmable_move_call(
            self.package_id,
            ident("hash_share_market"),
            ident("place_sell_order"),
            vec![hs_cfg.hashshare_type.clone(), self.quote_type.clone()],
            vec![price_arg, expires_arg, first_arg],
        );
        let resp = self.exec(ptb.finish()).await?;
        self.update_from_resp(&resp);
        Ok(Some(format!(
            "{} (peg {:?}±{}bps → placed {} units @ {} MIST/unit)",
            resp.digest, cfg.anchor, cfg.offset_bps, new_units, target
        )))
    }

    /// Walk the last 100 BuyOrderPlaced + SellOrderPlaced events for
    /// matching coin types and return (best_bid_price, best_ask_price).
    /// Returns None for either side when no live orders are observed.
    async fn scan_orderbook_top(
        &self,
        want_buy_type: &str,
        want_sell_type: &str,
    ) -> Result<(Option<u64>, Option<u64>)> {
        let mut best_bid: Option<u64> = None;
        let mut best_ask: Option<u64> = None;

        let bid_evt = format!(
            "{}::hash_share_market::BuyOrderPlaced",
            self.package_id
        );
        let bid_page = self
            .client
            .event_api()
            .query_events(
                EventFilter::MoveEventType(bid_evt.parse().map_err(|e| anyhow!("{}", e))?),
                None,
                Some(100),
                true,
            )
            .await
            .map_err(|e| anyhow!("query_events: {}", e))?;
        for ev in bid_page.data {
            let order_id_hex = match ev.parsed_json["order_id"].as_str() {
                Some(s) => s,
                None => continue,
            };
            let norm = if order_id_hex.starts_with("0x") {
                order_id_hex.to_string()
            } else {
                format!("0x{}", order_id_hex)
            };
            let oid = match ObjectID::from_str(&norm) {
                Ok(id) => id,
                Err(_) => continue,
            };
            let resp = match self
                .client
                .read_api()
                .get_object_with_options(
                    oid,
                    SuiObjectDataOptions::new().with_type().with_content(),
                )
                .await
            {
                Ok(r) => r,
                Err(_) => continue,
            };
            let data = match resp.data {
                Some(d) => d,
                None => continue,
            };
            if data
                .type_
                .as_ref()
                .map(|t| t.to_string() != want_buy_type)
                .unwrap_or(true)
            {
                continue;
            }
            if let Some((price, budget)) = read_buy_order_fields(&data) {
                if budget > 0 {
                    best_bid = Some(match best_bid {
                        None => price,
                        Some(b) if price > b => price,
                        Some(b) => b,
                    });
                }
            }
        }

        let ask_evt = format!(
            "{}::hash_share_market::SellOrderPlaced",
            self.package_id
        );
        let ask_page = self
            .client
            .event_api()
            .query_events(
                EventFilter::MoveEventType(ask_evt.parse().map_err(|e| anyhow!("{}", e))?),
                None,
                Some(100),
                true,
            )
            .await
            .map_err(|e| anyhow!("query_events: {}", e))?;
        for ev in ask_page.data {
            let order_id_hex = match ev.parsed_json["order_id"].as_str() {
                Some(s) => s,
                None => continue,
            };
            let norm = if order_id_hex.starts_with("0x") {
                order_id_hex.to_string()
            } else {
                format!("0x{}", order_id_hex)
            };
            let oid = match ObjectID::from_str(&norm) {
                Ok(id) => id,
                Err(_) => continue,
            };
            let resp = match self
                .client
                .read_api()
                .get_object_with_options(
                    oid,
                    SuiObjectDataOptions::new().with_type().with_content(),
                )
                .await
            {
                Ok(r) => r,
                Err(_) => continue,
            };
            let data = match resp.data {
                Some(d) => d,
                None => continue,
            };
            if data
                .type_
                .as_ref()
                .map(|t| t.to_string() != want_sell_type)
                .unwrap_or(true)
            {
                continue;
            }
            if let Some((price, inventory)) = read_sell_order_fields(&data) {
                if inventory > 0 {
                    best_ask = Some(match best_ask {
                        None => price,
                        Some(b) if price < b => price,
                        Some(b) => b,
                    });
                }
            }
        }

        Ok((best_bid, best_ask))
    }

    /// Find the most recent live SellOrder owned by this miner for the
    /// active HS slot. Returns (order_id, initial_shared_version, current_price).
    async fn find_my_active_sell_order(
        &self,
        want_sell_type: &str,
    ) -> Result<Option<(ObjectID, SequenceNumber, u64)>> {
        let evt = format!(
            "{}::hash_share_market::SellOrderPlaced",
            self.package_id
        );
        let page = self
            .client
            .event_api()
            .query_events(
                EventFilter::MoveEventType(evt.parse().map_err(|e| anyhow!("{}", e))?),
                None,
                Some(100),
                true,
            )
            .await
            .map_err(|e| anyhow!("query_events: {}", e))?;
        for ev in page.data {
            let seller_hex = ev.parsed_json["seller"].as_str().unwrap_or("");
            let seller_norm = if seller_hex.starts_with("0x") {
                seller_hex.to_string()
            } else {
                format!("0x{}", seller_hex)
            };
            if SuiAddress::from_str(&seller_norm)
                .map(|a| a != self.address)
                .unwrap_or(true)
            {
                continue;
            }
            let order_id_hex = match ev.parsed_json["order_id"].as_str() {
                Some(s) => s,
                None => continue,
            };
            let norm = if order_id_hex.starts_with("0x") {
                order_id_hex.to_string()
            } else {
                format!("0x{}", order_id_hex)
            };
            let oid = match ObjectID::from_str(&norm) {
                Ok(id) => id,
                Err(_) => continue,
            };
            let opts = SuiObjectDataOptions::new()
                .with_type()
                .with_content()
                .with_owner();
            let resp = match self
                .client
                .read_api()
                .get_object_with_options(oid, opts)
                .await
            {
                Ok(r) => r,
                Err(_) => continue,
            };
            let data = match resp.data {
                Some(d) => d,
                None => continue, // deleted / cancelled
            };
            if data
                .type_
                .as_ref()
                .map(|t| t.to_string() != want_sell_type)
                .unwrap_or(true)
            {
                continue;
            }
            let iver = match data.owner {
                Some(Owner::Shared { initial_shared_version, .. }) => initial_shared_version,
                _ => continue,
            };
            let (price, inventory) = match read_sell_order_fields(&data) {
                Some(v) => v,
                None => continue,
            };
            if inventory == 0 {
                continue; // empty resting order — skip
            }
            return Ok(Some((oid, iver, price)));
        }
        Ok(None)
    }

    // ── Round accumulation ────────────────────────────────────────────────────

    /// Check once per 30 s whether the operator has opened a RoundAccumulator
    /// for our current round. If so, drain our MinerRoundStats into it.
    /// Called periodically from the sidecar batch-flusher loop.
    pub async fn poll_and_accumulate(&mut self) -> Result<()> {
        if let Some(at) = self.acc_check_at {
            if at.elapsed() < Duration::from_secs(30) {
                return Ok(());
            }
        }
        self.acc_check_at = Some(Instant::now());

        let round_id = self.current_round;
        if self.accumulated_rounds.contains(&round_id) {
            return Ok(());
        }
        let mrs_id = match self.miner_round_stats_id {
            Some(id) => id,
            None => return Ok(()),
        };

        let acc_id = match self.find_accumulator_for_round(round_id).await? {
            Some(id) => id,
            None => return Ok(()),
        };

        self.do_accumulate(acc_id, mrs_id).await?;
        self.accumulated_rounds.insert(round_id);
        info!("Accumulated round {} stats into accumulator {}", round_id, acc_id);
        Ok(())
    }

    async fn find_accumulator_for_round(&self, round_id: u64) -> Result<Option<ObjectID>> {
        let event_type = format!("{}::pool::RoundAccumulatorOpened", self.package_id);
        let filter = EventFilter::MoveEventType(
            event_type.parse().map_err(|e| anyhow!("parse event type: {}", e))?,
        );
        let page = self.client.event_api()
            .query_events(filter, None, Some(10), true)
            .await
            .map_err(|e| anyhow!("query_events: {}", e))?;

        for ev in page.data {
            let r = ev.parsed_json["round_id"]
                .as_u64()
                .or_else(|| ev.parsed_json["round_id"].as_str().and_then(|s| s.parse().ok()))
                .unwrap_or(u64::MAX);
            if r == round_id {
                let hex = ev.parsed_json["accumulator_id"].as_str().unwrap_or("");
                let normalized = if hex.starts_with("0x") {
                    hex.to_string()
                } else {
                    format!("0x{}", hex)
                };
                if let Ok(id) = ObjectID::from_str(&normalized) {
                    return Ok(Some(id));
                }
            }
        }
        Ok(None)
    }

    async fn do_accumulate(&mut self, acc_id: ObjectID, mrs_id: ObjectID) -> Result<()> {
        let acc_iver = self.get_initial_shared_ver(acc_id).await?;
        let (mrs_ver, mrs_dig) = self.get_ver(mrs_id).await?;

        let mut ptb = ProgrammableTransactionBuilder::new();

        let acc_arg = ptb.obj(ObjectArg::SharedObject {
            id: acc_id,
            initial_shared_version: acc_iver,
            mutability: SharedObjectMutability::Mutable,
        }).map_err(|e| anyhow!("acc arg: {}", e))?;

        let mrs_arg = ptb.obj(ObjectArg::ImmOrOwnedObject((mrs_id, mrs_ver, mrs_dig)))
            .map_err(|e| anyhow!("mrs arg: {}", e))?;

        let mrs_vec_arg = ptb.command(
            sui_sdk::types::transaction::Command::MakeMoveVec(None, vec![mrs_arg])
        );

        ptb.programmable_move_call(
            self.package_id,
            ident("pool"),
            ident("accumulate_miner_stats"),
            vec![],
            vec![acc_arg, mrs_vec_arg],
        );

        let resp = self.exec(ptb.finish()).await?;
        self.update_from_resp(&resp);
        Ok(())
    }

    // ── Object lifecycle helpers ──────────────────────────────────────────────

    /// Delete a MinerRoundStats object to reclaim its storage rebate.
    /// Only safe to call after the round's work has been accumulated (MinerWorkAccumulated
    /// event is the permanent on-chain record that replaces the object).
    async fn close_mrs(&mut self, mrs_id: ObjectID) -> Result<()> {
        let (mrs_ver, mrs_dig) = self.get_ver(mrs_id).await?;
        let mut ptb = ProgrammableTransactionBuilder::new();
        let mrs_arg = ptb.obj(ObjectArg::ImmOrOwnedObject((mrs_id, mrs_ver, mrs_dig)))
            .map_err(|e| anyhow!("mrs arg: {}", e))?;
        ptb.programmable_move_call(
            self.package_id,
            ident("miner"),
            ident("close_miner_round_stats"),
            vec![],
            vec![mrs_arg],
        );
        let resp = self.exec(ptb.finish()).await?;
        self.update_from_resp(&resp);
        self.obj_vers.remove(&mrs_id);
        info!("MinerRoundStats {} deleted — storage rebate reclaimed", mrs_id);
        Ok(())
    }

    async fn ensure_round_stats(&mut self, round_id: u64) -> Result<()> {
        if self.current_round == round_id && self.miner_round_stats_id.is_some() {
            return Ok(());
        }
        // Round has advanced — close the old MRS if we already accumulated it.
        // The MinerWorkAccumulated event is the permanent record, so deletion is safe.
        if self.current_round != round_id {
            if let Some(old_mrs_id) = self.miner_round_stats_id {
                if self.accumulated_rounds.contains(&self.current_round) {
                    if let Err(e) = self.close_mrs(old_mrs_id).await {
                        warn!("Failed to close MinerRoundStats for round {}: {}", self.current_round, e);
                    } else {
                        self.miner_round_stats_id = None;
                    }
                }
            }
        }
        let mrs_type = format!("{}::miner::MinerRoundStats", self.package_id);
        if let Some(id) = self.find_owned_for_round(&mrs_type, round_id).await? {
            self.current_round = round_id;
            self.miner_round_stats_id = Some(id);
            return Ok(());
        }
        let mut ptb = ProgrammableTransactionBuilder::new();
        let mrr_id = self.miner_round_registry_id
            .ok_or_else(|| anyhow!("miner_round_registry_id required after trustless cleanup; \
                                   set with `with_miner_round_registry`"))?;
        // SharedObject args need `initial_shared_version` (the version at which
        // the object was first shared — never changes), not the current version.
        // Passing the current version causes validators to reject the tx, which
        // the SDK's QuorumDriver retries internally until the 60s deadline
        // fires — surfacing as "execute_transaction_block: Request timeout".
        // Latent until the registry has been mutated since init (current != initial).
        // See `get_initial_shared_ver` docstring.
        let mrr_iver = self.get_initial_shared_ver(mrr_id).await?;
        let mrr_arg = ptb.obj(ObjectArg::SharedObject {
            id: mrr_id,
            initial_shared_version: mrr_iver,
            mutability: SharedObjectMutability::Mutable,
        }).map_err(|e| anyhow!("MinerRoundRegistry arg: {}", e))?;
        let round_arg = ptb.pure(round_id).map_err(|e| anyhow!("{}", e))?;
        let height_arg = ptb.pure(self.pool_height).map_err(|e| anyhow!("{}", e))?;
        ptb.programmable_move_call(
            self.package_id,
            ident("miner"),
            ident("create_round_stats"),
            vec![],
            vec![mrr_arg, round_arg, height_arg],
        );
        let resp = self.exec(ptb.finish()).await?;

        let id_from_changes = resp.object_changes.as_ref().and_then(|changes| {
            changes.iter().find_map(|c| {
                if let ObjectChange::Created { object_id, object_type, .. } = c {
                    if object_type.name.as_str() == "MinerRoundStats" {
                        return Some(*object_id);
                    }
                }
                None
            })
        });

        self.update_from_resp(&resp);

        let id = if let Some(id) = id_from_changes {
            id
        } else {
            self.find_owned_for_round(&mrs_type, round_id).await?
                .ok_or_else(|| anyhow!("MinerRoundStats not found after creation"))?
        };
        self.current_round = round_id;
        self.miner_round_stats_id = Some(id);
        info!("Created MinerRoundStats for round {}: {}", round_id, id);
        Ok(())
    }

    async fn ensure_share_dedup(&mut self, round_id: u64) -> Result<()> {
        if self.share_dedup_ids.contains_key(&round_id) {
            return Ok(());
        }
        let dedup_type = format!("{}::share_dedup::ShareDedup", self.package_id);
        if let Some(id) = self.find_owned_dedup(&dedup_type, round_id).await? {
            self.share_dedup_ids.insert(round_id, id);
            return Ok(());
        }
        let mut ptb = ProgrammableTransactionBuilder::new();
        let reg_id = self.dedup_registry_id.ok_or_else(|| anyhow!("dedup_registry not configured"))?;
        let reg_iver = self.get_initial_shared_ver(reg_id).await?;
        let reg_arg = ptb.obj(ObjectArg::SharedObject {
            id: reg_id,
            initial_shared_version: reg_iver,
            mutability: SharedObjectMutability::Mutable,
        }).map_err(|e| anyhow!("dedup_registry arg: {}", e))?;
        let round_arg = ptb.pure(round_id).map_err(|e| anyhow!("{}", e))?;
        ptb.programmable_move_call(
            self.package_id,
            ident("share_dedup"),
            ident("create_share_dedup"),
            vec![],
            vec![reg_arg, round_arg],
        );
        let resp = self.exec(ptb.finish()).await?;

        let id_from_changes = resp.object_changes.as_ref().and_then(|changes| {
            changes.iter().find_map(|c| {
                if let ObjectChange::Created { object_id, object_type, .. } = c {
                    if object_type.name.as_str() == "ShareDedup" {
                        return Some(*object_id);
                    }
                }
                None
            })
        });

        self.update_from_resp(&resp);

        let id = if let Some(id) = id_from_changes {
            id
        } else {
            self.find_owned_dedup(&dedup_type, round_id).await?
                .ok_or_else(|| anyhow!("ShareDedup not found after creation"))?
        };
        self.share_dedup_ids.insert(round_id, id);
        info!("Created ShareDedup for round {}: {}", round_id, id);
        Ok(())
    }

    // ── Version cache ─────────────────────────────────────────────────────────

    async fn get_ver(
        &mut self,
        id: ObjectID,
    ) -> Result<(SequenceNumber, ObjectDigest)> {
        if let Some(&cached) = self.obj_vers.get(&id) {
            return Ok(cached);
        }
        let resp = self.client.read_api()
            .get_object_with_options(id, SuiObjectDataOptions::new())
            .await
            .map_err(|e| anyhow!("get_object {}: {}", id, e))?;
        let data = resp.data.ok_or_else(|| anyhow!("Object {} not found", id))?;
        let entry = (data.version, data.digest);
        self.obj_vers.insert(id, entry);
        Ok(entry)
    }

    /// Fetch the `initial_shared_version` of a shared object.
    /// This is the SequenceNumber at which the object was first shared — never changes.
    /// `ObjectArg::SharedObject` requires this value; passing the current version
    /// causes validators to reject the transaction (manifests as a 504 timeout).
    async fn get_initial_shared_ver(&self, id: ObjectID) -> Result<SequenceNumber> {
        let resp = self.client.read_api()
            .get_object_with_options(id, SuiObjectDataOptions::new().with_owner())
            .await
            .map_err(|e| anyhow!("get_object {}: {}", id, e))?;
        let data = resp.data.ok_or_else(|| anyhow!("Object {} not found", id))?;
        let owner = data.owner.ok_or_else(|| anyhow!("Object {} owner not returned", id))?;
        match owner {
            Owner::Shared { initial_shared_version } => Ok(initial_shared_version),
            _ => Err(anyhow!("Object {} is not a shared object", id)),
        }
    }

    async fn clock_arg(
        &mut self,
        ptb: &mut ProgrammableTransactionBuilder,
    ) -> Result<sui_sdk::types::transaction::Argument> {
        let clock_id = ObjectID::from_str("0x6").unwrap();
        let ver = if let Some(v) = self.clock_ver {
            v
        } else {
            let v = self.get_initial_shared_ver(clock_id).await?;
            self.clock_ver = Some(v);
            v
        };
        ptb.obj(ObjectArg::SharedObject {
            id: clock_id,
            initial_shared_version: ver,
            mutability: SharedObjectMutability::Immutable,
        })
        .map_err(|e| anyhow!("clock arg: {}", e))
    }

    fn update_from_resp(&mut self, resp: &SuiTransactionBlockResponse) {
        if let Some(changes) = &resp.object_changes {
            for change in changes {
                let entry = match change {
                    ObjectChange::Mutated { object_id, version, digest, .. } => {
                        Some((*object_id, *version, *digest))
                    }
                    ObjectChange::Created { object_id, version, digest, .. } => {
                        Some((*object_id, *version, *digest))
                    }
                    // Capture the new version when an owned object is transferred back
                    // to us (e.g. MinerRoundStats returned by accumulate_miner_stats).
                    ObjectChange::Transferred { object_id, version, digest, .. } => {
                        Some((*object_id, *version, *digest))
                    }
                    _ => None,
                };
                if let Some((oid, ver, dig)) = entry {
                    self.obj_vers.insert(oid, (ver, dig));
                }
            }
        }
        // Refresh gas coin version if it appeared in object_changes.
        // Clear cache if not found so the next exec() re-fetches fresh.
        let gas_id = self.gas_coin.map(|(id, _, _)| id);
        if let Some(gid) = gas_id {
            if let Some(&(v, d)) = self.obj_vers.get(&gid) {
                self.gas_coin = Some((gid, v, d));
            } else {
                self.gas_coin = None;
            }
        }
    }

    // ── Pool round cache ──────────────────────────────────────────────────────

    async fn fetch_pool_round(&mut self) -> Result<u64> {
        if let Some(at) = self.pool_round_at {
            if at.elapsed() < ROUND_TTL {
                return Ok(self.pool_round);
            }
        }
        let resp = self.client.read_api()
            .get_object_with_options(self.pool_id, SuiObjectDataOptions::new().with_content())
            .await
            .map_err(|e| anyhow!("pool RPC: {}", e))?;
        let data = resp.data.ok_or_else(|| anyhow!("Pool not found"))?;
        let content = data.content.ok_or_else(|| anyhow!("Pool no content"))?;
        let json = serde_json::to_value(content).unwrap_or_default();
        let fields = &json["fields"];
        let round = fields["current_round"]
            .as_u64()
            .or_else(|| fields["current_round"].as_str().and_then(|s| s.parse().ok()))
            .ok_or_else(|| anyhow!("Cannot read current_round"))?;
        // Also cache current_height so create_round_stats can anchor to the latest block.
        let height = fields["current_height"]
            .as_u64()
            .or_else(|| fields["current_height"].as_str().and_then(|s| s.parse().ok()))
            .unwrap_or(0);
        self.pool_round = round;
        self.pool_height = height;
        self.pool_round_at = Some(Instant::now());
        Ok(round)
    }

    // ── Owned object discovery ────────────────────────────────────────────────

    async fn find_owned_id(&self, struct_type: &str) -> Result<Option<ObjectID>> {
        let filter = SuiObjectDataFilter::StructType(
            struct_type.parse().map_err(|e| anyhow!("Bad type: {}", e))?,
        );
        let page = self.client.read_api()
            .get_owned_objects(
                self.address,
                Some(SuiObjectResponseQuery { filter: Some(filter), options: None }),
                None,
                Some(1),
            )
            .await
            .map_err(|e| anyhow!("get_owned_objects: {}", e))?;
        Ok(page.data.first().and_then(|r| r.data.as_ref()).map(|d| d.object_id))
    }

    async fn find_owned_for_round(
        &self,
        struct_type: &str,
        round_id: u64,
    ) -> Result<Option<ObjectID>> {
        let filter = SuiObjectDataFilter::StructType(
            struct_type.parse().map_err(|e| anyhow!("Bad type: {}", e))?,
        );
        let page = self.client.read_api()
            .get_owned_objects(
                self.address,
                Some(SuiObjectResponseQuery {
                    filter: Some(filter),
                    options: Some(SuiObjectDataOptions::new().with_content()),
                }),
                None,
                Some(50),
            )
            .await
            .map_err(|e| anyhow!("get_owned_objects: {}", e))?;
        for item in &page.data {
            if let Some(data) = &item.data {
                if let Some(content) = &data.content {
                    let json = serde_json::to_value(content).unwrap_or_default();
                    let r = json["fields"]["round_id"]
                        .as_u64()
                        .or_else(|| {
                            json["fields"]["round_id"].as_str().and_then(|s| s.parse().ok())
                        })
                        .unwrap_or(u64::MAX);
                    if r == round_id {
                        return Ok(Some(data.object_id));
                    }
                }
            }
        }
        Ok(None)
    }

    async fn find_owned_dedup(
        &self,
        struct_type: &str,
        round_id: u64,
    ) -> Result<Option<ObjectID>> {
        let filter = SuiObjectDataFilter::StructType(
            struct_type.parse().map_err(|e| anyhow!("Bad type: {}", e))?,
        );
        let page = self.client.read_api()
            .get_owned_objects(
                self.address,
                Some(SuiObjectResponseQuery {
                    filter: Some(filter),
                    options: Some(SuiObjectDataOptions::new().with_content()),
                }),
                None,
                Some(50),
            )
            .await
            .map_err(|e| anyhow!("get_owned_objects: {}", e))?;
        for item in &page.data {
            if let Some(data) = &item.data {
                if let Some(content) = &data.content {
                    let json = serde_json::to_value(content).unwrap_or_default();
                    let r = json["fields"]["round_id"]
                        .as_u64()
                        .or_else(|| {
                            json["fields"]["round_id"].as_str().and_then(|s| s.parse().ok())
                        })
                        .unwrap_or(u64::MAX);
                    if r == round_id {
                        return Ok(Some(data.object_id));
                    }
                }
            }
        }
        Ok(None)
    }

    // ── Transaction execution ─────────────────────────────────────────────────

    async fn exec(
        &mut self,
        pt: ProgrammableTransaction,
    ) -> Result<SuiTransactionBlockResponse> {
        let result = execute_ptb(
            &self.client, &self.keypair, self.address, self.gas_budget, pt,
            &mut self.gas_price, &mut self.gas_price_at, &mut self.gas_coin,
        ).await;

        // If a transaction failed due to a stale owned-object version, drop the
        // entire version cache so every owned object is re-fetched on the next exec.
        if let Err(ref e) = result {
            let msg = e.to_string();
            if msg.contains("unavailable for consumption") || msg.contains("version") {
                self.obj_vers.clear();
            }
        }

        result
    }
}

// ── Shared standalone helpers ─────────────────────────────────────────────────

/// Load a keypair from a Sui JSON keystore file.
///
/// If the keystore has multiple keys, tries to match the active address from
/// the `client.yaml` sitting next to the keystore.  Falls back to the first
/// key if the active address cannot be determined or does not match any entry.
pub fn load_keystore(path: &str) -> Result<SuiKeyPair> {
    let expanded = if path.starts_with("~/") {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .map_err(|_| anyhow!("HOME not set"))?;
        format!("{}{}", home, &path[1..])
    } else {
        path.to_string()
    };
    let content = std::fs::read_to_string(&expanded)
        .map_err(|e| anyhow!("Cannot read keystore {}: {}", expanded, e))?;
    let keys: Vec<String> = serde_json::from_str(content.trim())
        .map_err(|e| anyhow!("Cannot parse keystore JSON: {}", e))?;

    if keys.len() > 1 {
        // Try to read active_address from client.yaml next to the keystore.
        let client_yaml = std::path::Path::new(&expanded)
            .parent()
            .map(|p| p.join("client.yaml"));
        if let Some(yaml_path) = client_yaml {
            if let Ok(yaml) = std::fs::read_to_string(&yaml_path) {
                // Extract active_address: "0x..." line without pulling in a yaml dep.
                let active = yaml.lines()
                    .find_map(|l| {
                        let l = l.trim();
                        let prefix = "active_address:";
                        if l.starts_with(prefix) {
                            Some(l[prefix.len()..].trim().trim_matches('"').to_lowercase())
                        } else {
                            None
                        }
                    });
                if let Some(active_addr) = active {
                    for key_b64 in &keys {
                        if let Ok(kp) = SuiKeyPair::decode_base64(key_b64) {
                            let addr = SuiAddress::from(&kp.public()).to_string().to_lowercase();
                            if addr == active_addr {
                                return Ok(kp);
                            }
                        }
                    }
                }
            }
        }
    }

    let key = keys.into_iter().next().ok_or_else(|| anyhow!("Empty keystore"))?;
    SuiKeyPair::decode_base64(&key).map_err(|e| anyhow!("Invalid keypair: {}", e))
}

/// Load a specific keypair from the keystore by Sui address. Unlike
/// `load_keystore`, this ignores `client.yaml`'s active_address and
/// matches the supplied address directly. Used by stratum-server +
/// miner-sidecar to lock the signer to whatever the operator's env file
/// specifies, independent of the global CLI state.
pub fn load_keystore_by_address(path: &str, address: &str) -> Result<SuiKeyPair> {
    let expanded = if path.starts_with("~/") {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .map_err(|_| anyhow!("HOME not set"))?;
        format!("{}{}", home, &path[1..])
    } else {
        path.to_string()
    };
    let content = std::fs::read_to_string(&expanded)
        .map_err(|e| anyhow!("Cannot read keystore {}: {}", expanded, e))?;
    let keys: Vec<String> = serde_json::from_str(content.trim())
        .map_err(|e| anyhow!("Cannot parse keystore JSON: {}", e))?;

    let target = address.to_lowercase();
    for key_b64 in &keys {
        if let Ok(kp) = SuiKeyPair::decode_base64(key_b64) {
            let addr = SuiAddress::from(&kp.public()).to_string().to_lowercase();
            if addr == target {
                return Ok(kp);
            }
        }
    }
    Err(anyhow!(
        "Address {} not found in keystore at {}",
        address,
        expanded,
    ))
}

/// Build, sign, and execute a PTB.  Used by both `MinerClient` and the
/// operator-level `SuiSubmitter`.
///
/// `gas_price_cache` and `gas_coin_cache` are optional in-out caches;
/// pass `&mut 0` / `&mut None` for a stateless call.
#[allow(clippy::too_many_arguments)]
pub async fn execute_ptb(
    client: &SuiClient,
    keypair: &SuiKeyPair,
    sender: SuiAddress,
    gas_budget: u64,
    pt: ProgrammableTransaction,
    gas_price_cache: &mut u64,
    gas_price_at: &mut Option<Instant>,
    gas_coin_cache: &mut Option<(ObjectID, SequenceNumber, ObjectDigest)>,
) -> Result<SuiTransactionBlockResponse> {
    // Gas price with TTL
    let gas_price = {
        let stale = gas_price_at
            .map(|at| at.elapsed() >= GAS_PRICE_TTL)
            .unwrap_or(true);
        if stale {
            let p = client.read_api()
                .get_reference_gas_price()
                .await
                .map_err(|e| anyhow!("get_reference_gas_price: {}", e))?;
            *gas_price_cache = p;
            *gas_price_at = Some(Instant::now());
            p
        } else {
            *gas_price_cache
        }
    };

    // Gas coin — use cached ref, else fetch once.
    let gas_ref = if let Some(coin) = *gas_coin_cache {
        coin
    } else {
        let coins = client.coin_read_api()
            .get_coins(sender, None, None, Some(1))
            .await
            .map_err(|e| anyhow!("get_coins: {}", e))?;
        let coin = coins.data.into_iter().next()
            .ok_or_else(|| anyhow!("No SUI coins for gas"))?;
        let r = coin.object_ref();
        *gas_coin_cache = Some(r);
        r
    };

    let tx_data = TransactionData::new_programmable(
        sender,
        vec![gas_ref],
        pt,
        gas_budget,
        gas_price,
    );

    let tx = Transaction::from_data_and_signer(tx_data, vec![keypair as &dyn Signer<Signature>]);

    let result = client
        .quorum_driver_api()
        .execute_transaction_block(
            tx,
            SuiTransactionBlockResponseOptions::new()
                .with_effects()
                .with_object_changes(),
            // `WaitForEffectsCert` is the faster path — we get the
            // effects (including any Move abort reason) once validators
            // have certified them, without waiting on the local
            // fullnode to apply the state change. Empirically a Sui
            // mainnet fullnode under load can take 60+ seconds to
            // apply, manifesting as a "Request timeout" SDK error that
            // masks the actual abort. The local-execution wait was
            // useful when the next PTB needed to read the post-state
            // immediately, but the share-submission hot path doesn't.
            Some(ExecuteTransactionRequestType::WaitForEffectsCert),
        )
        .await
        .map_err(|e| anyhow!("execute_transaction_block: {}", e));

    // On any failure, invalidate the gas coin cache so the next call fetches
    // the current version.  This is necessary when another process sharing the
    // same account (e.g. stratum-server and miner-sidecar) bumps the coin version
    // between our calls.
    if result.is_err() {
        *gas_coin_cache = None;
    }

    result
}

/// Variant of `execute_ptb` that also requests events in the response.
/// Used by the stratum-server operator to extract TemplateRegistered event data.
pub async fn execute_ptb_with_events(
    client: &SuiClient,
    keypair: &SuiKeyPair,
    sender: SuiAddress,
    gas_budget: u64,
    pt: ProgrammableTransaction,
) -> Result<SuiTransactionBlockResponse> {
    let gas_price = client.read_api()
        .get_reference_gas_price()
        .await
        .map_err(|e| anyhow!("get_reference_gas_price: {}", e))?;

    let gas_ref = {
        let coins = client.coin_read_api()
            .get_coins(sender, None, None, Some(1))
            .await
            .map_err(|e| anyhow!("get_coins: {}", e))?;
        coins.data.into_iter().next()
            .ok_or_else(|| anyhow!("No SUI coins for gas"))?
            .object_ref()
    };

    let tx_data = TransactionData::new_programmable(
        sender,
        vec![gas_ref],
        pt,
        gas_budget,
        gas_price,
    );

    let tx = Transaction::from_data_and_signer(tx_data, vec![keypair as &dyn Signer<Signature>]);

    client
        .quorum_driver_api()
        .execute_transaction_block(
            tx,
            SuiTransactionBlockResponseOptions::new()
                .with_effects()
                .with_events()
                .with_object_changes(),
            // `WaitForEffectsCert` is the faster path — we get the
            // effects (including any Move abort reason) once validators
            // have certified them, without waiting on the local
            // fullnode to apply the state change. Empirically a Sui
            // mainnet fullnode under load can take 60+ seconds to
            // apply, manifesting as a "Request timeout" SDK error that
            // masks the actual abort. The local-execution wait was
            // useful when the next PTB needed to read the post-state
            // immediately, but the share-submission hot path doesn't.
            Some(ExecuteTransactionRequestType::WaitForEffectsCert),
        )
        .await
        .map_err(|e| anyhow!("execute_transaction_block: {}", e))
}

// ── Tiny helpers ──────────────────────────────────────────────────────────────

/// Infallible `Identifier` from a static string literal.
fn ident(s: &str) -> Identifier {
    Identifier::from_str(s).expect("valid identifier")
}

/// Extract `(price_per_unit_mist, remaining_budget_mist)` from a
/// `BuyOrder<T>`'s Move-object content. The Move struct lays out:
///   - price_per_unit_mist: u64
///   - payment: Balance<SUI>     // serialized as flat decimal string
fn read_buy_order_fields(
    data: &sui_sdk::rpc_types::SuiObjectData,
) -> Option<(u64, u64)> {
    let content = data.content.as_ref()?;
    let move_obj = match content {
        sui_sdk::rpc_types::SuiParsedData::MoveObject(o) => o,
        _ => return None,
    };
    let fields = match &move_obj.fields {
        sui_sdk::rpc_types::SuiMoveStruct::WithFields(m) => m,
        sui_sdk::rpc_types::SuiMoveStruct::WithTypes { fields, .. } => fields,
        _ => return None,
    };
    let price = parse_u64_field(fields.get("price_per_unit_mist")?)?;
    let budget = parse_u64_field(fields.get("payment")?)?;
    Some((price, budget))
}

/// Mirror of `read_buy_order_fields` for `SellOrder<T>`:
///   - price_per_unit_mist: u64
///   - inventory: Balance<T>
fn read_sell_order_fields(
    data: &sui_sdk::rpc_types::SuiObjectData,
) -> Option<(u64, u64)> {
    let content = data.content.as_ref()?;
    let move_obj = match content {
        sui_sdk::rpc_types::SuiParsedData::MoveObject(o) => o,
        _ => return None,
    };
    let fields = match &move_obj.fields {
        sui_sdk::rpc_types::SuiMoveStruct::WithFields(m) => m,
        sui_sdk::rpc_types::SuiMoveStruct::WithTypes { fields, .. } => fields,
        _ => return None,
    };
    let price = parse_u64_field(fields.get("price_per_unit_mist")?)?;
    let inventory = parse_u64_field(fields.get("inventory")?)?;
    Some((price, inventory))
}

/// `Balance<T>` serializes as a flat decimal string in the RPC content
/// JSON; `u64` fields serialize either as JSON numbers or numeric strings.
/// Accept both forms.
fn parse_u64_field(v: &sui_sdk::rpc_types::SuiMoveValue) -> Option<u64> {
    use sui_sdk::rpc_types::SuiMoveValue;
    match v {
        SuiMoveValue::Number(n) => Some(*n as u64),
        SuiMoveValue::String(s) => s.parse::<u64>().ok(),
        _ => None,
    }
}

/// `apply_bps(p, bps)` = `p * (10000 + bps) / 10000`. Saturating.
/// Caller passes a *signed* offset (+100 = +1%, -50 = -0.5%).
fn apply_bps(anchor: u64, bps: i32) -> u64 {
    if anchor == 0 {
        return 0;
    }
    let num = 10_000i64 + bps as i64;
    if num <= 0 {
        return 0;
    }
    let n = num as u128;
    let scaled = (anchor as u128).saturating_mul(n) / 10_000u128;
    if scaled > u64::MAX as u128 {
        u64::MAX
    } else {
        scaled as u64
    }
}
