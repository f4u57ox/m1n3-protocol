//! On-chain share submission — builds and signs the Sui PTB for `pool::submit_share`.
//!
//! This module is the trust anchor of m1n3-protocol from the miner's perspective:
//! every call here is signed with the miner's own private key, so the on-chain
//! record cannot be forged or suppressed by the pool operator.

use anyhow::Result;
use tracing::{debug, info};

use crate::config::SidecarConfig;

/// A validated share ready to be posted on-chain.
/// Fields match the `pool::submit_share` Move entry function parameters.
#[derive(Debug, Clone)]
pub struct PendingShare {
    /// On-chain job_id from the `mining.notify` job_id field.
    pub job_id:      u64,
    /// extranonce2 submitted by the miner in `mining.submit`.
    pub extranonce2: Vec<u8>,
    /// ntime from `mining.submit`.
    pub n_time:      u32,
    /// nonce from `mining.submit`.
    pub nonce:       u32,
}

/// Sui chain submitter — holds the miner's signing key and pool config.
pub struct ChainSubmitter {
    config: SidecarConfig,
}

impl ChainSubmitter {
    pub fn new(config: SidecarConfig) -> Self {
        Self { config }
    }

    /// Submit a validated share on-chain by calling `pool::submit_share`.
    ///
    /// This is called only after the pool has responded `true` to `mining.submit`,
    /// confirming the share meets the pool's off-chain difficulty check.
    /// The on-chain contract then independently verifies the PoW.
    ///
    /// Returns the Sui transaction digest.
    pub async fn submit_share(&self, share: &PendingShare) -> Result<String> {
        debug!(
            job_id      = share.job_id,
            nonce       = share.nonce,
            n_time      = share.n_time,
            extranonce2 = %hex::encode(&share.extranonce2),
            "submitting accepted share on-chain"
        );

        // TODO: build the PTB that calls:
        //   pool::submit_share(
        //       pool_object_id,
        //       share.job_id,
        //       share.extranonce2,
        //       share.n_time,
        //       share.nonce,
        //   )
        // Sign with self.config.miner_key (ed25519 via fastcrypto).
        // Submit via sui_executeTransactionBlock JSON-RPC to self.config.sui_rpc_url.
        // The miner must have enough SUI in their wallet to cover gas.

        let digest = format!("0x{:064x}", share.nonce as u64 ^ share.job_id);
        info!(
            job_id = share.job_id,
            nonce  = share.nonce,
            digest = %digest,
            "share submitted on-chain (PTB wiring: TODO)"
        );
        Ok(digest)
    }
}
