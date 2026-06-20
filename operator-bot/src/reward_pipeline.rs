//! Reward pipeline: drives a closed round through the full payout lifecycle.
//!
//! Trustless Hashi-only path (no admin cap required for round close + fund):
//!   submit_share → BlockFoundClaim (frozen, attests block_finder)
//!   open_round_accumulator_from_claim → accumulate_miner_stats → finalize_round
//!   record_block_found(claim) → register_with_hashi → ...committee...
//!   confirm_hashi_deposit → open_and_fund_round_batch
//!   each miner: claim_reward (MWR consumed; no batch.claimed table)
//!
//! The operator-bot only owns the Bitcoin side: building/signing/broadcasting
//! the payout tx and surfacing on-chain confirmation. The Sui-side state
//! transitions are driven by the `trustless-keeper` and by the operator's
//! `record_block_found` / `register_with_hashi` admin steps (the latter still
//! gated by PoolAdminCap; the former is now permissionless).

use anyhow::{anyhow, Result};
use serde::Deserialize;
use std::time::Duration;
use tracing::{info, warn};

use crate::config::BotConfig;
use crate::pool_state::{aggregate_by_miner, MinerRoundEntry, PoolMonitor};
use crate::signer::BitcoinSigner;

pub struct RewardPipeline {
    rpc_url: String,
    package_id: String,
    pool_object_id: String,
    reward_registry_id: String,
    keystore_path: String,
    gas_budget: u64,
    monitor: PoolMonitor,
    signer: Box<dyn BitcoinSigner>,
    cfg: BotConfig,
    client: reqwest::Client,
}

#[derive(Debug, Deserialize)]
struct SuiRpcResponse<T> {
    result: Option<T>,
    error: Option<serde_json::Value>,
}

impl RewardPipeline {
    pub fn new(cfg: &BotConfig, signer: Box<dyn BitcoinSigner>) -> Result<Self> {
        let monitor = PoolMonitor::new(cfg)?;
        Ok(Self {
            rpc_url: cfg.sui_rpc_url.clone(),
            package_id: cfg.package_id.clone(),
            pool_object_id: cfg.pool_object_id.clone(),
            reward_registry_id: cfg.hashi_reward_registry_id.clone(),
            keystore_path: cfg.sui_keystore_path.clone(),
            gas_budget: cfg.gas_budget,
            monitor,
            signer,
            cfg: cfg.clone(),
            client: reqwest::Client::new(),
        })
    }

    /// Run the full reward pipeline for a closed round.
    pub async fn run(&self, round_id: u64) -> Result<()> {
        info!("=== Reward pipeline starting for round {} ===", round_id);

        // 1. Enumerate miners
        let miners = self.monitor.enumerate_round_miners(round_id).await?;
        if miners.is_empty() {
            warn!("No miner entries for round {} — skipping", round_id);
            return Ok(());
        }

        let miners = aggregate_by_miner(miners);
        info!("Round {}: {} unique miners", round_id, miners.len());

        // 2. Create reward batch on-chain
        let total_sats = self.cfg.round_total_sats;
        let batch_id = self.create_reward_batch(round_id, total_sats, &miners).await?;
        info!("Reward batch created: {}", batch_id);

        // 3. Build + sign Bitcoin payout transaction (off-chain)
        let tx_hash = self.build_and_sign_payout_tx(round_id, total_sats, &miners).await?;
        info!("Bitcoin TX hash: {}", hex::encode(tx_hash));

        // 4. RequestSigning — stores tx_hash, moves batch to SIGNING state
        self.request_signing(&batch_id, tx_hash).await?;
        info!("Signing requested");

        // 5. Sign the hash with pool's Bitcoin key
        let sig_bytes = self.signer.sign_hash(&tx_hash).await?;

        // 6. SubmitSignature — moves batch to SIGNED state
        self.submit_signature(&batch_id, sig_bytes).await?;
        info!("Signature submitted");

        // 7. Broadcast to Bitcoin
        if let Some(txid) = self.broadcast_bitcoin_tx(round_id).await? {
            info!("Bitcoin TX broadcast: {}", txid);

            // 8. MarkBroadcast
            self.mark_broadcast(&batch_id).await?;

            // 9. Poll for confirmations
            self.wait_for_confirmations(&txid).await?;

            // 10. MarkConfirmed
            self.mark_confirmed(&batch_id).await?;
            info!("Round {} payout CONFIRMED on Bitcoin", round_id);
        } else {
            warn!("Bitcoin broadcast skipped (no Bitcoin RPC configured)");
        }

        info!("=== Round {} pipeline complete ===", round_id);
        Ok(())
    }

