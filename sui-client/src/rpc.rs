//! Sui full node JSON-RPC client.
//!
//! Only the methods needed by m1n3-protocol are implemented:
//!   - `suix_getCoins`         — fetch gas coins for signing
//!   - `suix_getReferenceGasPrice` — current gas price
//!   - `sui_getObject`         — fetch object + owner (for shared-object version)
//!   - `sui_executeTransactionBlock` — submit a signed PTB

use anyhow::{Context, Result};
use reqwest::Client;
use serde_json::{json, Value};
use tracing::debug;

use crate::bcs_types::{CoinData, CoinPage, ObjectData, ObjectResponse, RpcResponse};

pub struct SuiRpcClient {
    url:    String,
    client: Client,
}

impl SuiRpcClient {
    pub fn new(url: &str) -> Self {
        Self { url: url.to_string(), client: Client::new() }
    }

    async fn call<T: serde::de::DeserializeOwned>(
        &self,
        method:  &str,
        params:  Value,
    ) -> Result<T> {
        let body = json!({
            "jsonrpc": "2.0",
            "id":      1,
            "method":  method,
            "params":  params,
        });

        debug!(method, "Sui RPC call");

        let resp: RpcResponse<T> = self.client
            .post(&self.url)
            .json(&body)
            .send()
            .await
            .with_context(|| format!("RPC request to {} failed", self.url))?
            .json()
            .await
            .with_context(|| format!("failed to parse {} response", method))?;

        if let Some(e) = resp.error {
            anyhow::bail!("{} RPC error: {}", method, e);
        }

        resp.result.with_context(|| format!("{} returned null result", method))
    }

    /// Fetch the first SUI coin owned by `address` (used as gas payment).
    pub async fn get_first_coin(&self, address: &str) -> Result<CoinData> {
        let page: CoinPage = self.call(
            "suix_getCoins",
            json!([address, "0x2::sui::SUI", null, 1]),
        ).await?;

        page.data.into_iter().next()
            .context("address has no SUI coins — run `sui client faucet`")
    }

    /// Current reference gas price in MIST.
    pub async fn get_reference_gas_price(&self) -> Result<u64> {
        let s: String = self.call("suix_getReferenceGasPrice", json!([])).await?;
        s.parse::<u64>().context("invalid gas price from RPC")
    }

    /// Fetch a Sui object (with owner field).
    pub async fn get_object(&self, object_id: &str) -> Result<ObjectData> {
        let resp: ObjectResponse = self.call(
            "sui_getObject",
            json!([object_id, {"showOwner": true}]),
        ).await?;

        if let Some(e) = resp.error {
            anyhow::bail!("sui_getObject error: {}", e);
        }
        resp.data.context("object not found")
    }

    /// Extract `initial_shared_version` from an object's owner field.
    pub fn parse_shared_version(owner: &serde_json::Value) -> Result<u64> {
        owner
            .get("Shared")
            .and_then(|s| s.get("initial_shared_version"))
            .and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
            .context("object is not a shared object or initial_shared_version missing")
    }

    /// Parse a coin's `(objectId, version, digest)` as an `ObjectRef` (`[u8;32], u64, [u8;32]`).
    pub fn coin_to_object_ref(coin: &CoinData) -> Result<crate::bcs_types::ObjectRef> {
        let id      = parse_object_id(&coin.coin_object_id)?;
        let version = coin.version.parse::<u64>()
            .context("invalid coin version")?;
        let digest  = crate::bcs_types::ObjectDigest(parse_digest(&coin.digest)?);
        Ok((id, version, digest))
    }

    /// Submit a signed programmable transaction block.
    ///
    /// `tx_b64`  — base64 BCS-encoded `TransactionData`
    /// `sig_b64` — base64 `[flag || sig(64) || pubkey(32)]`
    ///
    /// Returns the transaction digest string.
    pub async fn execute_transaction(
        &self,
        tx_b64:  &str,
        sig_b64: &str,
    ) -> Result<String> {
        #[derive(serde::Deserialize)]
        struct ExecResult {
            digest:  Option<String>,
            effects: Option<Value>,
        }

        let result: ExecResult = self.call(
            "sui_executeTransactionBlock",
            json!([
                tx_b64,
                [sig_b64],
                {"showEffects": true},
                "WaitForLocalExecution"
            ]),
        ).await?;

        // Check for Move abort in effects
        if let Some(effects) = &result.effects {
            if let Some(status) = effects.get("status") {
                if let Some(err) = status.get("error") {
                    anyhow::bail!("transaction failed (Move abort): {}", err);
                }
            }
        }

        result.digest.context("no digest in execute response")
    }
}

// ── Decode helpers ────────────────────────────────────────────────────────────

/// Parse a `0x…` hex object ID to `[u8; 32]`.
pub fn parse_object_id(s: &str) -> Result<[u8; 32]> {
    let bytes = hex::decode(s.trim_start_matches("0x"))
        .with_context(|| format!("invalid object ID hex: {}", s))?;
    // Sui addresses can be shorter than 32 bytes if leading zeros were stripped
    if bytes.len() > 32 {
        anyhow::bail!("object ID too long: {} bytes", bytes.len());
    }
    let mut id = [0u8; 32];
    id[32 - bytes.len()..].copy_from_slice(&bytes);
    Ok(id)
}

/// Parse a base58-encoded object digest to `[u8; 32]`.
pub fn parse_digest(s: &str) -> Result<[u8; 32]> {
    let bytes = bs58::decode(s)
        .into_vec()
        .with_context(|| format!("invalid base58 digest: {}", s))?;
    bytes.try_into()
        .map_err(|v: Vec<u8>| anyhow::anyhow!("digest must be 32 bytes, got {}", v.len()))
}
