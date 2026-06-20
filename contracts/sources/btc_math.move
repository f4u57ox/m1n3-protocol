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
}
