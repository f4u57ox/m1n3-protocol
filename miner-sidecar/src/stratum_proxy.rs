//! Stratum v1 proxy: intercepts mining.submit results and submits accepted
//! shares directly to Sui using the miner's own keypair.

use std::{collections::HashMap, time::Duration};

use anyhow::Result;
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    time::interval,
};
use tracing::{info, warn};

use crate::{
    sui_sender::{PendingShare, SuiSender},
    Args,
};
use sui_client::HashShareMintConfig;

pub async fn run(args: Args) -> Result<()> {
    let mut sender = SuiSender::new(
        &args.sui_package,
        &args.pool_object,
        &args.dedup_registry,
        &args.sui_rpc,
        &args.sui_keystore,
        args.gas_budget,
    ).await?;

    if let Some(mrr) = args.miner_round_registry.as_deref() {
        sender = sender.with_miner_round_registry(mrr)?;
        info!("MinerRoundRegistry wired: {}", mrr);
    }

    if let Some(path) = args.state_file.as_deref() {
        sender = sender.with_state_file(std::path::PathBuf::from(path));
        if let Err(e) = sender.load_state() {
            tracing::warn!("load_state failed: {}", e);
        }
        info!("State file wired: {}", path);
    }

    if !args.quote_coin_type.is_empty() {
        sender = sender.with_quote_type(&args.quote_coin_type)?;
        info!("Quote coin type set: {}", args.quote_coin_type);
    }

    // Optional dynamic auto-sell floor (off-chain feeder). Lives behind
    // an AtomicU64 so the price-feeder task can update it while
    // batch_flusher reads it on every PTB build.
    if args.auto_price_feeder {
        let floor = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        sender = sender.with_dynamic_floor(floor.clone());
        let cfg = crate::price_feeder::DynamicPriceConfig {
            sui_rpc: args.sui_rpc.clone(),
            package_id: args.sui_package.clone(),
            price_api_url: args.auto_price_api_url.clone(),
            refresh_secs: args.auto_price_refresh_secs,
            multiplier_bps: args.auto_price_multiplier_bps,
        };
        info!(
            "Dynamic price feeder enabled — refresh {}s, markup {}bps, api={}",
            cfg.refresh_secs.max(15), cfg.multiplier_bps, cfg.price_api_url
        );
        tokio::spawn(async move {
            if let Err(e) = crate::price_feeder::run(cfg, floor).await {
                warn!("price feeder exited: {:?}", e);
            }
        });
    }

    // Initial HashShare config (optional). The slot watcher below may
    // overwrite it as soon as the next `SlotBoundToRound` lands.
    if let (Some(reg), Some(cap), Some(ty)) = (
        args.hashshare_registry.as_deref(),
        args.hashshare_treasury_cap.as_deref(),
        args.hashshare_type.as_deref(),
    ) {
        let cfg = HashShareMintConfig::from_strings(reg, cap, ty)?;
        info!(
            "HashShare mint enabled (initial config) — registry={} cap={} type={}",
            cfg.registry_id, cfg.treasury_cap_id, ty
        );
        sender = sender.with_hashshare_mint(cfg);
    }

    // Optional auto-sell (fixed floor). Activates when --auto-sell-price-mist > 0.
    if args.auto_sell_price_mist > 0 {
        let asc = sui_client::AutoSellConfig {
            price_per_unit_mist: args.auto_sell_price_mist,
            expires_at_ms: args.auto_sell_expires_ms,
        };
        info!(
            "Auto-sell enabled — floor={} MIST/unit, expires_ms={}",
            asc.price_per_unit_mist, asc.expires_at_ms,
        );
        sender = sender.with_auto_sell(asc);
    }

    // Optional peg-to-mid sell pricing. Overrides --auto-sell-price-mist when set.
    if !args.auto_sell_peg.is_empty() {
        let anchor: sui_client::PegAnchor = args.auto_sell_peg.parse()?;
        let peg = sui_client::AutoSellPegConfig {
            anchor,
            offset_bps: args.auto_sell_offset_bps,
            fallback_floor_mist: args.auto_sell_fallback_mist,
            expires_at_ms: args.auto_sell_expires_ms,
        };
        info!(
            "Auto-sell peg enabled — anchor={:?}, offset_bps={}, fallback_mist={}",
            peg.anchor, peg.offset_bps, peg.fallback_floor_mist
        );
        sender = sender.with_auto_sell_peg(peg);
    }

    // Optional MarketFeePool — required by auto-fill mode.
    sender = sender.with_market_fee_pool(&args.market_fee_pool)?;

    // Optional buyer-template lane: drain a HashpowerBuyOrder per share.
    // When set, the proxy's flush() routes through submit_share_for_pay
    // instead of submit_share (HashShare mint + auto-sell short-circuited).
    if !args.hashpower_buy_order_id.is_empty() {
        info!(
            "Buyer-template lane enabled — order={} quote={}",
            args.hashpower_buy_order_id,
            if args.quote_coin_type.is_empty() {
                "0x2::sui::SUI"
            } else {
                args.quote_coin_type.as_str()
            }
        );
        sender = sender.with_hashpower_buy_order(&args.hashpower_buy_order_id)?;
    }

    // Optional auto-fill-best-bid. Activates when --auto-fill-bid-floor-mist > 0.
    if args.auto_fill_bid_floor_mist > 0 {
        let cfg = sui_client::AutoFillBidConfig {
            floor_price_mist: args.auto_fill_bid_floor_mist,
        };
        info!(
            "Auto-fill-bid enabled — floor={} MIST/unit (fee_pool required)",
            cfg.floor_price_mist
        );
        sender = sender.with_auto_fill_bid(cfg);
    }

    let (cfg_tx, cfg_rx) = mpsc::unbounded_channel::<HashShareMintConfig>();

    if let Some(reg) = args.hashshare_registry.clone() {
        let rpc = args.sui_rpc.clone();
        let pkg = args.sui_package.clone();
        let poll = args.slot_poll_seconds;
        info!(
            "Slot-bound watcher starting — registry={} poll_secs={}",
            reg, poll
        );
        tokio::spawn(async move {
            if let Err(e) = crate::slot_watcher::run(rpc, pkg, reg, poll, cfg_tx).await {
                warn!("Slot watcher exited: {:?}", e);
            }
        });
    } else {
        info!("HashShare mint disabled (no --hashshare-registry).");
    }

    let (share_tx, share_rx) = mpsc::unbounded_channel::<(String, PendingShare)>();

    tokio::spawn(batch_flusher(
        sender,
        share_rx,
        cfg_rx,
        args.batch_size,
        args.batch_timeout_ms,
    ));

    let listener = TcpListener::bind(format!("0.0.0.0:{}", args.listen_port)).await?;
    info!("Listening on 0.0.0.0:{}", args.listen_port);

    loop {
        let (stream, addr) = listener.accept().await?;
        info!("Miner connected: {}", addr);
        let tx = share_tx.clone();
        let host = args.stratum_host.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream, host, tx).await {
                warn!("Connection closed: {}", e);
            }
        });
    }
}

