//! Stratum v1 TCP proxy with share interception and automatic on-chain registration.
//!
//! The proxy sits transparently between the miner's hardware and the upstream pool:
//!
//! ```text
//! ASIC/GPU  ──→  sidecar :SIDECAR_PORT  ──→  pool :POOL_PORT
//!                    │
//!                    │  on pool {result: true} for mining.authorize
//!                    ▼
//!             Sui: pool::register_worker  (signed by miner's own key)
//!
//!                    │  on pool {result: true} for mining.submit
//!                    ▼
//!             Sui: pool::submit_share     (signed by miner's own key)
//! ```
//!
//! All Stratum message parsing uses [`sv1_api::json_rpc::Message`] for real-world
//! ASIC (Avalon) compatibility.
//!
//! State machine per connection:
//!   1. `mining.subscribe` response  → capture extranonce1
//!   2. `mining.authorize` (miner→)  → buffer pending auth (username + rpc_id)
//!   3. `{result: true}` for auth    → call register_worker on-chain
//!   4. `mining.notify`              → update stored job template
//!   5. `mining.submit` (miner→pool) → buffer pending share
//!   6. `{result: true}` for submit  → submit share on-chain
//!   7. `{result: false/error}`      → discard pending share

use anyhow::Result;
use sv1_api::json_rpc::Message;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn};

use crate::config::SidecarConfig;
use crate::submit::{ChainSubmitter, PendingShare};

// ── Session state ─────────────────────────────────────────────────────────────

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

#[derive(Debug, Clone)]
struct PendingSubmit {
    job_id:      u64,
    extranonce2: String,
    ntime:       String,
    nonce:       String,
}

#[derive(Debug, Clone)]
struct PendingAuth {
    username:    String,
    rpc_id:      u64,
}

#[derive(Debug, Default)]
struct SessionState {
    extranonce1:     Option<String>,
    current_job:     Option<CurrentJob>,
    pending_submit:  Option<PendingSubmit>,
    pending_auth:    Option<PendingAuth>,
    /// RPC id of the last `mining.submit` forwarded upstream.
    pending_rpc_id:  Option<u64>,
}

// ── Proxy server ──────────────────────────────────────────────────────────────

pub struct ProxyServer {
    config:    SidecarConfig,
    submitter: Arc<ChainSubmitter>,
}

impl ProxyServer {
    pub fn new(config: SidecarConfig) -> Result<Self> {
        let submitter = Arc::new(ChainSubmitter::new(config.clone())?);
        Ok(Self { config, submitter })
    }

    pub async fn run(self) -> Result<()> {
        let addr = format!("0.0.0.0:{}", self.config.listen_port);
        let listener = TcpListener::bind(&addr).await?;
        info!(
            listen   = %addr,
            upstream = %format!("{}:{}", self.config.pool_host, self.config.pool_port),
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
    let upstream_addr = format!("{}:{}", config.pool_host, config.pool_port);
    let upstream = TcpStream::connect(&upstream_addr).await?;
    info!(pool = %upstream_addr, "connected to upstream pool");

    let (ds_read, ds_write) = downstream.into_split();
    let (us_read, us_write) = upstream.into_split();

    let ds_writer = Arc::new(Mutex::new(ds_write));
    let us_writer = Arc::new(Mutex::new(us_write));

    let mut ds_reader = BufReader::new(ds_read);
    let mut us_reader = BufReader::new(us_read);

    let state = Arc::new(Mutex::new(SessionState::default()));

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
                info!(raw = %line, "ASIC→pool");

                if let Ok(Message::StandardRequest(req)) = serde_json::from_str::<Message>(&line) {
                    match req.method.as_str() {
                        "mining.submit" => {
                            intercept_miner_submit(&req.params, req.id, &state).await;
                        }
                        "mining.authorize" => {
                            intercept_miner_authorize(&req.params, req.id, &state).await;
                        }
                        _ => {}
                    }
                }

                let mut w = us_writer.lock().await;
                w.write_all(line.as_bytes()).await?;
                w.write_all(b"\n").await?;
            }

            // ── Pool → Miner ─────────────────────────────────────────────────
            n = us_reader.read_line(&mut us_line) => {
                if n? == 0 { break; }
                let line = us_line.trim().to_string();
                if line.is_empty() { continue; }
                info!(raw = %line, "pool→ASIC");

                if let Ok(msg) = serde_json::from_str::<Message>(&line) {
                    intercept_pool_message(&msg, &state, &submitter).await;
                }

                let mut w = ds_writer.lock().await;
                w.write_all(line.as_bytes()).await?;
                w.write_all(b"\n").await?;
            }
        }
    }
    Ok(())
}

// ── Interception logic ────────────────────────────────────────────────────────

async fn intercept_miner_authorize(
    params: &serde_json::Value,
    rpc_id: u64,
    state:  &Arc<Mutex<SessionState>>,
) {
    let username = params
        .get(0)
        .and_then(|v| v.as_str())
        .unwrap_or("anonymous")
        .to_string();

    debug!(username = %username, "buffering pending authorize");
    state.lock().await.pending_auth = Some(PendingAuth { username, rpc_id });
}

