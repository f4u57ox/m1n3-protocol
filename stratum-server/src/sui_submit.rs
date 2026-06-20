//! Sui blockchain template registration and pool state queries.
//!
//! Handles template registration as Sui shared objects on behalf of the
//! pool operator.  Keypair loading and transaction execution are delegated
//! to the shared `sui-client` crate.

use anyhow::{anyhow, Result};
use std::str::FromStr;
use tokio::time::{sleep, Duration};
use sui_sdk::{
    rpc_types::{EventFilter, ObjectChange, SuiObjectDataOptions},
    types::{
        base_types::{ObjectID, SequenceNumber, SuiAddress},
        crypto::SuiKeyPair,
        object::Owner,
        programmable_transaction_builder::ProgrammableTransactionBuilder,
        transaction::{ObjectArg, SharedObjectMutability},
        Identifier,
    },
    SuiClient, SuiClientBuilder,
};
use sui_sdk::rpc_types::SuiTransactionBlockEffectsAPI;
use tracing::{info, warn};

pub use sui_client::load_keystore;

use crate::MiningJob;

pub struct SuiSubmitter {
    client: SuiClient,
    keypair: SuiKeyPair,
    sender: SuiAddress,
    package_id: Option<ObjectID>,
    pool_id: Option<ObjectID>,
    pool_admin_cap_id: Option<ObjectID>,
    gas_budget: u64,
}

#[derive(Debug, Clone)]
pub struct PoolState {
    pub global_min_difficulty: u64,
    pub current_round: u64,
    pub chain_height: u64,
}

impl SuiSubmitter {
    pub async fn new(
        package_id_str: String,
        pool_id_str: String,
        rpc_url: String,
        keystore_path: String,
        _address: Option<String>,
    ) -> Self {
        let package_id = if package_id_str.is_empty() {
            info!("No --sui-package configured — on-chain features disabled");
            None
        } else {
            ObjectID::from_str(&package_id_str).ok().or_else(|| {
                info!("Invalid --sui-package '{}' — on-chain features disabled", package_id_str);
                None
            })
        };

        let pool_id = if pool_id_str.is_empty() {
            None
        } else {
            ObjectID::from_str(&pool_id_str).ok().or_else(|| {
                info!("Invalid --pool-object '{}' — pool queries disabled", pool_id_str);
                None
            })
        };

        let keypair = load_keystore(&keystore_path)
            .expect("Failed to load Sui keystore");

        let sender = SuiAddress::from(&keypair.public());

        let client = SuiClientBuilder::default()
            .build(&rpc_url)
            .await
            .expect("Cannot connect to Sui RPC");

        info!(
            "Sui submitter initialized: package={}, pool={}, authority={}, rpc={}",
            package_id.as_ref().map(|id| id.to_string()).as_deref().unwrap_or("none"),
            pool_id.as_ref().map(|id| id.to_string()).as_deref().unwrap_or("none"),
            sender, rpc_url
        );

        Self {
            client,
            keypair,
            sender,
            package_id,
            pool_id,
            pool_admin_cap_id: None,
            gas_budget: 50_000_000,
        }
    }

    pub fn with_admin_cap(mut self, cap_id_str: &str) -> Self {
        self.pool_admin_cap_id = ObjectID::from_str(cap_id_str).ok();
        self
    }

    pub fn with_gas_budget(mut self, budget: u64) -> Self {
        self.gas_budget = budget;
        self
    }

    /// Read pool state from the Pool shared object.
    pub async fn get_pool_state(&self) -> Result<PoolState> {
        let pool_id = self.pool_id.ok_or_else(|| anyhow!("pool_id not configured"))?;
        let resp = self.client.read_api()
            .get_object_with_options(pool_id, SuiObjectDataOptions::new().with_content())
            .await
            .map_err(|e| anyhow!("Pool RPC: {}", e))?;

        let data = resp.data.ok_or_else(|| anyhow!("Pool object not found"))?;
        let content = data.content.ok_or_else(|| anyhow!("Pool has no content"))?;
        let json = serde_json::to_value(content).unwrap_or_default();
        let fields = &json["fields"];

        Ok(PoolState {
            current_round: parse_u64(fields, "current_round"),
            global_min_difficulty: parse_u64(fields, "global_min_difficulty"),
            chain_height: 0, // Not stored directly in Pool; use block_registry if needed
        })
    }

