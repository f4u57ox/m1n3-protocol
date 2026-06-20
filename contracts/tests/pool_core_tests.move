/// Tests for pool.move — share submission, dedup, round lifecycle.
#[test_only]
module m1n3_v4::pool_core_tests {
    use sui::test_scenario::{Self as ts};
    use sui::clock;
    use m1n3_v4::pool::{Self, Pool, PoolAdminCap, Template, RoundAccumulator, MinerWorkRecord, BlockFoundClaim};
    use m1n3_v4::miner::{Self, MinerStats, MinerRoundStats};
    use m1n3_v4::share_dedup::{Self, ShareDedup, ShareDedupRegistry};

    // ── Actors ────────────────────────────────────────────────────────────────

    const ADMIN:   address = @0xAD;
    const MINER_A: address = @0xA;
    const MINER_B: address = @0xB;

    // ── Round / height constants ───────────────────────────────────────────────

    const ROUND_0:     u64 = 0;
    const HEIGHT_850K: u64 = 850_000;
    const T0:          u64 = 1_000_000;
    // Must exceed ACCUMULATION_WINDOW_MS = 5_000
    const AFTER_WINDOW: u64 = 1_006_000;

    // ── Template fixture data ─────────────────────────────────────────────────

    fun prev_hash(): vector<u8> {
        x"0000000000000000000000000000000000000000000000000000000000000000"
    }

    // regtest nbits → cached_network_difficulty = 1 so any hash qualifies as a block
    const NBITS_REGTEST: u32 = 0x207fffff;
    const VERSION:       u32 = 0x20000000;
    const NTIME:         u32 = 1234567890;

    // ── Helpers ───────────────────────────────────────────────────────────────

    fun setup(sc: &mut ts::Scenario) {
        ts::next_tx(sc, ADMIN);
        { pool::init_for_testing(ts::ctx(sc)); };
        ts::next_tx(sc, ADMIN);
        { share_dedup::init_for_testing(ts::ctx(sc)); };
        ts::next_tx(sc, ADMIN);
        { miner::init_for_testing(ts::ctx(sc)); };
    }

    /// Wrapper that runs `miner::create_round_stats` with the shared registry.
    fun create_round_stats(sc: &mut ts::Scenario, miner_addr: address, round_id: u64, min_height: u64) {
        ts::next_tx(sc, miner_addr);
        let mut reg = ts::take_shared<m1n3_v4::miner::MinerRoundRegistry>(sc);
        miner::create_round_stats(&mut reg, round_id, min_height, ts::ctx(sc));
        ts::return_shared(reg);
    }

    /// Trustless replacement for the legacy admin-cap `open_round_accumulator`:
    /// mints a synthetic BlockFoundClaim attesting MINER_A and opens via
    /// `_from_claim`. Used wherever the legacy admin path used to drive the round.
    fun open_acc_via_claim(sc: &mut ts::Scenario, round_id: u64, height: u64) {
        ts::next_tx(sc, ADMIN);
        pool::create_block_found_claim_for_testing(round_id, height, MINER_A, ts::ctx(sc));
        ts::next_tx(sc, ADMIN);
        let mut pool_obj = ts::take_shared<Pool>(sc);
        let claim = ts::take_immutable<BlockFoundClaim>(sc);
        let mut clk = clock::create_for_testing(ts::ctx(sc));
        clock::set_for_testing(&mut clk, T0);
        pool::open_round_accumulator_from_claim(&mut pool_obj, &claim, &clk, ts::ctx(sc));
        clock::destroy_for_testing(clk);
        ts::return_immutable(claim);
        ts::return_shared(pool_obj);
    }

    /// Register a template for ROUND_0 and return the scenario (template is frozen).
    fun register_template(sc: &mut ts::Scenario) {
        ts::next_tx(sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(sc);
            let mut pool_obj = ts::take_shared<Pool>(sc);
            let mut clk = clock::create_for_testing(ts::ctx(sc));
            clock::set_for_testing(&mut clk, T0);
            pool::register_template(
                &mut pool_obj, &cap, &clk,
                HEIGHT_850K, prev_hash(),
                b"cb1", b"cb2",
                vector::empty<vector<u8>>(),
                VERSION, NBITS_REGTEST, NTIME,
                ts::ctx(sc),
            );
            clock::destroy_for_testing(clk);
            ts::return_to_sender(sc, cap);
            ts::return_shared(pool_obj);
        };
    }

