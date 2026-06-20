/// Tests for miner.move — MinerStats and MinerRoundStats invariants.
#[test_only]
module m1n3_v4::miner_tests {
    use sui::test_scenario::{Self as ts};
    use sui::clock;
    use m1n3_v4::miner::{Self, MinerStats, MinerRoundStats, MinerRoundRegistry};

    const MINER_A: address = @0xA;
    const MINER_B: address = @0xB;
    const ROUND_0: u64 = 0;
    const ROUND_1: u64 = 1;
    const HEIGHT_100: u64 = 100;
    const HEIGHT_200: u64 = 200;

    /// Initialize the MinerRoundRegistry shared object once at the start of
    /// the scenario. All `create_round_stats` calls below thread it via the
    /// `take_shared / return_shared` pattern.
    fun init_registry(sc: &mut ts::Scenario, sender: address) {
        ts::next_tx(sc, sender);
        miner::init_for_testing(ts::ctx(sc));
    }

    /// Wrapper that runs `create_round_stats` with the shared MinerRoundRegistry.
    fun create_round_stats(sc: &mut ts::Scenario, sender: address, round_id: u64, min_height: u64) {
        ts::next_tx(sc, sender);
        let mut reg = ts::take_shared<MinerRoundRegistry>(sc);
        miner::create_round_stats(&mut reg, round_id, min_height, ts::ctx(sc));
        ts::return_shared(reg);
    }

    // ── register_miner ────────────────────────────────────────────────────────

    #[test]
    fun test_register_miner_creates_stats() {
        let mut sc = ts::begin(MINER_A);
        ts::next_tx(&mut sc, MINER_A);
        {
            let clk = clock::create_for_testing(ts::ctx(&mut sc));
            miner::register_miner(b"bc1qtest", &clk, ts::ctx(&mut sc));
            clock::destroy_for_testing(clk);
        };
        ts::next_tx(&mut sc, MINER_A);
        {
            let stats = ts::take_from_sender<MinerStats>(&sc);
            assert!(miner::miner_address(&stats) == MINER_A, 0);
            assert!(miner::total_shares(&stats) == 0, 1);
            assert!(miner::blocks_found(&stats) == 0, 2);
            assert!(miner::btc_payout_address(&stats) == b"bc1qtest", 3);
            ts::return_to_sender(&sc, stats);
        };
        ts::end(sc);
    }

    #[test]
    fun test_set_btc_payout_address_by_owner() {
        let mut sc = ts::begin(MINER_A);
        ts::next_tx(&mut sc, MINER_A);
        {
            let clk = clock::create_for_testing(ts::ctx(&mut sc));
            miner::register_miner(b"old_address", &clk, ts::ctx(&mut sc));
            clock::destroy_for_testing(clk);
        };
        ts::next_tx(&mut sc, MINER_A);
        {
            let mut stats = ts::take_from_sender<MinerStats>(&sc);
            miner::set_btc_payout_address(&mut stats, b"new_address", ts::ctx(&mut sc));
            assert!(miner::btc_payout_address(&stats) == b"new_address", 0);
            ts::return_to_sender(&sc, stats);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = 11)] // ENotOwner
    fun test_set_btc_payout_address_non_owner_aborts() {
        let mut sc = ts::begin(MINER_A);
        ts::next_tx(&mut sc, MINER_A);
        {
            let clk = clock::create_for_testing(ts::ctx(&mut sc));
            miner::register_miner(b"bc1qtest", &clk, ts::ctx(&mut sc));
            clock::destroy_for_testing(clk);
        };
        // MINER_B tries to update MINER_A's payout address
        ts::next_tx(&mut sc, MINER_B);
        {
            let mut stats = ts::take_from_address<MinerStats>(&sc, MINER_A);
            miner::set_btc_payout_address(&mut stats, b"attacker", ts::ctx(&mut sc));
            ts::return_to_address(MINER_A, stats);
        };
        ts::end(sc);
    }

    // ── create_round_stats ────────────────────────────────────────────────────

    #[test]
    fun test_create_round_stats() {
        let mut sc = ts::begin(MINER_A);
        init_registry(&mut sc, MINER_A);
        create_round_stats(&mut sc, MINER_A, ROUND_0, HEIGHT_100);
        ts::next_tx(&mut sc, MINER_A);
        {
            let mrs = ts::take_from_sender<MinerRoundStats>(&sc);
            assert!(miner::mrs_round_id(&mrs) == ROUND_0, 0);
            assert!(miner::mrs_miner(&mrs) == MINER_A, 1);
            assert!(miner::mrs_work(&mrs) == 0u128, 2);
            assert!(miner::mrs_shares(&mrs) == 0, 3);
            assert!(miner::mrs_sold_work(&mrs) == 0u128, 4);
            assert!(miner::mrs_min_height(&mrs) == HEIGHT_100, 5);
            ts::return_to_sender(&sc, mrs);
        };
        ts::end(sc);
    }

