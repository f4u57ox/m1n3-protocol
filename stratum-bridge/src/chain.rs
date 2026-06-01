//! Sui chain client for the stratum-bridge operator.
//!
//! Responsible for posting job templates on-chain via `pool::post_job`.
//! Share submission is handled by each miner's own sidecar process.

use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use tracing::{debug, info};

use sui_client::{
    bcs_types::Argument as PtbArg,
    rpc::{parse_object_id, SuiRpcClient},
    PtbBuilder, SuiKeypair,
};

use crate::pool::Job;
use crate::pow::compute_pool_scalar;

// ── Config ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct BridgeConfig {
    pub host:             String,
    pub port:             u16,
    pub sui_rpc_url:      String,
    /// Bech32 `suiprivkey1…` or 64-char hex ed25519 private key.
    pub operator_key:     String,
    pub pool_object_id:   String,
    /// Deployed package ID from `sui client publish`.
    pub package_id:       String,
    /// Stratum difficulty floor — miners never go below this (VARDIFF floor).
    pub initial_difficulty: u64,
    /// VARDIFF target: how many shares per minute across all miners.
    pub target_shares_per_min: u64,
    /// SUI reward added to pool treasury per job, in MIST.
    pub reward_mist:      u64,
    // ── Bitcoin Core RPC ─────────────────────────────────────────────────────
    pub bitcoin_rpc_url:  String,
    pub bitcoin_rpc_user: String,
    pub bitcoin_rpc_pass: String,
    pub job_refresh_secs: u64,
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
                .unwrap_or_else(|_| "https://fullnode.devnet.sui.io:443".to_string()),
            operator_key: std::env::var("OPERATOR_KEY")
                .context("OPERATOR_KEY is required (suiprivkey1… or 64-char hex)")?,
            pool_object_id: std::env::var("POOL_OBJECT_ID")
                .context("POOL_OBJECT_ID is required")?,
            package_id: std::env::var("PACKAGE_ID")
                .context("PACKAGE_ID is required")?,
            initial_difficulty: std::env::var("INITIAL_DIFFICULTY")
                .unwrap_or_else(|_| "512".to_string())
                .parse()
                .context("INITIAL_DIFFICULTY must be a u64")?,
            target_shares_per_min: std::env::var("TARGET_SHARES_PER_MIN")
                .unwrap_or_else(|_| "10".to_string())
                .parse()
                .context("TARGET_SHARES_PER_MIN must be a u64")?,
            reward_mist: std::env::var("REWARD_MIST")
                .unwrap_or_else(|_| "100000000".to_string())
                .parse()
                .context("REWARD_MIST must be a u64")?,
            bitcoin_rpc_url: std::env::var("BITCOIN_RPC_URL")
                .context("BITCOIN_RPC_URL is required (e.g. http://127.0.0.1:8332)")?,
            bitcoin_rpc_user: std::env::var("BITCOIN_RPC_USER")
                .context("BITCOIN_RPC_USER is required")?,
            bitcoin_rpc_pass: std::env::var("BITCOIN_RPC_PASS")
                .context("BITCOIN_RPC_PASS is required")?,
            job_refresh_secs: std::env::var("JOB_REFRESH_SECS")
                .unwrap_or_else(|_| "30".to_string())
                .parse()
                .context("JOB_REFRESH_SECS must be a u64")?,
        })
    }
}

// ── Chain client ──────────────────────────────────────────────────────────────

pub struct SuiChainClient {
    config:     BridgeConfig,
    rpc:        SuiRpcClient,
    keypair:    SuiKeypair,
    package_id: [u8; 32],
    pool_id:    [u8; 32],
}

impl SuiChainClient {
    pub fn new(config: BridgeConfig) -> Result<Self> {
        let rpc        = SuiRpcClient::new(&config.sui_rpc_url);
        let keypair    = SuiKeypair::parse(&config.operator_key)?;
        let package_id = parse_object_id(&config.package_id).context("invalid PACKAGE_ID")?;
        let pool_id    = parse_object_id(&config.pool_object_id).context("invalid POOL_OBJECT_ID")?;

        info!(
            network  = %config.sui_rpc_url,
            operator = %keypair.address_hex(),
            pool     = %config.pool_object_id,
            package  = %config.package_id,
            "Sui chain client initialized"
        );

        Ok(Self { config, rpc, keypair, package_id, pool_id })
    }