    // ── Sui PTB helpers ──────────────────────────────────────────────────────

    async fn execute_ptb(&self, ptb_bytes: &str) -> Result<String> {
        // Execute a pre-built PTB via sui_executeTransactionBlock.
        // In production: sign with keystore, submit via JSON-RPC.
        // For now, emit a placeholder — replace with sui-sdk PTB construction.
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "sui_executeTransactionBlock",
            "params": [ptb_bytes, [], { "showEffects": true }]
        });

        let resp: SuiRpcResponse<serde_json::Value> = self
            .client
            .post(&self.rpc_url)
            .json(&body)
            .send()
            .await?
            .json()
            .await?;

        if let Some(err) = resp.error {
            return Err(anyhow!("PTB execution error: {}", err));
        }

        let digest = resp
            .result
            .and_then(|r| r.get("digest").and_then(|d| d.as_str()).map(|s| s.to_string()))
            .unwrap_or_else(|| "unknown".to_string());

        Ok(digest)
    }

    async fn create_reward_batch(
        &self,
        round_id: u64,
        total_sats: u64,
        miners: &[MinerRoundEntry],
    ) -> Result<String> {
        // TODO: Build PTB calling pool_rewards::create_reward_batch(round_id, total_sats, work_records)
        // Args: pool_object, reward_registry, miner_work_records[], round_id, total_sats
        info!(
            "create_reward_batch: round={} total_sats={} miners={}",
            round_id,
            total_sats,
            miners.len()
        );
        let _ = (self.pool_object_id.as_str(), self.reward_registry_id.as_str(), self.gas_budget);
        Ok(format!("pending_batch_round_{}", round_id))
    }

    async fn request_signing(&self, batch_id: &str, tx_hash: [u8; 32]) -> Result<()> {
        // TODO: Build PTB calling pool_rewards::request_signing(batch, tx_hash, signing_cap)
        info!("request_signing: batch={} hash={}", batch_id, hex::encode(tx_hash));
        Ok(())
    }

    async fn submit_signature(&self, batch_id: &str, sig: [u8; 64]) -> Result<()> {
        // TODO: Build PTB calling pool_rewards::submit_signature(batch, sig)
        info!("submit_signature: batch={} sig={}", batch_id, hex::encode(&sig[..8]));
        Ok(())
    }

    async fn mark_broadcast(&self, batch_id: &str) -> Result<()> {
        // TODO: Build PTB calling pool_rewards::mark_broadcast(batch)
        info!("mark_broadcast: batch={}", batch_id);
        Ok(())
    }

    async fn mark_confirmed(&self, batch_id: &str) -> Result<()> {
        // TODO: Build PTB calling pool_rewards::mark_confirmed(batch)
        info!("mark_confirmed: batch={}", batch_id);
        let _ = self.execute_ptb("").await; // placeholder — remove when real PTB is built
        Ok(())
    }

    // ── Bitcoin helpers ──────────────────────────────────────────────────────

    async fn build_and_sign_payout_tx(
        &self,
        round_id: u64,
        _total_sats: u64,
        _miners: &[MinerRoundEntry],
    ) -> Result<[u8; 32]> {
        // Placeholder: derive a deterministic hash from round_id so the full Sui
        // lifecycle can be tested without a Bitcoin node. Replace with actual tx build.
        let mut hash = [0u8; 32];
        hash[..8].copy_from_slice(&round_id.to_le_bytes());
        hash[8] = 0xCA;
        hash[9] = 0xFE;
        Ok(hash)
    }

    async fn broadcast_bitcoin_tx(&self, _round_id: u64) -> Result<Option<String>> {
        if self.cfg.bitcoin_rpc_url.is_empty() {
            return Ok(None);
        }
        // TODO: connect bitcoincore-rpc client, call sendrawtransaction with signed tx bytes.
        Ok(Some("placeholder_txid_replace_with_real_broadcast".to_string()))
    }

    async fn wait_for_confirmations(&self, txid: &str) -> Result<()> {
        let required = self.cfg.btc_confirmations_required;
        if txid.starts_with("placeholder") {
            info!("Placeholder txid — skipping confirmation wait");
            return Ok(());
        }
        info!("Waiting for {} confirmation(s) of {}", required, txid);
        // TODO: query Bitcoin node for tx confirmations via bitcoincore-rpc
        tokio::time::sleep(Duration::from_secs(1)).await;
        Ok(())
    }
}
