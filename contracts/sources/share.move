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
    use std::hash::sha2_256;

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

    /// The Bitcoin difficulty-1 target: nbits_to_target(0x1d00ffff).
    /// 0x00000000FFFF0000000000000000000000000000000000000000000000000000
    /// Pool share target = diff1_target / stratum_difficulty.
    fun diff1_target(): vector<u8> {
        nbits_to_target(0x1d00ffff)
    }

    /// Divide a 32-byte big-endian 256-bit target by a u64 scalar.
    ///
    /// Implements long division byte-by-byte (MSB to LSB).  The invariant
    /// remainder < scalar guarantees quotient ≤ 255 per step, so each output
    /// byte is always in range [0, 255].
    fun divide_target_by_scalar(target: vector<u8>, scalar: u64): vector<u8> {
        let scalar128 = (scalar as u128);
        let mut result = vector::empty<u8>();
        let mut remainder: u128 = 0;
        let mut i = 0u64;
        while (i < 32) {
            remainder = remainder * 256 + (*vector::borrow(&target, i) as u128);
            let quotient = remainder / scalar128;
            remainder = remainder % scalar128;
            vector::push_back(&mut result, (quotient as u8));
            i = i + 1;
        };
        result
    }

    /// Compute the actual Stratum difficulty of a share from its block hash.
    ///
    ///   share_difficulty = 0xFFFF × 2^exp / hash_mantissa_64bit
    ///
    /// where hash_mantissa_64bit is the 8 most-significant bytes of the hash in
    /// big-endian (display) order, and exp = 208 − 8 × lsb_position.
    ///
    /// Mirrors calculate_difficulty_from_hash() in the m1n3_sui reference server.
    /// Uses 64-bit mantissa precision — gives distinct values for every share.
    /// Saturates to 0xFFFFFFFFFFFFFFFF on near-block difficulty overflow.
    ///
    /// `hash` is in internal (little-endian) Bitcoin byte order — hash[31] is
    /// the most-significant display byte.
    fun compute_share_difficulty(hash: &vector<u8>): u64 {
        // Find the highest non-zero byte (scan from the most-significant end).
        // In internal byte order, high indices = high significance.
        let mut msb = 31u64;
        while (msb > 0 && *vector::borrow(hash, msb) == 0) {
            msb = msb - 1;
        };
        if (*vector::borrow(hash, msb) == 0) return 0xFFFFFFFFFFFFFFFF;

        // Build 64-bit mantissa from up to 8 bytes starting at msb, going down.
        let bytes = if (msb + 1 < 8) { msb + 1 } else { 8u64 };
        let mut mant: u64 = 0;
        let mut i = 0u64;
        while (i < bytes) {
            mant = (mant << 8) | (*vector::borrow(hash, msb - i) as u64);
            i = i + 1;
        };
        if (mant == 0) return 0xFFFFFFFFFFFFFFFF;

        // lsb = position of the least-significant byte of the 8-byte window.
        // exp = 208 - 8 × lsb  (always ≥ 16 for valid Bitcoin shares; max 208)
        let lsb = msb - bytes + 1;
        if (lsb * 8 > 208) return 1; // hash > diff1: invalid, floor to 1
        let exp = 208 - lsb * 8;

        if (exp >= 112) {
            return 0xFFFFFFFFFFFFFFFF // near-block: saturate
        };

        // diff = (0xFFFF × 2^exp) / mant, computed in u128 to avoid overflow.
        let numerator: u128 = 65535u128 << (exp as u8);
        let result = numerator / (mant as u128);
        if (result > 0xFFFFFFFFFFFFFFFFu128) { 0xFFFFFFFFFFFFFFFF } else { (result as u64) }
    }

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
    /// Returns `(is_valid, actual_difficulty)` where `actual_difficulty` is the
    /// specific difficulty of this share: diff1_target / block_hash_value.
    /// This value varies per share — a share can be much harder than the pool minimum.
    ///
    /// Pool acceptance threshold: hash ≤ diff1_target / stratum_difficulty.
    public fun verify_share(
        coinbase1:         &vector<u8>,
        coinbase2:         &vector<u8>,
        extranonce1:       &vector<u8>,
        extranonce2:       &vector<u8>,
        merkle_branches:   &vector<vector<u8>>,
        version:           u32,
        prev_hash:         vector<u8>,
        n_bits:            u32,
        n_time:            u32,
        nonce:             u32,
        stratum_difficulty: u64,
    ): (bool, u64) {
        let cb_hash  = coinbase_hash(coinbase1, extranonce1, extranonce2, coinbase2);
        let merkle   = compute_merkle_root(cb_hash, merkle_branches);
        let header   = pack_header(version, prev_hash, merkle, n_time, n_bits, nonce);
        let hash     = block_hash(header);
        // Compute actual share difficulty before moving hash into meets_target.
        let actual_diff = compute_share_difficulty(&hash);
        let pool_tgt = divide_target_by_scalar(diff1_target(), stratum_difficulty);
        let is_valid = meets_target(hash, pool_tgt);
        (is_valid, actual_diff)
    }

    // ── Serialization helpers ─────────────────────────────────────────────────

    fun append_u32_le(buf: &mut vector<u8>, v: u32) {
        vector::push_back(buf, ((v         & 0xFF) as u8));
        vector::push_back(buf, (((v >>  8) & 0xFF) as u8));
        vector::push_back(buf, (((v >> 16) & 0xFF) as u8));
        vector::push_back(buf, (((v >> 24) & 0xFF) as u8));
    }
}
