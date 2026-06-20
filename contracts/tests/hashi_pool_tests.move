/// Tests for hashi_pool.move — deposit pipeline state machine.
#[test_only]
module m1n3_v4::hashi_pool_tests {
    use sui::test_scenario::{Self as ts, Scenario};
    use sui::clock;
    use m1n3_v4::hashi_pool::{Self, HashiPoolConfig, BlockDepositRecord};
    use m1n3_v4::pool::{Self, PoolAdminCap, BlockFoundClaim};

    // ── Actors ────────────────────────────────────────────────────────────────

    const ADMIN: address = @0xAD;

    // ── Fixtures ──────────────────────────────────────────────────────────────

    /// Valid 32-byte P2TR witness program.
    fun p2tr_addr(): vector<u8> {
        x"aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd"
    }

    /// Another valid 32-byte P2TR witness program (for rotation test).
    fun p2tr_addr2(): vector<u8> {
        x"1122334411223344112233441122334411223344112233441122334411223344"
    }

    /// Valid 32-byte txid.
    fun txid(): vector<u8> {
        x"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    }

    /// A short (invalid) txid.
    fun short_txid(): vector<u8> { x"deadbeef" }

    /// A short (invalid) BTC address.
    fun short_btc_addr(): vector<u8> { x"aabbccdd" }

    const ROUND_1:      u64 = 1;
    const SATS_6_25:    u64 = 625_000_000; // 6.25 BTC in sats
    const T0:           u64 = 1_000_000;
    const HASHI_REQ_ID: address = @0x1234;

    // ── Helpers ───────────────────────────────────────────────────────────────

    /// Standard setup: create PoolAdminCap and HashiPoolConfig.
    fun setup(): Scenario {
        let mut sc = ts::begin(ADMIN);
        // mint PoolAdminCap (test-only entry in pool.move)
        ts::next_tx(&mut sc, ADMIN);
        {
            m1n3_v4::pool::init_for_testing(ts::ctx(&mut sc));
        };
        // initialize Hashi config
        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            hashi_pool::initialize(&cap, ADMIN, p2tr_addr(), ts::ctx(&mut sc));
            ts::return_to_sender(&sc, cap);
        };
        sc
    }

    /// Freeze a synthetic BlockFoundClaim so the trustless `record_block_found`
    /// has a claim to bind to.
    fun mint_claim(sc: &mut Scenario, round_id: u64) {
        ts::next_tx(sc, ADMIN);
        pool::create_block_found_claim_for_testing(round_id, 800_000, ADMIN, ts::ctx(sc));
    }

    /// Record a block and return the scenario. Config and record are shared objects.
    fun record_block(sc: &mut Scenario) {
        mint_claim(sc, ROUND_1);
        ts::next_tx(sc, ADMIN);
        let mut config = ts::take_shared<HashiPoolConfig>(sc);
        let claim = ts::take_immutable<BlockFoundClaim>(sc);
        let mut clk = clock::create_for_testing(ts::ctx(sc));
        clock::set_for_testing(&mut clk, T0);
        hashi_pool::record_block_found(
            &mut config, &clk, &claim, txid(), 0, SATS_6_25, ts::ctx(sc),
        );
        clock::destroy_for_testing(clk);
        ts::return_shared(config);
        ts::return_immutable(claim);
    }

    // ── Tests: initialize ─────────────────────────────────────────────────────

