//! Bitcoin Core JSON-RPC client for `getblocktemplate` and coinbase construction.
//!
//! The bridge polls this every `JOB_REFRESH_SECS` seconds to get real mainnet
//! block templates and broadcasts them to all connected miners (Avalon, etc.).

use anyhow::{Context, Result};
use reqwest::Client;
use serde::Deserialize;
use serde_json::json;
use tracing::debug;

// ── RPC client ────────────────────────────────────────────────────────────────

pub struct BitcoinRpcClient {
    url:    String,
    user:   String,
    pass:   String,
    client: Client,
}

/// Parsed subset of the `getblocktemplate` RPC response.
#[derive(Debug, Deserialize)]
pub struct BlockTemplate {
    pub version:           u32,
    pub previousblockhash: String,  // 64-char hex (internal byte order)
    pub coinbasevalue:     u64,     // satoshis available to the coinbase output
    pub bits:              String,  // compact target, e.g. "1d00ffff"
    pub curtime:           u32,
    pub height:            u32,
}

impl BitcoinRpcClient {
    pub fn new(url: String, user: String, pass: String) -> Self {
        Self { url, user, pass, client: Client::new() }
    }

    pub async fn get_block_template(&self) -> Result<BlockTemplate> {
        #[derive(Deserialize)]
        struct RpcResponse {
            result: Option<BlockTemplate>,
            error:  Option<serde_json::Value>,
        }

        let body = json!({
            "jsonrpc": "1.0",
            "id":      "m1n3",
            "method":  "getblocktemplate",
            "params":  [{"rules": ["segwit"]}],
        });

        debug!(url = %self.url, "calling getblocktemplate");

        let resp: RpcResponse = self.client
            .post(&self.url)
            .basic_auth(&self.user, Some(&self.pass))
            .json(&body)
            .send()
            .await
            .context("getblocktemplate HTTP request failed")?
            .json()
            .await
            .context("getblocktemplate response deserialization failed")?;

        if let Some(e) = resp.error {
            anyhow::bail!("getblocktemplate RPC error: {}", e);
        }

        resp.result.context("getblocktemplate returned null result")
    }
}

// ── Coinbase construction ─────────────────────────────────────────────────────

/// Build Stratum `coinbase1` and `coinbase2` hex strings from a block template.
///
/// Layout of the full coinbase transaction (serialized):
/// ```
/// [coinbase1] [extranonce1] [extranonce2] [coinbase2]
/// ```
/// The extranonce placeholder (en1_len + en2_len bytes) sits between the two halves
/// so miners can iterate over different extranonce2 values without rebuilding the
/// coinbase prefix.
///
/// Returns `(coinbase1_hex, coinbase2_hex)`.
pub fn build_coinbase_parts(
    tmpl:        &BlockTemplate,
    en1_len:     usize,
    en2_len:     usize,
) -> (String, String) {
    // ── coinbase1: everything up to (but not including) extranonce ─────────────
    let mut cb1 = Vec::<u8>::new();

    // tx version: 1 (4 bytes LE)
    cb1.extend_from_slice(&1u32.to_le_bytes());

    // segwit marker + flag (BIP 141)
    cb1.push(0x00); // marker
    cb1.push(0x01); // flag

    // input count: 1
    cb1.push(0x01);

    // coinbase input: prev txid = 00..00 (32 bytes)
    cb1.extend_from_slice(&[0u8; 32]);

    // coinbase input: prev vout = 0xFFFFFFFF
    cb1.extend_from_slice(&0xFFFF_FFFFu32.to_le_bytes());

    // script_sig:  [height_push | "m1n3-protocol" | extranonce placeholder]
    // Only height_push + tag go in coinbase1; extranonce fills the gap.
    let height_push = encode_height(tmpl.height);
    let pool_tag    = b"/m1n3-protocol/";
    let script_len  = height_push.len() + pool_tag.len() + en1_len + en2_len;

    cb1.extend_from_slice(&encode_varint(script_len as u64));
    cb1.extend_from_slice(&height_push);
    cb1.extend_from_slice(pool_tag);
    // extranonce1 + extranonce2 go here (between cb1 and cb2)

    // ── coinbase2: continues after the extranonce ──────────────────────────────
    let mut cb2 = Vec::<u8>::new();

    // sequence: 0xFFFFFFFF
    cb2.extend_from_slice(&0xFFFF_FFFFu32.to_le_bytes());

    // output count: 2  (OP_RETURN pool tag + segwit commitment)
    cb2.push(0x02);

    // output 0: OP_RETURN "m1n3-protocol" (non-spendable; identifies the pool)
    let op_return_data = pool_tag;
    let op_return_script: Vec<u8> = {
        let mut s = vec![0x6a, op_return_data.len() as u8]; // OP_RETURN <push len>
        s.extend_from_slice(op_return_data);
        s
    };
    cb2.extend_from_slice(&0u64.to_le_bytes()); // value = 0 satoshis
    cb2.extend_from_slice(&encode_varint(op_return_script.len() as u64));
    cb2.extend_from_slice(&op_return_script);

    // output 1: coinbase reward to OP_TRUE (placeholder; real payout output in later phase)
    let reward_script: Vec<u8> = vec![0x51]; // OP_TRUE (anyone can spend — devnet only)
    cb2.extend_from_slice(&tmpl.coinbasevalue.to_le_bytes());
    cb2.extend_from_slice(&encode_varint(reward_script.len() as u64));
    cb2.extend_from_slice(&reward_script);

    // witness commitment placeholder (BIP 141) — empty in this simplified version
    // lock_time: 0
    cb2.extend_from_slice(&0u32.to_le_bytes());

    (hex::encode(&cb1), hex::encode(&cb2))
}

// ── Bitcoin serialization helpers ─────────────────────────────────────────────

/// Encode block height as a Bitcoin script push per BIP 34.
fn encode_height(height: u32) -> Vec<u8> {
    if height == 0 {
        return vec![0x01, 0x00];
    }
    let bytes = height.to_le_bytes();
    // Find minimum byte length (strip trailing zeros in LE)
    let len = bytes.iter().rposition(|&b| b != 0).map(|i| i + 1).unwrap_or(1);
    // If the MSB is set we need a sign byte (Bitcoin uses minimally-encoded signed ints)
    let needs_sign = bytes[len - 1] & 0x80 != 0;
    let total_len  = len + if needs_sign { 1 } else { 0 };

    let mut out = vec![total_len as u8]; // OP_PUSH<n>
    out.extend_from_slice(&bytes[..len]);
    if needs_sign { out.push(0x00); }
    out
}

fn encode_varint(n: u64) -> Vec<u8> {
    match n {
        0x00..=0xfc => vec![n as u8],
        0xfd..=0xffff => {
            let mut v = vec![0xfd];
            v.extend_from_slice(&(n as u16).to_le_bytes());
            v
        }
        0x1_0000..=0xffff_ffff => {
            let mut v = vec![0xfe];
            v.extend_from_slice(&(n as u32).to_le_bytes());
            v
        }
        _ => {
            let mut v = vec![0xff];
            v.extend_from_slice(&n.to_le_bytes());
            v
        }
    }
}
