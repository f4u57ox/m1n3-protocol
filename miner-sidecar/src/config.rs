//! Runtime configuration for the miner sidecar.
//!
//! All values are read from environment variables so the sidecar can be deployed
//! without modifying the binary (12-factor app style).

use anyhow::{Context, Result};

/// Configuration for a single miner-sidecar instance.
///
/// One sidecar runs per mining rig (or per ASIC farm with a shared wallet).
#[derive(Debug, Clone)]
pub struct SidecarConfig {
    /// Address of the upstream Stratum pool (the stratum-bridge host).
    pub pool_host: String,
    /// Upstream pool Stratum port.
    pub pool_port: u16,
    /// Local TCP port the sidecar listens on — point ASICs at this.
    pub listen_port: u16,
    /// Sui JSON-RPC endpoint.
    pub sui_rpc_url: String,
    /// Hex-encoded ed25519 private key belonging to the miner.
    /// This key signs all on-chain `pool::submit_share` transactions,
    /// so `ctx.sender()` in the contract equals the miner's Sui address.
    pub miner_key: String,
    /// On-chain Pool object ID (same value the operator publishes in the pool config).
    pub pool_object_id: String,
}

impl SidecarConfig {
    pub fn from_env() -> Result<Self> {
        Ok(Self {
            pool_host: std::env::var("POOL_HOST")
                .context("POOL_HOST is required (e.g. pool.example.com)")?,
            pool_port: std::env::var("POOL_PORT")
                .unwrap_or_else(|_| "3333".to_string())
                .parse()
                .context("POOL_PORT must be a valid port number")?,
            listen_port: std::env::var("SIDECAR_PORT")
                .unwrap_or_else(|_| "3334".to_string())
                .parse()
                .context("SIDECAR_PORT must be a valid port number")?,
            sui_rpc_url: std::env::var("SUI_RPC_URL")
                .unwrap_or_else(|_| "https://fullnode.testnet.sui.io:443".to_string()),
            miner_key: std::env::var("MINER_KEY")
                .context("MINER_KEY is required (hex-encoded ed25519 private key)")?,
            pool_object_id: std::env::var("POOL_OBJECT_ID")
                .context("POOL_OBJECT_ID is required")?,
        })
    }
}