    /// Pool is created at deploy time. This is a no-op on Sui.
    pub async fn initialize_pool_if_needed(&self) -> Result<()> {
        match self.pool_id {
            Some(id) => info!("Pool object {} already exists (created at deploy)", id),
            None => info!("Pool object not configured — on-chain pool features disabled"),
        }
        Ok(())
    }

    /// Register a block template as a Sui shared object.
    /// Returns the template object ID.
    /// Retries up to 3 times on stale owned-object-reference errors.
    pub async fn register_template(&self, job: &MiningJob) -> Result<String> {
        const MAX_ATTEMPTS: usize = 3;
        let mut last_err = anyhow!("no attempts made");
        for attempt in 1..=MAX_ATTEMPTS {
            match self.try_register_template(job).await {
                Ok(id) => return Ok(id),
                Err(e) => {
                    let s = e.to_string();
                    // Validator rejection due to stale owned-object version — safe to retry
                    // after re-fetching the object reference (obj_ref_parts is called fresh each attempt).
                    if attempt < MAX_ATTEMPTS
                        && (s.contains("unavailable for consumption")
                            || s.contains("Transaction is rejected as invalid"))
                    {
                        warn!(
                            "register_template attempt {}/{} rejected (stale object ref), retrying in {}ms: {}",
                            attempt, MAX_ATTEMPTS, 300 * attempt as u64, e
                        );
                        sleep(Duration::from_millis(300 * attempt as u64)).await;
                        last_err = e;
                    } else {
                        return Err(e);
                    }
                }
            }
        }
        Err(last_err)
    }

    async fn try_register_template(&self, job: &MiningJob) -> Result<String> {
        let package_id = self.package_id.ok_or_else(|| anyhow!("sui_package not configured"))?;
        let pool_id = self.pool_id.ok_or_else(|| anyhow!("pool_object not configured"))?;
        let cap_id = self.pool_admin_cap_id
            .ok_or_else(|| anyhow!("pool_admin_cap_id required for register_template"))?;

        let mut ptb = ProgrammableTransactionBuilder::new();

        // Pool (shared, mutable) — m1n3_v4 pool::register_template signature
        let pool_iver = get_initial_shared_ver(&self.client, pool_id).await?;
        let pool_arg = ptb.obj(ObjectArg::SharedObject {
            id: pool_id,
            initial_shared_version: pool_iver,
            mutability: SharedObjectMutability::Mutable,
        }).map_err(|e| anyhow!("pool arg: {}", e))?;

        // PoolAdminCap (owned)
        let (cap_ver, cap_dig) = self.obj_ref_parts(cap_id).await?;
        let cap_arg = ptb.obj(ObjectArg::ImmOrOwnedObject((cap_id, cap_ver, cap_dig)))
            .map_err(|e| anyhow!("cap arg: {}", e))?;

        // Clock (shared, immutable)
        let clock_id = ObjectID::from_str("0x6").unwrap();
        let clock_iver = get_initial_shared_ver(&self.client, clock_id).await?;
        let clock_arg = ptb.obj(ObjectArg::SharedObject {
            id: clock_id,
            initial_shared_version: clock_iver,
            mutability: SharedObjectMutability::Immutable,
        }).map_err(|e| anyhow!("clock arg: {}", e))?;

        // Pure args
        let height_arg = ptb.pure(job.height).map_err(|e| anyhow!("{}", e))?;
        let prev_hash_arg = ptb.pure(job.prev_block_hash.to_vec()).map_err(|e| anyhow!("{}", e))?;
        let cb1_arg = ptb.pure(job.coinbase1.clone()).map_err(|e| anyhow!("{}", e))?;
        let cb2_arg = ptb.pure(job.coinbase2.clone()).map_err(|e| anyhow!("{}", e))?;
        let branches: Vec<Vec<u8>> = job.merkle_branches.iter().map(|b| b.to_vec()).collect();
        let branches_arg = ptb.pure(branches).map_err(|e| anyhow!("{}", e))?;
        let version_arg = ptb.pure(job.version).map_err(|e| anyhow!("{}", e))?;
        let nbits_arg = ptb.pure(job.nbits).map_err(|e| anyhow!("{}", e))?;
        let ntime_arg = ptb.pure(job.ntime).map_err(|e| anyhow!("{}", e))?;

        ptb.programmable_move_call(
            package_id,
            ident("pool"),
            ident("register_template"),
            vec![],
            vec![pool_arg, cap_arg, clock_arg, height_arg, prev_hash_arg,
                 cb1_arg, cb2_arg, branches_arg, version_arg, nbits_arg, ntime_arg],
        );

        let pt = ptb.finish();
        let response = self.sign_and_execute(pt).await?;

        // Check effects status first — a Move abort returns Ok from execute but has Failure status.
        if let Some(effects) = &response.effects {
            use sui_sdk::rpc_types::SuiExecutionStatus;
            if let SuiExecutionStatus::Failure { error } = effects.status() {
                return Err(anyhow!("register_template Move execution failed: {}", error));
            }
        }

        // Extract template_id from the TemplateRegistered event emitted by m1n3_v4::pool.
        if let Some(events) = &response.events {
            for ev in &events.data {
                let ty = ev.type_.to_string();
                if ty.contains("::pool::TemplateRegistered") || ty.contains("::pool::TemplateCreated") {
                    let template_id = ev.parsed_json["template_id"]
                        .as_str()
                        .map(|s| {
                            if s.starts_with("0x") { s.to_string() } else { format!("0x{}", s) }
                        })
                        .ok_or_else(|| anyhow!("TemplateRegistered event missing template_id"))?;
                    info!("Template registered: {} (height={})", template_id, job.height);
                    return Ok(template_id);
                }
            }
        }

        Err(anyhow!("TemplateRegistered event not found in tx {} — effects: {:?}",
            response.digest,
            response.effects.as_ref().map(|e| format!("{:?}", e.status()))))
    }

