/// Share verification — pure cryptographic functions for on-chain proof-of-work checking.
///
/// This module implements exactly the same verification steps a traditional Stratum v1
/// pool performs server-side, but as on-chain Move functions:
///
///   1. Assemble the coinbase transaction: coinbase1 + extranonce1 + extranonce2 + coinbase2
///   2. Hash it with SHA-256d to get the coinbase txid
///   3. Walk the merkle branch: iteratively SHA-256d(concat(running_root, branch_hash))
///   4. Pack the 80-byte Bitcoin block header (version, prev_hash, merkle_root, ntime, nbits, nonce)
///   5. SHA-256d the header to get the candidate block hash
///   6. Decode the compact n_bits target and compare: reverse(hash) <= target
///
/// `verify_share` is the single entry point that composes all of the above.
/// All other functions are exposed as `public` for unit-testing and off-chain tooling.
module m1n3_protocol::share {
    use sui::hash::sha2_256;
    use std::vector;

    // ── Internal: SHA-256d ────────────────────────────────────────────────────

    /// Bitcoin's canonical double-SHA-256.
    fun sha256d(data: vector<u8>): vector<u8> {
        sha2_256(sha2_256(data))
    }

    // ── Coinbase ──────────────────────────────────────────────────────────────

    /// Concatenate the four Stratum coinbase fields into the raw coinbase transaction bytes.
    public fun build_coinbase(
        coinbase1:   &vector<u8>,
        extranonce1: &vector<u8>,
        extranonce2: &vector<u8>,
        coinbase2:   &vector<u8>,
    ): vector<u8> {
        let mut cb = vector::empty<u8>();
        vector::append(&mut cb, *coinbase1);
        vector::append(&mut cb, *extranonce1);
        vector::append(&mut cb, *extranonce2);
        vector::append(&mut cb, *coinbase2);
        cb
    }

    /// SHA-256d of the assembled coinbase — this is the coinbase txid (internal byte order).
    public fun coinbase_hash(
        coinbase1:   &vector<u8>,
        extranonce1: &vector<u8>,
        extranonce2: &vector<u8>,
        coinbase2:   &vector<u8>,
    ): vector<u8> {
        sha256d(build_coinbase(coinbase1, extranonce1, extranonce2, coinbase2))
    }

    // ── Merkle root ───────────────────────────────────────────────────────────

    /// Build the merkle root from the coinbase hash and the branch list received in
    /// `mining.notify`. Each step: root = SHA-256d(root || branch[i]).
    /// The coinbase is always the leftmost leaf so we only need the right-side branch.
    public fun compute_merkle_root(
        coinbase_txid: vector<u8>,
        branches:      &vector<vector<u8>>,
    ): vector<u8> {
        let mut root = coinbase_txid;
        let len = vector::length(branches);
        let mut i = 0;
        while (i < len) {
            let branch = vector::borrow(branches, i);
            let mut node = vector::empty<u8>();
            vector::append(&mut node, root);
            vector::append(&mut node, *branch);
            root = sha256d(node);
            i = i + 1;
        };
        root
    }

    // ── Block header ──────────────────────────────────────────────────────────

    /// Serialize the 80-byte Bitcoin block header in the exact wire format.
    /// All multi-byte fields are little-endian, prev_hash and merkle_root are 32 bytes each.
    public fun pack_header(
        version:     u32,
        prev_hash:   vector<u8>,
        merkle_root: vector<u8>,
        n_time:      u32,
        n_bits:      u32,
        nonce:       u32,
    ): vector<u8> {
        let mut h = vector::empty<u8>();
        append_u32_le(&mut h, version);
        vector::append(&mut h, prev_hash);
        vector::append(&mut h, merkle_root);
        append_u32_le(&mut h, n_time);
        append_u32_le(&mut h, n_bits);
        append_u32_le(&mut h, nonce);
        h
    }

    /// SHA-256d of the 80-byte block header — the candidate block hash in internal byte order.
    public fun block_hash(header: vector<u8>): vector<u8> {
        sha256d(header)
    }

    // ── Difficulty ────────────────────────────────────────────────────────────

    /// Decode Bitcoin's compact n_bits encoding into a 32-byte big-endian target.
    ///
    /// Layout of n_bits (u32, big-endian interpretation):
    ///   bits[31:24] = exponent  (number of bytes in the full target)
    ///   bits[23:0]  = mantissa  (the significant bytes)
    ///
    /// Full target = mantissa * 256^(exponent - 3), left-padded to 32 bytes.
    ///
    /// Example: 0x1d00ffff → exponent=0x1d=29, mantissa=0x00ffff
    ///   target[29] = 0xff, target[30] = 0xff → rest are 0x00
    ///   (displayed as 0x00000000FFFF0000...0000)
    public fun nbits_to_target(n_bits: u32): vector<u8> {
        let exponent  = ((n_bits >> 24) as u8);
        let mantissa2 = (((n_bits >> 16) & 0xFF) as u8);
        let mantissa1 = (((n_bits >> 8)  & 0xFF) as u8);
        let mantissa0 = ((n_bits & 0xFF) as u8);

        let mut target = vector::empty<u8>();
        let mut i = 0u8;
        while (i < 32) {
            vector::push_back(&mut target, 0u8);
            i = i + 1;
        };

        // Place the 3 mantissa bytes starting at position (32 - exponent).
        // Guard: exponent must be in [3, 32].
        if (exponent >= 3 && exponent <= 32) {
            let base = (32 - (exponent as u64));
            if (base < 32)     { *vector::borrow_mut(&mut target, base)     = mantissa2 };
            if (base + 1 < 32) { *vector::borrow_mut(&mut target, base + 1) = mantissa1 };
            if (base + 2 < 32) { *vector::borrow_mut(&mut target, base + 2) = mantissa0 };
        };
        target
    }

