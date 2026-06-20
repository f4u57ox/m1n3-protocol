//! Reproduce Hashi's per-Sui-address Bitcoin P2TR derivation, byte-for-byte
//! matching MystenLabs/hashi:
//!
//!   crates/hashi-types/src/bitcoin/taproot.rs  ← descriptor builder
//!   fastcrypto-tbls/src/threshold_schnorr/key_derivation.rs ← derive_verifying_key
//!
//! The Hashi descriptor is:
//!
//!   tr({NUMS}, {multi_a(2, {guardian}, {h}),
//!               and_v(v:older({delay}), pk({h}))})
//!
//! where:
//!   NUMS     = 0x50929b74…03ac0 (the BIP-341 NUMS point, no known privkey)
//!   guardian = x-only Schnorr pubkey from Hashi's btc_config (guardian_btc_public_key)
//!   h        = derive_verifying_key(master_g, sui_addr_bytes)
//!   delay    = 60-day BIP-68 relative-locktime sequence
//!
//! `derive_verifying_key(vk, addr)`:
//!   ikm   = vk.x_be_bytes() || sui_addr_bytes      (32 + 32 bytes)
//!   bytes = HKDF-SHA3-256(ikm = ikm, salt=[], info=[], L=64)
//!   t     = bytes_mod_n  (reduce 64 bytes mod secp256k1 group order)
//!   P'    = vk + t·G
//!   return BIP-340 x-only(P')  (negate if odd Y)

use anyhow::{anyhow, bail, Context, Result};
use ark_ec::AffineRepr;
use ark_ff::{BigInteger, PrimeField};
use ark_secp256k1::{Affine, Fr};
use ark_serialize::CanonicalDeserialize;
use bitcoin::Network;
use clap::Parser;
use hkdf::Hkdf;
use miniscript::Descriptor;
use secp256k1::{PublicKey, Scalar, SECP256K1, XOnlyPublicKey};
use sha3::Sha3_256;

#[derive(Parser, Debug)]
#[command(name = "hashi-derive-address", about = "Compute the Hashi BTC P2TR deposit address for a Sui address")]
struct Args {
    /// Sui address that serves as the Hashi derivation path. For m1n3 this is
    /// the HashiVault object's UID-derived address.
    #[arg(long)]
    sui_addr: String,

    /// Hashi MPC aggregated public key (33-byte compressed secp256k1), hex.
    /// Read from the Hashi shared object's `committee_set.mpc_public_key`.
    #[arg(long)]
    master_g: String,

    /// Guardian x-only Schnorr pubkey (32 bytes), hex. From btc_config's
    /// `guardian_btc_public_key`.
    #[arg(long)]
    guardian_btc: String,

    /// Bitcoin network for address encoding. Hashi devnet → signet.
    #[arg(long, default_value = "signet")]
    network: String,
}

fn parse_hex32(s: &str, name: &str) -> Result<[u8; 32]> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    let v = hex::decode(s).with_context(|| format!("invalid hex for {}", name))?;
    if v.len() != 32 {
        bail!("{} must be 32 bytes (got {})", name, v.len());
    }
    let mut a = [0u8; 32];
    a.copy_from_slice(&v);
    Ok(a)
}

fn parse_hex33(s: &str, name: &str) -> Result<[u8; 33]> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    let v = hex::decode(s).with_context(|| format!("invalid hex for {}", name))?;
    if v.len() != 33 {
        bail!("{} must be 33 bytes (got {})", name, v.len());
    }
    let mut a = [0u8; 33];
    a.copy_from_slice(&v);
    Ok(a)
}

/// Deserialise Hashi's on-chain `mpc_public_key` (33 bytes, arkworks
/// `CanonicalSerialize` of `Projective<secp256k1>` — NOT SEC1) into a secp256k1
/// affine point. Returns the BE x-bytes and a re-encoded SEC1 compressed
/// pubkey suitable for `secp256k1::PublicKey::from_slice`.
fn parse_master_g(bytes: &[u8; 33]) -> Result<([u8; 32], [u8; 33])> {
    let affine = Affine::deserialize_compressed(&bytes[..])
        .map_err(|e| anyhow!("master_g arkworks deserialise: {}", e))?;
    if affine.is_zero() {
        bail!("master_g is the point at infinity");
    }
    let x = affine
        .x()
        .ok_or_else(|| anyhow!("missing x"))?
        .into_bigint()
        .to_bytes_be();
    let y_odd = !affine
        .y()
        .ok_or_else(|| anyhow!("missing y"))?
        .into_bigint()
        .is_even();
    let mut x_be = [0u8; 32];
    x_be.copy_from_slice(&x);
    let mut sec1 = [0u8; 33];
    sec1[0] = if y_odd { 0x03 } else { 0x02 };
    sec1[1..].copy_from_slice(&x_be);
    Ok((x_be, sec1))
}

