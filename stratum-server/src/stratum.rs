//! Stratum protocol types

use serde::{Deserialize, Serialize};

/// Stratum JSON-RPC request
#[derive(Debug, Deserialize)]
pub struct StratumRequest {
    pub id: serde_json::Value,
    pub method: String,
    #[serde(default)]
    pub params: Vec<serde_json::Value>,
}

/// Stratum JSON-RPC response (no jsonrpc field — Stratum v1 standard)
#[derive(Debug, Serialize)]
pub struct StratumResponse {
    pub id: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<serde_json::Value>,
}

/// Stratum notification (server-initiated, no jsonrpc field — Stratum v1 standard)
#[derive(Debug, Serialize)]
pub struct StratumNotification {
    pub id: serde_json::Value,
    pub method: String,
    pub params: Vec<serde_json::Value>,
}
