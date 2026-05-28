/// Stratum v1 message types — mirrors sv1/src/json_rpc.rs from stratum-mining/stratum.
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ── Inbound (miner → server) ─────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct RpcRequest {
    pub id:     Option<Value>,
    pub method: String,
    pub params: Value,
}

/// mining.subscribe params — [agent_string, session_id?]
#[derive(Debug, Deserialize)]
pub struct SubscribeParams(pub String, #[serde(default)] pub Option<String>);

/// mining.authorize params — [username, password]
#[derive(Debug, Deserialize)]
pub struct AuthorizeParams(pub String, pub String);

/// mining.submit params — [username, job_id, extranonce2, ntime, nonce]
#[derive(Debug, Deserialize)]
pub struct SubmitParams {
    pub username:    String,
    pub job_id:      String,
    pub extranonce2: String,
    pub ntime:       String,
    pub nonce:       String,
}

// ── Outbound (server → miner) ─────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct RpcResponse {
    pub id:     Option<Value>,
    pub result: Value,
    pub error:  Option<Value>,
}

impl RpcResponse {
    pub fn ok(id: Option<Value>, result: impl Serialize) -> Self {
        Self { id, result: serde_json::to_value(result).unwrap(), error: None }
    }

    pub fn err(id: Option<Value>, code: i32, msg: &str) -> Self {
        Self {
            id,
            result: Value::Null,
            error: Some(serde_json::json!([code, msg, Value::Null])),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct RpcNotification {
    pub id:     Option<Value>,
    pub method: String,
    pub params: Value,
}

impl RpcNotification {
    pub fn new(method: &str, params: impl Serialize) -> Self {
        Self {
            id: None,
            method: method.to_string(),
            params: serde_json::to_value(params).unwrap(),
        }
    }
}

/// State tracked per connected miner session.
#[derive(Debug)]
pub struct MinerSession {
    pub session_id:  String,
    pub extranonce1: String,
    pub username:    Option<String>,
    pub authorized:  bool,
    pub difficulty:  u64,
}

impl MinerSession {
    pub fn new(session_id: String, extranonce1: String, difficulty: u64) -> Self {
        Self { session_id, extranonce1, username: None, authorized: false, difficulty }
    }
}