// ── Batch flusher ─────────────────────────────────────────────────────────────

async fn batch_flusher(
    mut sender: SuiSender,
    mut rx: mpsc::UnboundedReceiver<(String, PendingShare)>,
    mut cfg_rx: mpsc::UnboundedReceiver<HashShareMintConfig>,
    batch_size: usize,
    batch_timeout_ms: u64,
) {
    let mut batch: Vec<(String, PendingShare)> = Vec::new();
    let mut ticker = interval(Duration::from_millis(batch_timeout_ms));
    ticker.tick().await; // consume the immediate first tick

    // Periodic ShareDedup cleanup tick. One dedup per fire to bound
    // latency in the share hot-path; the crank loops until eligible
    // round count drops to zero across subsequent ticks. 5-minute
    // cadence is a good middle ground: rounds finalise on block-find
    // intervals which average ~10 minutes on mainnet, so we usually
    // catch each round's dedup within one or two ticks of it closing
    // without spamming PTBs.
    let mut cleanup_ticker = interval(Duration::from_secs(300));
    cleanup_ticker.tick().await;

    loop {
        tokio::select! {
            cfg = cfg_rx.recv() => {
                match cfg {
                    Some(cfg) => {
                        info!(
                            "Applied refreshed HashShare config — cap={}",
                            cfg.treasury_cap_id
                        );
                        sender.set_hashshare_mint(cfg);
                    }
                    None => {} // watcher dropped — keep running with last cfg
                }
            }
            item = rx.recv() => {
                match item {
                    None => { flush(&mut sender, &mut batch).await; break; }
                    Some(item) => {
                        batch.push(item);
                        if batch.len() >= batch_size {
                            flush(&mut sender, &mut batch).await;
                        }
                    }
                }
            }
            _ = ticker.tick() => flush(&mut sender, &mut batch).await,
            _ = cleanup_ticker.tick() => {
                match sender.crank_share_dedup_cleanup().await {
                    Ok(Some((round, dedup_id))) => {
                        info!(
                            "Cleaned up ShareDedup for round {} ({}) — storage rebate reclaimed",
                            round, dedup_id
                        );
                    }
                    Ok(None) => {} // nothing eligible, fine
                    Err(e) => warn!("ShareDedup cleanup tick errored: {}", e),
                }
            }
        }
    }
}

