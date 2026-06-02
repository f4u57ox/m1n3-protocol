//! Stratum v1 server — accepts miner connections and drives the on-chain job registry.
//!
//! Protocol reference:
//! <https://github.com/stratum-mining/stratum/tree/65c9688ca0e9cdcf213b32a6f51e9309fb75bbab/sv1>
//!
//! JSON-RPC message parsing uses [`sv1_api`] — the reference implementation from the
//! stratum-mining project — ensuring compatibility with real ASIC hardware (Avalon, etc.)
//! whose Stratum dialects often deviate from the spec in subtle ways.
//!
//! This process is the **operator side** of m1n3-protocol:
//! - Polls Bitcoin Core's `getblocktemplate` every `JOB_REFRESH_SECS` seconds.
//! - Broadcasts mining jobs to connected miners via `mining.notify`.
//! - Posts each job template on-chain via [`SuiChainClient::post_job`] in parallel.
//! - Validates shares off-chain (SHA-256d) before responding `true` to `mining.submit`.
//!
//! Share submission to the on-chain contract is handled by each miner's own
//! `miner-sidecar` process (see the `miner-sidecar/` crate).

use anyhow::Result;
use sv1_api::json_rpc::{Message, Notification, Response, StandardRequest};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, Mutex};
use tracing::{error, info, warn};

use crate::bitcoin_rpc::{BitcoinRpcClient, build_coinbase_parts, build_merkle_branches};
use crate::chain::{BridgeConfig, SuiChainClient};
use crate::pow;

// ── Job ───────────────────────────────────────────────────────────────────────

/// An active mining job — fields correspond 1-to-1 with `mining.notify` params.
#[derive(Debug, Clone)]
pub struct Job {
    pub id:              u64,
    pub prev_hash:       String,
    pub coinbase1:       String,
    pub coinbase2:       String,
    pub merkle_branches: Vec<String>,
    pub version:         String,
    pub n_bits:          String,
    pub n_time:          String,
    pub clean_jobs:      bool,
}

impl Job {
    /// Serialize as the params array for a `mining.notify` JSON-RPC notification.
    pub fn to_notify_params(&self) -> serde_json::Value {
        serde_json::json!([
            format!("{:016x}", self.id),
            self.prev_hash,
            self.coinbase1,
            self.coinbase2,
            self.merkle_branches,
            self.version,
            self.n_bits,
            self.n_time,
            self.clean_jobs,
        ])
    }
}

// ── Session state ─────────────────────────────────────────────────────────────

/// Per-connection miner session state.
struct MinerSession {
    session_id:  String,
    extranonce1: String,
    username:    Option<String>,
    authorized:  bool,
    difficulty:  u64,
}

impl MinerSession {
    fn new(session_id: String, extranonce1: String, difficulty: u64) -> Self {
        Self { session_id, extranonce1, username: None, authorized: false, difficulty }
    }
}

// ── Server ────────────────────────────────────────────────────────────────────

/// Shared state cloned (via `Arc`) into every spawned connection handler.
struct ServerState {
    config:       BridgeConfig,
    chain:        Arc<SuiChainClient>,
    job_tx:       broadcast::Sender<Arc<Job>>,
    next_session: Mutex<u32>,
    /// Most recently broadcast job — sent to miners that subscribe mid-cycle.
    current_job:  Mutex<Option<Arc<Job>>>,
    /// History of recent jobs keyed by job_id for share validation.
    /// Allows shares for recently-seen jobs to validate correctly even if a newer
    /// job has been broadcast since the miner started working on that share.
    recent_jobs:  Mutex<HashMap<u64, Arc<Job>>>,
}

pub struct StratumServer {
    state: Arc<ServerState>,
}

impl StratumServer {
    pub async fn new(config: BridgeConfig) -> Result<Self> {
        let chain = Arc::new(SuiChainClient::new(config.clone())?);
        let (job_tx, _) = broadcast::channel(32);
        Ok(Self {
            state: Arc::new(ServerState {
                chain,
                job_tx,
                next_session: Mutex::new(0),
                current_job:  Mutex::new(None),
                recent_jobs:  Mutex::new(HashMap::new()),
                config,
            }),
        })
    }

