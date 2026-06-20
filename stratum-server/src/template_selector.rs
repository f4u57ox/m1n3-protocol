//! Template selection logic for decentralized pool mode
//!
//! Miners can select which template to mine based on:
//! - ByCreator: Mine templates from a specific creator address
//! - ByStake: Mine the template with the highest M1N3 stake
//! - ByShares: Mine the template with the most shares submitted
//! - Combined: Mine the template with highest (stake * shares) score
//! - Default: Use the server's local template (current behavior)

use crate::sui_queries::{SuiTemplateQuerier, TemplateData, TemplateObjectData};
use anyhow::Result;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use tracing::info;

/// Template selection mode
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TemplateSelectionMode {
    /// Mine templates from a specific creator address
    ByCreator(String),
    /// Mine the template with the highest M1N3 stake
    ByStake,
    /// Mine the template with the most shares submitted
    ByShares,
    /// Mine the template with the highest combined score (stake * shares)
    Combined,
    /// Use server's local template (default behavior)
    Default,
}

impl TemplateSelectionMode {
    /// Parse selection mode from worker name suffix
    /// Format: <sui_address>.<worker>.<mode>
    /// Examples:
    ///   - 0xabc...def.rig1.stake -> ByStake
    ///   - 0xabc...def.rig1.shares -> ByShares
    ///   - 0xabc...def.rig1.combined -> Combined
    ///   - 0xabc...def.rig1.c:0x456... -> ByCreator(0x456...)
    ///   - 0xabc...def.rig1 -> Default
    pub fn parse_from_worker_name(worker_name: &str) -> Self {
        let parts: Vec<&str> = worker_name.split('.').collect();

        // Need at least 3 parts for a mode: address.worker.mode
        if parts.len() >= 3 {
            let mode_part = parts[parts.len() - 1].to_lowercase();

            match mode_part.as_str() {
                "stake" => return Self::ByStake,
                "shares" => return Self::ByShares,
                "combined" => return Self::Combined,
                _ => {
                    // Check for creator mode: c:<address> or creator:<address>
                    if let Some(creator_addr) = mode_part.strip_prefix("c:") {
                        if creator_addr.starts_with("0x") && creator_addr.len() == 66 {
                            return Self::ByCreator(creator_addr.to_string());
                        }
                    } else if let Some(creator_addr) = mode_part.strip_prefix("creator:") {
                        if creator_addr.starts_with("0x") && creator_addr.len() == 66 {
                            return Self::ByCreator(creator_addr.to_string());
                        }
                    }
                }
            }
        }

        Self::Default
    }

    /// Get a human-readable description of the mode
    pub fn description(&self) -> String {
        match self {
            Self::ByCreator(addr) => format!("creator:{}", &addr[..10]),
            Self::ByStake => "highest-stake".to_string(),
            Self::ByShares => "most-shares".to_string(),
            Self::Combined => "combined-score".to_string(),
            Self::Default => "local-template".to_string(),
        }
    }
}

/// Cached template information with rankings
#[derive(Debug, Clone)]
pub struct TemplateCache {
    /// All templates by ID
    pub templates: HashMap<String, CachedTemplate>,
    /// Templates grouped by creator
    pub by_creator: HashMap<String, Vec<String>>,
    /// Templates ranked by stake (highest first)
    pub stake_ranking: Vec<(String, u64)>,
    /// Templates ranked by share count (highest first)
    pub shares_ranking: Vec<(String, u64)>,
    /// Templates ranked by combined score (highest first)
    pub combined_ranking: Vec<(String, u128)>,
    /// When this cache was last refreshed
    pub last_refresh: Instant,
}

impl Default for TemplateCache {
    fn default() -> Self {
        Self {
            templates: HashMap::new(),
            by_creator: HashMap::new(),
            stake_ranking: Vec::new(),
            shares_ranking: Vec::new(),
            combined_ranking: Vec::new(),
            last_refresh: Instant::now(),
        }
    }
}

/// Cached template data
#[derive(Debug, Clone)]
pub struct CachedTemplate {
    pub template_id: String,
    pub creator: String,
    pub height: u64,
    pub share_count: u64,
    pub total_stake: u64,
    pub is_active: bool,
    /// Full template data (lazily loaded when needed)
    pub template_object: Option<TemplateObjectData>,
}