/// Heuristic: does an `anyhow::Error` from the Sui SDK look like a transient
/// RPC issue (timeout, connection reset, fullnode unreachable) rather than
/// a Move-execution abort? Used to decide whether to requeue the share or
/// drop it.
///
/// The buyer-pay and operator paths both wrap their errors with explicit
/// "aborted on chain" prefixes when the tx executed and aborted on a Move
/// check — that string disambiguates a permanent failure from the
/// underlying SDK's connection-level errors.
fn is_transient_rpc_error(e: &anyhow::Error) -> bool {
    let s = e.to_string().to_lowercase();
    if s.contains("aborted on chain") {
        // Move abort — permanent. Retrying wouldn't help.
        return false;
    }
    s.contains("timeout")
        || s.contains("connection reset")
        || s.contains("connection refused")
        || s.contains("transport error")
        || s.contains("decode error")
}

async fn flush(sender: &mut SuiSender, batch: &mut Vec<(String, PendingShare)>) {
    if batch.is_empty() {
        return;
    }
    let items: Vec<(String, PendingShare)> = batch.drain(..).collect();
    let n = items.len();

    // Buyer-template lane: when the sidecar is wired to a
    // `HashpowerBuyOrder`, every share goes through
    // `submit_share_for_pay<QuoteT>` and Coin<QuoteT> lands directly in
    // the miner's wallet. HashShare mint + auto-sell + auto-fill all
    // sit out — they don't apply to direct-pay shares.
    if sender.hashpower_buy_config().is_some() {
        match sender.submit_batch_for_buyer_pay(&items).await {
            Ok(digest) => info!(
                "Buyer-bound batch of {} share(s) confirmed (Coin<QuoteT> → miner): {}",
                n, digest
            ),
            Err(e) => {
                if is_transient_rpc_error(&e) {
                    warn!(
                        "Buyer-bound batch transient RPC error, requeuing {} share(s): {}",
                        n, e
                    );
                    batch.extend(items);
                } else {
                    warn!(
                        "Buyer-bound batch submission failed (dropping {} share(s)): {}",
                        n, e
                    );
                }
            }
        }
        return;
    }

    match sender.submit_batch(&items).await {
        Ok(digest) => {
            info!("Batch of {} share(s) confirmed: {}", n, digest);
            // Post-batch market action. Priority:
            //   1. auto-fill-best-bid (Mode 3 — take an aggressive bid if one exists)
            //   2. on no-fill, fall through to:
            //       a. auto_sell_pegged (peg-to-mid)
            //       b. auto_sell_minted (fixed-floor)
            // Each step is a no-op when its config isn't set.
            let mut filled = false;
            match sender.auto_fill_best_bid().await {
                Ok(Some(label)) => {
                    info!("Auto-fill matched: {}", label);
                    filled = true;
                }
                Ok(None) => {}
                Err(e) => warn!("Auto-fill failed: {}", e),
            }
            if !filled {
                if sender.auto_sell_peg_config().is_some() {
                    match sender.auto_sell_pegged().await {
                        Ok(Some(label)) => info!("Auto-sell (pegged): {}", label),
                        Ok(None) => {}
                        Err(e) => warn!("Auto-sell pegged failed: {}", e),
                    }
                } else {
                    match sender.auto_sell_minted().await {
                        Ok(Some(label)) => info!("Auto-sell placed: {}", label),
                        Ok(None) => {}
                        Err(e) => warn!("Auto-sell failed: {}", e),
                    }
                }
            }
        }
        Err(e) => {
            if is_transient_rpc_error(&e) {
                // Transient RPC flakiness (Sui mainnet fullnode can take
                // longer than the SDK's HTTP timeout under load). Don't
                // drop the share — put the batch back so the next flush
                // ticker retries it.
                warn!(
                    "Batch transient RPC error, requeuing {} share(s) for retry: {}",
                    n, e
                );
                batch.extend(items);
            } else {
                // Move-execution failure or other permanent error — the
                // tx genuinely won't settle. Dropping is correct;
                // retrying would just abort again.
                warn!(
                    "Batch submission failed (dropping {} share(s)): {}",
                    n, e
                );
            }
        }
    }
}

