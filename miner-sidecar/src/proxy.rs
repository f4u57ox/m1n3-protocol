//! Stratum v1 TCP proxy with share interception.
//!
//! The proxy sits transparently between the miner's hardware and the upstream pool:
//!
//! ```text
//! ASIC/GPU  ──→  sidecar :SIDECAR_PORT  ──→  pool :POOL_PORT
//!                    │
//!                    │  on pool response: {result: true}
//!                    ▼
//!             Sui: pool::submit_share  (signed by miner's key)
//! ```
//!
//! State machine per connection:
//!   1. `mining.subscribe` response → capture extranonce1
//!   2. `mining.notify`             → update current job template
//!   3. `mining.submit` (miner →)   → buffer pending share
//!   4. `{result: true}` (pool →)   → submit pending share on-chain, clear buffer
//!   5. `{result: false/error}`     → discard pending share

use anyhow::Result;
use serde_json::Value;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tracing::{debug, error, info, warn};

use crate::config::SidecarConfig;
use crate::submit::{ChainSubmitter, PendingShare};

// ── Job state ─────────────────────────────────────────────────────────────────

/// Current mining job as received via `mining.notify`.
#[derive(Debug, Clone, Default)]
struct CurrentJob {
    id:              u64,
    prev_hash:       String,
    coinbase1:       String,
    coinbase2:       String,
    merkle_branches: Vec<String>,
    version:         String,
    n_bits:          String,
    n_time:          String,
}

/// A share submitted by the miner, held until the pool accepts or rejects it.
#[derive(Debug, Clone)]
struct PendingSubmit {
    job_id:      u64,
    extranonce2: String,
    ntime:       String,
    nonce:       String,
}

// ── Session state ─────────────────────────────────────────────────────────────

#[derive(Debug, Default)]
struct SessionState {
    extranonce1:     Option<String>,
    current_job:     Option<CurrentJob>,
    pending_submit:  Option<PendingSubmit>,
    /// Monotonically increasing RPC id of the last `mining.submit` sent upstream.
    pending_rpc_id:  Option<Value>,
}

// ── Proxy server ──────────────────────────────────────────────────────────────

/// Manages the listen socket and spawns a handler per ASIC connection.
pub struct ProxyServer {
    config:    SidecarConfig,
    submitter: Arc<ChainSubmitter>,
}

impl ProxyServer {
    pub fn new(config: SidecarConfig) -> Self {
        let submitter = Arc::new(ChainSubmitter::new(config.clone()));
        Self { config, submitter }
    }

    pub async fn run(self) -> Result<()> {
        let addr = format!("0.0.0.0:{}", self.config.listen_port);
        let listener = TcpListener::bind(&addr).await?;
        info!(
            listen  = %addr,
            upstream = format!("{}:{}", self.config.pool_host, self.config.pool_port),
            "m1n3-sidecar proxy listening"
        );

        loop {
            let (downstream, peer) = listener.accept().await?;
            info!(peer = %peer, "ASIC connected to sidecar");
            let config    = self.config.clone();
            let submitter = self.submitter.clone();
            tokio::spawn(async move {
                if let Err(e) = handle_session(downstream, config, submitter).await {
                    warn!(peer = %peer, error = %e, "sidecar session closed with error");
                }
            });
        }
    }
}

// ── Session handler ───────────────────────────────────────────────────────────

async fn handle_session(
    downstream: TcpStream,
    config:     SidecarConfig,
    submitter:  Arc<ChainSubmitter>,
) -> Result<()> {
    // Open connection to the upstream pool.
    let upstream_addr = format!("{}:{}", config.pool_host, config.pool_port);
    let upstream = TcpStream::connect(&upstream_addr).await?;
    info!(pool = %upstream_addr, "connected to upstream pool");

    let (ds_read, ds_write) = downstream.into_split();
    let (us_read, us_write) = upstream.into_split();

    let ds_writer = Arc::new(tokio::sync::Mutex::new(ds_write));
    let us_writer = Arc::new(tokio::sync::Mutex::new(us_write));

    let mut ds_reader = BufReader::new(ds_read);
    let mut us_reader = BufReader::new(us_read);

    let state = Arc::new(tokio::sync::Mutex::new(SessionState::default()));

    let mut ds_line = String::new();
    let mut us_line = String::new();

    loop {
        ds_line.clear();
        us_line.clear();

        tokio::select! {
            // ── Miner → Pool ─────────────────────────────────────────────────
            n = ds_reader.read_line(&mut ds_line) => {
                if n? == 0 { break; }
                let line = ds_line.trim().to_string();
                if line.is_empty() { continue; }

                // Intercept mining.submit before forwarding upstream.
                if let Ok(msg) = serde_json::from_str::<Value>(&line) {
                    if msg.get("method").and_then(Value::as_str) == Some("mining.submit") {
                        intercept_miner_submit(&msg, &state).await;
                    }
                }

                // Forward to pool.
                let mut w = us_writer.lock().await;
                w.write_all(line.as_bytes()).await?;
                w.write_all(b"\n").await?;
            }

            // ── Pool → Miner ─────────────────────────────────────────────────
            n = us_reader.read_line(&mut us_line) => {
                if n? == 0 { break; }
                let line = us_line.trim().to_string();
                if line.is_empty() { continue; }

                // Intercept pool responses and notifications before forwarding.
                if let Ok(msg) = serde_json::from_str::<Value>(&line) {
                    intercept_pool_message(&msg, &state, &submitter).await;
                }

                // Forward to miner.
                let mut w = ds_writer.lock().await;
                w.write_all(line.as_bytes()).await?;
                w.write_all(b"\n").await?;
            }
        }
    }
    Ok(())
}

