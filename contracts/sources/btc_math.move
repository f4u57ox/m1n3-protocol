/// Shared Bitcoin math and encoding primitives used by pool.move and block_registry.move.
/// Eliminates duplication and provides a single source of truth for:
///   - SHA256d (double SHA256)
///   - Byte encoding/decoding (u32 LE, u256 LE, 32-byte reversal)
///   - Compact target ↔ u256 target conversion (bits_to_target / target_to_bits)
///   - Chain work calculation
///   - Merkle proof verification with CVE-2012-2459 defense
module m1n3_v4::btc_math {
    use std::hash::sha2_256;

    // ===== Errors =====

    #[error]
    const EInvalidLength: vector<u8> = b"Input byte vector has the wrong length (expected 32 bytes)";
    #[error]
    const EInvalidMerkleHashLength: vector<u8> = b"Merkle hash must be exactly 32 bytes";
    #[error]
    const ECoinbaseTooShort: vector<u8> = b"Coinbase bytes are too short to contain vout_count + locktime";
    #[error]
    const EUnsupportedVarintWidth: vector<u8> = b"verify_derived_coinbase only supports 1-byte varint vout_count (<253 outputs)";
    #[error]
    const EDerivedFewerOutputs: vector<u8> = b"Derived coinbase must have strictly more outputs than parent";
    #[error]
    const EParentVoutsNotPreserved: vector<u8> = b"Derived coinbase does not preserve parent's vout bytes (parent outputs must come first, unchanged)";
    #[error]
    const ELocktimeMismatch: vector<u8> = b"Derived coinbase locktime does not match parent's";
    #[error]
    const ECoinbaseMissingVout1: vector<u8> = b"Coinbase has fewer than 2 outputs; vout_1 is required to carry the MPC fee recipient";
    #[error]
    const EWrongVout1Script: vector<u8> = b"Coinbase vout_1's scriptPubKey does not match the expected MPC script";

    // ===== Hash Functions =====

    /// Double SHA256 (Bitcoin's standard hash function).
    public fun sha256d(data: vector<u8>): vector<u8> {
        sha2_256(sha2_256(data))
    }

    // ===== Byte Conversion =====

    /// Converts 32 bytes in little-endian format to u256.
    public fun bytes_to_u256_le(v: &vector<u8>): u256 {
        assert!(vector::length(v) == 32, EInvalidLength);
        let mut result = 0u256;
        let mut i = 0;
        while (i < 32) {
            result = result + ((*vector::borrow(v, i) as u256) << ((i * 8) as u8));
            i = i + 1;
        };
        result
    }

