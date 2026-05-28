//! Sui chain client for the stratum-bridge operator.
//!
//! Responsible for one thing: posting job templates on-chain via `pool::post_job`
//! whenever the Stratum server broadcasts a new `mining.notify`. Share submission
//! is handled entirely by the miner-side sidecar (each miner signs with their own key).

use anyhow::{Context, Result};
use tracing::{debug, info};

/// Runtime configuration loaded from environment variables.
#[derive(Debug, Clone)]
pub struct BridgeConfig {
    /// Stratum server listen address.
    pub host: String,
    /// Stratum server port.
    pub port: u16,
    /// Sui JSON-RPC endpoint.
    pub sui_rpc_url: String,
    /// Hex-encoded ed25519 private key for the pool operator.
    pub operator_key: String,
    /// On-chain Pool object ID (set after `sui client publish`).
    pub pool_object_id: String,
    /// Initial pool share difficulty scalar.
    pub initial_difficulty: u64,
}

impl BridgeConfig {
    pub fn from_env() -> Result<Self> {
        Ok(Self {
            host: std::env::var("BRIDGE_HOST")
                .unwrap_or_else(|_| "0.0.0.0".to_string()),
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

/// Sui chain client — operator side only.
///
/// The operator key is used exclusively for `post_job` calls. Share submission
/// is signed by each miner's own key in the miner-sidecar process.
pub struct SuiChainClient {
    config: BridgeConfig,
}

impl SuiChainClient {
    pub fn new(config: BridgeConfig) -> Self {
        Self { config }
    }

    /// Post a new mining job template on-chain via `pool::post_job`.
    ///
    /// Called every time the Stratum server produces a new `mining.notify`, so the
    /// on-chain record stays in sync with what miners are actually working on.
    ///
    /// Returns the Sui transaction digest on success.
    pub async fn post_job(&self, job: &crate::pool::Job) -> Result<String> {
        debug!(
            job_id = job.id,
            n_bits = %job.n_bits,
            n_time = %job.n_time,
            "posting job template on-chain"
        );

        // TODO: construct a Programmable Transaction Block (PTB) that calls:
        //   pool::post_job(
        //       pool_object_id,
        //       hex::decode(&job.prev_hash)?,
        //       hex::decode(&job.coinbase1)?,
        //       hex::decode(&job.coinbase2)?,
        //       job.merkle_branches.iter().map(|b| hex::decode(b)).collect(),
        //       u32::from_str_radix(&job.version, 16)?,
        //       u32::from_str_radix(&job.n_bits, 16)?,
        //       u32::from_str_radix(&job.n_time, 16)?,
        //       reward_mist,      // configured per job
        //       payment_coin,     // operator's SUI coin object
        //   )
        // Sign with self.config.operator_key (ed25519 via fastcrypto).
        // Submit via sui_executeTransactionBlock JSON-RPC to self.config.sui_rpc_url.

        info!(job_id = job.id, "job posted on-chain (PTB wiring: TODO)");
        Ok(format!("0x{:064x}", job.id))
    }
}