impl From<TemplateData> for CachedTemplate {
    fn from(data: TemplateData) -> Self {
        Self {
            template_id: data.template_id,
            creator: data.creator,
            height: data.height,
            share_count: data.share_count,
            total_stake: data.total_stake,
            is_active: data.is_active,
            template_object: None,
        }
    }
}

/// Template selector for decentralized pool mode
pub struct TemplateSelector {
    querier: SuiTemplateQuerier,
    cache: Arc<RwLock<TemplateCache>>,
    cache_ttl: Duration,
}

impl TemplateSelector {
    /// Create a new template selector
    pub fn new(
        sui_rpc_url: String,
        package_id: String,
        staking_registry_id: String,
        cache_ttl: Duration,
    ) -> Self {
        Self {
            querier: SuiTemplateQuerier::new(
                sui_rpc_url,
                package_id,
                staking_registry_id,
            ),
            cache: Arc::new(RwLock::new(TemplateCache::default())),
            cache_ttl,
        }
    }

    /// Refresh the template cache from Sui
    pub async fn refresh_cache(&self) -> Result<()> {
        info!("Refreshing template cache from Sui...");

        // Fetch registry state
        let registry_state = self.querier.fetch_registry_state().await?;

        let mut cache = self.cache.write().await;

        // Clear old data
        cache.templates.clear();
        cache.by_creator.clear();
        cache.stake_ranking.clear();
        cache.shares_ranking.clear();
        cache.combined_ranking.clear();

        // Populate templates
        for (template_id, template_data) in registry_state.templates {
            let cached = CachedTemplate::from(template_data.clone());

            // Add to creator index
            cache
                .by_creator
                .entry(cached.creator.clone())
                .or_default()
                .push(template_id.clone());

            // Add to rankings if active
            if cached.is_active {
                cache
                    .stake_ranking
                    .push((template_id.clone(), cached.total_stake));
                cache
                    .shares_ranking
                    .push((template_id.clone(), cached.share_count));
                let combined_score =
                    (cached.total_stake as u128) * (cached.share_count as u128);
                cache
                    .combined_ranking
                    .push((template_id.clone(), combined_score));
            }

            cache.templates.insert(template_id, cached);
        }

        // Sort rankings (highest first)
        cache.stake_ranking.sort_by(|a, b| b.1.cmp(&a.1));
        cache.shares_ranking.sort_by(|a, b| b.1.cmp(&a.1));
        cache.combined_ranking.sort_by(|a, b| b.1.cmp(&a.1));

        cache.last_refresh = Instant::now();

        info!(
            "Template cache refreshed: {} templates, {} creators",
            cache.templates.len(),
            cache.by_creator.len()
        );

        Ok(())
    }

    /// Check if cache needs refresh
    pub async fn needs_refresh(&self) -> bool {
        let cache = self.cache.read().await;
        cache.last_refresh.elapsed() > self.cache_ttl
    }

    /// Select the best template ID for a given selection mode
    pub async fn select_template(&self, mode: &TemplateSelectionMode) -> Option<String> {
        match mode {
            TemplateSelectionMode::ByCreator(creator) => {
                let cache = self.cache.read().await;
                // Find first active template for this creator from cache
                if let Some(templates) = cache.by_creator.get(creator) {
                    for template_id in templates.iter().rev() {
                        if let Some(template) = cache.templates.get(template_id) {
                            if template.is_active {
                                return Some(template_id.clone());
                            }
                        }
                    }
                }
                // Fallback: use highest stake template
                cache.stake_ranking.first().map(|(id, _)| id.clone())
            }
            TemplateSelectionMode::ByStake => {
                let cache = self.cache.read().await;
                cache.stake_ranking.first().map(|(id, _)| id.clone())
            }
            TemplateSelectionMode::ByShares => {
                let cache = self.cache.read().await;
                cache.shares_ranking.first().map(|(id, _)| id.clone())
            }
            TemplateSelectionMode::Combined => {
                let cache = self.cache.read().await;
                cache.combined_ranking.first().map(|(id, _)| id.clone())
            }
            TemplateSelectionMode::Default => None,
        }
    }