    // ── record_share (via package-internal calls, tested via pool tests) ──────
    // These test the invariants exposed by public accessors.

    #[test]
    fun test_record_share_accumulates_work() {
        let mut sc = ts::begin(MINER_A);
        init_registry(&mut sc, MINER_A);
        ts::next_tx(&mut sc, MINER_A);
        {
            let clk = clock::create_for_testing(ts::ctx(&mut sc));
            miner::register_miner(b"bc1q", &clk, ts::ctx(&mut sc));
            clock::destroy_for_testing(clk);
        };
        create_round_stats(&mut sc, MINER_A, ROUND_0, HEIGHT_100);
        ts::next_tx(&mut sc, MINER_A);
        {
            let mut stats = ts::take_from_sender<MinerStats>(&sc);
            let mut mrs = ts::take_from_sender<MinerRoundStats>(&sc);
            // Simulate 3 shares of difficulty 1000, 2000, 3000; last one is a block
            miner::record_share_for_testing(&mut stats, &mut mrs, 1000, false, ROUND_0, HEIGHT_100);
            miner::record_share_for_testing(&mut stats, &mut mrs, 2000, false, ROUND_0, HEIGHT_100);
            miner::record_share_for_testing(&mut stats, &mut mrs, 3000, true, ROUND_0, HEIGHT_100);

            assert!(miner::total_shares(&stats) == 3, 0);
            assert!(miner::blocks_found(&stats) == 1, 1);
            assert!(miner::mrs_work(&mrs) == 6000u128, 2); // 1000+2000+3000
            assert!(miner::mrs_shares(&mrs) == 3, 3);
            assert!(miner::mrs_min_height(&mrs) == HEIGHT_100, 4); // ratchet stays at 100

            ts::return_to_sender(&sc, stats);
            ts::return_to_sender(&sc, mrs);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = 20)] // ERoundMismatch
    fun test_record_share_wrong_round_aborts() {
        let mut sc = ts::begin(MINER_A);
        init_registry(&mut sc, MINER_A);
        ts::next_tx(&mut sc, MINER_A);
        {
            let clk = clock::create_for_testing(ts::ctx(&mut sc));
            miner::register_miner(b"bc1q", &clk, ts::ctx(&mut sc));
            clock::destroy_for_testing(clk);
        };
        create_round_stats(&mut sc, MINER_A, ROUND_0, HEIGHT_100);
        ts::next_tx(&mut sc, MINER_A);
        {
            let mut stats = ts::take_from_sender<MinerStats>(&sc);
            let mut mrs = ts::take_from_sender<MinerRoundStats>(&sc);
            // MRS is for ROUND_0 but we claim it's ROUND_1
            miner::record_share_for_testing(&mut stats, &mut mrs, 100, false, ROUND_1, HEIGHT_100);
            ts::return_to_sender(&sc, stats);
            ts::return_to_sender(&sc, mrs);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = 22)] // EStaleTemplate
    fun test_record_share_stale_height_aborts() {
        let mut sc = ts::begin(MINER_A);
        init_registry(&mut sc, MINER_A);
        ts::next_tx(&mut sc, MINER_A);
        {
            let clk = clock::create_for_testing(ts::ctx(&mut sc));
            miner::register_miner(b"bc1q", &clk, ts::ctx(&mut sc));
            clock::destroy_for_testing(clk);
        };
        // min_height = 200
        create_round_stats(&mut sc, MINER_A, ROUND_0, HEIGHT_200);
        ts::next_tx(&mut sc, MINER_A);
        {
            let mut stats = ts::take_from_sender<MinerStats>(&sc);
            let mut mrs = ts::take_from_sender<MinerRoundStats>(&sc);
            // Submit at HEIGHT_100 which is < min_height=200 → stale
            miner::record_share_for_testing(&mut stats, &mut mrs, 100, false, ROUND_0, HEIGHT_100);
            ts::return_to_sender(&sc, stats);
            ts::return_to_sender(&sc, mrs);
        };
        ts::end(sc);
    }

