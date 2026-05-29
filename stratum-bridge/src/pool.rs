//! Stratum v1 server — accepts miner connections and drives the on-chain job registry.
//!
//! Protocol reference:
//! <https://github.com/stratum-mining/stratum/tree/65c9688ca0e9cdcf213b32a6f51e9309fb75bbab/sv1>
//!
//! JSON-RPC message parsing uses [`sv1_api`] — the reference implementation from the
//! stratum-mining project — ensuring compatibility with real ASIC hardware whose
//! Stratum dialects often deviate from the spec in subtle ways.
//!
//! This process is the **operator side** of m1n3-protocol:
//! - Manages miner TCP connections using the Stratum v1 wire protocol.
//! - Broadcasts mining jobs to connected miners via `mining.notify`.
//! - Posts each job template on-chain via [`SuiChainClient::post_job`] in parallel.
//!
//! Share submission to the on-chain contract is handled by each miner's own
//! `miner-sidecar` process (see the `miner-sidecar/` crate).

use anyhow::Result;
use sv1_api::json_rpc::{Message, Notification, Response, StandardRequest};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, Mutex};
use tracing::{error, info, warn};

use crate::chain::{BridgeConfig, SuiChainClient};

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
    session_id:   String,
    extranonce1:  String,
    username:     Option<String>,
    authorized:   bool,
    difficulty:   u64,
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
    chain:        SuiChainClient,
    /// Broadcast channel — new jobs fan out to every connected worker.
    job_tx:       broadcast::Sender<Arc<Job>>,
    /// Monotonically increasing counter — source of unique extranonce1 values.
    next_session: Mutex<u32>,
}

pub struct StratumServer {
    state: Arc<ServerState>,
}

impl StratumServer {
    pub fn new(config: BridgeConfig) -> Self {
        let chain = SuiChainClient::new(config.clone());
        let (job_tx, _) = broadcast::channel(32);
        Self {
            state: Arc::new(ServerState {
                config,
                chain,
                job_tx,
                next_session: Mutex::new(0),
            }),
        }
    }

    pub async fn run(self) -> Result<()> {
        let addr = format!("{}:{}", self.state.config.host, self.state.config.port);
        let listener = TcpListener::bind(&addr).await?;
        info!("Stratum v1 server listening on {}", addr);

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
    let mut line = String::new();

    loop {
        line.clear();
        tokio::select! {
            n = reader.read_line(&mut line) => {
                if n? == 0 { break; }
                let trimmed = line.trim();
                if trimmed.is_empty() { continue; }

                // Use sv1_api's Message parser — handles real-world ASIC quirks.
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

            // Push current difficulty immediately.
            let set_diff = Notification {
                method: "mining.set_difficulty".to_string(),
                params: serde_json::json!([session.difficulty]),
            };
            send_msg(writer.clone(), &Message::Notification(set_diff)).await?;
        }

        // ── mining.authorize ─────────────────────────────────────────────────
        // The sidecar registers the worker on-chain after this succeeds,
        // passing the extranonce1 from the subscribe response.
        "mining.authorize" => {
            let username = req.params
                .get(0)
                .and_then(|v| v.as_str())
                .unwrap_or("anonymous")
                .to_string();

            session.username  = Some(username.clone());
            session.authorized = true;
            info!(username = %username, extranonce1 = %session.extranonce1, "worker authorized");
            send_msg(writer.clone(), &ok(req.id, true)).await?;
        }

        // ── mining.submit ────────────────────────────────────────────────────
        // Traditional path: accept the share off-chain and respond.
        // The miner's sidecar watches for this `true` response and independently
        // submits the share on-chain, signed with the miner's own Sui key.
        "mining.submit" => {
            if !session.authorized {
                send_msg(writer.clone(), &err(req.id, 24, "Unauthorized worker")).await?;
                return Ok(());
            }

            let job_id   = req.params.get(1).and_then(|v| v.as_str()).unwrap_or("0");
            let en2      = req.params.get(2).and_then(|v| v.as_str()).unwrap_or("");
            let ntime    = req.params.get(3).and_then(|v| v.as_str()).unwrap_or("0");
            let nonce    = req.params.get(4).and_then(|v| v.as_str()).unwrap_or("0");
            let worker   = session.username.as_deref().unwrap_or("unknown");

            // TODO: run SHA-256d off-chain here before responding.
            info!(worker, job_id, extranonce2 = en2, ntime, nonce, "share received");
            send_msg(writer.clone(), &ok(req.id, true)).await?;
        }

        // ── Acknowledged, not implemented in v1 ───────────────────────────────
        "mining.get_transactions" | "mining.extranonce.subscribe" => {
            send_msg(writer.clone(), &ok(req.id, serde_json::Value::Null)).await?;
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
