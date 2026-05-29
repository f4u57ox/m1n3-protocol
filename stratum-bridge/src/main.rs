use anyhow::Result;
use tracing::info;
use tracing_subscriber::EnvFilter;

mod pool;
mod chain;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse()?))
        .init();

    let config = chain::BridgeConfig::from_env()?;
    info!("m1n3-protocol bridge starting on {}:{}", config.host, config.port);

    pool::StratumServer::new(config).run().await
}
