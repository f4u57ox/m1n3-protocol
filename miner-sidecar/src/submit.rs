//! On-chain share submission — builds and signs Sui PTBs for `pool::submit_share`
//! and `pool::register_worker`.
//!
//! Every call here is signed with the miner's own private key, so the on-chain
//! record cannot be forged or suppressed by the pool operator.

use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use tokio::sync::Mutex;
use tracing::{debug, info};

use sui_client::{
    rpc::{parse_object_id, SuiRpcClient},
    PtbBuilder, SuiKeypair,
};

use crate::config::SidecarConfig;

// ── PendingShare ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct PendingShare {
    pub job_id:      u64,
    pub extranonce2: Vec<u8>,
    pub n_time:      u32,
    pub nonce:       u32,
    /// Actual block header version used for hashing (base version XOR version_bits
    /// when the miner uses BIP320 version-rolling).
    pub version:     u32,
}

// ── ChainSubmitter ────────────────────────────────────────────────────────────

pub struct ChainSubmitter {
    config:      SidecarConfig,
    rpc:         SuiRpcClient,
    keypair:     SuiKeypair,
    package_id:  [u8; 32],
    pool_id:     [u8; 32],
    /// Serializes PTB submissions so concurrent shares don't race for the same gas coin.
    submit_lock: Mutex<()>,
}

impl ChainSubmitter {
    pub fn new(config: SidecarConfig) -> Result<Self> {
        let rpc        = SuiRpcClient::new(&config.sui_rpc_url);
        let keypair    = SuiKeypair::parse(&config.miner_key)?;
        let package_id = parse_object_id(&config.package_id).context("invalid PACKAGE_ID")?;
        let pool_id    = parse_object_id(&config.pool_object_id).context("invalid POOL_OBJECT_ID")?;

        info!(
            network = %config.sui_rpc_url,
            miner   = %keypair.address_hex(),
            pool    = %config.pool_object_id,
            package = %config.package_id,
            "sidecar chain submitter initialized"
        );

        Ok(Self { config, rpc, keypair, package_id, pool_id, submit_lock: Mutex::new(()) })
    }

    async fn execute_ptb(&self, ptb: PtbBuilder) -> Result<String> {
        // Hold the lock for the full gas-fetch → sign → submit sequence so that
        // concurrent share submissions don't try to use the same gas coin object.
        let _guard = self.submit_lock.lock().await;

        let sender    = self.keypair.address;
        let gas_coin  = self.rpc.get_first_coin(&self.keypair.address_hex()).await?;
        let gas_ref   = SuiRpcClient::coin_to_object_ref(&gas_coin)?;
        let gas_price = self.rpc.get_reference_gas_price().await?;

        let tx_b64  = ptb.build(sender, gas_ref, gas_price, 5_000_000)?;
        let sig_b64 = self.keypair.sign_transaction(
            &STANDARD.decode(&tx_b64).unwrap(),
        );
        self.rpc.execute_transaction(&tx_b64, &sig_b64).await
    }

    async fn pool_shared_version(&self) -> Result<u64> {
        let obj = self.rpc.get_object(&self.config.pool_object_id).await?;
        SuiRpcClient::parse_shared_version(
            obj.owner.as_ref().context("pool object missing owner")?,
        )
    }

    /// Submit a validated share on-chain by calling `pool::submit_share`.
    pub async fn submit_share(&self, share: &PendingShare) -> Result<String> {
        debug!(
            job_id      = share.job_id,
            nonce       = share.nonce,
            extranonce2 = %hex::encode(&share.extranonce2),
            "submitting share on-chain"
        );

        let initial_shared_version = self.pool_shared_version().await?;

        let mut ptb = PtbBuilder::new();
        let pool_arg    = ptb.shared_object(self.pool_id, initial_shared_version, true);
        let job_id_arg  = ptb.pure_u64(share.job_id)?;
        let en2_arg     = ptb.pure_bytes(share.extranonce2.clone())?;
        let ntime_arg   = ptb.pure_u32(share.n_time)?;
        let nonce_arg   = ptb.pure_u32(share.nonce)?;
        let version_arg = ptb.pure_u32(share.version)?;

        ptb.move_call(
            self.package_id, "pool", "submit_share",
            vec![pool_arg, job_id_arg, en2_arg, ntime_arg, nonce_arg, version_arg],
        );

        let digest = self.execute_ptb(ptb).await?;
        info!(job_id = share.job_id, nonce = share.nonce, digest = %digest, "share recorded on-chain");
        Ok(digest)
    }

    /// Register a worker on-chain by calling `pool::register_worker`.
    ///
    /// Called automatically after `mining.authorize` is accepted — no manual step needed.
    pub async fn register_worker(&self, name: &str, extranonce1: &[u8]) -> Result<String> {
        debug!(worker = name, "registering worker on-chain");

        let initial_shared_version = self.pool_shared_version().await?;

        let mut ptb = PtbBuilder::new();
        let pool_arg = ptb.shared_object(self.pool_id, initial_shared_version, true);
        let name_arg = ptb.pure_bytes(name.as_bytes().to_vec())?;
        let en1_arg  = ptb.pure_bytes(extranonce1.to_vec())?;

        ptb.move_call(
            self.package_id, "pool", "register_worker",
            vec![pool_arg, name_arg, en1_arg],
        );

        let digest = self.execute_ptb(ptb).await?;
        info!(worker = name, digest = %digest, "worker registered on-chain");
        Ok(digest)
    }
}