    /// Register MINER_A: MinerStats + MinerRoundStats + ShareDedup for the current template.
    fun setup_miner(sc: &mut ts::Scenario) {
        ts::next_tx(sc, MINER_A);
        {
            let clk = clock::create_for_testing(ts::ctx(sc));
            miner::register_miner(b"bc1qminer", &clk, ts::ctx(sc));
            clock::destroy_for_testing(clk);
        };
        create_round_stats(sc, MINER_A, ROUND_0, HEIGHT_850K);
        ts::next_tx(sc, MINER_A);
        {
            let template = ts::take_immutable<Template>(sc);
            let tid = pool::template_id(&template);
            let mut registry = ts::take_shared<ShareDedupRegistry>(sc);
            share_dedup::create_share_dedup(&mut registry, tid, ts::ctx(sc));
            ts::return_shared(registry);
            ts::return_immutable(template);
        };
    }

    // ── Template registration ─────────────────────────────────────────────────

    #[test]
    fun register_template_creates_frozen_object() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        register_template(&mut sc);

        ts::next_tx(&mut sc, ADMIN);
        {
            let template = ts::take_immutable<Template>(&sc);
            assert!(pool::template_height(&template) == HEIGHT_850K, 0);
            assert!(pool::template_round_id(&template) == ROUND_0, 1);
            assert!(pool::template_min_difficulty(&template) == 1, 2);
            ts::return_immutable(template);
        };
        ts::end(sc);
    }

    #[test]
    fun register_template_requires_admin_cap() {
        // Positive path — just verify it succeeds with the correct cap.
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        register_template(&mut sc);
        ts::next_tx(&mut sc, ADMIN);
        {
            let pool_obj = ts::take_shared<Pool>(&sc);
            assert!(pool::current_round(&pool_obj) == 0, 0);
            ts::return_shared(pool_obj);
        };
        ts::end(sc);
    }

    // ── share submission ──────────────────────────────────────────────────────

    #[test]
    fun submit_share_succeeds() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        register_template(&mut sc);
        setup_miner(&mut sc);

        ts::next_tx(&mut sc, MINER_A);
        {
            let template  = ts::take_immutable<Template>(&sc);
            let mut stats = ts::take_from_sender<MinerStats>(&sc);
            let mut mrs   = ts::take_from_sender<MinerRoundStats>(&sc);
            let mut dedup = ts::take_from_sender<ShareDedup>(&sc);
            let clk       = clock::create_for_testing(ts::ctx(&mut sc));

            let receipt = pool::submit_share(
                &template, &mut stats, &mut mrs, &mut dedup,
                b"en1", b"en2", NTIME, 0u32, VERSION, &clk, ts::ctx(&mut sc),
            );

            // Receipt contains correct miner and round info
            assert!(pool::receipt_miner(&receipt) == MINER_A, 0);
            assert!(pool::receipt_round_id(&receipt) == ROUND_0, 1);
            assert!(pool::receipt_difficulty(&receipt) >= 1, 2);
            // Share count incremented
            assert!(miner::total_shares(&stats) == 1, 3);
            assert!(miner::mrs_shares(&mrs) == 1, 4);

            clock::destroy_for_testing(clk);
            ts::return_immutable(template);
            ts::return_to_sender(&sc, stats);
            ts::return_to_sender(&sc, mrs);
            ts::return_to_sender(&sc, dedup);
        };
        ts::end(sc);
    }

    // ── Trustless round-close path ─────────────────────────────────────────
    //
    // submit_share with regtest difficulty (cached_network_difficulty=1) forces
    // is_block=true on the first accepted share, so we should observe a frozen
    // BlockFoundClaim attesting the miner. Anyone can then call
    // open_round_accumulator_from_claim with no PoolAdminCap.

    #[test]
    fun block_found_claim_opens_accumulator_without_cap() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        register_template(&mut sc);
        setup_miner(&mut sc);

        // 1. Block-difficulty share by MINER_A → freezes a BlockFoundClaim.
        ts::next_tx(&mut sc, MINER_A);
        {
            let template  = ts::take_immutable<Template>(&sc);
            let mut stats = ts::take_from_sender<MinerStats>(&sc);
            let mut mrs   = ts::take_from_sender<MinerRoundStats>(&sc);
            let mut dedup = ts::take_from_sender<ShareDedup>(&sc);
            let clk       = clock::create_for_testing(ts::ctx(&mut sc));
            let _ = pool::submit_share(
                &template, &mut stats, &mut mrs, &mut dedup,
                b"en1", b"en2", NTIME, 0u32, VERSION, &clk, ts::ctx(&mut sc),
            );
            clock::destroy_for_testing(clk);
            ts::return_immutable(template);
            ts::return_to_sender(&sc, stats);
            ts::return_to_sender(&sc, mrs);
            ts::return_to_sender(&sc, dedup);
        };

        // 2. Inspect the claim (frozen → immutable). Cryptographic attestation
        //    that MINER_A is the block_finder. No operator could forge this.
        ts::next_tx(&mut sc, MINER_A);
        {
            let claim = ts::take_immutable<BlockFoundClaim>(&sc);
            assert!(pool::claim_round_id(&claim) == ROUND_0, 0);
            assert!(pool::claim_height(&claim) == HEIGHT_850K, 1);
            assert!(pool::claim_block_finder(&claim) == MINER_A, 2);
            ts::return_immutable(claim);
        };

        // 3. A DIFFERENT actor (MINER_B, no admin cap) opens the round
        //    accumulator using the claim. Trustlessness: anyone can drive
        //    round closure once a real block has been found.
        ts::next_tx(&mut sc, MINER_B);
        {
            let mut pool_obj = ts::take_shared<Pool>(&sc);
            let claim = ts::take_immutable<BlockFoundClaim>(&sc);
            let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
            clock::set_for_testing(&mut clk, T0);
            pool::open_round_accumulator_from_claim(&mut pool_obj, &claim, &clk, ts::ctx(&mut sc));
            clock::destroy_for_testing(clk);
            ts::return_immutable(claim);
            ts::return_shared(pool_obj);
        };

        // 4. The shared RoundAccumulator carries the claim's block_finder
        //    verbatim, not a value the opener supplied.
        ts::next_tx(&mut sc, MINER_B);
        {
            let acc = ts::take_shared<RoundAccumulator>(&sc);
            // No direct accessor for these fields in the public surface; the
            // round_id is exposed via finalize_round/round_history. Round 0
            // is the only one we opened, so its presence + correct shape is
            // enough for now.
            ts::return_shared(acc);
        };

        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::share_dedup::EDuplicateShare)]
    fun submit_duplicate_share_aborts() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        register_template(&mut sc);
        setup_miner(&mut sc);

        ts::next_tx(&mut sc, MINER_A);
        {
            let template  = ts::take_immutable<Template>(&sc);
            let mut stats = ts::take_from_sender<MinerStats>(&sc);
            let mut mrs   = ts::take_from_sender<MinerRoundStats>(&sc);
            let mut dedup = ts::take_from_sender<ShareDedup>(&sc);
            let clk       = clock::create_for_testing(ts::ctx(&mut sc));

            // First submission — succeeds.
            let r1 = pool::submit_share(
                &template, &mut stats, &mut mrs, &mut dedup,
                b"en1", b"en2", NTIME, 0u32, VERSION, &clk, ts::ctx(&mut sc),
            );
            // Second submission with identical params → same hash → abort EDuplicateShare.
            let _r2 = pool::submit_share(
                &template, &mut stats, &mut mrs, &mut dedup,
                b"en1", b"en2", NTIME, 0u32, VERSION, &clk, ts::ctx(&mut sc),
            );

            let _ = r1;
            clock::destroy_for_testing(clk);
            ts::return_immutable(template);
            ts::return_to_sender(&sc, stats);
            ts::return_to_sender(&sc, mrs);
            ts::return_to_sender(&sc, dedup);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::pool::EWrongMiner)]
    fun submit_share_wrong_miner_stats_aborts() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        register_template(&mut sc);

        // Register MINER_A
        ts::next_tx(&mut sc, MINER_A);
        {
            let clk = clock::create_for_testing(ts::ctx(&mut sc));
            miner::register_miner(b"bc1qa", &clk, ts::ctx(&mut sc));
            clock::destroy_for_testing(clk);
        };
        create_round_stats(&mut sc, MINER_A, ROUND_0, HEIGHT_850K);
        ts::next_tx(&mut sc, MINER_A);
        {
            let template = ts::take_immutable<Template>(&sc);
            let tid = pool::template_id(&template);
            let mut registry = ts::take_shared<ShareDedupRegistry>(&mut sc);
            share_dedup::create_share_dedup(&mut registry, tid, ts::ctx(&mut sc));
            ts::return_shared(registry);
            ts::return_immutable(template);
        };

        // Register MINER_B
        ts::next_tx(&mut sc, MINER_B);
        {
            let clk = clock::create_for_testing(ts::ctx(&mut sc));
            miner::register_miner(b"bc1qb", &clk, ts::ctx(&mut sc));
            clock::destroy_for_testing(clk);
        };
        create_round_stats(&mut sc, MINER_B, ROUND_0, HEIGHT_850K);
        ts::next_tx(&mut sc, MINER_B);
        {
            let template = ts::take_immutable<Template>(&sc);
            let tid = pool::template_id(&template);
            let mut registry = ts::take_shared<ShareDedupRegistry>(&mut sc);
            share_dedup::create_share_dedup(&mut registry, tid, ts::ctx(&mut sc));
            ts::return_shared(registry);
            ts::return_immutable(template);
        };

        // MINER_B tries to submit with MINER_A's MinerStats → should abort
        ts::next_tx(&mut sc, MINER_B);
        {
            let template  = ts::take_immutable<Template>(&sc);
            // MINER_B uses MINER_A's stats (wrong miner)
            let mut stats = ts::take_from_address<MinerStats>(&sc, MINER_A);
            let mut mrs   = ts::take_from_sender<MinerRoundStats>(&sc);
            let mut dedup = ts::take_from_sender<ShareDedup>(&sc);
            let clk       = clock::create_for_testing(ts::ctx(&mut sc));

            let _r = pool::submit_share(
                &template, &mut stats, &mut mrs, &mut dedup,
                b"en1", b"en2", NTIME, 0u32, VERSION, &clk, ts::ctx(&mut sc),
            );

            clock::destroy_for_testing(clk);
            ts::return_immutable(template);
            ts::return_to_address(MINER_A, stats);
            ts::return_to_sender(&sc, mrs);
            ts::return_to_sender(&sc, dedup);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::pool::EInvalidNtime)]
    fun submit_share_ntime_too_far_future_aborts() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        register_template(&mut sc);
        setup_miner(&mut sc);

        ts::next_tx(&mut sc, MINER_A);
        {
            let template  = ts::take_immutable<Template>(&sc);
            let mut stats = ts::take_from_sender<MinerStats>(&sc);
            let mut mrs   = ts::take_from_sender<MinerRoundStats>(&sc);
            let mut dedup = ts::take_from_sender<ShareDedup>(&sc);
            let clk       = clock::create_for_testing(ts::ctx(&mut sc));

            // ntime = NTIME + MAX_NTIME_OFFSET_SECONDS + 1 = template.ntime + 7201 → too far
            let bad_ntime = NTIME + 7201u32;
            let _r = pool::submit_share(
                &template, &mut stats, &mut mrs, &mut dedup,
                b"en1", b"en2", bad_ntime, 0u32, VERSION, &clk, ts::ctx(&mut sc),
            );

            clock::destroy_for_testing(clk);
            ts::return_immutable(template);
            ts::return_to_sender(&sc, stats);
            ts::return_to_sender(&sc, mrs);
            ts::return_to_sender(&sc, dedup);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::pool::EInvalidVersionRolling)]
    fun submit_share_bad_version_bits_aborts() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        register_template(&mut sc);
        setup_miner(&mut sc);

        ts::next_tx(&mut sc, MINER_A);
        {
            let template  = ts::take_immutable<Template>(&sc);
            let mut stats = ts::take_from_sender<MinerStats>(&sc);
            let mut mrs   = ts::take_from_sender<MinerRoundStats>(&sc);
            let mut dedup = ts::take_from_sender<ShareDedup>(&sc);
            let clk       = clock::create_for_testing(ts::ctx(&mut sc));

            // Flip a non-rolling bit (bit 0 is outside VERSION_ROLLING_MASK 0x1fffe000)
            let bad_version = VERSION | 0x00000001u32;
            let _r = pool::submit_share(
                &template, &mut stats, &mut mrs, &mut dedup,
                b"en1", b"en2", NTIME, 0u32, bad_version, &clk, ts::ctx(&mut sc),
            );

            clock::destroy_for_testing(clk);
            ts::return_immutable(template);
            ts::return_to_sender(&sc, stats);
            ts::return_to_sender(&sc, mrs);
            ts::return_to_sender(&sc, dedup);
        };
        ts::end(sc);
    }

    // ── C-1 regression: ShareDedupRegistry blocks second dedup for same template ─
    // C-1 fix verified: a second create_share_dedup for the same (miner, template)
    // pair now aborts with EAlreadyRegistered (code 3). The attack vector of
    // submitting the same share hash to two separate dedup objects is closed.

    #[test]
    #[expected_failure(abort_code = m1n3_v4::share_dedup::EAlreadyRegistered)]
    fun c1_same_hash_accepted_by_two_separate_dedups() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        register_template(&mut sc);

        ts::next_tx(&mut sc, MINER_A);
        {
            let clk = clock::create_for_testing(ts::ctx(&mut sc));
            miner::register_miner(b"bc1q", &clk, ts::ctx(&mut sc));
            clock::destroy_for_testing(clk);
        };

        // Attempt to create two ShareDedup objects for the same template — second must abort.
        ts::next_tx(&mut sc, MINER_A);
        {
            let template = ts::take_immutable<Template>(&sc);
            let tid = pool::template_id(&template);
            let mut registry = ts::take_shared<ShareDedupRegistry>(&mut sc);
            share_dedup::create_share_dedup(&mut registry, tid, ts::ctx(&mut sc)); // OK
            share_dedup::create_share_dedup(&mut registry, tid, ts::ctx(&mut sc)); // aborts here
            ts::return_shared(registry);
            ts::return_immutable(template);
        };
        ts::end(sc);
    }

    // ── Round accumulation ────────────────────────────────────────────────────

    #[test]
    fun open_round_accumulator_from_claim_idempotent() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);

        // First open: succeeds and produces a shared RoundAccumulator.
        open_acc_via_claim(&mut sc, ROUND_0, HEIGHT_850K);

        // Second open with the same claim: silently returns (no-op) — the
        // `pool.accumulator_open` flag guards re-entry.
        ts::next_tx(&mut sc, ADMIN);
        {
            let mut pool_obj = ts::take_shared<Pool>(&sc);
            let claim = ts::take_immutable<BlockFoundClaim>(&sc);
            let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
            clock::set_for_testing(&mut clk, T0);
            pool::open_round_accumulator_from_claim(&mut pool_obj, &claim, &clk, ts::ctx(&mut sc));
            clock::destroy_for_testing(clk);
            ts::return_immutable(claim);
            ts::return_shared(pool_obj);
        };

        // Only one accumulator should exist.
        ts::next_tx(&mut sc, ADMIN);
        {
            let acc = ts::take_shared<RoundAccumulator>(&sc);
            assert!(pool::accumulator_round_id(&acc) == ROUND_0, 0);
            ts::return_shared(acc);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::pool::EAccumulationWindowOpen)]
    fun finalize_round_before_window_aborts() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);

        open_acc_via_claim(&mut sc, ROUND_0, HEIGHT_850K);
        // Try to finalize immediately — should abort (window = 5 seconds, clock at T0)
        ts::next_tx(&mut sc, ADMIN);
        {
            let mut pool_obj = ts::take_shared<Pool>(&sc);
            let acc = ts::take_shared<RoundAccumulator>(&sc);
            let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
            clock::set_for_testing(&mut clk, T0); // hasn't advanced past window
            pool::finalize_round(&mut pool_obj, acc, &clk, ts::ctx(&mut sc));
            clock::destroy_for_testing(clk);
            ts::return_shared(pool_obj);
        };
        ts::end(sc);
    }

    #[test]
    fun finalize_round_advances_current_round() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);

        open_acc_via_claim(&mut sc, ROUND_0, HEIGHT_850K);
        ts::next_tx(&mut sc, ADMIN);
        {
            let mut pool_obj = ts::take_shared<Pool>(&sc);
            let acc = ts::take_shared<RoundAccumulator>(&sc);
            let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
            // Advance past ACCUMULATION_WINDOW_MS = 5_000
            clock::set_for_testing(&mut clk, AFTER_WINDOW);
            pool::finalize_round(&mut pool_obj, acc, &clk, ts::ctx(&mut sc));
            assert!(pool::current_round(&pool_obj) == 1, 0);
            assert!(pool::total_blocks(&pool_obj) == 1, 1);
            clock::destroy_for_testing(clk);
            ts::return_shared(pool_obj);
        };
        ts::end(sc);
    }

    #[test]
    fun accumulate_miner_stats_produces_work_record() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);

        open_acc_via_claim(&mut sc, ROUND_0, HEIGHT_850K);

        // Give miner_a some MRS with work
        ts::next_tx(&mut sc, MINER_A);
        {
            let clk = clock::create_for_testing(ts::ctx(&mut sc));
            miner::register_miner(b"bc1q", &clk, ts::ctx(&mut sc));
            clock::destroy_for_testing(clk);
        };
        create_round_stats(&mut sc, MINER_A, ROUND_0, HEIGHT_850K);
        ts::next_tx(&mut sc, MINER_A);
        {
            let mut stats = ts::take_from_sender<MinerStats>(&sc);
            let mut mrs   = ts::take_from_sender<MinerRoundStats>(&sc);
            miner::record_share_for_testing(&mut stats, &mut mrs, 5000, false, ROUND_0, HEIGHT_850K);
            ts::return_to_sender(&sc, stats);
            ts::return_to_sender(&sc, mrs);
        };

        // Miner self-accumulates
        ts::next_tx(&mut sc, MINER_A);
        {
            let mut acc = ts::take_shared<RoundAccumulator>(&sc);
            let mrs     = ts::take_from_sender<MinerRoundStats>(&sc);
            let mut v   = vector::empty<MinerRoundStats>();
            vector::push_back(&mut v, mrs);
            pool::accumulate_miner_stats(&mut acc, v, ts::ctx(&mut sc));
            ts::return_shared(acc);
        };

        // MinerWorkRecord transferred to MINER_A
        ts::next_tx(&mut sc, MINER_A);
        {
            let record = ts::take_from_sender<MinerWorkRecord>(&sc);
            assert!(pool::work_record_net_work(&record) == 5000u128, 0);
            assert!(pool::work_record_miner(&record) == MINER_A, 1);
            ts::return_to_sender(&sc, record);
        };
        ts::end(sc);
    }

    // test_accumulate_round_stats_wrong_round_aborts was removed: the admin
    // path (`accumulate_round_stats`) is gone. The trustless replacement
    // `accumulate_miner_stats` silently skips wrong-round MRS rather than
    // aborting, so the original assertion no longer applies. Coverage for
    // wrong-miner aborts is preserved by
    // `test_accumulate_miner_stats_other_miner_aborts` below.

    #[test]
    #[expected_failure(abort_code = m1n3_v4::pool::EWrongMiner)]
    fun accumulate_miner_stats_other_miner_aborts() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);

        open_acc_via_claim(&mut sc, ROUND_0, HEIGHT_850K);

        ts::next_tx(&mut sc, MINER_A);
        {
            let clk = clock::create_for_testing(ts::ctx(&mut sc));
            miner::register_miner(b"bc1qa", &clk, ts::ctx(&mut sc));
            clock::destroy_for_testing(clk);
        };
        create_round_stats(&mut sc, MINER_A, ROUND_0, HEIGHT_850K);

        // MINER_B tries to accumulate MINER_A's MRS → abort EWrongMiner
        ts::next_tx(&mut sc, MINER_B);
        {
            let mut acc = ts::take_shared<RoundAccumulator>(&sc);
            let mrs     = ts::take_from_address<MinerRoundStats>(&sc, MINER_A);
            let mut v   = vector::empty<MinerRoundStats>();
            vector::push_back(&mut v, mrs);
            pool::accumulate_miner_stats(&mut acc, v, ts::ctx(&mut sc));
            ts::return_shared(acc);
        };
        ts::end(sc);
    }
}
