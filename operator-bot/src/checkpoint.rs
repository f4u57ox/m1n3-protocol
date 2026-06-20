//! Per-round checkpoint for pipeline resume-on-restart.
//!
//! Written after each completed pipeline step. On restart, `run()` reads
//! the checkpoint and skips already-completed steps.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum PipelineStep {
    Start,
    OpenAcc,
    Accumulate,
    Finalize,
    FetchCoinbase,
    BuildRewardTx,
    WaitHashi,
    HashiBatch,
    Broadcast,
    WaitConf,
    Done,
}

impl Default for PipelineStep {
    fn default() -> Self { PipelineStep::Start }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoundCheckpoint {
    pub round_id: u64,
    pub step: PipelineStep,
    /// RoundHistory object ID captured from finalize_round tx effects.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub round_history_id: Option<String>,
    /// Block finder Sui address.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_finder: Option<String>,
    /// Block height at which this block was found.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_height: Option<u64>,
}

impl RoundCheckpoint {
    pub fn new(round_id: u64) -> Self {
        Self {
            round_id,
            step: PipelineStep::Start,
            round_history_id: None,
            block_finder: None,
            block_height: None,
        }
    }
}

fn checkpoint_path(dir: &str, round_id: u64) -> PathBuf {
    Path::new(dir).join(format!("{}.json", round_id))
}

pub fn load(dir: &str, round_id: u64) -> Result<Option<RoundCheckpoint>> {
    let path = checkpoint_path(dir, round_id);
    if !path.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| anyhow!("Cannot read checkpoint {}: {}", path.display(), e))?;
    let cp: RoundCheckpoint = serde_json::from_str(&content)
        .map_err(|e| anyhow!("Cannot parse checkpoint {}: {}", path.display(), e))?;
    Ok(Some(cp))
}

pub fn save(dir: &str, cp: &RoundCheckpoint) -> Result<()> {
    std::fs::create_dir_all(dir)
        .map_err(|e| anyhow!("Cannot create checkpoint dir '{}': {}", dir, e))?;
    let path = checkpoint_path(dir, cp.round_id);
    let content = serde_json::to_string_pretty(cp)
        .map_err(|e| anyhow!("Cannot serialize checkpoint: {}", e))?;
    std::fs::write(&path, content)
        .map_err(|e| anyhow!("Cannot write checkpoint {}: {}", path.display(), e))?;
    Ok(())
}

pub fn remove(dir: &str, round_id: u64) {
    let path = checkpoint_path(dir, round_id);
    let _ = std::fs::remove_file(path);
}
