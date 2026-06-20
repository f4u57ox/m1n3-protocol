//! Reads on-chain pool state from Sui and enumerates MinerWorkRecord objects for a round.

use anyhow::{anyhow, Result};
use serde::Deserialize;
use std::collections::HashMap;
use tracing::info;

use crate::config::BotConfig;

/// Information about a single miner's contribution to a closed round.
#[derive(Debug, Clone)]
pub struct MinerRoundEntry {
    pub miner: String,       // Sui address (0x…)
    pub work: u128,
    pub shares: u64,
    pub net_work: u128,
}

#[derive(Debug, Deserialize)]
struct SuiRpcResponse<T> {
    result: Option<T>,
    error: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct SuiObjectResponse {
    data: Option<SuiObjectData>,
}

#[derive(Debug, Deserialize)]
struct SuiObjectData {
    content: Option<SuiMoveObject>,
}

#[derive(Debug, Deserialize)]
struct SuiMoveObject {
    fields: Option<serde_json::Value>,
}

pub struct PoolMonitor {
    rpc_url: String,
    pool_object_id: String,
    package_id: String,
    client: reqwest::Client,
}

impl PoolMonitor {
    pub fn new(cfg: &BotConfig) -> Result<Self> {
        Ok(Self {
            rpc_url: cfg.sui_rpc_url.clone(),
            pool_object_id: cfg.pool_object_id.clone(),
            package_id: cfg.package_id.clone(),
            client: reqwest::Client::new(),
        })
    }

    async fn rpc_call<T: for<'de> Deserialize<'de>>(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<T> {
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        });

        let resp: SuiRpcResponse<T> = self
            .client
            .post(&self.rpc_url)
            .json(&body)
            .send()
            .await?
            .json()
            .await?;

        if let Some(err) = resp.error {
            return Err(anyhow!("Sui RPC error: {}", err));
        }

        resp.result.ok_or_else(|| anyhow!("Empty RPC result for {}", method))
    }

    /// Read the current round_id from the Pool shared object.
    pub async fn current_round(&self) -> Result<u64> {
        let result: SuiObjectResponse = self
            .rpc_call(
                "sui_getObject",
                serde_json::json!([
                    self.pool_object_id,
                    { "showContent": true }
                ]),
            )
            .await?;

        let fields = result
            .data
            .and_then(|d| d.content)
            .and_then(|c| c.fields)
            .ok_or_else(|| anyhow!("Cannot read Pool object fields"))?;

        let round_id = fields
            .get("current_round")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<u64>().ok())
            .or_else(|| fields.get("current_round").and_then(|v| v.as_u64()))
            .ok_or_else(|| anyhow!("Cannot parse current_round from Pool"))?;

        Ok(round_id)
    }

    /// Enumerate all MinerWorkRecord objects for a closed round using suix_queryObjects.
    ///
    /// MinerWorkRecord objects are owned by miners (transferred on accumulate_miner_stats).
    /// We query by type filter for the closed round's records.
    pub async fn enumerate_round_miners(&self, round_id: u64) -> Result<Vec<MinerRoundEntry>> {
        let type_filter = format!("{}::pool::MinerWorkRecord", self.package_id);

        let mut entries = Vec::new();
        let mut cursor: Option<String> = None;

        loop {
            let params = match &cursor {
                None => serde_json::json!([
                    { "StructType": type_filter },
                    null,
                    50,
                    null
                ]),
                Some(c) => serde_json::json!([
                    { "StructType": type_filter },
                    null,
                    50,
                    c
                ]),
            };

            #[derive(Deserialize)]
            struct QueryResult {
                data: Vec<SuiObjectSummary>,
                #[serde(rename = "nextCursor")]
                next_cursor: Option<String>,
                #[serde(rename = "hasNextPage")]
                has_next_page: bool,
            }

            #[derive(Deserialize)]
            struct SuiObjectSummary {
                #[allow(dead_code)]
                digest: String,
                #[serde(rename = "objectId")]
                object_id: String,
            }

            let page: QueryResult = self.rpc_call("suix_queryObjects", params).await?;

            // Fetch full content for each object
            for summary in &page.data {
                let obj: SuiObjectResponse = self
                    .rpc_call(
                        "sui_getObject",
                        serde_json::json!([
                            summary.object_id,
                            { "showContent": true, "showOwner": true }
                        ]),
                    )
                    .await?;

                let fields = match obj.data.and_then(|d| d.content).and_then(|c| c.fields) {
                    Some(f) => f,
                    None => continue,
                };

                // Filter by round_id
                let obj_round = fields
                    .get("round_id")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<u64>().ok())
                    .or_else(|| fields.get("round_id").and_then(|v| v.as_u64()))
                    .unwrap_or(u64::MAX);

                if obj_round != round_id {
                    continue;
                }

                let miner = fields
                    .get("miner")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                let work = parse_u128(&fields, "work");
                let shares = fields
                    .get("shares")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<u64>().ok())
                    .or_else(|| fields.get("shares").and_then(|v| v.as_u64()))
                    .unwrap_or(0);
                let net_work = parse_u128(&fields, "net_work");

                entries.push(MinerRoundEntry { miner, work, shares, net_work });
            }

            if !page.has_next_page {
                break;
            }
            cursor = page.next_cursor;
        }

        info!("Round {}: found {} miner entries", round_id, entries.len());
        Ok(entries)
    }
}

fn parse_u128(fields: &serde_json::Value, key: &str) -> u128 {
    fields
        .get(key)
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<u128>().ok())
        .or_else(|| fields.get(key).and_then(|v| v.as_u64()).map(|n| n as u128))
        .unwrap_or(0)
}

/// Build a map from miner address to total net_work across all entries.
/// Used when multiple MinerWorkRecord objects exist per miner.
pub fn aggregate_by_miner(entries: Vec<MinerRoundEntry>) -> Vec<MinerRoundEntry> {
    let mut map: HashMap<String, MinerRoundEntry> = HashMap::new();
    for e in entries {
        map.entry(e.miner.clone())
            .and_modify(|acc| {
                acc.work += e.work;
                acc.shares += e.shares;
                acc.net_work += e.net_work;
            })
            .or_insert(e);
    }
    map.into_values().collect()
}
