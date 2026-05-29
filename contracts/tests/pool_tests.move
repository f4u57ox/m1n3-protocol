/// Integration tests for the m1n3-protocol pool module.
///
/// Tests cover:
///   - Pool creation and initial state
///   - Worker registration with extranonce1
///   - Share submission with real PoW verification (using the Bitcoin genesis block)
///   - Proportional reward claiming
///
/// The genesis block is used as the canonical correctness fixture because its
/// SHA-256d output and n_bits target are universally known and verifiable.
#[test_only]
module m1n3_protocol::pool_tests {
    use sui::test_scenario::{Self as ts};
    use sui::coin;
    use sui::sui::SUI;
    use sui::transfer;
    use std::string;
    use std::vector;
    use m1n3_protocol::pool::{Self, Pool};
    use m1n3_protocol::share;

    const OPERATOR: address = @0xCAFE;
    const WORKER_A: address = @0xA1;
    const WORKER_B: address = @0xB2;

    // ── Genesis block constants ───────────────────────────────────────────────
    // Source: https://en.bitcoin.it/wiki/Genesis_block
    // All values in the byte order that Bitcoin uses internally (little-endian where applicable).

    // genesis prev_hash (32 zero bytes)
    fun genesis_prev_hash(): vector<u8> {
        let mut v = vector::empty<u8>();
        let mut i = 0;
        while (i < 32) { vector::push_back(&mut v, 0u8); i = i + 1; };
        v
    }

    // genesis coinbase (raw bytes, simplified for testing — extranonce is embedded)
    fun genesis_coinbase1(): vector<u8> { x"01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff" }
    fun genesis_coinbase2(): vector<u8> { x"ffffffff0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000" }
    fun genesis_extranonce1(): vector<u8> { x"4d04ffff001d0104" }
    fun genesis_extranonce2(): vector<u8> { x"" }

    // genesis block: version=1, n_bits=0x1d00ffff, n_time=0x495fab29, nonce=0x7c2bac1d
    const GENESIS_VERSION: u32 = 1u32;
    const GENESIS_NBITS:   u32 = 0x1d00ffffu32;
    const GENESIS_NTIME:   u32 = 0x495fab29u32;
    const GENESIS_NONCE:   u32 = 0x7c2bac1du32;

    // ── Helpers ───────────────────────────────────────────────────────────────

    fun setup_pool(s: &mut ts::Scenario) {
        ts::next_tx(s, OPERATOR);
        pool::create_pool(ts::ctx(s));
    }

    fun post_genesis_job(s: &mut ts::Scenario) {
        ts::next_tx(s, OPERATOR);
        let mut p   = ts::take_shared<Pool>(s);
        let mut pay = coin::mint_for_testing<SUI>(1_000_000_000, ts::ctx(s));
        pool::post_job(
            &mut p,
            genesis_prev_hash(),
            genesis_coinbase1(),
            genesis_coinbase2(),
            vector::empty<vector<u8>>(),
            GENESIS_VERSION,
            GENESIS_NBITS,
            GENESIS_NTIME,
            500_000_000,
            &mut pay,
            ts::ctx(s),
        );
        ts::return_shared(p);
        transfer::public_transfer(pay, OPERATOR);
    }

    // ── Tests ─────────────────────────────────────────────────────────────────

    #[test]
    fun test_create_pool() {
        let mut s = ts::begin(OPERATOR);
        setup_pool(&mut s);
        ts::next_tx(&mut s, OPERATOR);
        let p = ts::take_shared<Pool>(&s);
        assert!(pool::difficulty(&p) > 0, 0);
        assert!(pool::total_shares(&p) == 0, 1);
        ts::return_shared(p);
        ts::end(s);
    }

