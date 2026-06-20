/// Tests for btc_math.move — Bitcoin crypto primitives.
#[test_only]
module m1n3_v4::btc_math_tests {
    use m1n3_v4::btc_math;

    // ── sha256d ───────────────────────────────────────────────────────────────

    #[test]
    fun test_sha256d_empty() {
        // sha256d("") = sha256(sha256(""))
        // sha256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
        // sha256(above) = 5df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c9456
        let result = btc_math::test_sha256d(b"");
        assert!(result == x"5df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c9456", 0);
    }

    #[test]
    fun test_sha256d_abc() {
        // sha256d("abc")
        // sha256("abc") = ba7816bf8f01cfea414140de5dae2ec73b00361bbef0469327243710d48a9b
        // (leading zero) = 0ba7816bf8f01cfea414140de5dae2ec73b00361bbef0469327243710d48a9b
        // sha256(above)  = 4f8b42c22dd3729b519ba6f68d2da7cc5b2d606d05daed5ad5128cc03e6c6358
        let result = btc_math::test_sha256d(b"abc");
        assert!(result == x"4f8b42c22dd3729b519ba6f68d2da7cc5b2d606d05daed5ad5128cc03e6c6358", 1);
    }

    #[test]
    fun test_sha256d_deterministic() {
        // Same input must always produce same output.
        let a = btc_math::test_sha256d(b"hello world");
        let b = btc_math::test_sha256d(b"hello world");
        assert!(a == b, 0);
    }

    #[test]
    fun test_sha256d_distinct_inputs() {
        let a = btc_math::test_sha256d(b"hello");
        let b = btc_math::test_sha256d(b"world");
        assert!(a != b, 0);
    }

    #[test]
    fun test_sha256d_output_length() {
        let result = btc_math::test_sha256d(b"any data here");
        assert!(vector::length(&result) == 32, 0);
    }

    // ── bytes_to_u256_le ──────────────────────────────────────────────────────

    #[test]
    fun test_bytes_to_u256_le_zeros() {
        let v = x"0000000000000000000000000000000000000000000000000000000000000000";
        assert!(btc_math::test_bytes_to_u256_le(&v) == 0u256, 0);
    }

    #[test]
    fun test_bytes_to_u256_le_one() {
        // Little-endian: byte[0] = 1, rest = 0 → value = 1
        let v = x"0100000000000000000000000000000000000000000000000000000000000000";
        assert!(btc_math::test_bytes_to_u256_le(&v) == 1u256, 0);
    }

    #[test]
    fun test_bytes_to_u256_le_256() {
        // byte[1] = 1, byte[0] = 0 → value = 256 = 0x100
        let v = x"0001000000000000000000000000000000000000000000000000000000000000";
        assert!(btc_math::test_bytes_to_u256_le(&v) == 256u256, 0);
    }

    #[test]
    fun test_bytes_to_u256_le_max_byte() {
        // byte[0] = 0xff → value = 255
        let v = x"ff00000000000000000000000000000000000000000000000000000000000000";
        assert!(btc_math::test_bytes_to_u256_le(&v) == 255u256, 0);
    }

    // ── append_u32_le / extract_u32_le roundtrip ──────────────────────────────

    #[test]
    fun test_u32_le_roundtrip_zero() {
        let mut buf = vector[];
        btc_math::append_u32_le(&mut buf, 0u32);
        assert!(vector::length(&buf) == 4, 0);
        assert!(btc_math::extract_u32_le(&buf, 0) == 0u32, 1);
    }

    #[test]
    fun test_u32_le_roundtrip_one() {
        let mut buf = vector[];
        btc_math::append_u32_le(&mut buf, 1u32);
        // little-endian: [0x01, 0x00, 0x00, 0x00]
        assert!(*vector::borrow(&buf, 0) == 1u8, 0);
        assert!(*vector::borrow(&buf, 1) == 0u8, 1);
        assert!(btc_math::extract_u32_le(&buf, 0) == 1u32, 2);
    }

    #[test]
    fun test_u32_le_roundtrip_max() {
        let mut buf = vector[];
        btc_math::append_u32_le(&mut buf, 0xFFFFFFFFu32);
        assert!(btc_math::extract_u32_le(&buf, 0) == 0xFFFFFFFFu32, 0);
    }

    #[test]
    fun test_u32_le_roundtrip_known() {
        // 0x01020304 little-endian → bytes [0x04, 0x03, 0x02, 0x01]
        let mut buf = vector[];
        btc_math::append_u32_le(&mut buf, 0x01020304u32);
        assert!(*vector::borrow(&buf, 0) == 0x04u8, 0);
        assert!(*vector::borrow(&buf, 1) == 0x03u8, 1);
        assert!(*vector::borrow(&buf, 2) == 0x02u8, 2);
        assert!(*vector::borrow(&buf, 3) == 0x01u8, 3);
        assert!(btc_math::extract_u32_le(&buf, 0) == 0x01020304u32, 4);
    }

    // ── reverse_bytes_32 ──────────────────────────────────────────────────────

    #[test]
    fun test_reverse_bytes_32_involution() {
        // reverse(reverse(x)) == x
        let original = x"000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
        let once = btc_math::test_reverse_bytes_32(&original);
        let twice = btc_math::test_reverse_bytes_32(&once);
        assert!(twice == original, 0);
    }