/// derive_verifying_key from fastcrypto-tbls — applied to secp256k1.
///
/// Returns the BIP-340 x-only pubkey (forced even-Y if needed).
fn derive_child_xonly(master_g_arkbytes: &[u8; 33], sui_addr: &[u8; 32]) -> Result<XOnlyPublicKey> {
    // 1. Decode the arkworks-serialised master G and reconstruct in SEC1.
    let (master_x_be, master_sec1) = parse_master_g(master_g_arkbytes)?;
    let master = PublicKey::from_slice(&master_sec1)
        .map_err(|e| anyhow!("master_g reserialised SEC1: {}", e))?;

    // 2. ikm = master.x_be_bytes() || sui_addr  (matches compute_tweak)
    let mut ikm = Vec::with_capacity(64);
    ikm.extend_from_slice(&master_x_be);
    ikm.extend_from_slice(sui_addr);

    // HKDF-SHA3-256, no salt, no info, 64-byte output (matches fastcrypto's
    // hkdf_sha3_256 with empty salt + empty info, producing OKM directly).
    let hk = Hkdf::<Sha3_256>::new(None, &ikm);
    let mut okm = [0u8; 64];
    hk.expand(&[], &mut okm)
        .map_err(|e| anyhow!("HKDF expand failed: {}", e))?;

    // 3. Reduce 64 BE bytes mod the secp256k1 group order — byte-exact match
    //    for `Fr::from_be_bytes_mod_order` (which is what fastcrypto's
    //    `Scalar::from_bytes_mod_order` calls). Use arkworks here so we don't
    //    drift from Hashi's reduction.
    let t_fr = Fr::from_be_bytes_mod_order(&okm);
    let t_be = t_fr.into_bigint().to_bytes_be();
    let mut t_be_32 = [0u8; 32];
    // into_bigint may emit fewer than 32 bytes for small values; left-pad.
    let pad = 32 - t_be.len();
    t_be_32[pad..].copy_from_slice(&t_be);
    let tweak = Scalar::from_be_bytes(t_be_32)
        .map_err(|e| anyhow!("scalar from tweak bytes: {}", e))?;

    // 4. derived = master + t·G  (point add)
    let derived = master
        .add_exp_tweak(SECP256K1, &tweak)
        .map_err(|e| anyhow!("point add t·G failed: {}", e))?;

    // 5. BIP-340 x-only (force even-Y).
    let (xonly, _parity) = derived.x_only_public_key();
    Ok(xonly)
}

fn main() -> Result<()> {
    let args = Args::parse();

    let sui_addr = parse_hex32(&args.sui_addr, "sui_addr")?;
    let master_g = parse_hex33(&args.master_g, "master_g")?;
    let guardian_xonly = parse_hex32(&args.guardian_btc, "guardian_btc")?;

    let network = match args.network.to_lowercase().as_str() {
        "mainnet" | "main" | "bitcoin" => Network::Bitcoin,
        "signet" => Network::Signet,
        "testnet" | "testnet3" => Network::Testnet,
        "regtest" => Network::Regtest,
        other => bail!("unknown network: {}", other),
    };

    let derived_xonly = derive_child_xonly(&master_g, &sui_addr)?;

    // Hashi descriptor (must match crates/hashi-types/src/bitcoin/taproot.rs):
    //   tr({NUMS},{multi_a(2,{guardian},{h}),and_v(v:older({delay}),pk({h}))})
    // delay = 60 days as a BIP-68 time-based relative locktime sequence.
    let delay_seq: u32 = bitcoin::relative::LockTime::from_seconds_ceil(60 * 24 * 60 * 60)
        .map_err(|e| anyhow!("BIP-68 sequence: {}", e))?
        .to_sequence()
        .to_consensus_u32();

    const NUMS_HEX: &str = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";
    let guardian_hex = hex::encode(guardian_xonly);
    let derived_hex = hex::encode(derived_xonly.serialize());

    let desc_str = format!(
        "tr({NUMS_HEX},{{multi_a(2,{g},{h}),and_v(v:older({d}),pk({h}))}})",
        g = guardian_hex,
        h = derived_hex,
        d = delay_seq,
    );

    // tr() leaves take x-only pubkeys in miniscript v13.
    let desc: Descriptor<XOnlyPublicKey> = desc_str
        .parse()
        .map_err(|e| anyhow!("could not parse descriptor {}: {}", desc_str, e))?;

    let address = desc
        .address(network)
        .map_err(|e| anyhow!("descriptor → address failed: {}", e))?;

    // The on-chain witness program is the BIP-341 *output key* (NUMS
    // internal pubkey + script-tree tweak), NOT the internal `h` we just
    // derived. Pull it straight out of the script_pubkey we'd lock to.
    let script_pubkey = address.script_pubkey();
    let spk = script_pubkey.as_bytes();
    // P2TR script_pubkey = OP_1 PUSH32 <output_key>  →  bytes [0]=0x51,
    // [1]=0x20, [2..34]=witness program.
    let witness_program_hex = if spk.len() == 34 && spk[0] == 0x51 && spk[1] == 0x20 {
        hex::encode(&spk[2..34])
    } else {
        bail!("unexpected script_pubkey shape: {}", hex::encode(spk));
    };

    println!("descriptor       : {}", desc_str);
    println!("sui addr         : 0x{}", hex::encode(sui_addr));
    println!("internal h xonly : {}", derived_hex);
    println!("output key (WP)  : {}", witness_program_hex);
    println!("BTC ({:?})    : {}", network, address);
    Ok(())
}
