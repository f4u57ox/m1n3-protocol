//! Stratum v1 server — accepts miner connections and drives the on-chain job registry.
//!
//! Protocol reference:
//! <https://github.com/stratum-mining/stratum/tree/65c9688ca0e9cdcf213b32a6f51e9309fb75bbab/sv1>
//!
//! This process is the **operator side** of m1n3-protocol:
//! - Manages miner TCP connections using the standard Stratum v1 wire protocol.
//! - Broadcasts mining jobs to connected miners (`mining.notify`).
//! - In parallel, posts each job template on-chain via [`SuiChainClient::post_job`].
//!
//! Share submission to the on-chain contract is handled by each miner's own
//! `miner-sidecar` process (see the `miner-sidecar/` crate).

use anyhow::Result;
use serde_json::Value;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, Mutex};
use tracing::{error, info, warn};

use crate::chain::{BridgeConfig, SuiChainClient};
use crate::worker::{
    AuthorizeParams, MinerSession, RpcNotification, RpcRequest, RpcResponse, SubmitParams,
};

// ── Job ───────────────────────────────────────────────────────────────────────

/// An active mining job — fields correspond 1-to-1 with the Stratum `mining.notify` params.
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
    pub fn to_notify_params(&self) -> Value {
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

// ── Server ────────────────────────────────────────────────────────────────────

/// Shared state cloned (via `Arc`) into every spawned connection handler.
struct ServerState {
    config:       BridgeConfig,
    chain:        SuiChainClient,
    /// Broadcast channel — new jobs are sent here and every connected worker receives them.
    job_tx:       broadcast::Sender<Arc<Job>>,
    /// Per-session counter used to generate unique extranonce1 values.
    next_session: Mutex<u32>,
}

/// The top-level Stratum v1 server.
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

    // Assign a unique extranonce1 for this session (hex-encoded session counter).
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
                let req: RpcRequest = match serde_json::from_str(trimmed) {
                    Ok(r)  => r,
                    Err(e) => {
                        error!(raw = trimmed, error = %e, "malformed JSON-RPC");
                        continue;
                    }
                };
                dispatch(&req, &mut session, &state, writer.clone()).await?;
            }
            Ok(job) = job_rx.recv() => {
                if session.authorized {
                    let note = RpcNotification::new("mining.notify", job.to_notify_params());
                    send_json(writer.clone(), &note).await?;
                }
            }
        }
    }
    Ok(())
}

// ── Stratum method dispatch ───────────────────────────────────────────────────

async fn dispatch(
    req:     &RpcRequest,
    session: &mut MinerSession,
    state:   &Arc<ServerState>,
    writer:  Arc<Mutex<tokio::net::tcp::OwnedWriteHalf>>,
) -> Result<()> {
    match req.method.as_str() {
        // ── mining.subscribe ─────────────────────────────────────────────────
        // Handshake: returns session subscriptions + extranonce1 + extranonce2 size.
        "mining.subscribe" => {
            let result = serde_json::json!([
                [
                    ["mining.set_difficulty", &session.session_id],
                    ["mining.notify",         &session.session_id],
                ],
                session.extranonce1,
                4   // extranonce2 size in bytes
            ]);
            send_json(writer.clone(), &RpcResponse::ok(req.id.clone(), result)).await?;

            // Push current difficulty immediately after subscribe.
            let set_diff = RpcNotification::new(
                "mining.set_difficulty",
                serde_json::json!([session.difficulty]),
            );
            send_json(writer.clone(), &set_diff).await?;
        }

        // ── mining.authorize ─────────────────────────────────────────────────
        // Worker identification. The sidecar will call `pool::register_worker` on-chain
        // after this succeeds, passing the extranonce1 from the subscribe response.
        "mining.authorize" => {
            let params: AuthorizeParams = serde_json::from_value(req.params.clone())
                .unwrap_or(AuthorizeParams("anonymous".into(), "x".into()));
            session.username  = Some(params.0.clone());
            session.authorized = true;
            info!(username = %params.0, extranonce1 = %session.extranonce1, "worker authorized");
            send_json(writer.clone(), &RpcResponse::ok(req.id.clone(), true)).await?;
        }

        // ── mining.submit ────────────────────────────────────────────────────
        // Traditional Stratum path: validate PoW off-chain and respond.
        // The miner's sidecar independently submits the accepted share on-chain.
        "mining.submit" => {
            if !session.authorized {
                send_json(
                    writer.clone(),
                    &RpcResponse::err(req.id.clone(), 24, "Unauthorized worker"),
                ).await?;
                return Ok(());
            }

            let params: SubmitParams = match serde_json::from_value(req.params.clone()) {
                Ok(p)  => p,
                Err(_) => {
                    send_json(
                        writer.clone(),
                        &RpcResponse::err(req.id.clone(), 20, "Other/Unknown"),
                    ).await?;
                    return Ok(());
                }
            };

            let worker = session.username.as_deref().unwrap_or("unknown");

            // TODO: perform off-chain SHA-256d validation here before responding.
            // The sidecar only submits on-chain when the pool responds with `true`,
            // so this response is the gating signal for the on-chain record.
            info!(
                worker,
                job_id    = %params.job_id,
                extranonce2 = %params.extranonce2,
                ntime     = %params.ntime,
                nonce     = %params.nonce,
                "share received"
            );

            send_json(writer.clone(), &RpcResponse::ok(req.id.clone(), true)).await?;
        }

        // ── Acknowledged but not implemented in v1 ────────────────────────────
        "mining.get_transactions" | "mining.extranonce.subscribe" => {
            send_json(writer.clone(), &RpcResponse::ok(req.id.clone(), Value::Null)).await?;
        }

        other => {
            warn!(method = other, "unknown Stratum method");
            send_json(
                writer.clone(),
                &RpcResponse::err(req.id.clone(), 20, "Unknown method"),
            ).await?;
        }
    }
    Ok(())
}

// ── Utilities ─────────────────────────────────────────────────────────────────

async fn send_json<T: serde::Serialize>(
    writer: Arc<Mutex<tokio::net::tcp::OwnedWriteHalf>>,
    value:  &T,
) -> Result<()> {
    let mut data = serde_json::to_vec(value)?;
    data.push(b'\n');
    let mut w = writer.lock().await;
    w.write_all(&data).await?;
    Ok(())
}
