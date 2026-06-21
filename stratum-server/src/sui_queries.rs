//! Sui RPC queries for template data.
//!
//! Discovers active Template objects by querying TemplateRegistered events,
//! then fetches each template's full content via the object API.

use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::str::FromStr;
use sui_sdk::{
    rpc_types::{EventFilter, SuiObjectDataOptions},
    types::base_types::ObjectID,
    SuiClient, SuiClientBuilder,
};
use tracing::warn;

/// Template data for ranking/selection.
#[derive(Debug, Clone)]
pub struct TemplateData {
    pub template_id: String,
    pub creator: String,
    pub height: u64,
    pub share_count: u64,
    pub total_stake: u64,
    pub is_active: bool,
    pub created_at_ms: u64,
}

/// Full registry state (all known templates).
#[derive(Debug, Clone, Default)]
pub struct RegistryState {
    pub templates: HashMap<String, TemplateData>,
    pub active_count: u64,
}

/// Full template object data (used to create a MiningJob).
#[derive(Debug, Clone)]
pub struct TemplateObjectData {
    pub template_id: String,
    pub height: u64,
    pub prev_block_hash: Vec<u8>,
    pub coinbase1: Vec<u8>,
    pub coinbase2: Vec<u8>,
    pub merkle_branches: Vec<Vec<u8>>,
    pub version: u32,
    pub nbits: u32,
    pub ntime: u32,
    pub is_active: bool,
    pub owner: String,
    pub share_count: u64,
}

pub struct SuiTemplateQuerier {
    client: SuiClient,
    package_id: String,
}

impl SuiTemplateQuerier {
    pub fn new(
        rpc_url: String,
        package_id: String,
        _staking_registry_id: String,
    ) -> Self {
        let client = tokio::runtime::Handle::current().block_on(async {
            SuiClientBuilder::default()
                .build(&rpc_url)
                .await
                .expect("Cannot connect to Sui RPC for template querier")
        });
        Self { client, package_id }
    }

    /// Async constructor that does not call `Handle::current().block_on`.
    /// Use from contexts already inside the tokio runtime (e.g.
    /// `override_job_updater`). The blocking `new` panics there with
    /// "Cannot start a runtime from within a runtime".
    pub async fn new_async(rpc_url: String, package_id: String) -> Result<Self> {
        let client = SuiClientBuilder::default()
            .build(&rpc_url)
            .await
            .map_err(|e| anyhow!("Cannot connect to Sui RPC: {}", e))?;
        Ok(Self { client, package_id })
    }

    /// Fetch a specific Template object by its Sui object ID.
    pub async fn fetch_template(&self, template_id: &str) -> Result<TemplateObjectData> {
        let obj_id = ObjectID::from_str(template_id)
            .map_err(|_| anyhow!("Invalid template object ID: {}", template_id))?;

        let resp = self.client.read_api()
            .get_object_with_options(obj_id, SuiObjectDataOptions::new().with_content())
            .await
            .map_err(|e| anyhow!("get_object {}: {}", template_id, e))?;

        let data = resp.data.ok_or_else(|| anyhow!("Template {} not found", template_id))?;
        let content = data.content.ok_or_else(|| anyhow!("Template {} has no content", template_id))?;

        let json = serde_json::to_value(content)
            .map_err(|e| anyhow!("Cannot serialize template content: {}", e))?;
        let fields = &json["fields"];

        parse_template_object(template_id, fields)
    }

    /// Enumerate active templates by querying TemplateRegistered events.
    pub async fn fetch_registry_state(&self) -> Result<RegistryState> {
        let event_type = format!("{}::pool::TemplateRegistered", self.package_id);
        let filter = EventFilter::MoveEventType(
            event_type.parse().map_err(|e| anyhow!("Invalid event type: {}", e))?
        );

        let mut cursor = None;
        let mut template_ids: Vec<String> = Vec::new();

        loop {
            let page = self.client.event_api()
                .query_events(filter.clone(), cursor, Some(50), false)
                .await
                .map_err(|e| anyhow!("query_events: {}", e))?;

            for event in &page.data {
                if let Some(id) = event.parsed_json["template_id"].as_str() {
                    template_ids.push(id.to_string());
                }
            }

            if page.has_next_page {
                cursor = page.next_cursor;
            } else {
                break;
            }
        }

        let mut registry = RegistryState::default();

        for template_id in template_ids {
            match self.fetch_template(&template_id).await {
                Ok(tpl) => {
                    if tpl.is_active {
                        registry.active_count += 1;
                    }
                    registry.templates.insert(template_id.clone(), TemplateData {
                        template_id: template_id.clone(),
                        creator: tpl.owner.clone(),
                        height: tpl.height,
                        share_count: tpl.share_count,
                        total_stake: 0,
                        is_active: tpl.is_active,
                        created_at_ms: 0,
                    });
                }
                Err(e) => warn!("Failed to fetch template {}: {}", template_id, e),
            }
        }

        Ok(registry)
    }

}

fn parse_template_object(template_id: &str, fields: &serde_json::Value) -> Result<TemplateObjectData> {
    let height = parse_u64(fields, "height");
    let version = parse_u32(fields, "version");
    let nbits = parse_u32(fields, "nbits");
    let ntime = parse_u32(fields, "ntime");
    let is_active = fields["is_active"].as_bool().unwrap_or(false);
    let owner = fields["owner"].as_str().unwrap_or("").to_string();
    let share_count = parse_u64(fields, "total_shares");

    let prev_block_hash = parse_bytes(fields, "prev_block_hash");
    let coinbase1 = parse_bytes(fields, "coinbase1");
    let coinbase2 = parse_bytes(fields, "coinbase2");

    // merkle_branches: array of arrays
    let merkle_branches = fields["merkle_branches"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|branch| {
                    branch.as_array()
                        .map(|bytes| bytes.iter().filter_map(|b| b.as_u64()).map(|b| b as u8).collect())
                        .unwrap_or_default()
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(TemplateObjectData {
        template_id: template_id.to_string(),
        height,
        prev_block_hash,
        coinbase1,
        coinbase2,
        merkle_branches,
        version,
        nbits,
        ntime,
        is_active,
        owner,
        share_count,
    })
}

fn parse_u64(fields: &serde_json::Value, key: &str) -> u64 {
    let v = &fields[key];
    v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())).unwrap_or(0)
}

fn parse_u32(fields: &serde_json::Value, key: &str) -> u32 {
    let v = &fields[key];
    v.as_u64().map(|n| n as u32)
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(0)
}

fn parse_bytes(fields: &serde_json::Value, key: &str) -> Vec<u8> {
    fields[key]
        .as_array()
        .map(|arr| arr.iter().filter_map(|b| b.as_u64()).map(|b| b as u8).collect())
        .unwrap_or_default()
}
