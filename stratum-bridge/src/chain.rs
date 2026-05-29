/// Sui chain client — submits validated shares and job data to the on-chain pool.
use anyhow::{Context, Result};
use tracing::{debug, warn};

#[derive(Debug, Clone)]
pub struct BridgeConfig {
    /// Stratum server listen address.
    pub host: String,
    pub port: u16,
    /// Sui RPC endpoint.
    pub sui_rpc_url: String,
    /// Hex-encoded operator private key (ed25519).
    pub operator_key: String,
    /// On-chain pool object ID.
    pub pool_object_id: String,
    /// Initial difficulty.
    pub initial_difficulty: u64,
}

impl BridgeConfig {
    pub fn from_env() -> Result<Self> {
        Ok(Self {
            host: std::env::var("BRIDGE_HOST").unwrap_or_else(|_| "0.0.0.0".to_string()),
            port: std::env::var("BRIDGE_PORT")
                .unwrap_or_else(|_| "3333".to_string())
                .parse()
                .context("BRIDGE_PORT must be a valid port number")?,
            sui_rpc_url: std::env::var("SUI_RPC_URL")
                .unwrap_or_else(|_| "https://fullnode.testnet.sui.io:443".to_string()),
            operator_key: std::env::var("OPERATOR_KEY")
                .context("OPERATOR_KEY env var is required")?,
            pool_object_id: std::env::var("POOL_OBJECT_ID")
                .context("POOL_OBJECT_ID env var is required")?,
            initial_difficulty: std::env::var("INITIAL_DIFFICULTY")
                .unwrap_or_else(|_| "1000".to_string())
                .parse()
                .context("INITIAL_DIFFICULTY must be a u64")?,
        })
    }
}

/// Lightweight Sui transaction builder for pool interactions.
/// Replace with sui-sdk when available for the target toolchain.
pub struct SuiChainClient {
    config: BridgeConfig,
}

impl SuiChainClient {
    pub fn new(config: BridgeConfig) -> Self {
        Self { config }
    }

    /// Submit a validated share on-chain via pool::submit_share.
    pub async fn submit_share(
        &self,
        worker_addr: &str,
        job_id: u64,
        nonce: u32,
    ) -> Result<String> {
        debug!(
            worker = worker_addr,
            job_id,
            nonce,
            "submitting share on-chain"
        );
        // TODO: build and sign PTB using sui-sdk, call pool::submit_share.
        // Placeholder returns a fake digest for integration scaffold.
        let digest = format!("0x{:064x}", nonce as u64 ^ job_id);
        Ok(digest)
    }

    /// Post a new mining job on-chain via pool::post_job.
    pub async fn post_job(&self, job: &crate::pool::Job) -> Result<String> {
        debug!(job_id = job.id, "posting job on-chain");
        // TODO: build PTB, call pool::post_job.
        warn!("post_job: on-chain submission not yet wired (scaffold)");
        Ok(format!("0x{:064x}", job.id))
    }
}