    #[test]
    fun test_reverse_bytes_32_known() {
        // First byte becomes last, last becomes first.
        let v = x"0000000000000000000000000000000000000000000000000000000000000001";
        let r = btc_math::test_reverse_bytes_32(&v);
        // After reversal: byte[0] should be 0x01, rest 0.
        assert!(*vector::borrow(&r, 0) == 0x01u8, 0);
        assert!(*vector::borrow(&r, 31) == 0x00u8, 1);
    }

    // ── bits_to_target ────────────────────────────────────────────────────────

    #[test]
    fun test_bits_to_target_genesis() {
        // Bitcoin genesis nbits = 0x1d00ffff
        // exponent = 29, mantissa = 0x00ffff = 65535
        // target = 65535 << (29-3)*8 = 65535 << 208
        let target = btc_math::test_bits_to_target(0x1d00ffffu32);
        // target should have the 0xffff in bytes 26-27 (0-indexed from LSB)
        // In u256: 65535 * 2^208 = 0x00000000FFFF0000...0000 (26 zero bytes then 0xffff then zeros)
        // Verify: target / 2^208 == 65535
        let shift: u8 = 208;
        let shifted = target >> shift;
        assert!(shifted == 65535u256, 0);
    }

    #[test]
    fun test_bits_to_target_zero_mantissa() {
        // mantissa = 0 → target = 0 (per code: mantissa == 0 → MAX_DIFFICULTY path skipped,
        // but bits_to_target just returns 0 for mantissa=0)
        let target = btc_math::test_bits_to_target(0x03000000u32); // exponent=3, mantissa=0
        assert!(target == 0u256, 0);
    }

    #[test]
    fun test_bits_to_target_exponent_less_than_3() {
        // exponent = 2, mantissa = 0x000100 = 256
        // target = 256 >> (3-2)*8 = 256 >> 8 = 1
        let target = btc_math::test_bits_to_target(0x02000100u32);
        assert!(target == 1u256, 0);
    }

    // ── target_to_bits / bits_to_target roundtrip ────────────────────────────

    #[test]
    fun test_bits_roundtrip_genesis() {
        let nbits = 0x1d00ffffu32;
        let target = btc_math::test_bits_to_target(nbits);
        let back = btc_math::test_target_to_bits(target);
        assert!(back == nbits, 0);
    }

    #[test]
    fun test_bits_roundtrip_regtest() {
        // Regtest nbits = 0x207fffff
        let nbits = 0x207fffffu32;
        let target = btc_math::test_bits_to_target(nbits);
        let back = btc_math::test_target_to_bits(target);
        assert!(back == nbits, 0);
    }

    // ── calc_work_from_bits ───────────────────────────────────────────────────

    #[test]
    fun test_calc_work_from_bits_genesis() {
        // Genesis difficulty is 1, so work = ~target / (target+1) + 1 ≈ 1
        let work = btc_math::test_calc_work_from_bits(0x1d00ffffu32);
        assert!(work >= 1u256, 0);
    }

    #[test]
    fun test_calc_work_from_bits_zero_target() {
        // bits = 0x03000000 → target = 0 → work = 0 (guarded early return in impl)
        let work = btc_math::test_calc_work_from_bits(0x03000000u32);
        assert!(work == 0u256, 0);
    }

    // ── verify_merkle_proof ───────────────────────────────────────────────────

    #[test]
    fun test_verify_merkle_proof_single_leaf() {
        // A tree with one leaf: root = leaf, empty path.
        let leaf = x"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
        assert!(btc_math::verify_merkle_proof(leaf, vector[], leaf, 0), 0);
    }

    #[test]
    fun test_verify_merkle_proof_wrong_leaf() {
        let root = x"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
        let wrong_leaf = x"0000000000000000000000000000000000000000000000000000000000000001";
        // Wrong leaf should not match the root.
        assert!(!btc_math::verify_merkle_proof(root, vector[], wrong_leaf, 0), 0);
    }

    #[test]
    fun test_verify_merkle_proof_two_leaves_left() {
        // Two-leaf tree: tx0 (index=0, left), tx1 (sibling)
        // With the custom CVE defense: root = sha256d(tx0 || sha256(tx1))
        use std::hash::sha2_256;
        let tx0 = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let tx1 = x"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

        // Compute expected root using the same non-standard algorithm:
        // h = sha256(tx1)
        // combined = tx0 || h
        // root = sha256d(combined)
        let h_sibling = sha2_256(tx1);
        let mut combined = tx0;
        vector::append(&mut combined, h_sibling);
        // sha256d = sha256(sha256(combined))
        let root = btc_math::test_sha256d(combined);

        let mut path = vector[];
        vector::push_back(&mut path, tx1);

        assert!(btc_math::verify_merkle_proof(root, path, tx0, 0), 0);
    }

    #[test]
    fun test_verify_merkle_proof_tampered_sibling() {
        use std::hash::sha2_256;
        let tx0 = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let tx1 = x"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

        // Compute correct root with tx1 as sibling.
        let h_sibling = sha2_256(tx1);
        let mut combined = tx0;
        vector::append(&mut combined, h_sibling);
        let root = btc_math::test_sha256d(combined);

        // Use wrong sibling — proof should fail.
        let wrong_sibling = x"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
        let mut path = vector[];
        vector::push_back(&mut path, wrong_sibling);

        assert!(!btc_math::verify_merkle_proof(root, path, tx0, 0), 0);
    }
}