    pub async fn run(self) -> Result<()> {
        let addr = format!("{}:{}", self.state.config.host, self.state.config.port);
        let listener = TcpListener::bind(&addr).await?;
        info!("Stratum v1 server listening on {}", addr);

        // ── Job refresh loop ──────────────────────────────────────────────────
        // Polls Bitcoin Core for new block templates and broadcasts to miners.
        {
            let state    = self.state.clone();
            let btc      = BitcoinRpcClient::new(
                state.config.bitcoin_rpc_url.clone(),
                state.config.bitcoin_rpc_user.clone(),
                state.config.bitcoin_rpc_pass.clone(),
            );
            let interval = Duration::from_secs(state.config.job_refresh_secs);
            let mut first_job = true;

            tokio::spawn(async move {
                loop {
                    match btc.get_block_template().await {
                        Err(e) => {
                            error!(error = %e, "getblocktemplate failed — will retry");
                        }
                        Ok(tmpl) => {
                            let n_bits = u32::from_str_radix(&tmpl.bits, 16).unwrap_or(0);

                            let (cb1, cb2) = build_coinbase_parts(&tmpl, 4, 4);
                            // Fetch the on-chain next_job_id so stratum job IDs always
                            // match what the contract auto-assigns on post_job.
                            let job_counter = match state.chain.get_next_job_id().await {
                                Ok(id) => id,
                                Err(e) => {
                                    error!(error = %e, "get_next_job_id failed — skipping job");
                                    tokio::time::sleep(interval).await;
                                    continue;
                                }
                            };

                            // Stratum prevhash convention: per-word-swap of internal
                            // (internal = full-reverse of Bitcoin RPC display format).
                            // CGMiner/Avalon applies per-word-swap to the received bytes
                            // to get back internal for the block header.
                            let stratum_prev_hash = {
                                let mut b = hex::decode(&tmpl.previousblockhash).unwrap_or_default();
                                b.reverse(); // display → internal
                                b.chunks(4).flat_map(|c| c.iter().rev().copied()).collect::<Vec<u8>>()
                            };

                            let job = Arc::new(Job {
                                id:              job_counter,
                                prev_hash:       hex::encode(&stratum_prev_hash),
                                coinbase1:       cb1,
                                coinbase2:       cb2,
                                merkle_branches: build_merkle_branches(&tmpl.transactions)
                                    .iter().map(hex::encode).collect(),
                                version:         format!("{:08x}", tmpl.version),
                                n_bits:          tmpl.bits.clone(),
                                n_time:          format!("{:08x}", tmpl.curtime),
                                clean_jobs:      true,
                            });

                            info!(
                                job_id   = job.id,
                                height   = tmpl.height,
                                n_bits   = %job.n_bits,
                                branches = job.merkle_branches.len(),
                                "new job from getblocktemplate"
                            );

                            // First job: set on-chain pool difficulty from INITIAL_DIFFICULTY.
                            if first_job {
                                first_job = false;
                                if let Err(e) = state.chain.init_pool_difficulty(n_bits).await {
                                    error!(error = %e, "init_pool_difficulty failed");
                                }
                            }

                            // Store as current job for late-connecting miners
                            *state.current_job.lock().await = Some(job.clone());

                            // Keep a rolling window of recent jobs for share validation.
                            // Miners may submit shares for jobs slightly older than current.
                            {
                                let mut jobs = state.recent_jobs.lock().await;
                                jobs.insert(job.id, job.clone());
                                if jobs.len() > 20 {
                                    if let Some(&oldest) = jobs.keys().min() {
                                        jobs.remove(&oldest);
                                    }
                                }
                            }

                            // Broadcast to all connected miners
                            let _ = state.job_tx.send(job.clone());

                            // Post on-chain — fire-and-forget; log errors but don't halt
                            let chain = state.chain.clone();
                            let j     = job.clone();
                            tokio::spawn(async move {
                                match chain.post_job(&j).await {
                                    Ok((digest, on_chain_id)) => {
                                        if on_chain_id != j.id {
                                            warn!(
                                                stratum_id = j.id,
                                                on_chain_id,
                                                digest = %digest,
                                                "job ID mismatch between stratum and chain"
                                            );
                                        }
                                    }
                                    Err(e) => error!(job_id = j.id, error = %e, "post_job PTB failed"),
                                }
                            });
                        }
                    }
                    tokio::time::sleep(interval).await;
                }
            });
        }

        // ── Accept miner connections ──────────────────────────────────────────
        loop {
            let (socket, peer) = listener.accept().await?;
            info!(peer = %peer, "miner connected");
            let state = self.state.clone();
            tokio::spawn(async move {
                if let Err(e) = handle_connection(socket, state).await {
                    warn!(peer = %peer, error = %e, "connection closed with error");
                }
            });
        }
    }
}

// ── Connection handler ────────────────────────────────────────────────────────

async fn handle_connection(stream: TcpStream, state: Arc<ServerState>) -> Result<()> {
    handle_connection_inner(stream, state).await
}