// ── Interception logic ────────────────────────────────────────────────────────

/// Called when the miner sends `mining.submit` upstream.
/// Buffers the share so we can post it on-chain if the pool accepts it.
async fn intercept_miner_submit(
    msg:   &Value,
    state: &Arc<tokio::sync::Mutex<SessionState>>,
) {
    let params = match msg.get("params").and_then(Value::as_array) {
        Some(p) if p.len() >= 5 => p,
        _ => {
            warn!("mining.submit with unexpected params shape");
            return;
        }
    };

    let job_id_str  = params[1].as_str().unwrap_or("0");
    let extranonce2 = params[2].as_str().unwrap_or("").to_string();
    let ntime       = params[3].as_str().unwrap_or("0").to_string();
    let nonce       = params[4].as_str().unwrap_or("0").to_string();
    let job_id      = u64::from_str_radix(job_id_str, 16).unwrap_or(0);

    debug!(job_id, nonce = %nonce, "buffering pending share");

    let mut s = state.lock().await;
    s.pending_submit = Some(PendingSubmit { job_id, extranonce2, ntime, nonce });
    s.pending_rpc_id = msg.get("id").cloned();
}

/// Called for every message received from the pool (responses + notifications).
async fn intercept_pool_message(
    msg:       &Value,
    state:     &Arc<tokio::sync::Mutex<SessionState>>,
    submitter: &Arc<ChainSubmitter>,
) {
    // ── mining.notify ─────────────────────────────────────────────────────────
    if msg.get("method").and_then(Value::as_str) == Some("mining.notify") {
        if let Some(params) = msg.get("params").and_then(Value::as_array) {
            if params.len() >= 8 {
                let job_id_str = params[0].as_str().unwrap_or("0");
                let job = CurrentJob {
                    id:              u64::from_str_radix(job_id_str, 16).unwrap_or(0),
                    prev_hash:       params[1].as_str().unwrap_or("").to_string(),
                    coinbase1:       params[2].as_str().unwrap_or("").to_string(),
                    coinbase2:       params[3].as_str().unwrap_or("").to_string(),
                    merkle_branches: params[4].as_array()
                        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                        .unwrap_or_default(),
                    version:         params[5].as_str().unwrap_or("").to_string(),
                    n_bits:          params[6].as_str().unwrap_or("").to_string(),
                    n_time:          params[7].as_str().unwrap_or("").to_string(),
                };
                debug!(job_id = job.id, "job template updated from mining.notify");
                state.lock().await.current_job = Some(job);
            }
        }
        return;
    }

    // ── mining.subscribe response → capture extranonce1 ───────────────────────
    if let Some(result) = msg.get("result").and_then(Value::as_array) {
        if result.len() == 3 {
            if let Some(e1) = result[1].as_str() {
                info!(extranonce1 = %e1, "captured extranonce1 from subscribe response");
                state.lock().await.extranonce1 = Some(e1.to_string());
                return;
            }
        }
    }

    // ── Pool response to mining.submit ────────────────────────────────────────
    let s = state.lock().await;
    let is_submit_response = s.pending_rpc_id.is_some()
        && msg.get("id") == s.pending_rpc_id.as_ref();
    let accepted = msg.get("result").and_then(Value::as_bool) == Some(true)
        && msg.get("error").map_or(true, Value::is_null);
    drop(s);

    if is_submit_response {
        let mut s = state.lock().await;
        if accepted {
            if let Some(pending) = s.pending_submit.take() {
                let extranonce2 = hex::decode(&pending.extranonce2).unwrap_or_default();
                let n_time = u32::from_str_radix(
                    pending.ntime.trim_start_matches("0x"), 16
                ).unwrap_or(0);
                let nonce = u32::from_str_radix(
                    pending.nonce.trim_start_matches("0x"), 16
                ).unwrap_or(0);

                let share = PendingShare {
                    job_id: pending.job_id,
                    extranonce2,
                    n_time,
                    nonce,
                };

                // Drop the lock before the async call.
                drop(s);
                let submitter = submitter.clone();
                tokio::spawn(async move {
                    match submitter.submit_share(&share).await {
                        Ok(digest)  => info!(digest = %digest, "share recorded on-chain"),
                        Err(e)      => error!(error = %e, "on-chain share submission failed"),
                    }
                });
            } else {
                drop(s);
            }
        } else {
            // Pool rejected the share — discard, nothing goes on-chain.
            s.pending_submit = None;
            s.pending_rpc_id = None;
            debug!("share rejected by pool — not submitted on-chain");
        }
    }
}