    /// Get full template data for creating a mining job
    pub async fn get_template_data(&self, template_id: &str) -> Result<TemplateObjectData> {
        // Check cache first
        {
            let cache = self.cache.read().await;
            if let Some(template) = cache.templates.get(template_id) {
                if let Some(ref object_data) = template.template_object {
                    return Ok(object_data.clone());
                }
            }
        }

        // Fetch from chain
        let template_data = self.querier.fetch_template(template_id).await?;

        // Update cache with full data
        {
            let mut cache = self.cache.write().await;
            if let Some(template) = cache.templates.get_mut(template_id) {
                template.template_object = Some(template_data.clone());
            }
        }

        Ok(template_data)
    }

    /// Get cached template info without fetching full object
    pub async fn get_cached_template(&self, template_id: &str) -> Option<CachedTemplate> {
        let cache = self.cache.read().await;
        cache.templates.get(template_id).cloned()
    }

    /// Get the current leader template IDs for each mode
    pub async fn get_leaders(&self) -> TemplateLeaders {
        let cache = self.cache.read().await;
        TemplateLeaders {
            by_stake: cache.stake_ranking.first().map(|(id, s)| (id.clone(), *s)),
            by_shares: cache.shares_ranking.first().map(|(id, s)| (id.clone(), *s)),
            combined: cache.combined_ranking.first().map(|(id, s)| (id.clone(), *s)),
        }
    }

    /// Get all active templates
    pub async fn get_active_templates(&self) -> Vec<CachedTemplate> {
        let cache = self.cache.read().await;
        cache
            .templates
            .values()
            .filter(|t| t.is_active)
            .cloned()
            .collect()
    }

    /// Get templates for a specific creator
    pub async fn get_templates_for_creator(&self, creator: &str) -> Vec<CachedTemplate> {
        let cache = self.cache.read().await;
        cache
            .by_creator
            .get(creator)
            .map(|ids| {
                ids.iter()
                    .filter_map(|id| cache.templates.get(id).cloned())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Get cache statistics
    pub async fn get_stats(&self) -> CacheStats {
        let cache = self.cache.read().await;
        CacheStats {
            total_templates: cache.templates.len(),
            active_templates: cache.templates.values().filter(|t| t.is_active).count(),
            unique_creators: cache.by_creator.len(),
            cache_age_secs: cache.last_refresh.elapsed().as_secs(),
        }
    }
}

/// Current template leaders
#[derive(Debug, Clone)]
pub struct TemplateLeaders {
    pub by_stake: Option<(String, u64)>,
    pub by_shares: Option<(String, u64)>,
    pub combined: Option<(String, u128)>,
}

/// Cache statistics
#[derive(Debug, Clone)]
pub struct CacheStats {
    pub total_templates: usize,
    pub active_templates: usize,
    pub unique_creators: usize,
    pub cache_age_secs: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_selection_mode() {
        // Basic modes
        assert_eq!(
            TemplateSelectionMode::parse_from_worker_name("0x123.rig1.stake"),
            TemplateSelectionMode::ByStake
        );
        assert_eq!(
            TemplateSelectionMode::parse_from_worker_name("0x123.rig1.shares"),
            TemplateSelectionMode::ByShares
        );
        assert_eq!(
            TemplateSelectionMode::parse_from_worker_name("0x123.rig1.combined"),
            TemplateSelectionMode::Combined
        );

        // Case insensitive
        assert_eq!(
            TemplateSelectionMode::parse_from_worker_name("0x123.rig1.STAKE"),
            TemplateSelectionMode::ByStake
        );

        // Creator mode
        let creator_addr = "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
        assert_eq!(
            TemplateSelectionMode::parse_from_worker_name(&format!("0x123.rig1.c:{}", creator_addr)),
            TemplateSelectionMode::ByCreator(creator_addr.to_string())
        );

        // Default (no mode specified)
        assert_eq!(
            TemplateSelectionMode::parse_from_worker_name("0x123.rig1"),
            TemplateSelectionMode::Default
        );

        // Invalid mode falls back to default
        assert_eq!(
            TemplateSelectionMode::parse_from_worker_name("0x123.rig1.invalid"),
            TemplateSelectionMode::Default
        );
    }
}