async fn handle_connection_inner(stream: TcpStream, state: Arc<ServerState>) -> Result<()> {
    let (read_half, write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    let writer = Arc::new(Mutex::new(write_half));

    // Assign a unique extranonce1 for this session.
    let extranonce1 = {
        let mut n = state.next_session.lock().await;
        let s = format!("{:08x}", *n);
        *n += 1;
        s
    };
    let mut session = MinerSession::new(
        extranonce1.clone(),
        extranonce1,
        state.config.initial_difficulty,
    );

    let mut job_rx = state.job_tx.subscribe();
    let mut line   = String::new();

    loop {
        line.clear();
        tokio::select! {
            n = reader.read_line(&mut line) => {
                if n? == 0 { break; }
                let trimmed = line.trim();
                if trimmed.is_empty() { continue; }

                let msg: Message = match serde_json::from_str(trimmed) {
                    Ok(m)  => m,
                    Err(e) => {
                        error!(raw = trimmed, error = %e, "malformed Stratum message");
                        continue;
                    }
                };

                if let Message::StandardRequest(req) = msg {
                    dispatch(req, &mut session, &state, writer.clone()).await?;
                }
            }
            Ok(job) = job_rx.recv() => {
                if session.authorized {
                    let notif = Notification {
                        method: "mining.notify".to_string(),
                        params: job.to_notify_params(),
                    };
                    send_msg(writer.clone(), &Message::Notification(notif)).await?;
                }
            }
        }
    }
    Ok(())
}

// ── Stratum method dispatch ───────────────────────────────────────────────────

async fn dispatch(
    req:     StandardRequest,
    session: &mut MinerSession,
    state:   &Arc<ServerState>,
    writer:  Arc<Mutex<tokio::net::tcp::OwnedWriteHalf>>,
) -> Result<()> {
    match req.method.as_str() {
        // ── mining.subscribe ─────────────────────────────────────────────────
        "mining.subscribe" => {
            let result = serde_json::json!([
                [
                    ["mining.set_difficulty", &session.session_id],
                    ["mining.notify",         &session.session_id],
                ],
                session.extranonce1,
                4   // extranonce2 size in bytes
            ]);
            send_msg(writer.clone(), &ok(req.id, result)).await?;

            let set_diff = Notification {
                method: "mining.set_difficulty".to_string(),
                params: serde_json::json!([session.difficulty]),
            };
            send_msg(writer.clone(), &Message::Notification(set_diff)).await?;

            // Push the current job immediately if one exists
            if let Some(job) = state.current_job.lock().await.clone() {
                let notif = Notification {
                    method: "mining.notify".to_string(),
                    params: job.to_notify_params(),
                };
                send_msg(writer.clone(), &Message::Notification(notif)).await?;
            }
        }

        // ── mining.authorize ─────────────────────────────────────────────────
        "mining.authorize" => {
            let username = req.params
                .get(0)
                .and_then(|v| v.as_str())
                .unwrap_or("anonymous")
                .to_string();

            session.username   = Some(username.clone());
            session.authorized = true;
            info!(username = %username, extranonce1 = %session.extranonce1, "worker authorized");
            send_msg(writer.clone(), &ok(req.id, true)).await?;
        }

        // ── mining.submit ────────────────────────────────────────────────────
        // Off-chain SHA-256d check first; sidecar submits on-chain only when
        // we respond true (ensuring the contract sees only valid shares).
        "mining.submit" => {
            if !session.authorized {
                send_msg(writer.clone(), &err(req.id, 24, "Unauthorized worker")).await?;
                return Ok(());
            }

            let params    = &req.params;
            let job_id_hex   = params.get(1).and_then(|v| v.as_str()).unwrap_or("0");
            let en2_hex      = params.get(2).and_then(|v| v.as_str()).unwrap_or("");
            let ntime_hex    = params.get(3).and_then(|v| v.as_str()).unwrap_or("0");
            let nonce_hex    = params.get(4).and_then(|v| v.as_str()).unwrap_or("0");
            let version_bits = params.get(5).and_then(|v| v.as_str())
                .and_then(|s| u32::from_str_radix(s.trim_start_matches("0x"), 16).ok())
                .unwrap_or(0);
            let worker       = session.username.as_deref().unwrap_or("unknown");

            // Look up the specific job the miner submitted against.
            // Using the submitted job_id (not state.current_job) is critical for
            // correctness: the ASIC may submit shares for jobs that were valid when
            // it received them but are no longer the latest job.
            let job_id_dec = u64::from_str_radix(job_id_hex, 16).unwrap_or(0);
            let job_opt = state.recent_jobs.lock().await.get(&job_id_dec).cloned();
            let Some(job) = job_opt else {
                warn!(worker, job_id = job_id_hex, "share rejected — job not in recent history");
                send_msg(writer.clone(), &err(req.id, 21, "Job not found")).await?;
                return Ok(());
            };

            // Parse share fields
            let en1 = match hex::decode(&session.extranonce1) {
                Ok(b) => b,
                Err(_) => {
                    send_msg(writer.clone(), &err(req.id, 20, "Bad extranonce1")).await?;
                    return Ok(());
                }
            };
            let en2 = match hex::decode(en2_hex) {
                Ok(b) => b,
                Err(_) => {
                    send_msg(writer.clone(), &err(req.id, 20, "Bad extranonce2")).await?;
                    return Ok(());
                }
            };
            let cb1 = hex::decode(&job.coinbase1).unwrap_or_default();
            let cb2 = hex::decode(&job.coinbase2).unwrap_or_default();
            let branches: Vec<[u8; 32]> = job.merkle_branches.iter()
                .filter_map(|b| {
                    hex::decode(b).ok().and_then(|v| v.try_into().ok())
                })
                .collect();
            // job.prev_hash is in Stratum format: per_word_swap(internal).
            // CGMiner applies per_word_swap to the received Stratum bytes to get internal.
            // Apply the same per-word-swap here so both sides hash the same header.
            let mut prev_hash: [u8; 32] = hex::decode(&job.prev_hash)
                .unwrap_or_default()
                .try_into()
                .unwrap_or([0u8; 32]);
            for chunk in prev_hash.chunks_mut(4) {
                chunk.reverse(); // per-word-swap → internal byte order
            }
            let version = u32::from_str_radix(&job.version, 16).unwrap_or(1) ^ version_bits;
            let n_bits  = u32::from_str_radix(&job.n_bits, 16).unwrap_or(0);
            let n_time  = u32::from_str_radix(ntime_hex.trim_start_matches("0x"), 16).unwrap_or(0);
            let nonce   = u32::from_str_radix(nonce_hex.trim_start_matches("0x"), 16).unwrap_or(0);

            // Off-chain PoW check: scalar derived from the fixed minimum difficulty.
            let pool_scalar = pow::compute_pool_scalar(
                n_bits,
                state.config.initial_difficulty,
            );
            let valid = pow::verify_share(
                &cb1, &cb2, &en1, &en2, &branches,
                version, &prev_hash, n_bits, n_time, nonce,
                pool_scalar,
            );

            if !valid {
                let (hash_hex, tgt_hex) = pow::debug_share(
                    &cb1, &cb2, &en1, &en2, &branches,
                    version, &prev_hash, n_bits, n_time, nonce,
                    pool_scalar,
                );
                warn!(
                    worker, job_id = job_id_hex,
                    hash = %hash_hex, target = %tgt_hex,
                    "low-difficulty share rejected"
                );
                send_msg(writer.clone(), &err(req.id, 23, "Low difficulty share")).await?;
                return Ok(());
            }

            info!(
                worker,
                job_id      = job_id_hex,
                extranonce2 = en2_hex,
                ntime       = ntime_hex,
                nonce       = nonce_hex,
                "share accepted"
            );
            send_msg(writer.clone(), &ok(req.id, true)).await?;
        }

        // ── Acknowledged, not implemented in v1 ───────────────────────────────
        "mining.get_transactions" | "mining.extranonce.subscribe" => {
            send_msg(writer.clone(), &ok(req.id, serde_json::Value::Null)).await?;
        }

        "mining.configure" => {
            // Version rolling is not supported: the on-chain submit_share has no
            // version_bits parameter, so we cannot reconstruct the correct header.
            // The Avalon will fall back to ntime rolling instead.
            send_msg(writer.clone(), &ok(req.id, serde_json::json!({
                "version-rolling": false
            }))).await?;
        }

        other => {
            warn!(method = other, "unknown Stratum method");
            send_msg(writer.clone(), &err(req.id, 20, "Unknown method")).await?;
        }
    }
    Ok(())
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn ok(id: u64, result: impl serde::Serialize) -> Message {
    Message::OkResponse(Response {
        id,
        error:  None,
        result: serde_json::to_value(result).unwrap_or(serde_json::Value::Null),
    })
}

fn err(id: u64, code: i32, msg: &str) -> Message {
    Message::ErrorResponse(Response {
        id,
        error:  Some(sv1_api::json_rpc::JsonRpcError {
            code,
            message: msg.to_string(),
            data:    None,
        }),
        result: serde_json::Value::Null,
    })
}

async fn send_msg(
    writer: Arc<Mutex<tokio::net::tcp::OwnedWriteHalf>>,
    msg:    &Message,
) -> Result<()> {
    let mut data = serde_json::to_vec(msg)?;
    data.push(b'\n');
    writer.lock().await.write_all(&data).await?;
    Ok(())
}
