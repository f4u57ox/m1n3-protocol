//! Solo-mode trustless share submission.
//!
//! When --miner-keypair is set the stratum server signs its own share batches
//! with the miner keypair directly — no sidecar needed.

use anyhow::Result;
use std::collections::HashMap;
use sui_client::{MinerClient, PendingShare};
use tokio::{sync::mpsc, time::interval, time::Duration};
use tracing::{info, warn};

// ── Public types ──────────────────────────────────────────────────────────────

pub struct MinerShare {
    pub extranonce2: Vec<u8>,
    pub ntime: u32,
    pub nonce: u32,
    pub version: u32,
}

pub enum BatchMsg {
    Share { template_pda: String, share: MinerShare },
    /// Flush all pending shares immediately (sent on new block).
    Flush,
    /// Flush pending shares and signal completion via the oneshot channel.
    FlushAndWait(tokio::sync::oneshot::Sender<()>),
}

// ── Submitter ─────────────────────────────────────────────────────────────────

pub struct MinerSubmitter {
    inner: MinerClient,
}

impl MinerSubmitter {
    pub async fn new(
        package_id: &str,
        pool_id: &str,
        dedup_registry_id: &str,
        rpc_url: &str,
        keystore_path: &str,
        gas_budget: u64,
    ) -> Result<Self> {
        Ok(Self {
            inner: MinerClient::new(
                package_id,
                pool_id,
                dedup_registry_id,
                rpc_url,
                keystore_path,
                gas_budget,
            )
            .await?,
        })
    }
}

// ── Batch flusher task ────────────────────────────────────────────────────────

pub async fn miner_batch_flusher(
    mut submitter: MinerSubmitter,
    mut rx: mpsc::UnboundedReceiver<BatchMsg>,
    batch_size: usize,
    batch_timeout_ms: u64,
) {
    let mut batch: Vec<(String, PendingShare)> = Vec::new();
    let mut ticker = interval(Duration::from_millis(batch_timeout_ms));
    ticker.tick().await; // consume the immediate first tick

    loop {
        tokio::select! {
            msg = rx.recv() => {
                match msg {
                    None => { flush(&mut submitter.inner, &mut batch).await; break; }
                    Some(BatchMsg::Flush) => flush(&mut submitter.inner, &mut batch).await,
                    Some(BatchMsg::FlushAndWait(done_tx)) => {
                        flush(&mut submitter.inner, &mut batch).await;
                        let _ = done_tx.send(());
                    }
                    Some(BatchMsg::Share { template_pda, share }) => {
                        let ps = PendingShare {
                            extranonce1: vec![],
                            extranonce2: share.extranonce2,
                            ntime: share.ntime,
                            nonce: share.nonce,
                            version: share.version,
                        };
                        batch.push((template_pda, ps));
                        if batch.len() >= batch_size {
                            flush(&mut submitter.inner, &mut batch).await;
                        }
                    }
                }
            }
            _ = ticker.tick() => flush(&mut submitter.inner, &mut batch).await,
        }
    }
}

async fn flush(client: &mut MinerClient, batch: &mut Vec<(String, PendingShare)>) {
    if batch.is_empty() {
        return;
    }
    let items: Vec<(String, PendingShare)> = batch.drain(..).collect();
    let n = items.len();
    match client.submit_batch(&items).await {
        Ok(digest) => info!("Batch of {} share(s) confirmed: {}", n, digest),
        Err(e) => warn!("Batch submission failed: {}", e),
    }
}