    #[test]
    fun test_min_height_ratchet() {
        let mut sc = ts::begin(MINER_A);
        init_registry(&mut sc, MINER_A);
        ts::next_tx(&mut sc, MINER_A);
        {
            let clk = clock::create_for_testing(ts::ctx(&mut sc));
            miner::register_miner(b"bc1q", &clk, ts::ctx(&mut sc));
            clock::destroy_for_testing(clk);
        };
        create_round_stats(&mut sc, MINER_A, ROUND_0, HEIGHT_100);
        ts::next_tx(&mut sc, MINER_A);
        {
            let mut stats = ts::take_from_sender<MinerStats>(&sc);
            let mut mrs = ts::take_from_sender<MinerRoundStats>(&sc);
            // Submit at height 100, then 200 — ratchet advances to 200
            miner::record_share_for_testing(&mut stats, &mut mrs, 100, false, ROUND_0, HEIGHT_100);
            assert!(miner::mrs_min_height(&mrs) == HEIGHT_100, 0);
            miner::record_share_for_testing(&mut stats, &mut mrs, 100, false, ROUND_0, HEIGHT_200);
            assert!(miner::mrs_min_height(&mrs) == HEIGHT_200, 1);
            ts::return_to_sender(&sc, stats);
            ts::return_to_sender(&sc, mrs);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = 22)] // EStaleTemplate after ratchet
    fun test_min_height_ratchet_prevents_backwards() {
        let mut sc = ts::begin(MINER_A);
        init_registry(&mut sc, MINER_A);
        ts::next_tx(&mut sc, MINER_A);
        {
            let clk = clock::create_for_testing(ts::ctx(&mut sc));
            miner::register_miner(b"bc1q", &clk, ts::ctx(&mut sc));
            clock::destroy_for_testing(clk);
        };
        create_round_stats(&mut sc, MINER_A, ROUND_0, HEIGHT_100);
        ts::next_tx(&mut sc, MINER_A);
        {
            let mut stats = ts::take_from_sender<MinerStats>(&sc);
            let mut mrs = ts::take_from_sender<MinerRoundStats>(&sc);
            // Advance to 200
            miner::record_share_for_testing(&mut stats, &mut mrs, 100, false, ROUND_0, HEIGHT_200);
            // Now try to go back to 100 — should abort
            miner::record_share_for_testing(&mut stats, &mut mrs, 100, false, ROUND_0, HEIGHT_100);
            ts::return_to_sender(&sc, stats);
            ts::return_to_sender(&sc, mrs);
        };
        ts::end(sc);
    }

    // ── sold_work deduction ───────────────────────────────────────────────────

    #[test]
    fun test_sold_work_deduction() {
        let mut sc = ts::begin(MINER_A);
        init_registry(&mut sc, MINER_A);
        create_round_stats(&mut sc, MINER_A, ROUND_0, HEIGHT_100);
        ts::next_tx(&mut sc, MINER_A);
        {
            let mut mrs = ts::take_from_sender<MinerRoundStats>(&sc);
            miner::record_sold_share_for_testing(&mut mrs, MINER_A, 500, ROUND_0);
            assert!(miner::mrs_sold_work(&mrs) == 500u128, 0);
            assert!(miner::mrs_sold_shares(&mrs) == 1, 1);
            ts::return_to_sender(&sc, mrs);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = 20)] // ERoundMismatch
    fun test_sold_work_wrong_round_aborts() {
        let mut sc = ts::begin(MINER_A);
        init_registry(&mut sc, MINER_A);
        create_round_stats(&mut sc, MINER_A, ROUND_0, HEIGHT_100);
        ts::next_tx(&mut sc, MINER_A);
        {
            let mut mrs = ts::take_from_sender<MinerRoundStats>(&sc);
            miner::record_sold_share_for_testing(&mut mrs, MINER_A, 500, ROUND_1);
            ts::return_to_sender(&sc, mrs);
        };
        ts::end(sc);
    }

    // ── close_miner_round_stats ───────────────────────────────────────────────

    #[test]
    fun test_close_miner_round_stats_by_owner() {
        let mut sc = ts::begin(MINER_A);
        init_registry(&mut sc, MINER_A);
        create_round_stats(&mut sc, MINER_A, ROUND_0, HEIGHT_100);
        ts::next_tx(&mut sc, MINER_A);
        {
            let mrs = ts::take_from_sender<MinerRoundStats>(&sc);
            miner::close_miner_round_stats(mrs, ts::ctx(&mut sc));
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = 11)] // ENotOwner
    fun test_close_miner_round_stats_non_owner_aborts() {
        let mut sc = ts::begin(MINER_A);
        init_registry(&mut sc, MINER_A);
        create_round_stats(&mut sc, MINER_A, ROUND_0, HEIGHT_100);
        ts::next_tx(&mut sc, MINER_B);
        {
            let mrs = ts::take_from_address<MinerRoundStats>(&sc, MINER_A);
            miner::close_miner_round_stats(mrs, ts::ctx(&mut sc));
        };
        ts::end(sc);
    }
}