// ── Per-connection proxy ───────────────────────────────────────────────────────

async fn handle_connection(
    downstream: TcpStream,
    stratum_host: String,
    share_tx: mpsc::UnboundedSender<(String, PendingShare)>,
) -> Result<()> {
    let upstream = TcpStream::connect(&stratum_host).await?;
    info!("Connected upstream: {}", stratum_host);

    let (ds_rd, mut ds_wr) = downstream.into_split();
    let (us_rd, mut us_wr) = upstream.into_split();

    let mut ds_lines = BufReader::new(ds_rd).lines();
    let mut us_lines = BufReader::new(us_rd).lines();

    // Per-job state: job_id → (template_id, template_version).
    // The miner mines against whatever job_id was current at the time it
    // started hashing; we must use THAT job's metadata when submitting to Sui,
    // not the latest notify (which may have rolled while the miner was still
    // working on the older job).
    let mut jobs: HashMap<String, (String, u32)> = HashMap::new();
    // Extranonce1 assigned by upstream in the mining.subscribe response.
    // Must be passed back to Sui so on-chain coinbase reconstruction matches
    // the share hash the miner actually solved.
    let mut extranonce1: Vec<u8> = Vec::new();
    // Subscribe request id pending an upstream response.
    let mut subscribe_id: Option<u64> = None;
    // pending submit requests: id → (job_id, captured share data)
    let mut pending: HashMap<u64, (String, PendingShare)> = HashMap::new();

    loop {
        tokio::select! {
            // ── Downstream → upstream ─────────────────────────────────────
            line = ds_lines.next_line() => {
                let line = match line? {
                    Some(l) => l,
                    None => break,
                };
                if let Ok(msg) = serde_json::from_str::<Value>(&line) {
                    track_subscribe_request(&msg, &mut subscribe_id);
                    intercept_submit_request(&msg, &mut pending, &jobs, &extranonce1);
                }
                us_wr.write_all(line.as_bytes()).await?;
                us_wr.write_all(b"\n").await?;
            }

            // ── Upstream → downstream ─────────────────────────────────────
            line = us_lines.next_line() => {
                let line = match line? {
                    Some(l) => l,
                    None => break,
                };
                if let Ok(msg) = serde_json::from_str::<Value>(&line) {
                    intercept_upstream(
                        &msg,
                        &mut jobs,
                        &mut subscribe_id,
                        &mut extranonce1,
                        &mut pending,
                        &share_tx,
                    );
                }
                ds_wr.write_all(line.as_bytes()).await?;
                ds_wr.write_all(b"\n").await?;
            }
        }
    }

    Ok(())
}

/// Capture share data from `mining.submit` before forwarding upstream.
/// `jobs` maps job_id → (template_id, template_version); we use the share's
/// own job_id (params[1]) to pick the right template, since the miner may
/// have submitted a share for an older job than the latest notify.
fn intercept_submit_request(
    msg: &Value,
    pending: &mut HashMap<u64, (String, PendingShare)>,
    jobs: &HashMap<String, (String, u32)>,
    extranonce1: &[u8],
) {
    if msg.get("method").and_then(Value::as_str) != Some("mining.submit") {
        return;
    }
    let id = match msg.get("id").and_then(Value::as_u64) {
        Some(id) => id,
        None => return,
    };
    let params = match msg.get("params").and_then(Value::as_array) {
        Some(p) => p,
        None => return,
    };
    // params[1] is the job_id the miner solved against.
    let job_id = match params.get(1).and_then(Value::as_str) {
        Some(j) => j.to_string(),
        None => return,
    };
    let template_version = jobs.get(&job_id).map(|(_, v)| *v).unwrap_or(0);

    if let Some(mut share) = parse_submit_params(params) {
        // BIP320: actual block version =
        //   (template.version & !MASK) | (miner_bits & MASK)
        // Plain OR would conflate the template's own bits inside the mask with
        // the miner's, producing a different hash than the miner actually used.
        const VERSION_ROLLING_MASK: u32 = 0x1fffe000;
        share.version = (template_version & !VERSION_ROLLING_MASK)
            | (share.version & VERSION_ROLLING_MASK);
        share.extranonce1 = extranonce1.to_vec();
        pending.insert(id, (job_id, share));
    }
}

