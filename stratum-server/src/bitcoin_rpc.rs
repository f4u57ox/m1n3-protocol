//! Bitcoin Core RPC client

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Bitcoin RPC client
pub struct BitcoinRpc {
    url: String,
    client: reqwest::Client,
    auth: Option<(String, String)>,
}

/// Blockchain info response
#[derive(Debug, Deserialize)]
pub struct BlockchainInfo {
    pub chain: String,
    pub blocks: u64,
    pub headers: u64,
    pub bestblockhash: String,
    pub difficulty: f64,
}

/// Block template response
#[derive(Debug, Deserialize)]
pub struct BlockTemplate {
    pub version: i64,
    pub previousblockhash: String,
    pub transactions: Vec<TemplateTransaction>,
    pub coinbasevalue: u64,
    pub target: String,
    pub mintime: u64,
    pub curtime: u64,
    pub bits: String,
    pub height: u64,
    /// SegWit witness commitment (hex scriptPubKey for the commitment output)
    #[serde(default)]
    pub default_witness_commitment: Option<String>,
}

/// Transaction in block template
#[derive(Debug, Deserialize)]
pub struct TemplateTransaction {
    pub data: String,
    pub txid: String,
    pub hash: String,
    pub fee: u64,
}

/// JSON-RPC request
#[derive(Serialize)]
struct RpcRequest {
    jsonrpc: &'static str,
    id: &'static str,
    method: &'static str,
    params: serde_json::Value,
}

/// JSON-RPC response
#[derive(Deserialize)]
struct RpcResponse<T> {
    result: Option<T>,
    error: Option<RpcError>,
}

#[derive(Deserialize, Debug)]
struct RpcError {
    code: i32,
    message: String,
}

impl BitcoinRpc {
    /// Create new Bitcoin RPC client
    ///
    /// URL format: http://user:pass@host:port
    pub fn new(url: &str) -> Result<Self> {
        // Parse auth from URL if present
        let (clean_url, auth) = if url.contains('@') {
            let parts: Vec<&str> = url.splitn(2, "://").collect();
            if parts.len() == 2 {
                let rest: Vec<&str> = parts[1].splitn(2, '@').collect();
                if rest.len() == 2 {
                    let auth_parts: Vec<&str> = rest[0].splitn(2, ':').collect();
                    if auth_parts.len() == 2 {
                        let clean = format!("{}://{}", parts[0], rest[1]);
                        let auth = Some((auth_parts[0].to_string(), auth_parts[1].to_string()));
                        (clean, auth)
                    } else {
                        (url.to_string(), None)
                    }
                } else {
                    (url.to_string(), None)
                }
            } else {
                (url.to_string(), None)
            }
        } else {
            (url.to_string(), None)
        };

        Ok(Self {
            url: clean_url,
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()?,
            auth,
        })
    }

    /// Make RPC call
    async fn call<T: for<'de> Deserialize<'de>>(
        &self,
        method: &'static str,
        params: serde_json::Value,
    ) -> Result<T> {
        let request = RpcRequest {
            jsonrpc: "1.0",
            id: "stratum",
            method,
            params,
        };

        let mut req = self.client.post(&self.url);

        if let Some((user, pass)) = &self.auth {
            req = req.basic_auth(user, Some(pass));
        }

        let response = req
            .json(&request)
            .send()
            .await
            .context("Failed to send RPC request")?;

        let rpc_response: RpcResponse<T> = response
            .json()
            .await
            .context("Failed to parse RPC response")?;

        if let Some(error) = rpc_response.error {
            anyhow::bail!("RPC error {}: {}", error.code, error.message);
        }

        rpc_response.result.context("Empty RPC result")
    }

    /// Get blockchain info
    pub async fn get_blockchain_info(&self) -> Result<BlockchainInfo> {
        self.call("getblockchaininfo", serde_json::json!([])).await
    }

    /// Get block template for mining
    pub async fn get_block_template(&self) -> Result<BlockTemplate> {
        self.call(
            "getblocktemplate",
            serde_json::json!([{"rules": ["segwit"]}]),
        )
        .await
    }

    /// Submit a block to the network
    pub async fn submit_block(&self, block_hex: &str) -> Result<()> {
        let result: serde_json::Value = self
            .call("submitblock", serde_json::json!([block_hex]))
            .await?;

        if result.is_null() {
            Ok(())
        } else {
            anyhow::bail!("submitblock failed: {:?}", result)
        }
    }
}
