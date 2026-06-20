//! m1n3 Pool Operator Bot
//!
//! Autonomous service that drives the full reward lifecycle:
//!   Block found → CreateRewardBatch → RequestSigning → sign → SubmitSignature
//!   → MarkBroadcast → poll confirmations → MarkConfirmed
//!
//! Signing is abstracted via the `BitcoinSigner` trait, backed by `OperatorSigner`
//! (a secp256k1 WIF private key). The Hashi bridge handles the actual BTC settlement.

mod config;
mod pool_state;
mod reward_pipeline;
mod signer;
mod bitcoin_tx;

use anyhow::Result;
use clap::Parser;
use std::sync::Arc;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

use crate::config::BotConfig;
use crate::pool_state::PoolMonitor;
use crate::reward_pipeline::RewardPipeline;
use crate::signer::make_signer;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("operator_bot=info".parse()?))
        .init();

    let cfg = BotConfig::parse();
    info!("m1n3 Operator Bot starting");
    info!("  Sui RPC:     {}", cfg.sui_rpc_url);
    info!("  Package ID:  {}", cfg.package_id);
    info!("  Pool object: {}", cfg.pool_object_id);
    info!("  Poll every:  {}s", cfg.poll_interval_secs);
    info!("  BTC confirms needed: {}", cfg.btc_confirmations_required);

    let signer = make_signer(&cfg)?;
    let pipeline = Arc::new(RewardPipeline::new(&cfg, signer)?);
    let monitor = PoolMonitor::new(&cfg)?;

    let mut last_round: Option<u64> = None;

    loop {
        match monitor.current_round().await {
            Err(e) => error!("Failed to read pool state: {}", e),
            Ok(round_id) => {
                if let Some(prev) = last_round {
                    if round_id > prev {
                        info!("Round advanced {} → {} (block found!)", prev, round_id);
                        let p = Arc::clone(&pipeline);
                        let closed_round = prev;
                        tokio::spawn(async move {
                            if let Err(e) = p.run(closed_round).await {
                                error!("Reward pipeline failed for round {}: {}", closed_round, e);
                            }
                        });
                    }
                }
                last_round = Some(round_id);
            }
        }

        tokio::time::sleep(tokio::time::Duration::from_secs(cfg.poll_interval_secs)).await;
    }
}