    /// Extract a u32 from bytes at given offset (little-endian).
    public fun extract_u32_le(bytes: &vector<u8>, offset: u64): u32 {
        let b0 = (*vector::borrow(bytes, offset) as u32);
        let b1 = (*vector::borrow(bytes, offset + 1) as u32);
        let b2 = (*vector::borrow(bytes, offset + 2) as u32);
        let b3 = (*vector::borrow(bytes, offset + 3) as u32);
        b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)
    }

    /// Append u32 as little-endian bytes.
    public fun append_u32_le(buf: &mut vector<u8>, val: u32) {
        vector::push_back(buf, ((val & 0xFF) as u8));
        vector::push_back(buf, (((val >> 8) & 0xFF) as u8));
        vector::push_back(buf, (((val >> 16) & 0xFF) as u8));
        vector::push_back(buf, (((val >> 24) & 0xFF) as u8));
    }

    /// Reverse a 32-byte vector (for endianness conversion).
    public fun reverse_bytes_32(v: &vector<u8>): vector<u8> {
        assert!(vector::length(v) == 32, EInvalidLength);
        let mut reversed = vector[];
        let mut k = 32;
        while (k > 0) {
            k = k - 1;
            vector::push_back(&mut reversed, *vector::borrow(v, k));
        };
        reversed
    }

    // ===== Bitcoin Difficulty Math =====

    /// Converts compact bits representation to target value.
    /// Format: bits = <1 byte exponent><3 bytes coefficient>
    /// Target = coefficient * 2^(8 * (exponent - 3))
    public fun bits_to_target(bits: u32): u256 {
        let exponent = (bits >> 24) as u8;
        let coefficient = (bits & 0x007fffff) as u256;

        if (exponent <= 3) {
            let shift = (8 * (3 - exponent)) as u8;
            coefficient >> shift
        } else {
            let shift = (8 * (exponent - 3)) as u8;
            coefficient << shift
        }
    }

    /// Converts target value to compact bits representation.
    public fun target_to_bits(target: u256): u32 {
        let mut exponent = bytes_of_target(target);
        let mut coefficient: u32;

        if (exponent <= 3) {
            let shift: u8 = 8 * (3 - exponent);
            coefficient = ((target << shift) & 0xffffffff) as u32;
        } else {
            let shift: u8 = 8 * (exponent - 3);
            coefficient = ((target >> shift) & 0xffffffff) as u32;
        };

        // Handle negative coefficient case (if high bit is set)
        if (coefficient & 0x00800000 > 0) {
            coefficient = coefficient >> 8;
            exponent = exponent + 1;
        };

        coefficient | ((exponent as u32) << 24)
    }

    /// Calculate number of bytes needed to represent a target.
    fun bytes_of_target(target: u256): u8 {
        if (target == 0) {
            return 1
        };
        let mut b: u8 = 255;
        while ((target & (1u256 << b)) == 0 && b > 0) {
            b = b - 1;
        };
        ((b as u32) / 8 + 1) as u8
    }

    /// Calculate the work represented by a block (2^256 / (target + 1)).
    public fun calc_work_from_bits(bits: u32): u256 {
        let target = bits_to_target(bits);
        if (target == 0) {
            return 0
        };
        // Work = ~target / (target + 1) + 1
        let not_target = target.bitwise_not();
        (not_target / (target + 1)) + 1
    }

    // ===== Merkle Proof Verification =====

    /// Verify a merkle proof with anti-leaf-node-weakness defense (CVE-2012-2459).
    ///
    /// Bitcoin's merkle tree doesn't distinguish 64-byte transactions from internal
    /// nodes. This implementation hashes the sibling with SHA256 before combining
    /// with HASH256 (double SHA256), preventing leaf-node spoofing attacks.
    ///
    /// Based on: https://bitslog.com/2018/08/21/simple-change-to-the-bitcoin-merkleblock-command-to-protect-from-leaf-node-weakness-in-transaction-merkle-tree/
    public fun verify_merkle_proof(
        root: vector<u8>,
        merkle_path: vector<vector<u8>>,
        tx_id: vector<u8>,
        tx_index: u64,
    ): bool {
        assert!(vector::length(&root) == 32, EInvalidMerkleHashLength);
        assert!(vector::length(&tx_id) == 32, EInvalidMerkleHashLength);

        let mut index = tx_index;
        let mut current = tx_id;
        let path_len = vector::length(&merkle_path);
        let mut i = 0;

        while (i < path_len) {
            let sibling = vector::borrow(&merkle_path, i);
            assert!(vector::length(sibling) == 32, EInvalidMerkleHashLength);

            // Anti-leaf-node-weakness: hash sibling with single SHA256 first
            let h = sha2_256(*sibling);

            let mut combined = vector[];
            if (index % 2 == 1) {
                // Coming from right: HASH256(SHA256(sibling) || current)
                vector::append(&mut combined, h);
                vector::append(&mut combined, current);
            } else {
                // Coming from left: HASH256(current || SHA256(sibling))
                vector::append(&mut combined, current);
                vector::append(&mut combined, h);
            };
            current = sha256d(combined);
            index = index >> 1;
            i = i + 1;
        };

        current == root
    }

    // ===== Coinbase derivation verification =====
    //
    // Used by `pool::register_derived_template_public` to enforce: a miner's
    // derived template is a strict structural extension of a buyer's parent
    // template. The miner is allowed to APPEND outputs to the coinbase tx
    // (e.g. a second output paying tx fees to themselves) but MUST NOT
    // modify or remove the buyer's existing outputs — that would let the
    // miner redirect the block reward away from the buyer.
    //
    // Wire format (Bitcoin coinbase tx, Stratum-style split):
    //
    //   serialized_tx = coinbase1 || extranonce1 || extranonce2 || coinbase2
    //
    // `coinbase1` ends inside the input's scriptSig (where the extranonce is
    // injected). `coinbase2` starts immediately after the extranonce and has
    // the layout:
    //
    //   [scriptSig_suffix bytes ...] [sequence: 4 bytes] [vout_count: varint]
    //   [vout_0] [vout_1] ... [vout_n-1] [locktime: 4 bytes]
    //
    // For the Stratum templates we accept, the scriptSig_suffix + sequence
    // bytes that come BEFORE the vout_count are also identical between
    // parent and derived (the buyer fixes the scriptSig prefix; the miner
    // only changes outputs). So we treat `coinbase2` as if it begins with
    // [vout_count][vouts][locktime] — i.e. the vout_count is the first byte
    // we examine. If your stratum implementation injects bytes between the
    // extranonce and the vout_count, those go into `coinbase1` and
    // `verify_derived_coinbase` will still hold because we require
    // byte-exact `coinbase1` equality.

    /// Read a single byte at `offset` from `buf` as a Bitcoin compact-size
    /// varint, asserting it fits in one byte (< 0xfd). Returns the decoded
    /// length. Used by the coinbase-derivation verifier — typical coinbase
    /// txs have 1-4 outputs and 25-34 byte script lengths, so 1-byte
    /// varints are universal in practice. If you really need >252 outputs,
    /// split into multiple templates or extend this function to handle the
    /// 3/5/9-byte forms.
    public fun read_byte_varint(buf: &vector<u8>, offset: u64): u64 {
        let b = *vector::borrow(buf, offset);
        assert!(b < 0xfd, EUnsupportedVarintWidth);
        b as u64
    }

    /// Verify that `derived_coinbase2` is a strict extension of
    /// `parent_coinbase2`: same vout_count byte width, derived has strictly
    /// more outputs, every byte of parent's [vout_0 ... vout_n-1] payload
    /// is preserved at the same offset in derived, and the 4-byte locktime
    /// at the end matches. Aborts otherwise.
    ///
    /// Why this is sufficient for trustlessness:
    ///   1. The buyer's vout_0 (which pays the buyer's BTC address) is the
    ///      first output in `parent_coinbase2` after the vout_count byte.
    ///   2. The byte-equality check forces derived's vout_0 to be bit-for-
    ///      bit identical to parent's vout_0 — same value, same scriptPubKey.
    ///   3. The miner's added output(s) come AFTER parent's vouts but BEFORE
    ///      the locktime. They can be anything (any value, any script).
    ///   4. Bitcoin enforces the global constraint that total output value
    ///      ≤ subsidy + tx_fees. If the buyer claims subsidy + fees in
    ///      vout_0 and the miner adds a non-zero vout_1, the block fails
    ///      consensus and the miner gets no BTC anyway. So the buyer
    ///      doesn't need to constrain the miner's appended value on chain.
    ///
    /// Aborts: ECoinbaseTooShort if either is shorter than vout_count+locktime;
    /// EUnsupportedVarintWidth if vout_count would need a multi-byte varint;
    /// EDerivedFewerOutputs if derived doesn't strictly add outputs;
    /// EParentVoutsNotPreserved if any parent vout byte differs in derived;
    /// ELocktimeMismatch if the trailing 4 bytes don't match.
    public fun verify_derived_coinbase(
        parent_coinbase2: &vector<u8>,
        derived_coinbase2: &vector<u8>,
    ) {
        let plen = vector::length(parent_coinbase2);
        let dlen = vector::length(derived_coinbase2);
        // Both need at minimum: 1 byte vout_count + 4 byte locktime.
        assert!(plen >= 5, ECoinbaseTooShort);
        assert!(dlen >= 5, ECoinbaseTooShort);

        // vout_count comparison (1-byte varint enforced inside read_byte_varint).
        let parent_n = read_byte_varint(parent_coinbase2, 0);
        let derived_n = read_byte_varint(derived_coinbase2, 0);
        assert!(derived_n > parent_n, EDerivedFewerOutputs);

        // Parent's vouts payload is bytes [1 .. plen-4]. Derived MUST contain
        // those exact bytes at the same offset (so the buyer's outputs come
        // first, unmodified, and the miner's appended outputs come after).
        let parent_vouts_len = plen - 5; // total - 1 byte vout_count - 4 byte locktime
        assert!(dlen >= 1 + parent_vouts_len + 4, ECoinbaseTooShort);
        let mut i = 0;
        while (i < parent_vouts_len) {
            assert!(
                *vector::borrow(parent_coinbase2, 1 + i)
                    == *vector::borrow(derived_coinbase2, 1 + i),
                EParentVoutsNotPreserved,
            );
            i = i + 1;
        };

        // Locktime — last 4 bytes of each.
        let mut k = 0;
        while (k < 4) {
            assert!(
                *vector::borrow(parent_coinbase2, plen - 4 + k)
                    == *vector::borrow(derived_coinbase2, dlen - 4 + k),
                ELocktimeMismatch,
            );
            k = k + 1;
        };
    }

    // ===== vout_1 script verification (MPC-split lane) =====
    //
    // Used by `pool::register_buyer_template_with_mpc_split` to enforce: the
    // buyer's template's coinbase pays the protocol MPC at vout_1. vout_0 is
    // unconstrained (typically the buyer's address taking the subsidy);
    // vout_1's scriptPubKey is byte-equal to a constant set by the admin in
    // `ProtocolMPCConfig`. The miner is *not* parameterised in the coinbase;
    // their share of the fees is paid off-chain by the MPC custodian.
    //
    // Layout assumptions (same as verify_derived_coinbase):
    //   - vout_count is a 1-byte varint (< 0xfd outputs — universal in practice).
    //   - Each vout's script_len is also a 1-byte varint (< 0xfd bytes).
    //     P2PKH = 25, P2WPKH = 22, P2TR = 34 — all fit.
    //
    // Wire layout of coinbase2 in this lane:
    //   [vout_count = 0x02] [vout_0] [vout_1] [locktime: 4 bytes]
    //   where each vout = [value: 8 LE] [script_len: 1 byte] [script: N bytes]

    /// Parse `coinbase2`, locate `vout_1`'s scriptPubKey, and assert it
    /// byte-equals `expected_script`. Aborts otherwise.
    public fun verify_vout_1_script(
        coinbase2: &vector<u8>,
        expected_script: &vector<u8>,
    ) {
        let len = vector::length(coinbase2);
        // Need at least: 1 vout_count + (8 value + 1 script_len) per vout + 4 locktime.
        // With two vouts that's >= 1 + 9*2 + 4 = 23.
        assert!(len >= 23, ECoinbaseTooShort);

        // vout_count — strictly more than 1 (so vout_1 exists).
        let n = read_byte_varint(coinbase2, 0);
        assert!(n >= 2, ECoinbaseMissingVout1);

        // Skip vout_0: 8 byte value + 1 byte script_len + script_len bytes.
        let v0_script_len = read_byte_varint(coinbase2, 9);
        let v1_value_offset = 10 + v0_script_len;
        // vout_1 layout: [value 8B at offset v1_value_offset] [script_len 1B at offset +8] [script bytes]
        assert!(len >= v1_value_offset + 8 + 1, ECoinbaseTooShort);
        let v1_script_len = read_byte_varint(coinbase2, v1_value_offset + 8);
        let v1_script_offset = v1_value_offset + 9;
        assert!(len >= v1_script_offset + v1_script_len, ECoinbaseTooShort);

        // Byte-for-byte equality with expected_script.
        let expected_len = vector::length(expected_script);
        assert!(v1_script_len == expected_len, EWrongVout1Script);
        let mut i = 0;
        while (i < expected_len) {
            assert!(
                *vector::borrow(coinbase2, v1_script_offset + i)
                    == *vector::borrow(expected_script, i),
                EWrongVout1Script,
            );
            i = i + 1;
        };
    }

    // ===== Test Helpers =====

    #[test_only]
    public fun test_bits_to_target(bits: u32): u256 {
        bits_to_target(bits)
    }

    #[test_only]
    public fun test_target_to_bits(target: u256): u32 {
        target_to_bits(target)
    }

    #[test_only]
    public fun test_calc_work_from_bits(bits: u32): u256 {
        calc_work_from_bits(bits)
    }

    #[test_only]
    public fun test_bytes_to_u256_le(v: &vector<u8>): u256 {
        bytes_to_u256_le(v)
    }

    #[test_only]
    public fun test_sha256d(data: vector<u8>): vector<u8> {
        sha256d(data)
    }

    #[test_only]
    public fun test_reverse_bytes_32(v: &vector<u8>): vector<u8> {
        reverse_bytes_32(v)
    }

    #[test_only]
    public fun test_verify_derived_coinbase(
        parent_coinbase2: &vector<u8>,
        derived_coinbase2: &vector<u8>,
    ) {
        verify_derived_coinbase(parent_coinbase2, derived_coinbase2)
    }

    #[test_only]
    public fun test_verify_vout_1_script(
        coinbase2: &vector<u8>,
        expected_script: &vector<u8>,
    ) {
        verify_vout_1_script(coinbase2, expected_script)
    }
}
