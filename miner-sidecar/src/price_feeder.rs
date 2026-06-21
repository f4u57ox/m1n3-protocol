//! Off-chain dynamic auto-sell floor.
//!
//! Periodically computes the fair-value µUSDC-per-HashShare-unit price
//! from (a) live BTC price via a public price API, (b) the current
//! Bitcoin network difficulty pulled from our own Pool's latest
//! `TemplateRegistered` event + the on-chain `Template.nbits` field, and
//! the post-2024-halving block subsidy constant.
//!
//! The result lands in a shared `AtomicU64` that `MinerClient`'s
//! auto-sell logic reads on every batch flush — no restart needed when
//! BTC moves or difficulty retargets.
//!
//! Formula (canonical PPS fair value, identical to the dapp's
//! `useHashprice.ts`):
//!
//!   sats_per_HashShare    = block_reward_sats / network_difficulty
//!   µUSDC_per_HashShare   = sats_per_HashShare × btc_usd / 1e8 × 1e6
//!                         = (block_reward_sats / network_difficulty)
//!                           × btc_usd × 1e-2
//!
//! For mainnet at 124T difficulty and $64k BTC, this rounds to 1 µUSDC
//! per HS (the smallest representable). The market's `price_per_unit`
//! is a u64 so we floor at 1 µUSDC.
//!
//! Phase B: replace the CoinGecko poll with an on-chain Pyth
//! `PriceInfoObject` read so the auto-sell PTB itself proves which
//! price was used.

use std::{sync::{atomic::{AtomicU64, Ordering}, Arc}, time::Duration};

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use tokio::time::interval;
use tracing::{info, warn};

/// Post-2024-halving subsidy. Will need a code change at the next
/// halving (~2028). Could be moved to a `PoolConfig` field on chain.
const BLOCK_REWARD_SATS: f64 = 312_500_000.0; // 3.125 BTC

/// HashShare bundle factor — MUST match `hash_share::BUNDLE_FACTOR` in
/// the on-chain Move package. 1 `Coin<HS_NNN>` represents this many
/// difficulty-1 units of work; the per-Coin fair-value PPS price is
/// therefore `(per_work_unit_value × BUNDLE_FACTOR)`. Pulling this from
/// chain via a Move call would be slightly more authoritative; for now
/// we keep it as a constant and assert it matches at sidecar startup
/// (TODO when `hash_share::bundle_factor()` view is published).
const BUNDLE_FACTOR: f64 = 10_000.0;

/// Sane floor: the market's u64 `price_per_unit` can't represent
/// fractional µUSDC, so 1 is the smallest sane price for a single Coin.
const MIN_FLOOR_UNITS: u64 = 1;

/// Config wired from the sidecar CLI.
pub struct DynamicPriceConfig {
    /// Sui RPC URL — same as the rest of the sidecar.
    pub sui_rpc: String,
    /// m1n3 package id; used to scope the `TemplateRegistered` event filter.
    pub package_id: String,
    /// CoinGecko (or compatible) URL returning `{ "bitcoin": { "usd": N } }`.
    pub price_api_url: String,
    /// Refresh cadence in seconds. The price API gets called this often;
    /// chain RPC also.
    pub refresh_secs: u64,
    /// Operator markup/markdown in basis points. 10_000 = 1.0× (no
    /// adjustment). Lets an operator price above PPS (to capture
    /// variance premium) or below (to dump shares aggressively).
    pub multiplier_bps: u64,
}

#[derive(Deserialize)]
struct CgPrice {
    bitcoin: CgBitcoin,
}
#[derive(Deserialize)]
struct CgBitcoin {
    usd: f64,
}

/// Background task: every `refresh_secs`, fetch BTC price + the latest
/// Template's nbits, derive µUSDC/HS, write into `floor`. Runs forever
/// (or until the sidecar exits).
pub async fn run(cfg: DynamicPriceConfig, floor: Arc<AtomicU64>) -> Result<()> {
    let http = reqwest::Client::builder()
        .user_agent("m1n3-sidecar/price-feeder")
        .build()?;
    let mut ticker = interval(Duration::from_secs(cfg.refresh_secs.max(15)));
    loop {
        ticker.tick().await;
        match refresh_once(&http, &cfg).await {
            Ok(price) => {
                let with_markup = ((price as u128) * cfg.multiplier_bps as u128 / 10_000) as u64;
                let final_floor = with_markup.max(MIN_FLOOR_UNITS);
                floor.store(final_floor, Ordering::Relaxed);
                info!(
                    "price-feeder: floor set to {} µUSDC/HS (raw fair-value {}, markup {}bps)",
                    final_floor, price, cfg.multiplier_bps
                );
            }
            Err(e) => {
                warn!("price-feeder: refresh failed, keeping last value — {:?}", e);
            }
        }
    }
}

