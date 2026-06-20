//! Build, sign, and broadcast a signet TX from our wallet (.env.btc-signet)
//! to the Hashi P2TR deposit address (.env.hashi BTC_DEPOSIT_ADDR), then
//! print the txid + vout + amount so we can hand them to
//! `scripts/hashi-real-deposit-request.sh`.
//!
//! Usage:
//!   cargo run --quiet -p hashi-derive --bin signet-deposit -- [--dry-run]
//!                                                            [--fee-sat-per-vb N]
//!                                                            [--leave-change SATS]

use anyhow::{anyhow, bail, Context, Result};
use bitcoin::{
    absolute::LockTime,
    hashes::Hash as _,
    consensus::encode,
    secp256k1::{Message, Secp256k1},
    sighash::{EcdsaSighashType, SighashCache},
    transaction::Version,
    Address, Amount, CompressedPublicKey, Network, OutPoint, PrivateKey, ScriptBuf, Sequence,
    Transaction, TxIn, TxOut, Txid, Witness,
};
use std::env;
use std::str::FromStr;

#[derive(serde::Deserialize, Debug)]
struct Utxo {
    txid: String,
    vout: u32,
    value: u64,
    status: UtxoStatus,
}

#[derive(serde::Deserialize, Debug)]
struct UtxoStatus {
    confirmed: bool,
}

fn read_env_from(path: &str, key: &str) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let prefix = format!("{}=", key);
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix(&prefix) {
            return Some(rest.trim().trim_matches('"').to_string());
        }
    }
    None
}

