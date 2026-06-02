//! m1n3-sidecar — trustless miner-side companion for m1n3-protocol.
//!
//! Point your ASIC or mining software at this process instead of directly at
//! the pool. It transparently proxies Stratum v1 traffic while intercepting
//! accepted shares and recording them on the Sui blockchain, signed with
//! the miner's own private key.
//!
//! # Quick start
//!
//! Set env vars (see `.env.example`) then:
//!
//! ```sh
//! cargo run --bin m1n3-sidecar
//! ```
//!
//! Then point your ASIC at `stratum+tcp://localhost:3334`.

use anyhow::Result;
use tracing::info;
use tracing_subscriber::EnvFilter;

mod config;
mod proxy;
mod submit;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse()?))
        .init();

    let config = config::SidecarConfig::from_env()?;
    info!(
        pool     = format!("{}:{}", config.pool_host, config.pool_port),
        listen   = config.listen_port,
        "m1n3-sidecar starting"
    );

    // Auto-replenish miner wallet on devnet/testnet so submissions never stall.
    if let Some(faucet_url) = faucet_url_for(&config.sui_rpc_url) {
        let keypair = sui_client::SuiKeypair::parse(&config.miner_key)?;
        let address = keypair.address_hex();
        let rpc_url = config.sui_rpc_url.clone();
        tokio::spawn(async move {
            faucet_monitor(rpc_url, address, faucet_url, "miner").await;
        });
    }

    proxy::ProxyServer::new(config)?.run().await
}

fn faucet_url_for(rpc_url: &str) -> Option<String> {
    if rpc_url.contains("devnet") {
        Some("https://faucet.devnet.sui.io/gas".into())
    } else if rpc_url.contains("testnet") {
        Some("https://faucet.testnet.sui.io/gas".into())
    } else {
        None
    }
}

async fn faucet_monitor(rpc_url: String, address: String, faucet_url: String, label: &str) {
    use std::time::Duration;
    use tokio::time::{interval, sleep};

    const THRESHOLD_MIST: u64 = 500_000_000; // 0.5 SUI — request before this
    const CHECK_INTERVAL: Duration = Duration::from_secs(60);

    let rpc = sui_client::SuiRpcClient::new(&rpc_url);
    let mut ticker = interval(CHECK_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        ticker.tick().await;
        match rpc.get_balance(&address).await {
            Ok(bal) if bal < THRESHOLD_MIST => {
                tracing::warn!(
                    wallet = label,
                    balance_sui = format!("{:.4}", bal as f64 / 1e9),
                    "low balance — requesting devnet faucet"
                );
                match rpc.request_faucet(&address, &faucet_url).await {
                    Ok(()) => {
                        sleep(Duration::from_secs(4)).await;
                        match rpc.get_balance(&address).await {
                            Ok(new_bal) => tracing::info!(
                                wallet = label,
                                balance_sui = format!("{:.4}", new_bal as f64 / 1e9),
                                "faucet ok — balance replenished"
                            ),
                            Err(e) => tracing::warn!(error = %e, "post-faucet balance check failed"),
                        }
                    }
                    Err(e) => tracing::error!(wallet = label, error = %e, "faucet request failed"),
                }
            }
            Ok(bal) => tracing::debug!(
                wallet = label,
                balance_sui = format!("{:.4}", bal as f64 / 1e9),
                "balance ok"
            ),
            Err(e) => tracing::warn!(wallet = label, error = %e, "balance check failed"),
        }
    }
}
