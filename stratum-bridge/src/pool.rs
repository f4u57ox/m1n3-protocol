/// Stratum v1 server — accepts miner connections and routes messages to the Sui chain.
/// Protocol reference: https://github.com/stratum-mining/stratum/tree/65c9688ca0e9cdcf213b32a6f51e9309fb75bbab/sv1
use anyhow::Result;
use serde_json::Value;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, Mutex};
use tracing::{error, info, warn};

use crate::chain::{BridgeConfig, SuiChainClient};
use crate::worker::{
    AuthorizeParams, MinerSession, RpcNotification, RpcRequest, RpcResponse, SubscribeParams,
    SubmitParams,
};

/// An active mining job broadcast to all connected miners.
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
    /// Serialize as Stratum mining.notify params array.
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

/// Shared server state — a new `Arc<ServerState>` is cloned per connection.
struct ServerState {
    config:   BridgeConfig,
    chain:    SuiChainClient,
    /// Job broadcast channel — every connected worker receives new jobs.
    job_tx:   broadcast::Sender<Arc<Job>>,
    /// Monotonically increasing extranonce1 counter (per session).
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
            info!(peer = %peer, "new miner connected");
            let state = self.state.clone();
            tokio::spawn(async move {
                if let Err(e) = handle_connection(socket, state).await {
                    warn!(peer = %peer, error = %e, "connection closed with error");
                }
            });
        }
    }
}

async fn handle_connection(stream: TcpStream, state: Arc<ServerState>) -> Result<()> {
    let (read_half, write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    let writer = Arc::new(Mutex::new(write_half));

    // Assign unique extranonce1 for this session.
    let session_id = {
        let mut n = state.next_session.lock().await;
        let id = *n;
        *n += 1;
        format!("{:08x}", id)
    };
    let extranonce1 = session_id.clone();
    let mut session =
        MinerSession::new(session_id, extranonce1, state.config.initial_difficulty);

    let mut job_rx = state.job_tx.subscribe();
    let mut line = String::new();

    loop {
        line.clear();
        tokio::select! {
            n = reader.read_line(&mut line) => {
                if n? == 0 { break; } // EOF
                let trimmed = line.trim();
                if trimmed.is_empty() { continue; }
                let req: RpcRequest = match serde_json::from_str(trimmed) {
                    Ok(r) => r,
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

async fn dispatch(
    req:     &RpcRequest,
    session: &mut MinerSession,
    state:   &Arc<ServerState>,
    writer:  Arc<Mutex<tokio::net::tcp::OwnedWriteHalf>>,
) -> Result<()> {
    match req.method.as_str() {
        "mining.subscribe" => {
            // Respond with [[["mining.set_difficulty","<id>"],["mining.notify","<id>"]],extranonce1,extranonce2_size]
            let result = serde_json::json!([
                [
                    ["mining.set_difficulty", &session.session_id],
                    ["mining.notify", &session.session_id],
                ],
                session.extranonce1,
                4  // extranonce2 size in bytes
            ]);
            send_json(writer.clone(), &RpcResponse::ok(req.id.clone(), result)).await?;

            // Immediately push difficulty.
            let set_diff = RpcNotification::new(
                "mining.set_difficulty",
                serde_json::json!([session.difficulty]),
            );
            send_json(writer.clone(), &set_diff).await?;
        }

        "mining.authorize" => {
            let params: AuthorizeParams =
                serde_json::from_value(req.params.clone()).unwrap_or(AuthorizeParams(
                    "anonymous".into(),
                    "x".into(),
                ));
            session.username = Some(params.0.clone());
            session.authorized = true;
            info!(username = %params.0, "worker authorized");
            send_json(writer.clone(), &RpcResponse::ok(req.id.clone(), true)).await?;
        }

        "mining.submit" => {
            if !session.authorized {
                send_json(
                    writer.clone(),
                    &RpcResponse::err(req.id.clone(), 24, "Unauthorized worker"),
                )
                .await?;
                return Ok(());
            }

            let params: SubmitParams = match serde_json::from_value(req.params.clone()) {
                Ok(p) => p,
                Err(_) => {
                    send_json(
                        writer.clone(),
                        &RpcResponse::err(req.id.clone(), 20, "Other/Unknown"),
                    )
                    .await?;
                    return Ok(());
                }
            };

            let job_id: u64 = u64::from_str_radix(&params.job_id, 16).unwrap_or(0);
            let nonce: u32 =
                u32::from_str_radix(params.nonce.trim_start_matches("0x"), 16).unwrap_or(0);

            let worker_addr = session.username.as_deref().unwrap_or("unknown");
            match state.chain.submit_share(worker_addr, job_id, nonce).await {
                Ok(digest) => {
                    info!(worker = worker_addr, job_id, nonce, digest = %digest, "share accepted");
                    send_json(writer.clone(), &RpcResponse::ok(req.id.clone(), true)).await?;
                }
                Err(e) => {
                    warn!(error = %e, "share rejected");
                    send_json(
                        writer.clone(),
                        &RpcResponse::err(req.id.clone(), 23, "Low difficulty share"),
                    )
                    .await?;
                }
            }
        }

        "mining.get_transactions" | "mining.extranonce.subscribe" => {
            // Acknowledged but not implemented in v1 scaffold.
            send_json(writer.clone(), &RpcResponse::ok(req.id.clone(), Value::Null)).await?;
        }

        other => {
            warn!(method = other, "unknown method");
            send_json(
                writer.clone(),
                &RpcResponse::err(req.id.clone(), 20, "Unknown method"),
            )
            .await?;
        }
    }
    Ok(())
}

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