fn main() -> Result<()> {
    let mut dry_run = false;
    let mut fee_rate: u64 = 2; // sat/vB; signet mempool is empty, 2 is plenty.
    let mut leave_change: u64 = 0; // sweep by default.

    let mut args = env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--dry-run" => dry_run = true,
            "--fee-sat-per-vb" => {
                fee_rate = args
                    .next()
                    .context("--fee-sat-per-vb needs a value")?
                    .parse()?
            }
            "--leave-change" => {
                leave_change = args
                    .next()
                    .context("--leave-change needs a value")?
                    .parse()?
            }
            other => bail!("unknown arg: {}", other),
        }
    }

    let wif = read_env_from(".env.btc-signet", "BTC_SIGNET_WIF")
        .ok_or_else(|| anyhow!("BTC_SIGNET_WIF missing from .env.btc-signet"))?;
    let dest = read_env_from(".env.hashi", "BTC_DEPOSIT_ADDR")
        .ok_or_else(|| anyhow!("BTC_DEPOSIT_ADDR missing from .env.hashi"))?;

    let secp = Secp256k1::new();
    let priv_key = PrivateKey::from_wif(&wif)?;
    let sk = priv_key.inner;
    let compressed = CompressedPublicKey::from_private_key(&secp, &priv_key)
        .map_err(|e| anyhow!("compressed pubkey: {}", e))?;
    let from_addr = Address::p2wpkh(&compressed, Network::Signet);

    // Fetch UTXOs.
    let utxo_url = format!(
        "https://mempool.space/signet/api/address/{}/utxo",
        from_addr
    );
    eprintln!("fetching {}", utxo_url);
    let utxos: Vec<Utxo> = ureq::get(&utxo_url).call()?.into_json()?;

    if utxos.is_empty() {
        bail!("no UTXOs at {}", from_addr);
    }
    // Use the largest single UTXO.
    let mut sorted = utxos;
    sorted.sort_by(|a, b| b.value.cmp(&a.value));
    let utxo = &sorted[0];
    eprintln!(
        "using UTXO: {}:{} ({} sats, confirmed={})",
        utxo.txid, utxo.vout, utxo.value, utxo.status.confirmed
    );

    let prev_txid = Txid::from_str(&utxo.txid)?;
    let prev_amount = Amount::from_sat(utxo.value);

    let dest_addr = Address::from_str(&dest)?.require_network(Network::Signet)?;
    let dest_script = dest_addr.script_pubkey();
    let change_script = from_addr.script_pubkey();

    // Fee estimate. For P2WPKH→{P2TR}: ~111 vB sweep, ~150 vB with change.
    let want_change = leave_change > 0;
    let est_vbytes: u64 = if want_change { 150 } else { 111 };
    let fee = est_vbytes * fee_rate;
    if utxo.value <= fee + leave_change + 546 {
        bail!(
            "UTXO too small ({}) for fee {} + leave-change {} + dust",
            utxo.value, fee, leave_change
        );
    }

    let mut outputs = Vec::with_capacity(2);
    let to_hashi = utxo.value - fee - leave_change;
    outputs.push(TxOut {
        value: Amount::from_sat(to_hashi),
        script_pubkey: dest_script.clone(),
    });
    if want_change {
        outputs.push(TxOut {
            value: Amount::from_sat(leave_change),
            script_pubkey: change_script.clone(),
        });
    }

    let mut tx = Transaction {
        version: Version::TWO,
        lock_time: LockTime::ZERO,
        input: vec![TxIn {
            previous_output: OutPoint {
                txid: prev_txid,
                vout: utxo.vout,
            },
            script_sig: ScriptBuf::new(),
            sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
            witness: Witness::new(),
        }],
        output: outputs,
    };

    // BIP-143 P2WPKH sign. bitcoin 0.32's helper takes the witness-v0
    // *script_pubkey* (OP_0 PUSH20 <pkh>) and derives the script_code internally.
    let prev_spk = from_addr.script_pubkey();
    let mut cache = SighashCache::new(&mut tx);
    let sighash = cache.p2wpkh_signature_hash(0, &prev_spk, prev_amount, EcdsaSighashType::All)?;
    let msg = Message::from_digest(*sighash.as_byte_array());
    let sig = secp.sign_ecdsa(&msg, &sk);
    let mut sig_bytes = sig.serialize_der().to_vec();
    sig_bytes.push(EcdsaSighashType::All as u8);
    let pk_bytes = compressed.to_bytes().to_vec();
    *cache.witness_mut(0).unwrap() = Witness::from_slice(&[sig_bytes, pk_bytes]);
    drop(cache);

    let signed_hex = encode::serialize_hex(&tx);
    let txid = tx.compute_txid();

    eprintln!("\n=== Signed signet TX ===");
    eprintln!("vsize : {}", tx.vsize());
    eprintln!("fee   : {} sats ({} sat/vB)", fee, fee_rate);
    for (i, o) in tx.output.iter().enumerate() {
        let a = Address::from_script(&o.script_pubkey, Network::Signet).ok();
        eprintln!("  out[{}] {:>8} sats → {:?}", i, o.value.to_sat(), a);
    }
    eprintln!("txid  : {}", txid);
    eprintln!("hex   : {}", signed_hex);

    if dry_run {
        eprintln!("\n[dry-run] not broadcasting");
        // Still print structured output so the caller has the TX hex.
        println!("BTC_DEPOSIT_TXID={}", txid);
        println!("BTC_DEPOSIT_VOUT=0");
        println!("BTC_DEPOSIT_AMOUNT={}", tx.output[0].value.to_sat());
        println!("BTC_DEPOSIT_RAW_HEX={}", signed_hex);
        return Ok(());
    }

    let bc_url = "https://mempool.space/signet/api/tx";
    eprintln!("\nbroadcasting to {}", bc_url);
    let resp = ureq::post(bc_url)
        .set("Content-Type", "text/plain")
        .send_string(&signed_hex);

    match resp {
        Ok(r) => {
            let body = r.into_string().unwrap_or_default();
            eprintln!("response: {}", body);
        }
        Err(ureq::Error::Status(code, r)) => {
            let body = r.into_string().unwrap_or_default();
            bail!("broadcast HTTP {}: {}", code, body);
        }
        Err(e) => bail!("broadcast transport error: {}", e),
    }

    println!("BTC_DEPOSIT_TXID={}", txid);
    println!("BTC_DEPOSIT_VOUT=0");
    println!("BTC_DEPOSIT_AMOUNT={}", tx.output[0].value.to_sat());
    println!("BTC_DEPOSIT_RAW_HEX={}", signed_hex);
    Ok(())
}