/// Watch for an outgoing mining.subscribe request so we know which upstream
/// response will carry the extranonce1 assignment.
fn track_subscribe_request(msg: &Value, subscribe_id: &mut Option<u64>) {
    if msg.get("method").and_then(Value::as_str) == Some("mining.subscribe") {
        if let Some(id) = msg.get("id").and_then(Value::as_u64) {
            *subscribe_id = Some(id);
        }
    }
}

/// Handle upstream messages: capture per-job template metadata from notify, queue shares on accept.
fn intercept_upstream(
    msg: &Value,
    jobs: &mut HashMap<String, (String, u32)>,
    subscribe_id: &mut Option<u64>,
    extranonce1: &mut Vec<u8>,
    pending: &mut HashMap<u64, (String, PendingShare)>,
    share_tx: &mpsc::UnboundedSender<(String, PendingShare)>,
) {
    let method = msg.get("method").and_then(Value::as_str);

    if method == Some("mining.set_extranonce") {
        // Some pools (including m1n3's stratum-server) replace extranonce1
        // post-authorize — typically derived from the miner's blockchain
        // address. We must track the latest value so on-chain coinbase
        // reconstruction matches what the miner is currently hashing with.
        if let Some(params) = msg.get("params").and_then(Value::as_array) {
            if let Some(en1_hex) = params.get(0).and_then(Value::as_str) {
                if let Ok(bytes) = hex::decode(en1_hex) {
                    *extranonce1 = bytes;
                    info!("Updated extranonce1 from mining.set_extranonce: {}", en1_hex);
                }
            }
        }
        return;
    }

    if method == Some("mining.notify") {
        // mining.notify params:
        //   [0] job_id, [1] prev_hash, [2] coinbase1, [3] coinbase2,
        //   [4] merkle_branches, [5] version, [6] nbits, [7] ntime,
        //   [8] clean_jobs, [9] template_pda (non-standard m1n3 extension)
        if let Some(params) = msg.get("params").and_then(Value::as_array) {
            let job_id = params.get(0).and_then(Value::as_str).unwrap_or("").to_string();
            let template_id = params.get(9).and_then(Value::as_str).unwrap_or("").to_string();
            let version = params
                .get(5)
                .and_then(Value::as_str)
                .and_then(|s| u32::from_str_radix(s, 16).ok())
                .unwrap_or(0);
            let clean_jobs = params.get(8).and_then(Value::as_bool).unwrap_or(false);
            if !job_id.is_empty() && !template_id.is_empty() {
                if clean_jobs {
                    jobs.clear();
                }
                jobs.insert(job_id, (template_id, version));
            }
        }
        return;
    }

    // Response to a previously tracked submit (or subscribe)
    let id = match msg.get("id").and_then(Value::as_u64) {
        Some(id) => id,
        None => return,
    };

    // Subscribe response: result is [[<subs>], extranonce1_hex, extranonce2_size]
    if Some(id) == *subscribe_id {
        if let Some(arr) = msg.get("result").and_then(Value::as_array) {
            if let Some(en1_hex) = arr.get(1).and_then(Value::as_str) {
                if let Ok(bytes) = hex::decode(en1_hex) {
                    *extranonce1 = bytes;
                    info!("Captured extranonce1 from upstream: {}", en1_hex);
                }
            }
        }
        *subscribe_id = None;
        return;
    }

    let (job_id, share) = match pending.remove(&id) {
        Some(p) => p,
        None => return,
    };
    let accepted = msg.get("result").and_then(Value::as_bool).unwrap_or(false);
    if !accepted {
        return;
    }
    match jobs.get(&job_id) {
        Some((tid, _)) => {
            let _ = share_tx.send((tid.clone(), share));
        }
        None => warn!("Share accepted for job {} but template_id not tracked — dropped", job_id),
    }
}

/// Parse Stratum v1 `mining.submit` params into a `PendingShare`.
///
/// params: [worker, job_id, extranonce2_hex, ntime_hex, nonce_hex, ?version_bits_hex]
fn parse_submit_params(params: &[Value]) -> Option<PendingShare> {
    let extranonce2 = hex::decode(params.get(2)?.as_str()?).ok()?;
    let ntime = u32::from_str_radix(params.get(3)?.as_str()?, 16).ok()?;
    let nonce = u32::from_str_radix(params.get(4)?.as_str()?, 16).ok()?;
    let version = params
        .get(5)
        .and_then(Value::as_str)
        .and_then(|s| u32::from_str_radix(s, 16).ok())
        .unwrap_or(0);

    Some(PendingShare { extranonce1: vec![], extranonce2, ntime, nonce, version })
}
