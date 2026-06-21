//! Watch `hash_share_registry::SlotBoundToRound` events and emit refreshed
//! `HashShareMintConfig`s on a channel so the batch flusher can hot-swap
//! the minting parameters without a restart.
//!
//! The registry ID stays constant for the package's lifetime; only the
//! `treasury_cap_id` + `hashshare_type` change per round when a new slot
//! is bound.

use std::{collections::HashSet, time::Duration};

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use serde_json::Value;
use sui_client::HashShareMintConfig;
use tokio::sync::mpsc;
use tracing::{info, warn};

#[derive(Deserialize)]
struct RpcResponse<T> {
    result: Option<T>,
    error: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct EventPage {
    data: Vec<EventEnvelope>,
}

#[derive(Deserialize)]
struct EventEnvelope {
    #[serde(rename = "parsedJson")]
    parsed: serde_json::Value,
}

/// Background task: poll `SlotBoundToRound` events. For each new (cap_id,
/// label) pair, derive the HashShare coin type and push a refreshed
/// `HashShareMintConfig` onto `tx`. Runs forever.
pub async fn run(
    rpc_url: String,
    package_id: String,
    registry_id: String,
    poll_secs: u64,
    tx: mpsc::UnboundedSender<HashShareMintConfig>,
) -> Result<()> {
    let http = reqwest::Client::new();
    let event_ty = format!("{}::hash_share_registry::SlotBoundToRound", package_id);
    let mut seen: HashSet<String> = HashSet::new();

    loop {
        match poll_once(&http, &rpc_url, &event_ty).await {
            Ok(page) => {
                for ev in page.data {
                    let cap_id = match ev.parsed.get("cap_id").and_then(|v| v.as_str()) {
                        Some(s) => s.to_string(),
                        None => continue,
                    };
                    if !seen.insert(cap_id.clone()) {
                        continue;
                    }
                    let label = match ev.parsed.get("label").and_then(parse_byte_array) {
                        Some(l) => l,
                        None => {
                            warn!("SlotBoundToRound missing/malformed label; skipping");
                            continue;
                        }
                    };
                    let hs_type = match label_to_hashshare_type(&package_id, &label) {
                        Some(t) => t,
                        None => {
                            warn!("could not derive HashShare type from label {}", label);
                            continue;
                        }
                    };
                    info!(
                        "Slot bound (label={} cap={}); HS type = {}. Hot-swapping mint config.",
                        label, cap_id, hs_type
                    );
                    match HashShareMintConfig::from_strings(&registry_id, &cap_id, &hs_type) {
                        Ok(cfg) => {
                            if tx.send(cfg).is_err() {
                                return Ok(()); // flusher dropped, exit
                            }
                        }
                        Err(e) => warn!("Failed to build HashShareMintConfig: {:?}", e),
                    }
                }
            }
            Err(e) => warn!("slot-bound poll error: {:?}", e),
        }
        tokio::time::sleep(Duration::from_secs(poll_secs)).await;
    }
}

async fn poll_once(
    http: &reqwest::Client,
    rpc_url: &str,
    event_ty: &str,
) -> Result<EventPage> {
    let body = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "suix_queryEvents",
        "params": [{ "MoveEventType": event_ty }, null, 50, true],
    });
    let resp: RpcResponse<EventPage> = http
        .post(rpc_url)
        .json(&body)
        .send()
        .await?
        .json()
        .await
        .context("rpc body not valid JSON")?;
    if let Some(e) = resp.error {
        bail!("rpc error: {}", e);
    }
    resp.result.ok_or_else(|| anyhow!("rpc returned neither result nor error"))
}

/// `parsedJson` represents `vector<u8>` either as a JSON array of u8 or as
/// a base64 string depending on RPC version. Try both.
fn parse_byte_array(v: &Value) -> Option<String> {
    if let Some(arr) = v.as_array() {
        let bytes: Option<Vec<u8>> = arr.iter().map(|x| x.as_u64().map(|n| n as u8)).collect();
        return bytes.and_then(|b| String::from_utf8(b).ok());
    }
    v.as_str().map(|s| s.to_string())
}

/// Map a slot label like "HS000" or "HS_000" to its fully-qualified Move
/// type string. Both forms are produced in the wild — the upstream
/// `hs_*.move` modules ship with display labels like "HS000" but the
/// mainnet `register-mainnet-slots.sh` script set labels to "HS_000"
/// (matching the file naming convention). Accept either.
fn label_to_hashshare_type(package_id: &str, label: &str) -> Option<String> {
    if !label.starts_with("HS") {
        return None;
    }
    let rest = &label[2..];
    // Allow an optional underscore separator between "HS" and the digits.
    let num = rest.strip_prefix('_').unwrap_or(rest);
    if num.is_empty() || !num.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(format!("{}::hs_{}::HS_{}", package_id, num, num))
}