async fn intercept_miner_submit(
    params: &serde_json::Value,
    rpc_id: u64,
    state:  &Arc<Mutex<SessionState>>,
) {
    let arr = match params.as_array() {
        Some(a) if a.len() >= 5 => a,
        _ => { warn!("mining.submit params unexpected shape"); return; }
    };

    let job_id_hex  = arr[1].as_str().unwrap_or("0");
    let extranonce2 = arr[2].as_str().unwrap_or("").to_string();
    let ntime       = arr[3].as_str().unwrap_or("0").to_string();
    let nonce       = arr[4].as_str().unwrap_or("0").to_string();
    let job_id      = u64::from_str_radix(job_id_hex, 16).unwrap_or(0);

    debug!(job_id, nonce = %nonce, "buffering pending share");

    let mut s = state.lock().await;
    s.pending_submit = Some(PendingSubmit { job_id, extranonce2, ntime, nonce });
    s.pending_rpc_id = Some(rpc_id);
}

async fn intercept_pool_message(
    msg:       &Message,
    state:     &Arc<Mutex<SessionState>>,
    submitter: &Arc<ChainSubmitter>,
) {
    match msg {
        // ── mining.notify — update stored job template ────────────────────────
        Message::Notification(notif) if notif.method == "mining.notify" => {
            let p = &notif.params;
            if let Some(arr) = p.as_array() {
                if arr.len() >= 8 {
                    let job = CurrentJob {
                        id:      u64::from_str_radix(
                                     arr[0].as_str().unwrap_or("0"), 16
                                 ).unwrap_or(0),
                        prev_hash:       arr[1].as_str().unwrap_or("").to_string(),
                        coinbase1:       arr[2].as_str().unwrap_or("").to_string(),
                        coinbase2:       arr[3].as_str().unwrap_or("").to_string(),
                        merkle_branches: arr[4].as_array()
                            .map(|a| a.iter()
                                .filter_map(|v| v.as_str().map(str::to_string))
                                .collect())
                            .unwrap_or_default(),
                        version: arr[5].as_str().unwrap_or("").to_string(),
                        n_bits:  arr[6].as_str().unwrap_or("").to_string(),
                        n_time:  arr[7].as_str().unwrap_or("").to_string(),
                    };
                    debug!(job_id = job.id, "job template updated");
                    state.lock().await.current_job = Some(job);
                }
            }
        }

        // ── OkResponse — match against pending authorize or submit ────────────
        Message::OkResponse(resp) => {
            // ── subscribe response: capture extranonce1 ───────────────────────
            if let Some(arr) = resp.result.as_array() {
                if arr.len() == 3 {
                    if let Some(e1) = arr[1].as_str() {
                        info!(extranonce1 = %e1, "captured extranonce1 from subscribe");
                        state.lock().await.extranonce1 = Some(e1.to_string());
                        return;
                    }
                }
            }

            let mut s = state.lock().await;

            // ── authorize accepted → register worker on-chain ─────────────────
            if let Some(auth) = &s.pending_auth {
                if resp.id == auth.rpc_id && resp.result.as_bool() == Some(true) {
                    let username    = auth.username.clone();
                    let extranonce1 = s.extranonce1.clone().unwrap_or_default();
                    s.pending_auth = None;
                    drop(s); // release lock before spawning

                    let en1_bytes = hex::decode(&extranonce1).unwrap_or_default();
                    let sub       = submitter.clone();
                    tokio::spawn(async move {
                        match sub.register_worker(&username, &en1_bytes).await {
                            Ok(digest) => info!(
                                worker = %username,
                                digest = %digest,
                                "worker registered on-chain"
                            ),
                            Err(e) => error!(
                                worker = %username,
                                error  = %e,
                                "register_worker PTB failed"
                            ),
                        }
                    });
                    return;
                }
            }

            // ── submit accepted → submit share on-chain ───────────────────────
            let pending_id = s.pending_rpc_id;
            if Some(resp.id) == pending_id {
                let pending = s.pending_submit.take();
                s.pending_rpc_id = None;
                drop(s); // release lock before spawning

                if let Some(p) = pending {
                    let extranonce2 = hex::decode(&p.extranonce2).unwrap_or_default();
                    let n_time = u32::from_str_radix(
                        p.ntime.trim_start_matches("0x"), 16
                    ).unwrap_or(0);
                    let nonce = u32::from_str_radix(
                        p.nonce.trim_start_matches("0x"), 16
                    ).unwrap_or(0);

                    let share = PendingShare { job_id: p.job_id, extranonce2, n_time, nonce };
                    let sub   = submitter.clone();
                    tokio::spawn(async move {
                        match sub.submit_share(&share).await {
                            Ok(digest) => info!(digest = %digest, "share recorded on-chain"),
                            Err(e)     => error!(error = %e, "submit_share PTB failed"),
                        }
                    });
                }
            }
        }

        // ── ErrorResponse — pool rejected the share, nothing goes on-chain ─────
        Message::ErrorResponse(resp) => {
            let mut s = state.lock().await;
            let pending_id = s.pending_rpc_id;
            if Some(resp.id) == pending_id {
                s.pending_submit = None;
                s.pending_rpc_id = None;
                debug!("share rejected by pool — not submitted on-chain");
            }
        }

        _ => {}
    }
}