    /// Post a new mining job template on-chain via `pool::post_job`.
    ///
    /// Builds, signs, and submits a Sui PTB. Returns the transaction digest.
    pub async fn post_job(&self, job: &Job) -> Result<String> {
        debug!(job_id = job.id, n_bits = %job.n_bits, "building post_job PTB");

        // ── Decode hex fields from the Job struct ─────────────────────────────
        // GBT previousblockhash is in display (big-endian) byte order.
        // The block header and the off-chain PoW check both use internal
        // (little-endian) byte order, so reverse to match.
        let mut prev_hash_bytes = hex::decode(&job.prev_hash)
            .context("invalid prev_hash hex")?;
        prev_hash_bytes.reverse();
        let cb1_bytes = hex::decode(&job.coinbase1)
            .context("invalid coinbase1 hex")?;
        let cb2_bytes = hex::decode(&job.coinbase2)
            .context("invalid coinbase2 hex")?;
        let branch_bytes: Vec<Vec<u8>> = job.merkle_branches
            .iter()
            .map(|b| hex::decode(b).context("invalid merkle branch hex"))
            .collect::<Result<_>>()?;
        let version = u32::from_str_radix(&job.version, 16)
            .context("invalid version hex")?;
        let n_bits = u32::from_str_radix(&job.n_bits, 16)
            .context("invalid n_bits hex")?;
        let n_time = u32::from_str_radix(job.n_time.trim_start_matches("0x"), 16)
            .context("invalid n_time hex")?;

        // ── Fetch on-chain state ──────────────────────────────────────────────
        let sender = self.keypair.address;

        let pool_obj = self.rpc.get_object(&self.config.pool_object_id).await?;
        let initial_shared_version = SuiRpcClient::parse_shared_version(
            pool_obj.owner.as_ref().context("pool object has no owner field")?,
        )?;

        let gas_coin  = self.rpc.get_first_coin(&self.keypair.address_hex()).await?;
        let gas_ref   = SuiRpcClient::coin_to_object_ref(&gas_coin)?;
        let gas_price = self.rpc.get_reference_gas_price().await?;

        // ── Build PTB ─────────────────────────────────────────────────────────
        let mut ptb = PtbBuilder::new();

        // Inputs
        let pool_arg     = ptb.shared_object(self.pool_id, initial_shared_version, true);
        let prev_hash_arg = ptb.pure_bytes(prev_hash_bytes)?;
        let cb1_arg       = ptb.pure_bytes(cb1_bytes)?;
        let cb2_arg       = ptb.pure_bytes(cb2_bytes)?;
        let branches_arg  = ptb.pure_bytes_vec(branch_bytes)?;
        let version_arg   = ptb.pure_u32(version)?;
        let n_bits_arg    = ptb.pure_u32(n_bits)?;
        let n_time_arg    = ptb.pure_u32(n_time)?;
        let reward_arg    = ptb.pure_u64(self.config.reward_mist)?;

        // MoveCall: pool::post_job — pass GasCoin directly as &mut Coin<SUI> payment
        ptb.move_call(
            self.package_id,
            "pool",
            "post_job",
            vec![
                pool_arg, prev_hash_arg, cb1_arg, cb2_arg, branches_arg,
                version_arg, n_bits_arg, n_time_arg, reward_arg, PtbArg::GasCoin,
            ],
        );

        // ── Encode, sign, submit ──────────────────────────────────────────────
        let tx_b64  = ptb.build(sender, gas_ref, gas_price, 10_000_000)?;
        let sig_b64 = self.keypair.sign_transaction(
            &STANDARD.decode(&tx_b64).unwrap(),
        );

        let digest = self.rpc.execute_transaction(&tx_b64, &sig_b64).await?;
        info!(job_id = job.id, digest = %digest, "job posted on-chain");
        Ok(digest)
    }

    /// Set the on-chain pool difficulty derived from the current n_bits and initial_difficulty.
    ///
    /// Called once when the first block template arrives.
    pub async fn init_pool_difficulty(&self, n_bits: u32) -> Result<()> {
        let pool_scalar = compute_pool_scalar(n_bits, self.config.initial_difficulty);
        self.set_on_chain_difficulty(pool_scalar).await?;
        info!(
            n_bits     = format!("{:08x}", n_bits),
            pool_scalar,
            "on-chain pool difficulty initialized"
        );
        Ok(())
    }

    /// Update on-chain difficulty after a VARDIFF adjustment.
    pub async fn update_on_chain_difficulty(&self, n_bits: u32, new_diff: u64) -> Result<()> {
        let pool_scalar = compute_pool_scalar(n_bits, new_diff);
        self.set_on_chain_difficulty(pool_scalar).await?;
        info!(
            n_bits     = format!("{:08x}", n_bits),
            stratum_diff = new_diff,
            pool_scalar,
            "on-chain difficulty updated via VARDIFF"
        );
        Ok(())
    }

    async fn set_on_chain_difficulty(&self, pool_scalar: u64) -> Result<()> {
        let pool_obj = self.rpc.get_object(&self.config.pool_object_id).await?;
        let initial_shared_version = SuiRpcClient::parse_shared_version(
            pool_obj.owner.as_ref().context("pool object has no owner field")?,
        )?;
        let gas_coin  = self.rpc.get_first_coin(&self.keypair.address_hex()).await?;
        let gas_ref   = SuiRpcClient::coin_to_object_ref(&gas_coin)?;
        let gas_price = self.rpc.get_reference_gas_price().await?;

        let mut ptb = PtbBuilder::new();
        let pool_arg = ptb.shared_object(self.pool_id, initial_shared_version, true);
        let diff_arg = ptb.pure_u64(pool_scalar)?;
        ptb.move_call(self.package_id, "pool", "set_difficulty", vec![pool_arg, diff_arg]);

        let tx_b64  = ptb.build(self.keypair.address, gas_ref, gas_price, 5_000_000)?;
        let sig_b64 = self.keypair.sign_transaction(&STANDARD.decode(&tx_b64).unwrap());
        let _digest = self.rpc.execute_transaction(&tx_b64, &sig_b64).await?;
        Ok(())
    }
}