    #[test]
    fun test_initialize_stores_fields() {
        let mut sc = setup();
        ts::next_tx(&mut sc, ADMIN);
        {
            let config = ts::take_shared<HashiPoolConfig>(&sc);
            assert!(hashi_pool::derivation_address(&config) == ADMIN, 0);
            assert!(hashi_pool::btc_deposit_address(&config) == p2tr_addr(), 1);
            assert!(hashi_pool::total_deposits(&config) == 0, 2);
            assert!(hashi_pool::total_sats_confirmed(&config) == 0, 3);
            assert!(hashi_pool::pending_sats(&config) == 0, 4);
            ts::return_shared(config);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::hashi_pool::EInvalidBtcAddress)]
    fun test_initialize_rejects_short_btc_address() {
        let mut sc = ts::begin(ADMIN);
        ts::next_tx(&mut sc, ADMIN);
        {
            m1n3_v4::pool::init_for_testing(ts::ctx(&mut sc));
        };
        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            // 4-byte address instead of 32 → should abort
            hashi_pool::initialize(&cap, ADMIN, short_btc_addr(), ts::ctx(&mut sc));
            ts::return_to_sender(&sc, cap);
        };
        ts::end(sc);
    }

    // ── Tests: update_btc_address ─────────────────────────────────────────────

    #[test]
    fun test_update_btc_address() {
        let mut sc = setup();
        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            let mut config = ts::take_shared<HashiPoolConfig>(&sc);
            hashi_pool::update_btc_address(&cap, &mut config, p2tr_addr2());
            assert!(hashi_pool::btc_deposit_address(&config) == p2tr_addr2(), 0);
            ts::return_shared(config);
            ts::return_to_sender(&sc, cap);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::hashi_pool::EInvalidBtcAddress)]
    fun test_update_btc_address_rejects_short() {
        let mut sc = setup();
        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            let mut config = ts::take_shared<HashiPoolConfig>(&sc);
            hashi_pool::update_btc_address(&cap, &mut config, short_btc_addr());
            ts::return_shared(config);
            ts::return_to_sender(&sc, cap);
        };
        ts::end(sc);
    }

    // ── Tests: record_block_found ─────────────────────────────────────────────

    #[test]
    fun test_record_block_found_creates_record() {
        let mut sc = setup();
        record_block(&mut sc);

        ts::next_tx(&mut sc, ADMIN);
        {
            let config = ts::take_shared<HashiPoolConfig>(&sc);
            let record = ts::take_shared<BlockDepositRecord>(&sc);
            assert!(hashi_pool::total_deposits(&config) == 1, 0);
            assert!(hashi_pool::record_status(&record) == hashi_pool::dep_unregistered(), 1);
            assert!(hashi_pool::record_round_id(&record) == ROUND_1, 2);
            assert!(hashi_pool::record_txid(&record) == txid(), 3);
            assert!(hashi_pool::record_vout(&record) == 0, 4);
            assert!(hashi_pool::record_amount_sats(&record) == SATS_6_25, 5);
            assert!(option::is_none(&hashi_pool::record_hashi_request_id(&record)), 6);
            ts::return_shared(config);
            ts::return_shared(record);
        };
        ts::end(sc);
    }

    #[test]
    fun test_record_block_found_indexes_by_round() {
        let mut sc = setup();
        record_block(&mut sc);

        ts::next_tx(&mut sc, ADMIN);
        {
            let config = ts::take_shared<HashiPoolConfig>(&sc);
            let record = ts::take_shared<BlockDepositRecord>(&sc);
            // deposit_index[ROUND_1] should point to the record's object address
            let indexed_id = hashi_pool::deposit_record_id_for_round(&config, ROUND_1);
            assert!(indexed_id != @0x0, 0); // non-zero object address
            let _ = indexed_id;
            ts::return_shared(config);
            ts::return_shared(record);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::hashi_pool::EInvalidTxid)]
    fun test_record_block_found_rejects_short_txid() {
        let mut sc = setup();
        mint_claim(&mut sc, ROUND_1);
        ts::next_tx(&mut sc, ADMIN);
        {
            let mut config = ts::take_shared<HashiPoolConfig>(&sc);
            let claim = ts::take_immutable<BlockFoundClaim>(&sc);
            let clk = clock::create_for_testing(ts::ctx(&mut sc));
            hashi_pool::record_block_found(
                &mut config, &clk, &claim, short_txid(), 0, SATS_6_25,
                ts::ctx(&mut sc),
            );
            clock::destroy_for_testing(clk);
            ts::return_shared(config);
            ts::return_immutable(claim);
        };
        ts::end(sc);
    }

    // ── Tests: full happy-path state machine ──────────────────────────────────

    #[test]
    fun test_register_with_hashi_transitions_to_registered() {
        let mut sc = setup();
        record_block(&mut sc);

        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            let config = ts::take_shared<HashiPoolConfig>(&sc);
            let mut record = ts::take_shared<BlockDepositRecord>(&sc);
            hashi_pool::register_with_hashi(&cap, &config, &mut record, ts::ctx(&mut sc));
            assert!(hashi_pool::record_status(&record) == hashi_pool::dep_registered(), 0);
            ts::return_shared(config);
            ts::return_shared(record);
            ts::return_to_sender(&sc, cap);
        };
        ts::end(sc);
    }

    #[test]
    fun test_set_hashi_request_id() {
        let mut sc = setup();
        record_block(&mut sc);

        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            let config = ts::take_shared<HashiPoolConfig>(&sc);
            let mut record = ts::take_shared<BlockDepositRecord>(&sc);
            hashi_pool::register_with_hashi(&cap, &config, &mut record, ts::ctx(&mut sc));
            hashi_pool::set_hashi_request_id(&cap, &mut record, HASHI_REQ_ID);
            let req_id = hashi_pool::record_hashi_request_id(&record);
            assert!(option::is_some(&req_id), 0);
            assert!(*option::borrow(&req_id) == HASHI_REQ_ID, 1);
            ts::return_shared(config);
            ts::return_shared(record);
            ts::return_to_sender(&sc, cap);
        };
        ts::end(sc);
    }

    #[test]
    fun test_full_deposit_state_machine() {
        let mut sc = setup();
        record_block(&mut sc);

        // UNREGISTERED → REGISTERED
        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            let config = ts::take_shared<HashiPoolConfig>(&sc);
            let mut record = ts::take_shared<BlockDepositRecord>(&sc);
            hashi_pool::register_with_hashi(&cap, &config, &mut record, ts::ctx(&mut sc));
            ts::return_shared(config);
            ts::return_shared(record);
            ts::return_to_sender(&sc, cap);
        };

        // Set request ID
        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            let mut record = ts::take_shared<BlockDepositRecord>(&sc);
            hashi_pool::set_hashi_request_id(&cap, &mut record, HASHI_REQ_ID);
            ts::return_shared(record);
            ts::return_to_sender(&sc, cap);
        };

        // REGISTERED → APPROVED
        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            let mut record = ts::take_shared<BlockDepositRecord>(&sc);
            hashi_pool::mark_hashi_approved(&cap, &mut record);
            assert!(hashi_pool::record_status(&record) == hashi_pool::dep_approved(), 0);
            ts::return_shared(record);
            ts::return_to_sender(&sc, cap);
        };

        // APPROVED → CONFIRMED
        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            let mut config = ts::take_shared<HashiPoolConfig>(&sc);
            let mut record = ts::take_shared<BlockDepositRecord>(&sc);
            let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
            clock::set_for_testing(&mut clk, T0 + 1000);
            hashi_pool::mark_hashi_confirmed(&cap, &mut config, &mut record, &clk);
            assert!(hashi_pool::record_status(&record) == hashi_pool::dep_confirmed(), 1);
            assert!(hashi_pool::total_sats_confirmed(&config) == (SATS_6_25 as u128), 2);
            assert!(hashi_pool::pending_sats(&config) == SATS_6_25, 3);
            clock::destroy_for_testing(clk);
            ts::return_shared(config);
            ts::return_shared(record);
            ts::return_to_sender(&sc, cap);
        };
        ts::end(sc);
    }

    // ── Tests: mark_hashi_failed ──────────────────────────────────────────────

    #[test]
    fun test_mark_hashi_failed_from_registered() {
        let mut sc = setup();
        record_block(&mut sc);

        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            let config = ts::take_shared<HashiPoolConfig>(&sc);
            let mut record = ts::take_shared<BlockDepositRecord>(&sc);
            hashi_pool::register_with_hashi(&cap, &config, &mut record, ts::ctx(&mut sc));
            hashi_pool::mark_hashi_failed(&cap, &mut record, b"below_minimum");
            assert!(hashi_pool::record_status(&record) == hashi_pool::dep_failed(), 0);
            ts::return_shared(config);
            ts::return_shared(record);
            ts::return_to_sender(&sc, cap);
        };
        ts::end(sc);
    }

    #[test]
    fun test_mark_hashi_failed_from_approved() {
        let mut sc = setup();
        record_block(&mut sc);

        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            let config = ts::take_shared<HashiPoolConfig>(&sc);
            let mut record = ts::take_shared<BlockDepositRecord>(&sc);
            hashi_pool::register_with_hashi(&cap, &config, &mut record, ts::ctx(&mut sc));
            hashi_pool::mark_hashi_approved(&cap, &mut record);
            hashi_pool::mark_hashi_failed(&cap, &mut record, b"aml_rejection");
            assert!(hashi_pool::record_status(&record) == hashi_pool::dep_failed(), 0);
            ts::return_shared(config);
            ts::return_shared(record);
            ts::return_to_sender(&sc, cap);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::hashi_pool::EInvalidStatus)]
    fun test_mark_hashi_failed_from_unregistered_fails() {
        let mut sc = setup();
        record_block(&mut sc);

        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            let mut record = ts::take_shared<BlockDepositRecord>(&sc);
            // Record is UNREGISTERED — cannot mark failed directly
            hashi_pool::mark_hashi_failed(&cap, &mut record, b"bad");
            ts::return_shared(record);
            ts::return_to_sender(&sc, cap);
        };
        ts::end(sc);
    }

    // ── Tests: wrong-status guard transitions ─────────────────────────────────

    #[test]
    #[expected_failure(abort_code = m1n3_v4::hashi_pool::EInvalidStatus)]
    fun test_register_twice_fails() {
        let mut sc = setup();
        record_block(&mut sc);

        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            let config = ts::take_shared<HashiPoolConfig>(&sc);
            let mut record = ts::take_shared<BlockDepositRecord>(&sc);
            hashi_pool::register_with_hashi(&cap, &config, &mut record, ts::ctx(&mut sc));
            // Second register call must abort (already REGISTERED)
            hashi_pool::register_with_hashi(&cap, &config, &mut record, ts::ctx(&mut sc));
            ts::return_shared(config);
            ts::return_shared(record);
            ts::return_to_sender(&sc, cap);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::hashi_pool::EInvalidStatus)]
    fun test_set_request_id_before_register_fails() {
        let mut sc = setup();
        record_block(&mut sc);

        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            let mut record = ts::take_shared<BlockDepositRecord>(&sc);
            // Record is UNREGISTERED — cannot set request ID yet
            hashi_pool::set_hashi_request_id(&cap, &mut record, HASHI_REQ_ID);
            ts::return_shared(record);
            ts::return_to_sender(&sc, cap);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::hashi_pool::EInvalidStatus)]
    fun test_approve_before_register_fails() {
        let mut sc = setup();
        record_block(&mut sc);

        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            let mut record = ts::take_shared<BlockDepositRecord>(&sc);
            // Must be REGISTERED first
            hashi_pool::mark_hashi_approved(&cap, &mut record);
            ts::return_shared(record);
            ts::return_to_sender(&sc, cap);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::hashi_pool::EInvalidStatus)]
    fun test_confirm_before_approve_fails() {
        let mut sc = setup();
        record_block(&mut sc);

        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            let mut config = ts::take_shared<HashiPoolConfig>(&sc);
            let mut record = ts::take_shared<BlockDepositRecord>(&sc);
            let clk = clock::create_for_testing(ts::ctx(&mut sc));
            hashi_pool::register_with_hashi(&cap, &config, &mut record, ts::ctx(&mut sc));
            // REGISTERED but not yet APPROVED
            hashi_pool::mark_hashi_confirmed(&cap, &mut config, &mut record, &clk);
            clock::destroy_for_testing(clk);
            ts::return_shared(config);
            ts::return_shared(record);
            ts::return_to_sender(&sc, cap);
        };
        ts::end(sc);
    }

    // ── Tests: clear_pending_sats ─────────────────────────────────────────────

    #[test]
    fun test_clear_pending_sats_full() {
        let mut sc = setup();
        record_block(&mut sc);

        // Fast-track to CONFIRMED
        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            let config = ts::take_shared<HashiPoolConfig>(&sc);
            let mut record = ts::take_shared<BlockDepositRecord>(&sc);
            hashi_pool::register_with_hashi(&cap, &config, &mut record, ts::ctx(&mut sc));
            hashi_pool::mark_hashi_approved(&cap, &mut record);
            ts::return_shared(config);
            ts::return_shared(record);
            ts::return_to_sender(&sc, cap);
        };
        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            let mut config = ts::take_shared<HashiPoolConfig>(&sc);
            let mut record = ts::take_shared<BlockDepositRecord>(&sc);
            let clk = clock::create_for_testing(ts::ctx(&mut sc));
            hashi_pool::mark_hashi_confirmed(&cap, &mut config, &mut record, &clk);
            clock::destroy_for_testing(clk);
            ts::return_shared(config);
            ts::return_shared(record);
            ts::return_to_sender(&sc, cap);
        };

        // Clear all pending_sats
        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            let mut config = ts::take_shared<HashiPoolConfig>(&sc);
            assert!(hashi_pool::pending_sats(&config) == SATS_6_25, 0);
            hashi_pool::clear_pending_sats(&cap, &mut config, SATS_6_25);
            assert!(hashi_pool::pending_sats(&config) == 0, 1);
            ts::return_shared(config);
            ts::return_to_sender(&sc, cap);
        };
        ts::end(sc);
    }

    #[test]
    fun test_clear_pending_sats_partial() {
        let mut sc = setup();
        record_block(&mut sc);

        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            let config = ts::take_shared<HashiPoolConfig>(&sc);
            let mut record = ts::take_shared<BlockDepositRecord>(&sc);
            hashi_pool::register_with_hashi(&cap, &config, &mut record, ts::ctx(&mut sc));
            hashi_pool::mark_hashi_approved(&cap, &mut record);
            ts::return_shared(config);
            ts::return_shared(record);
            ts::return_to_sender(&sc, cap);
        };
        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            let mut config = ts::take_shared<HashiPoolConfig>(&sc);
            let mut record = ts::take_shared<BlockDepositRecord>(&sc);
            let clk = clock::create_for_testing(ts::ctx(&mut sc));
            hashi_pool::mark_hashi_confirmed(&cap, &mut config, &mut record, &clk);
            clock::destroy_for_testing(clk);
            ts::return_shared(config);
            ts::return_shared(record);
            ts::return_to_sender(&sc, cap);
        };
        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            let mut config = ts::take_shared<HashiPoolConfig>(&sc);
            // Clear less than pending
            hashi_pool::clear_pending_sats(&cap, &mut config, 100_000_000);
            assert!(hashi_pool::pending_sats(&config) == SATS_6_25 - 100_000_000, 0);
            ts::return_shared(config);
            ts::return_to_sender(&sc, cap);
        };
        ts::end(sc);
    }

    #[test]
    fun test_clear_pending_sats_over_clamps_to_zero() {
        let mut sc = setup();
        record_block(&mut sc);

        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            let config = ts::take_shared<HashiPoolConfig>(&sc);
            let mut record = ts::take_shared<BlockDepositRecord>(&sc);
            hashi_pool::register_with_hashi(&cap, &config, &mut record, ts::ctx(&mut sc));
            hashi_pool::mark_hashi_approved(&cap, &mut record);
            ts::return_shared(config);
            ts::return_shared(record);
            ts::return_to_sender(&sc, cap);
        };
        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            let mut config = ts::take_shared<HashiPoolConfig>(&sc);
            let mut record = ts::take_shared<BlockDepositRecord>(&sc);
            let clk = clock::create_for_testing(ts::ctx(&mut sc));
            hashi_pool::mark_hashi_confirmed(&cap, &mut config, &mut record, &clk);
            clock::destroy_for_testing(clk);
            ts::return_shared(config);
            ts::return_shared(record);
            ts::return_to_sender(&sc, cap);
        };
        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            let mut config = ts::take_shared<HashiPoolConfig>(&sc);
            // Clear more than pending — should clamp to 0
            hashi_pool::clear_pending_sats(&cap, &mut config, SATS_6_25 + 1);
            assert!(hashi_pool::pending_sats(&config) == 0, 0);
            ts::return_shared(config);
            ts::return_to_sender(&sc, cap);
        };
        ts::end(sc);
    }

    // ── Tests: cumulative stats across two rounds ─────────────────────────────

    #[test]
    fun test_two_rounds_accumulate_stats() {
        let mut sc = setup();
        record_block(&mut sc);

        // Confirm first round
        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            let config = ts::take_shared<HashiPoolConfig>(&sc);
            let mut record = ts::take_shared<BlockDepositRecord>(&sc);
            hashi_pool::register_with_hashi(&cap, &config, &mut record, ts::ctx(&mut sc));
            hashi_pool::mark_hashi_approved(&cap, &mut record);
            ts::return_shared(config);
            ts::return_shared(record);
            ts::return_to_sender(&sc, cap);
        };
        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            let mut config = ts::take_shared<HashiPoolConfig>(&sc);
            let mut record = ts::take_shared<BlockDepositRecord>(&sc);
            let clk = clock::create_for_testing(ts::ctx(&mut sc));
            hashi_pool::mark_hashi_confirmed(&cap, &mut config, &mut record, &clk);
            clock::destroy_for_testing(clk);
            ts::return_shared(config);
            ts::return_shared(record);
            ts::return_to_sender(&sc, cap);
        };

        // Record second block (round 2)
        mint_claim(&mut sc, 2);
        ts::next_tx(&mut sc, ADMIN);
        {
            let mut config = ts::take_shared<HashiPoolConfig>(&sc);
            // The newest BlockFoundClaim is round_id=2; an earlier one for
            // ROUND_1 already exists. Walk past the older one.
            let claim_1 = ts::take_immutable<BlockFoundClaim>(&sc);
            let claim_2 = ts::take_immutable<BlockFoundClaim>(&sc);
            let clk = clock::create_for_testing(ts::ctx(&mut sc));
            // Pick whichever claim is for round 2.
            let claim_for_2 = if (pool::claim_round_id(&claim_2) == 2) &claim_2 else &claim_1;
            hashi_pool::record_block_found(
                &mut config, &clk, claim_for_2, txid(), 1, SATS_6_25,
                ts::ctx(&mut sc),
            );
            assert!(hashi_pool::total_deposits(&config) == 2, 0);
            ts::return_immutable(claim_1);
            ts::return_immutable(claim_2);
            clock::destroy_for_testing(clk);
            ts::return_shared(config);
        };

        // Confirm second round — need to take the second BlockDepositRecord.
        // test_scenario::take_shared takes the most recently shared object.
        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            let config = ts::take_shared<HashiPoolConfig>(&sc);
            let mut record2 = ts::take_shared<BlockDepositRecord>(&sc);
            // Skip directly from UNREGISTERED → REGISTERED → APPROVED
            hashi_pool::register_with_hashi(&cap, &config, &mut record2, ts::ctx(&mut sc));
            hashi_pool::mark_hashi_approved(&cap, &mut record2);
            ts::return_shared(config);
            ts::return_shared(record2);
            ts::return_to_sender(&sc, cap);
        };
        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            let mut config = ts::take_shared<HashiPoolConfig>(&sc);
            let mut record2 = ts::take_shared<BlockDepositRecord>(&sc);
            let clk = clock::create_for_testing(ts::ctx(&mut sc));
            hashi_pool::mark_hashi_confirmed(&cap, &mut config, &mut record2, &clk);
            assert!(
                hashi_pool::total_sats_confirmed(&config) == (SATS_6_25 as u128) * 2,
                0,
            );
            assert!(hashi_pool::pending_sats(&config) == SATS_6_25 * 2, 1);
            clock::destroy_for_testing(clk);
            ts::return_shared(config);
            ts::return_shared(record2);
            ts::return_to_sender(&sc, cap);
        };
        ts::end(sc);
    }

    // ── Tests: view helpers ───────────────────────────────────────────────────

    #[test]
    fun test_p2tr_len_constant() {
        assert!(hashi_pool::p2tr_len() == 32, 0);
    }

    #[test]
    fun test_p2wpkh_len_constant() {
        assert!(hashi_pool::p2wpkh_len() == 20, 0);
    }

    #[test]
    fun test_status_constants_distinct() {
        assert!(hashi_pool::dep_unregistered() == 0, 0);
        assert!(hashi_pool::dep_registered()   == 1, 1);
        assert!(hashi_pool::dep_approved()     == 2, 2);
        assert!(hashi_pool::dep_confirmed()    == 3, 3);
        assert!(hashi_pool::dep_failed()       == 4, 4);
    }
}
