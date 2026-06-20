//! Bitcoin transaction construction for miner payouts.

use anyhow::{anyhow, Result};
use bitcoin::{
    absolute::LockTime,
    transaction::Version,
    Amount, OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Witness,
};
use tracing::info;

use crate::pool_state::MinerRoundEntry;

/// Build an unsigned Bitcoin payout transaction.
///
/// `total_sats` — total satoshis to distribute (coinbase value minus fees).
/// `utxos`      — UTXOs the pool controls (the coinbase output(s)).
/// `miners`     — proportional payout entries.
/// `change_script` — where to send any dust remainder.
///
/// Returns the raw unsigned transaction bytes.
pub fn build_payout_tx(
    total_sats: u64,
    utxos: Vec<(OutPoint, u64)>,   // (outpoint, value_sats)
    miners: &[MinerRoundEntry],
    change_script: ScriptBuf,
) -> Result<Transaction> {
    if miners.is_empty() {
        return Err(anyhow!("No miners to pay"));
    }

    let total_input: u64 = utxos.iter().map(|(_, v)| v).sum();
    if total_input < total_sats {
        return Err(anyhow!(
            "Inputs ({} sats) less than payout amount ({} sats)",
            total_input, total_sats
        ));
    }

    // Compute total net work (post marketplace-sale deduction)
    let total_net_work: u128 = miners.iter().map(|m| m.net_work).sum();

    if total_net_work == 0 {
        return Err(anyhow!("Total net work is zero — cannot compute proportions"));
    }

    // Build outputs (one per miner, proportional to net work)
    // Dust threshold: 546 sats. Miners earning below dust are skipped.
    const DUST_SATS: u64 = 546;
    let mut outputs: Vec<TxOut> = Vec::new();
    let mut distributed: u64 = 0;

    for miner in miners {
        let effective = miner.net_work;
        if effective == 0 { continue; }

        let payout = ((effective * total_sats as u128) / total_net_work) as u64;
        if payout < DUST_SATS {
            info!("Skipping dust payout of {} sats for miner {}", payout, miner.miner);
            continue;
        }

        // Derive a deterministic P2WSH from the miner's Sui address bytes as a placeholder.
        // Production: look up miner's registered BTC address from MinerStats.btc_payout_address.
        let miner_bytes = hex_to_32_bytes(&miner.miner);
        let script = p2wsh_from_address_bytes(&miner_bytes);

        outputs.push(TxOut {
            value: Amount::from_sat(payout),
            script_pubkey: script,
        });
        distributed += payout;
        info!("  {} → {} sats", miner.miner, payout);
    }

    // Change output for any remainder
    let change = total_sats.saturating_sub(distributed);
    if change > DUST_SATS {
        outputs.push(TxOut {
            value: Amount::from_sat(change),
            script_pubkey: change_script,
        });
    }

    // Build inputs (no signatures yet — caller will sign)
    let inputs: Vec<TxIn> = utxos.iter().map(|(op, _)| TxIn {
        previous_output: *op,
        script_sig: ScriptBuf::default(),
        sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
        witness: Witness::default(),
    }).collect();

    Ok(Transaction {
        version: Version::TWO,
        lock_time: LockTime::ZERO,
        input: inputs,
        output: outputs,
    })
}

/// Placeholder: wrap address bytes in a P2WSH envelope.
/// Replace with actual registered Bitcoin address lookup in production.
fn p2wsh_from_address_bytes(key_bytes: &[u8; 32]) -> ScriptBuf {
    use bitcoin::script::Builder;
    use bitcoin::hashes::Hash;
    let hash = bitcoin::hashes::sha256::Hash::hash(key_bytes);
    Builder::new()
        .push_int(0)
        .push_slice(hash.to_byte_array())
        .into_script()
}

/// Parse a 0x-prefixed Sui address hex string to 32 bytes.
fn hex_to_32_bytes(addr: &str) -> [u8; 32] {
    let hex = addr.strip_prefix("0x").unwrap_or(addr);
    let mut out = [0u8; 32];
    if let Ok(bytes) = hex::decode(hex) {
        let len = bytes.len().min(32);
        out[..len].copy_from_slice(&bytes[..len]);
    }
    out
}

/// Serialize a transaction to raw bytes.
pub fn serialize_tx(tx: &Transaction) -> Vec<u8> {
    use bitcoin::consensus::encode::serialize;
    serialize(tx)
}
