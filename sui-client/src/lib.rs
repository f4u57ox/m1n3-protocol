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

use anyhow::{anyhow, Result};
use std::{
    collections::{HashMap, HashSet},
    str::FromStr,
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
    share_dedup_ids: HashMap<String, ObjectID>,

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
    // Fill-best-bid is a future iteration; this is the place-only MVP.
    auto_sell: Option<AutoSellConfig>,
}

#[derive(Clone, Debug)]
pub struct AutoSellConfig {
    /// MIST price per HashShare unit. 0 disables.
    pub price_per_unit_mist: u64,
    /// 0 = no expiry. Otherwise Unix-ms when the order auto-cancels.
    pub expires_at_ms: u64,
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
        //    and a ShareDedup per unique template in this batch.
        self.ensure_registered().await?;
        self.fetch_pool_round().await?;
        let round_id = self.pool_round;
        self.ensure_round_stats(round_id).await?;

        let mut unique_templates: Vec<String> =
            batch.iter().map(|(t, _)| t.clone()).collect();
        unique_templates.sort();
        unique_templates.dedup();
        for tid in &unique_templates {
            self.ensure_share_dedup(tid).await?;
        }

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

        // Per-template args: Template (frozen → immutable) + ShareDedup (owned, mutable)
        let mut tpl_args: HashMap<String, sui_sdk::types::transaction::Argument> = HashMap::new();
        let mut dedup_args: HashMap<String, sui_sdk::types::transaction::Argument> = HashMap::new();
        for tid in &unique_templates {
            let tpl_obj_id = ObjectID::from_str(tid)
                .map_err(|_| anyhow!("Invalid template ID: {}", tid))?;
            let (tpl_ver, tpl_dig) = self.get_ver(tpl_obj_id).await?;
            let tpl_arg = ptb.obj(ObjectArg::ImmOrOwnedObject((tpl_obj_id, tpl_ver, tpl_dig)))
                .map_err(|e| anyhow!("template arg: {}", e))?;
            tpl_args.insert(tid.clone(), tpl_arg);

            let dedup_id = *self.share_dedup_ids.get(tid)
                .ok_or_else(|| anyhow!("share_dedup not set for template {}", tid))?;
            let (d_ver, d_dig) = self.get_ver(dedup_id).await?;
            let d_arg = ptb.obj(ObjectArg::ImmOrOwnedObject((dedup_id, d_ver, d_dig)))
                .map_err(|e| anyhow!("share_dedup arg: {}", e))?;
            dedup_args.insert(tid.clone(), d_arg);
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
            let dedup_arg = *dedup_args.get(template_id).unwrap();

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

        let resp = self.exec(ptb.finish()).await?;
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
            vec![hs_cfg.hashshare_type.clone()],
            vec![price_arg, expires_arg, first_arg],
        );

        let resp = self.exec(ptb.finish()).await?;
        self.update_from_resp(&resp);
        Ok(Some(format!(
            "{} ({} units @ {} MIST/unit)",
            resp.digest, total_units, cfg.price_per_unit_mist
        )))
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
        let (mrr_ver, _) = self.get_ver(mrr_id).await?;
        let mrr_arg = ptb.obj(ObjectArg::SharedObject {
            id: mrr_id,
            initial_shared_version: mrr_ver,
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

    async fn ensure_share_dedup(&mut self, template_id: &str) -> Result<()> {
        if self.share_dedup_ids.contains_key(template_id) {
            return Ok(());
        }
        let tpl_obj_id = ObjectID::from_str(template_id)
            .map_err(|_| anyhow!("Invalid template ID: {}", template_id))?;
        let dedup_type = format!("{}::share_dedup::ShareDedup", self.package_id);
        if let Some(id) = self.find_owned_dedup(&dedup_type, template_id).await? {
            self.share_dedup_ids.insert(template_id.to_string(), id);
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
        let tpl_arg = ptb.pure(tpl_obj_id).map_err(|e| anyhow!("{}", e))?;
        ptb.programmable_move_call(
            self.package_id,
            ident("share_dedup"),
            ident("create_share_dedup"),
            vec![],
            vec![reg_arg, tpl_arg],
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
            self.find_owned_dedup(&dedup_type, template_id).await?
                .ok_or_else(|| anyhow!("ShareDedup not found after creation"))?
        };
        self.share_dedup_ids.insert(template_id.to_string(), id);
        info!("Created ShareDedup for template {}: {}", template_id, id);
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
        template_id: &str,
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
                    let tid = json["fields"]["template_id"].as_str().unwrap_or("");
                    if tid.eq_ignore_ascii_case(template_id) {
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
            Some(ExecuteTransactionRequestType::WaitForLocalExecution),
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
            Some(ExecuteTransactionRequestType::WaitForLocalExecution),
        )
        .await
        .map_err(|e| anyhow!("execute_transaction_block: {}", e))
}

// ── Tiny helpers ──────────────────────────────────────────────────────────────

/// Infallible `Identifier` from a static string literal.
fn ident(s: &str) -> Identifier {
    Identifier::from_str(s).expect("valid identifier")
}