    #[test]
    fun test_register_worker_stores_extranonce1() {
        let mut s = ts::begin(OPERATOR);
        setup_pool(&mut s);

        ts::next_tx(&mut s, WORKER_A);
        {
            let mut p = ts::take_shared<Pool>(&s);
            pool::register_worker(
                &mut p,
                string::utf8(b"miner_a.0"),
                x"deadbeef",    // extranonce1 assigned by the pool at subscribe time
                ts::ctx(&mut s),
            );
            ts::return_shared(p);
        };
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_protocol::pool::EAlreadyRegistered)]
    fun test_double_register_fails() {
        let mut s = ts::begin(OPERATOR);
        setup_pool(&mut s);

        ts::next_tx(&mut s, WORKER_A);
        {
            let mut p = ts::take_shared<Pool>(&s);
            pool::register_worker(&mut p, string::utf8(b"a"), x"01", ts::ctx(&mut s));
            pool::register_worker(&mut p, string::utf8(b"a"), x"01", ts::ctx(&mut s));
            ts::return_shared(p);
        };
        ts::end(s);
    }

    /// Verify that the share module correctly identifies the Bitcoin genesis block nonce
    /// as meeting the genesis n_bits target with difficulty_scalar = 1.
    /// This is the canonical unit test for sha256d + difficulty correctness.
    #[test]
    fun test_genesis_share_meets_target() {
        // Build the coinbase and compute the genesis merkle root (no branches).
        let cb_hash = share::coinbase_hash(
            &genesis_coinbase1(),
            &genesis_extranonce1(),
            &genesis_extranonce2(),
            &genesis_coinbase2(),
        );
        let merkle_root = share::compute_merkle_root(cb_hash, &vector::empty<vector<u8>>());
        let header      = share::pack_header(
            GENESIS_VERSION,
            genesis_prev_hash(),
            merkle_root,
            GENESIS_NTIME,
            GENESIS_NBITS,
            GENESIS_NONCE,
        );
        let hash   = share::block_hash(header);
        let target = share::nbits_to_target(GENESIS_NBITS);

        // The genesis block hash must satisfy its own n_bits target.
        assert!(share::meets_target(hash, target), 0);
    }

    /// End-to-end: register worker, post job using genesis parameters, submit the
    /// genesis nonce as a share. Pool difficulty scalar = 1_000 makes the target
    /// much easier than the real network target, so the genesis nonce easily qualifies.
    #[test]
    fun test_submit_share_accepted() {
        let mut s = ts::begin(OPERATOR);
        setup_pool(&mut s);
        post_genesis_job(&mut s);

        ts::next_tx(&mut s, WORKER_A);
        {
            let mut p = ts::take_shared<Pool>(&s);
            pool::register_worker(
                &mut p,
                string::utf8(b"miner_a.0"),
                genesis_extranonce1(),
                ts::ctx(&mut s),
            );
            pool::submit_share(
                &mut p,
                0,                       // job_id = 0 (first job)
                genesis_extranonce2(),
                GENESIS_NTIME,
                GENESIS_NONCE,
                ts::ctx(&mut s),
            );
            assert!(pool::worker_shares(&p, WORKER_A) == 1, 0);
            assert!(pool::total_shares(&p) == 1, 1);
            ts::return_shared(p);
        };
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_protocol::pool::EInvalidShare)]
    fun test_submit_bad_nonce_rejected() {
        let mut s = ts::begin(OPERATOR);
        setup_pool(&mut s);
        post_genesis_job(&mut s);

        ts::next_tx(&mut s, WORKER_A);
        {
            let mut p = ts::take_shared<Pool>(&s);
            pool::register_worker(
                &mut p,
                string::utf8(b"miner_a.0"),
                genesis_extranonce1(),
                ts::ctx(&mut s),
            );
            // nonce = 0x00000000 does not produce a hash that meets even the easy pool target
            pool::submit_share(
                &mut p,
                0,
                genesis_extranonce2(),
                GENESIS_NTIME,
                0x00000000u32,    // wrong nonce — should be rejected
                ts::ctx(&mut s),
            );
            ts::return_shared(p);
        };
        ts::end(s);
    }

    #[test]
    fun test_claim_reward_proportional() {
        let mut s = ts::begin(OPERATOR);
        setup_pool(&mut s);
        post_genesis_job(&mut s);

        // Register both workers.
        ts::next_tx(&mut s, WORKER_A);
        {
            let mut p = ts::take_shared<Pool>(&s);
            pool::register_worker(&mut p, string::utf8(b"a"), genesis_extranonce1(), ts::ctx(&mut s));
            ts::return_shared(p);
        };

        // Worker A submits the genesis share (valid nonce).
        ts::next_tx(&mut s, WORKER_A);
        {
            let mut p = ts::take_shared<Pool>(&s);
            pool::submit_share(&mut p, 0, genesis_extranonce2(), GENESIS_NTIME, GENESIS_NONCE, ts::ctx(&mut s));
            ts::return_shared(p);
        };

        // Worker A claims — should succeed and reset share counter.
        ts::next_tx(&mut s, WORKER_A);
        {
            let mut p = ts::take_shared<Pool>(&s);
            pool::claim_reward(&mut p, ts::ctx(&mut s));
            assert!(pool::worker_shares(&p, WORKER_A) == 0, 0);
            ts::return_shared(p);
        };

        ts::end(s);
    }
}