    // Round close (open_round_accumulator_from_claim → accumulate_miner_stats
    // → finalize_round) is driven trustlessly by `trustless-keeper` and by
    // the demo / fund scripts. The stratum-server's job is just to keep the
    // pool's templates fresh and submit shares — it doesn't need a PTB
    // builder for round management.

    /// No-op: On-chain difficulty is set by the pool contract's auto-adjust logic.
    pub async fn reset_difficulty(&self, _val: u64) -> Result<()> {
        Ok(())
    }

    /// No-op: Sui has no account rent — nothing to reclaim.
    pub async fn cleanup_all_templates(&self) -> Result<u64> {
        Ok(0)
    }

    /// No-op: Marketplace was removed in v5.
    pub async fn initialize_marketplace_if_needed(&self) -> Result<()> {
        Ok(())
    }

    /// Alias for get_pool_state (keeps stratum-server call sites consistent).
    pub async fn query_pool_state(&self) -> Result<PoolState> {
        self.get_pool_state().await
    }

    /// Query all on-chain templates that are still marked is_active=true.
    /// Used at startup to deactivate any templates left over from a previous session.
    pub async fn fetch_active_template_ids(&self) -> Result<Vec<String>> {
        let package_id = match self.package_id {
            Some(id) => id,
            None => return Ok(vec![]),
        };
        let event_type = format!("{}::pool::TemplateCreated", package_id);
        let filter = EventFilter::MoveEventType(
            event_type.parse().map_err(|e| anyhow!("Invalid event type: {}", e))?,
        );

        let mut cursor = None;
        let mut template_ids: Vec<String> = Vec::new();
        loop {
            let page = self.client.event_api()
                .query_events(filter.clone(), cursor, Some(50), false)
                .await
                .map_err(|e| anyhow!("query_events: {}", e))?;
            for event in &page.data {
                if let Some(id) = event.parsed_json["template_id"].as_str() {
                    template_ids.push(id.to_string());
                }
            }
            if page.has_next_page {
                cursor = page.next_cursor;
            } else {
                break;
            }
        }

        // Fetch each template object and keep only the active ones.
        let mut active_ids = Vec::new();
        for tid in template_ids {
            let obj_id = match ObjectID::from_str(&tid) {
                Ok(id) => id,
                Err(_) => continue,
            };
            let resp = self.client.read_api()
                .get_object_with_options(obj_id, SuiObjectDataOptions::new().with_content())
                .await;
            if let Ok(obj_resp) = resp {
                if let Some(data) = obj_resp.data {
                    if let Some(content) = data.content {
                        let fields = match &content {
                            sui_sdk::rpc_types::SuiParsedData::MoveObject(o) => &o.fields,
                            _ => continue,
                        };
                        if let sui_sdk::rpc_types::SuiMoveStruct::WithFields(map) = fields {
                            let is_active = map.get("is_active")
                                .and_then(|v| match v {
                                    sui_sdk::rpc_types::SuiMoveValue::Bool(b) => Some(*b),
                                    _ => None,
                                })
                                .unwrap_or(false);
                            if is_active {
                                active_ids.push(tid);
                            }
                        }
                    }
                }
            }
        }
        Ok(active_ids)
    }