async fn refresh_once(http: &reqwest::Client, cfg: &DynamicPriceConfig) -> Result<u64> {
    let btc_usd = fetch_btc_usd(http, &cfg.price_api_url).await?;
    let nbits = fetch_latest_template_nbits(http, &cfg.sui_rpc, &cfg.package_id).await?;
    let difficulty = difficulty_from_nbits(nbits);
    Ok(fair_value_micro_usdc_per_hs(btc_usd, difficulty))
}

async fn fetch_btc_usd(http: &reqwest::Client, url: &str) -> Result<f64> {
    let res = http.get(url).send().await.context("BTC price GET")?;
    let body: CgPrice = res.json().await.context("BTC price JSON")?;
    Ok(body.bitcoin.usd)
}

#[derive(Deserialize)]
struct RpcWrap<T> {
    result: Option<T>,
}
#[derive(Deserialize)]
struct EventPage {
    data: Vec<serde_json::Value>,
}

async fn fetch_latest_template_nbits(
    http: &reqwest::Client,
    rpc: &str,
    pkg: &str,
) -> Result<u32> {
    // 1. Query `TemplateRegistered` events on the package, descending.
    let event_ty = format!("{}::pool::TemplateRegistered", pkg);
    let body = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "suix_queryEvents",
        "params": [{ "MoveEventType": event_ty }, null, 1, true]
    });
    let page: RpcWrap<EventPage> = http
        .post(rpc).json(&body).send().await?.json().await?;
    let evt = page.result.and_then(|p| p.data.into_iter().next())
        .ok_or_else(|| anyhow!("no TemplateRegistered events for this package yet"))?;
    let template_id = evt["parsedJson"]["template_id"].as_str()
        .ok_or_else(|| anyhow!("event missing template_id"))?
        .to_string();

    // 2. Fetch the Template object and read its `nbits` field.
    let body = serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "method": "sui_getObject",
        "params": [template_id, { "showContent": true }]
    });
    let obj: RpcWrap<serde_json::Value> = http
        .post(rpc).json(&body).send().await?.json().await?;
    // Sui RPC returns u32 fields as JSON numbers, but other versions /
    // gateways have been seen returning them as strings. Accept either.
    let nbits_field = obj.result
        .as_ref()
        .map(|r| &r["data"]["content"]["fields"]["nbits"])
        .ok_or_else(|| anyhow!("Template object missing"))?;
    if let Some(n) = nbits_field.as_u64() {
        return Ok(n as u32);
    }
    if let Some(s) = nbits_field.as_str() {
        return s.parse::<u32>().map_err(|e| anyhow!("nbits parse: {e}"));
    }
    Err(anyhow!("Template.nbits field not readable (value: {:?})", nbits_field))
}

/// Convert Bitcoin compact nBits → difficulty (max_target / current_target).
/// Same formula as the dapp's `useHashprice.ts`, but computed in log space
/// to avoid u256 math while staying f64-stable across the realistic range
/// (10^9 — 10^14 difficulty).
fn difficulty_from_nbits(nbits: u32) -> f64 {
    let exponent = ((nbits >> 24) & 0xff) as i32;
    let mantissa = (nbits & 0x007f_ffff) as f64;
    if mantissa == 0.0 { return 0.0; }
    // target = mantissa × 2^(8*(exponent - 3))
    // max_target = 0xFFFF × 2^(8*(0x1d - 3))
    //            = 65535 × 2^208
    // difficulty = max_target / target
    //            = (65535 / mantissa) × 2^(8 * (0x1d - exponent))
    let exp_diff = (0x1d - exponent) * 8;
    (65535.0_f64 / mantissa) * 2.0_f64.powi(exp_diff)
}

/// µUSDC per `Coin<HS_NNN>` unit, floored to u64. The market's
/// `price_per_unit` field cannot represent fractional µUSDC. On
/// mainnet at $64k BTC + 124T difficulty + bundle factor 10_000 this
/// rounds to ~16 µUSDC per Coin, giving the orderbook tick (1 µUSDC)
/// economic meaning (~6% of fair value).
fn fair_value_micro_usdc_per_hs(btc_usd: f64, difficulty: f64) -> u64 {
    if difficulty <= 0.0 { return 0; }
    // Per work-unit fair value, then scaled up by the bundle factor
    // so the result is per-`Coin<HS_NNN>` (which represents
    // BUNDLE_FACTOR difficulty-1 units of work).
    let sats_per_work_unit = BLOCK_REWARD_SATS / difficulty;
    let micro_usdc_per_work_unit = sats_per_work_unit * btc_usd / 100.0; // /1e8 × 1e6
    let micro_usdc_per_coin = micro_usdc_per_work_unit * BUNDLE_FACTOR;
    if micro_usdc_per_coin <= 0.0 { return 0; }
    micro_usdc_per_coin.ceil().clamp(MIN_FLOOR_UNITS as f64, u64::MAX as f64) as u64
}
