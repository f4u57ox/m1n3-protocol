//! Off-chain Bitcoin PoW verification — mirrors the logic in `share.move`.
//!
//! Used by the bridge's `mining.submit` handler to reject low-difficulty shares
//! before responding `true`, preventing invalid on-chain submissions.

use sha2::{Digest, Sha256};

// ── Primitives ────────────────────────────────────────────────────────────────

pub fn sha256d(data: &[u8]) -> [u8; 32] {
    let first  = Sha256::digest(data);
    let second = Sha256::digest(first);
    second.into()
}

// ── Coinbase reconstruction ───────────────────────────────────────────────────

pub fn build_coinbase(cb1: &[u8], en1: &[u8], en2: &[u8], cb2: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(cb1.len() + en1.len() + en2.len() + cb2.len());
    v.extend_from_slice(cb1);
    v.extend_from_slice(en1);
    v.extend_from_slice(en2);
    v.extend_from_slice(cb2);
    v
}

// ── Merkle root ───────────────────────────────────────────────────────────────

pub fn merkle_root(cb_hash: [u8; 32], branches: &[[u8; 32]]) -> [u8; 32] {
    let mut root = cb_hash;
    for branch in branches {
        let mut pair = [0u8; 64];
        pair[..32].copy_from_slice(&root);
        pair[32..].copy_from_slice(branch);
        root = sha256d(&pair);
    }
    root
}

// ── Block header ─────────────────────────────────────────────────────────────

pub fn pack_header(
    version:   u32,
    prev_hash: &[u8; 32],
    merkle_rt: &[u8; 32],
    n_time:    u32,
    n_bits:    u32,
    nonce:     u32,
) -> [u8; 80] {
    let mut h = [0u8; 80];
    h[0..4].copy_from_slice(&version.to_le_bytes());
    h[4..36].copy_from_slice(prev_hash);
    h[36..68].copy_from_slice(merkle_rt);
    h[68..72].copy_from_slice(&n_time.to_le_bytes());
    h[72..76].copy_from_slice(&n_bits.to_le_bytes());
    h[76..80].copy_from_slice(&nonce.to_le_bytes());
    h
}

// ── Target arithmetic ─────────────────────────────────────────────────────────

/// Decode the compact `n_bits` field into a 32-byte big-endian target.
pub fn nbits_to_target(n_bits: u32) -> [u8; 32] {
    let exp  = (n_bits >> 24) as usize;
    let mant = n_bits & 0x00ff_ffff;
    let mut t = [0u8; 32];
    if exp == 0 || exp > 32 { return t; }
    let pos = 32usize.saturating_sub(exp);
    if pos + 2 < 32 { t[pos + 2] = (mant & 0xff) as u8; }
    if pos + 1 < 32 { t[pos + 1] = ((mant >> 8) & 0xff) as u8; }
    if pos     < 32 { t[pos]     = ((mant >> 16) & 0xff) as u8; }
    t
}

/// Multiply target by `scalar` (big-endian 32-byte integer × u64).
/// Mirrors share.move::scale_target exactly.
/// Higher scalar → larger target → easier to find a valid hash.
/// Overflows saturate to 0xFF…FF (every hash is valid).
pub fn scale_target(mut target: [u8; 32], scalar: u64) -> [u8; 32] {
    if scalar <= 1 { return target; }
    let mut carry: u64 = 0;
    for byte in target.iter_mut().rev() {
        let product = (*byte as u64) * scalar + carry;
        *byte = (product & 0xFF) as u8;
        carry = product >> 8;
    }
    if carry > 0 {
        target = [0xFF; 32]; // overflow → every hash is valid
    }
    target
}

/// True if the SHA-256d hash (in internal byte order) meets the target.
///
/// Bitcoin hashes are displayed byte-reversed; for comparison we reverse to
/// big-endian (matching the target byte order).
pub fn meets_target(hash: &[u8; 32], target: &[u8; 32]) -> bool {
    let mut rev = *hash;
    rev.reverse();
    rev.as_slice() <= target.as_slice()
}

// ── Full share verification ───────────────────────────────────────────────────

/// Verify a submitted share against the job template and pool difficulty scalar.
///
/// Returns `true` if `hash ≤ nbits_target × pool_scalar`.
/// This is identical to `share::verify_share` in the Move contract.
/// All byte slices are raw (not hex); caller decodes from Stratum hex fields.
pub fn verify_share(
    cb1:         &[u8],
    cb2:         &[u8],
    en1:         &[u8],
    en2:         &[u8],
    branches:    &[[u8; 32]],
    version:     u32,
    prev_hash:   &[u8; 32],
    n_bits:      u32,
    n_time:      u32,
    nonce:       u32,
    pool_scalar: u64,
) -> bool {
    let coinbase   = build_coinbase(cb1, en1, en2, cb2);
    let cb_hash    = sha256d(&coinbase);
    let root       = merkle_root(cb_hash, branches);
    let header     = pack_header(version, prev_hash, &root, n_time, n_bits, nonce);
    let block_hash = sha256d(&header);

    let base_target = nbits_to_target(n_bits);
    let pool_target = scale_target(base_target, pool_scalar);
    meets_target(&block_hash, &pool_target)
}

/// Convert a Stratum difficulty into a pool_scalar for the given n_bits compact target.
///
/// pool_scalar = diff_1_target / (network_target × stratum_difficulty)
///
/// Returns u64::MAX (accept every hash) on overflow or degenerate inputs.
pub fn compute_pool_scalar(n_bits: u32, stratum_difficulty: u64) -> u64 {
    let exp  = (n_bits >> 24) as u32;
    let mant = n_bits & 0x00ff_ffff;
    if mant == 0 || stratum_difficulty == 0 { return u64::MAX; }
    let net_shift  = 8u32.saturating_mul(exp.saturating_sub(3));
    let shift_diff = 208u32.saturating_sub(net_shift);
    if shift_diff >= 64 { return u64::MAX; }
    let numerator: u128   = 65535u128 << shift_diff;
    let denominator: u128 = mant as u128 * stratum_difficulty as u128;
    if denominator == 0 { return u64::MAX; }
    (numerator / denominator).min(u64::MAX as u128) as u64
}

/// Same computation as verify_share but returns (hash_hex, target_hex) for diagnostics.
pub fn debug_share(
    cb1: &[u8], cb2: &[u8], en1: &[u8], en2: &[u8], branches: &[[u8; 32]],
    version: u32, prev_hash: &[u8; 32], n_bits: u32, n_time: u32, nonce: u32,
    pool_scalar: u64,
) -> (String, String) {
    let coinbase   = build_coinbase(cb1, en1, en2, cb2);
    let cb_hash    = sha256d(&coinbase);
    let root       = merkle_root(cb_hash, branches);
    let header     = pack_header(version, prev_hash, &root, n_time, n_bits, nonce);
    let block_hash = sha256d(&header);
    let base_target = nbits_to_target(n_bits);
    let pool_target = scale_target(base_target, pool_scalar);
    let mut rev = block_hash;
    rev.reverse();
    (hex::encode(rev), hex::encode(pool_target))
}