    /// Deactivate a template (called when a new Bitcoin block is found).
    /// Retries up to 3 times on stale owned-object-reference errors.
    pub async fn deactivate_template(&self, template_id: &str) -> Result<()> {
        const MAX_ATTEMPTS: usize = 3;
        let mut last_err = anyhow!("no attempts made");
        for attempt in 1..=MAX_ATTEMPTS {
            match self.try_deactivate_template(template_id).await {
                Ok(()) => return Ok(()),
                Err(e) => {
                    let s = e.to_string();
                    if attempt < MAX_ATTEMPTS
                        && (s.contains("unavailable for consumption")
                            || s.contains("Transaction is rejected as invalid"))
                    {
                        warn!(
                            "deactivate_template attempt {}/{} rejected (stale object ref), retrying in {}ms",
                            attempt, MAX_ATTEMPTS, 300 * attempt as u64
                        );
                        sleep(Duration::from_millis(300 * attempt as u64)).await;
                        last_err = e;
                    } else {
                        return Err(e);
                    }
                }
            }
        }
        Err(last_err)
    }

    async fn try_deactivate_template(&self, template_id: &str) -> Result<()> {
        let package_id = self.package_id.ok_or_else(|| anyhow!("sui_package not configured"))?;

        let template_obj_id = ObjectID::from_str(template_id)
            .map_err(|_| anyhow!("Invalid template ID: {}", template_id))?;

        let mut ptb = ProgrammableTransactionBuilder::new();

        let tpl_iver = get_initial_shared_ver(&self.client, template_obj_id).await?;
        let tpl_arg = ptb.obj(ObjectArg::SharedObject {
            id: template_obj_id,
            initial_shared_version: tpl_iver,
            mutability: SharedObjectMutability::Mutable,
        }).map_err(|e| anyhow!("{}", e))?;

        ptb.programmable_move_call(
            package_id,
            ident("pool"),
            ident("deactivate_template"),
            vec![],
            vec![tpl_arg],
        );

        let pt = ptb.finish();
        let _ = self.sign_and_execute(pt).await?;
        info!("Template deactivated: {}", template_id);
        Ok(())
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    async fn obj_ref_parts(
        &self,
        id: ObjectID,
    ) -> Result<(sui_sdk::types::base_types::SequenceNumber, sui_sdk::types::base_types::ObjectDigest)> {
        let resp = self.client.read_api()
            .get_object_with_options(id, SuiObjectDataOptions::new())
            .await
            .map_err(|e| anyhow!("get_object {}: {}", id, e))?;
        let data = resp.data.ok_or_else(|| anyhow!("Object {} not found", id))?;
        Ok((data.version, data.digest))
    }

    async fn sign_and_execute(
        &self,
        pt: sui_sdk::types::transaction::ProgrammableTransaction,
    ) -> Result<sui_sdk::rpc_types::SuiTransactionBlockResponse> {
        sui_client::execute_ptb_with_events(
            &self.client, &self.keypair, self.sender, self.gas_budget, pt,
        ).await
    }
}

/// Fetch the `initial_shared_version` of a shared object.
///
/// `ObjectArg::SharedObject` requires the version at which the object was
/// first shared — NOT its current version.  Passing the current version causes
/// validators to reject the transaction (which manifests as a 504 timeout from
/// the quorum driver after the nginx proxy times out).
async fn get_initial_shared_ver(client: &SuiClient, id: ObjectID) -> Result<SequenceNumber> {
    let resp = client.read_api()
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

fn ident(s: &str) -> Identifier {
    Identifier::from_str(s).expect("valid identifier")
}

fn parse_u64(json: &serde_json::Value, key: &str) -> u64 {
    let v = &json[key];
    v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())).unwrap_or(0)
}

