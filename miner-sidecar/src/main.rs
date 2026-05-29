//! m1n3-sidecar — trustless miner-side companion for m1n3-protocol.
//!
//! Point your ASIC or mining software at this process instead of directly at
//! the pool. It transparently proxies Stratum v1 traffic while intercepting
//! accepted shares and recording them on the Sui blockchain, signed with
//! the miner's own private key.
//!
//! # Quick start
//!
//! ```bash
//! POOL_HOST=pool.example.com \
//! POOL_PORT=3333 \
//! SIDECAR_PORT=3334 \
//! MINER_KEY=<hex_ed25519_key> \
//! POOL_OBJECT_ID=0x... \
//! m1n3-sidecar
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

    proxy::ProxyServer::new(config).run().await
}
