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

/// Divide target by `difficulty` (integer, big-endian 32-byte).
/// Higher difficulty → lower target → harder to find a valid hash.
pub fn scale_target(mut target: [u8; 32], difficulty: u64) -> [u8; 32] {
    if difficulty <= 1 { return target; }
    let mut remainder: u128 = 0;
    for byte in target.iter_mut() {
        remainder = (remainder << 8) | (*byte as u128);
        *byte = (remainder / difficulty as u128) as u8;
        remainder %= difficulty as u128;
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

/// Verify a submitted share against the job template and pool difficulty.
///
/// Returns `true` if the share meets `difficulty × nbits_target`.
/// All byte slices are raw (not hex); caller decodes from Stratum hex fields.
pub fn verify_share(
    cb1:        &[u8],
    cb2:        &[u8],
    en1:        &[u8],
    en2:        &[u8],
    branches:   &[[u8; 32]],
    version:    u32,
    prev_hash:  &[u8; 32],
    n_bits:     u32,
    n_time:     u32,
    nonce:      u32,
    difficulty: u64,
) -> bool {
    let coinbase   = build_coinbase(cb1, en1, en2, cb2);
    let cb_hash    = sha256d(&coinbase);
    let root       = merkle_root(cb_hash, branches);
    let header     = pack_header(version, prev_hash, &root, n_time, n_bits, nonce);
    let block_hash = sha256d(&header);

    let base_target = nbits_to_target(n_bits);
    let target      = scale_target(base_target, difficulty);
    meets_target(&block_hash, &target)
}