    /// Scale the decoded target up by `difficulty_scalar` to get the pool share target.
    /// Pool share difficulty is always lower than the full Bitcoin network difficulty.
    ///
    /// pool_target = network_target * difficulty_scalar
    /// (larger target = easier to find a valid hash)
    public fun scale_target(target: vector<u8>, difficulty_scalar: u64): vector<u8> {
        // Treat the 32-byte target as a 256-bit big-endian integer and multiply by the scalar.
        // We carry through 32 bytes from LSB (index 31) to MSB (index 0).
        let mut result = target;
        let mut carry: u64 = 0;
        let mut i = 32u64;
        while (i > 0) {
            i = i - 1;
            let byte_val = (*vector::borrow(&result, i) as u64);
            let product  = byte_val * difficulty_scalar + carry;
            *vector::borrow_mut(&mut result, i) = ((product & 0xFF) as u8);
            carry = product >> 8;
        };
        // Overflow (carry > 0) means the scaled target saturates to max; cap to 0xFF...FF.
        if (carry > 0) {
            let mut i2 = 0u64;
            while (i2 < 32) {
                *vector::borrow_mut(&mut result, i2) = 0xFF;
                i2 = i2 + 1;
            };
        };
        result
    }

    /// Return true if `hash` (SHA-256d output, internal/LE byte order) meets `target`
    /// (big-endian 32-byte value from `nbits_to_target`).
    ///
    /// Bitcoin's rule: the hash, when displayed (i.e., byte-reversed), must be ≤ target.
    /// Equivalently: reverse(hash) compared byte-by-byte as a big-endian number ≤ target.
    public fun meets_target(hash: vector<u8>, target: vector<u8>): bool {
        // Reverse the hash to convert from internal order to display/comparison order.
        let mut reversed = vector::empty<u8>();
        let mut i = 32u64;
        while (i > 0) {
            i = i - 1;
            vector::push_back(&mut reversed, *vector::borrow(&hash, i));
        };

        // Lexicographic comparison of two 32-byte big-endian 256-bit numbers.
        let mut j = 0u64;
        while (j < 32) {
            let h_byte = *vector::borrow(&reversed, j);
            let t_byte = *vector::borrow(&target,   j);
            if (h_byte < t_byte) return true;
            if (h_byte > t_byte) return false;
            j = j + 1;
        };
        true // equal — also valid
    }

    // ── Top-level verifier ────────────────────────────────────────────────────

    /// Verify a complete Stratum v1 share submission.
    ///
    /// Returns true only if the reconstructed block hash meets the pool share difficulty
    /// target (network n_bits target scaled up by the pool's difficulty_scalar).
    ///
    /// Parameters mirror the fields in a Stratum `mining.submit` message plus the
    /// job template registered on-chain via `pool::post_job`.
    public fun verify_share(
        coinbase1:        &vector<u8>,
        coinbase2:        &vector<u8>,
        extranonce1:      &vector<u8>,
        extranonce2:      &vector<u8>,
        merkle_branches:  &vector<vector<u8>>,
        version:          u32,
        prev_hash:        vector<u8>,
        n_bits:           u32,
        n_time:           u32,
        nonce:            u32,
        difficulty_scalar: u64,
    ): bool {
        let cb_hash  = coinbase_hash(coinbase1, extranonce1, extranonce2, coinbase2);
        let merkle   = compute_merkle_root(cb_hash, merkle_branches);
        let header   = pack_header(version, prev_hash, merkle, n_time, n_bits, nonce);
        let hash     = block_hash(header);
        let net_tgt  = nbits_to_target(n_bits);
        let pool_tgt = scale_target(net_tgt, difficulty_scalar);
        meets_target(hash, pool_tgt)
    }

    // ── Serialization helpers ─────────────────────────────────────────────────

    fun append_u32_le(buf: &mut vector<u8>, v: u32) {
        vector::push_back(buf, ((v         & 0xFF) as u8));
        vector::push_back(buf, (((v >>  8) & 0xFF) as u8));
        vector::push_back(buf, (((v >> 16) & 0xFF) as u8));
        vector::push_back(buf, (((v >> 24) & 0xFF) as u8));
    }
}
