/// Share verification helpers — pure functions, no state.
/// The bridge submits pre-validated shares; these utilities can be used
/// in unit tests and off-chain tooling compiled via Move Prover / sui-sdk.
module m1n3_protocol::share {
    use std::vector;

    // ── Stratum extranonce ────────────────────────────────────────────────────

    /// Build the full coinbase transaction from Stratum fields + extranonce.
    public fun build_coinbase(
        coinbase1:  &vector<u8>,
        extranonce1: &vector<u8>,
        extranonce2: &vector<u8>,
        coinbase2:  &vector<u8>,
    ): vector<u8> {
        let mut cb = vector::empty<u8>();
        vector::append(&mut cb, *coinbase1);
        vector::append(&mut cb, *extranonce1);
        vector::append(&mut cb, *extranonce2);
        vector::append(&mut cb, *coinbase2);
        cb
    }

    /// Compute merkle root from coinbase txid + branch list.
    /// Each step: root = sha256d(concat(left, right)).
    /// NOTE: actual sha256d is performed off-chain; this models the structure.
    public fun compute_merkle_root(
        coinbase_hash: vector<u8>,
        branches:      &vector<vector<u8>>,
    ): vector<u8> {
        let mut root = coinbase_hash;
        let len = vector::length(branches);
        let mut i = 0;
        while (i < len) {
            let branch = vector::borrow(branches, i);
            let mut node = vector::empty<u8>();
            vector::append(&mut node, root);
            vector::append(&mut node, *branch);
            // In production, replace with actual sha256d call via native extension.
            root = node;
            i = i + 1;
        };
        root
    }

    /// Pack Stratum block header fields into 80-byte serialization.
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

    // ── Serialization helpers ────────────────────────────────────────────────

    fun append_u32_le(buf: &mut vector<u8>, v: u32) {
        vector::push_back(buf, ((v & 0xFF) as u8));
        vector::push_back(buf, (((v >> 8) & 0xFF) as u8));
        vector::push_back(buf, (((v >> 16) & 0xFF) as u8));
        vector::push_back(buf, (((v >> 24) & 0xFF) as u8));
    }
}
