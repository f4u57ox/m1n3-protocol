use anyhow::Result;
use tracing::info;
use tracing_subscriber::EnvFilter;

mod bitcoin_rpc;
mod chain;
mod pool;
mod pow;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse()?))
        .init();

    let config = chain::BridgeConfig::from_env()?;
    info!("m1n3-protocol bridge starting on {}:{}", config.host, config.port);

    // Auto-replenish operator wallet on devnet/testnet so the bridge never stalls.
    if let Some(faucet_url) = faucet_url_for(&config.sui_rpc_url) {
        let keypair = sui_client::SuiKeypair::parse(&config.operator_key)?;
        let address = keypair.address_hex();
        let rpc_url = config.sui_rpc_url.clone();
        tokio::spawn(async move {
            faucet_monitor(rpc_url, address, faucet_url, "operator").await;
        });
    }

    pool::StratumServer::new(config).await?.run().await
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
