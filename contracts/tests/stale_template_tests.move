/// Tests for the stale-template guard introduced in pool.move + miner.move.
///
/// The guard prevents miners from submitting shares against an old block-height
/// template once a newer template (same round, higher height) has been registered.
///
/// Two enforcement layers are tested:
///   1. MRS anchor  — pool.current_height is captured at create_round_stats time;
///                    any template with height < that value is immediately rejected.
///   2. Ratchet     — each accepted share advances mrs.min_height to template.height;
///                    subsequent shares must meet that new floor.
///
/// Tests 1-3 call miner::record_share directly (fast, precise).
/// Tests 4-7 go through the full pool::submit_share path (integration).
#[test_only]
module m1n3_v4::stale_template_tests {
    use sui::test_scenario::{Self as ts};
    use sui::clock;
    use m1n3_v4::pool::{Self, Pool, PoolAdminCap, Template};
    use m1n3_v4::miner::{Self, MinerStats, MinerRoundStats, MinerRoundRegistry};
    use m1n3_v4::share_dedup::{Self as share_dedup, ShareDedupRegistry};

    // ── Actors ────────────────────────────────────────────────────────────────

    const ADMIN: address = @0xAD;
    const MINER: address = @0xBE;

    // ── Template fixtures ─────────────────────────────────────────────────────

    // nbits where exponent=2 < 3, so target is shifted right to 0 → MAX_DIFFICULTY.
    // This ensures cached_network_difficulty is always MAX so no share ever looks
    // like a real block-find during testing.
    fun nbits_hard(): u32 { 0x02000001u32 }

    fun ver(): u32 { 0x20000000u32 }

    fun zero_hash(): vector<u8> {
        x"0000000000000000000000000000000000000000000000000000000000000000"
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    fun setup(sc: &mut ts::Scenario) {
        ts::next_tx(sc, ADMIN);
        { pool::init_for_testing(ts::ctx(sc)); };
        ts::next_tx(sc, ADMIN);
        { share_dedup::init_for_testing(ts::ctx(sc)); };
        ts::next_tx(sc, ADMIN);
        { miner::init_for_testing(ts::ctx(sc)); };
        ts::next_tx(sc, MINER);
        {
            let clk = clock::create_for_testing(ts::ctx(sc));
            miner::register_miner(b"bc1qtest", &clk, ts::ctx(sc));
            clock::destroy_for_testing(clk);
        };
    }

    /// Wrapper around `miner::create_round_stats` that threads the registry.
    fun create_round_stats_for(sc: &mut ts::Scenario, sender: address, round_id: u64, min_height: u64) {
        ts::next_tx(sc, sender);
        let mut reg = ts::take_shared<MinerRoundRegistry>(sc);
        miner::create_round_stats(&mut reg, round_id, min_height, ts::ctx(sc));
        ts::return_shared(reg);
    }

    /// Initialize the registry inside a test that doesn't go through `setup`
    /// (the layer-1 tests at the top of the file).
    fun init_registry_for(sc: &mut ts::Scenario, sender: address) {
        ts::next_tx(sc, sender);
        miner::init_for_testing(ts::ctx(sc));
    }

    fun register_at(sc: &mut ts::Scenario, height: u64) {
        ts::next_tx(sc, ADMIN);
        {
            let mut pool = ts::take_shared<Pool>(sc);
            let cap       = ts::take_from_sender<PoolAdminCap>(sc);
            let clk       = clock::create_for_testing(ts::ctx(sc));
            pool::register_template(
                &mut pool, &cap, &clk,
                height,
                zero_hash(),
                vector::empty<u8>(),           // coinbase1
                vector::empty<u8>(),           // coinbase2
                vector::empty<vector<u8>>(),   // merkle_branches
                ver(),
                nbits_hard(),
                0u32,                          // ntime
                ts::ctx(sc),
            );
            clock::destroy_for_testing(clk);
            ts::return_shared(pool);
            ts::return_to_sender(sc, cap);
        };
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Layer 1 — direct miner::record_share tests
    // These bypass SHA256d and test the height-guard logic directly.
    // ══════════════════════════════════════════════════════════════════════════

    // The ratchet must advance min_height to the submitted template's height
    // and allow equal-height re-submissions.
    #[test]
    fun test_ratchet_advances_and_allows_equal_height() {
        let mut sc = ts::begin(MINER);
        init_registry_for(&mut sc, MINER);
        ts::next_tx(&mut sc, MINER);
        {
            let clk = clock::create_for_testing(ts::ctx(&mut sc));
            miner::register_miner(b"", &clk, ts::ctx(&mut sc));
            clock::destroy_for_testing(clk);
        };
        create_round_stats_for(&mut sc, MINER, 0, 0);
        ts::next_tx(&mut sc, MINER);
        {
            let mut ms  = ts::take_from_sender<MinerStats>(&sc);
            let mut mrs = ts::take_from_sender<MinerRoundStats>(&sc);

            assert!(miner::mrs_min_height(&mrs) == 0,   0);

            miner::record_share(&mut ms, &mut mrs, 10_000, false, 0, 100);
            assert!(miner::mrs_min_height(&mrs) == 100, 1);

            miner::record_share(&mut ms, &mut mrs, 10_000, false, 0, 200);
            assert!(miner::mrs_min_height(&mrs) == 200, 2);

            // Equal height is allowed — same template, different nonce.
            miner::record_share(&mut ms, &mut mrs, 10_000, false, 0, 200);
            assert!(miner::mrs_min_height(&mrs) == 200, 3);

            ts::return_to_sender(&sc, ms);
            ts::return_to_sender(&sc, mrs);
        };
        ts::end(sc);
    }

    // After submitting at height 200, going back to height 100 must abort.
    #[test]
    #[expected_failure(abort_code = m1n3_v4::miner::EStaleTemplate)]
    fun test_ratchet_blocks_height_regression() {
        let mut sc = ts::begin(MINER);
        init_registry_for(&mut sc, MINER);
        ts::next_tx(&mut sc, MINER);
        {
            let clk = clock::create_for_testing(ts::ctx(&mut sc));
            miner::register_miner(b"", &clk, ts::ctx(&mut sc));
            clock::destroy_for_testing(clk);
        };
        create_round_stats_for(&mut sc, MINER, 0, 0);
        ts::next_tx(&mut sc, MINER);
        {
            let mut ms  = ts::take_from_sender<MinerStats>(&sc);
            let mut mrs = ts::take_from_sender<MinerRoundStats>(&sc);

            miner::record_share(&mut ms, &mut mrs, 10_000, false, 0, 200);
            // Regression: height 100 < min_height 200 → EStaleTemplate
            miner::record_share(&mut ms, &mut mrs, 10_000, false, 0, 100);

            ts::return_to_sender(&sc, ms);
            ts::return_to_sender(&sc, mrs);
        };
        ts::end(sc);
    }

    // An MRS created with min_height=800001 must block a template at height 800000
    // even before any share has been submitted (the anchor fires on first attempt).
    #[test]
    #[expected_failure(abort_code = m1n3_v4::miner::EStaleTemplate)]
    fun test_mrs_anchor_blocks_first_share_at_stale_height() {
        let mut sc = ts::begin(MINER);
        init_registry_for(&mut sc, MINER);
        ts::next_tx(&mut sc, MINER);
        {
            let clk = clock::create_for_testing(ts::ctx(&mut sc));
            miner::register_miner(b"", &clk, ts::ctx(&mut sc));
            clock::destroy_for_testing(clk);
        };
        // Anchor the MRS above the template height we'll try next.
        create_round_stats_for(&mut sc, MINER, 0, 800001);
        ts::next_tx(&mut sc, MINER);
        {
            let mut ms  = ts::take_from_sender<MinerStats>(&sc);
            let mut mrs = ts::take_from_sender<MinerRoundStats>(&sc);

            assert!(miner::mrs_min_height(&mrs) == 800001, 0);
            // First share ever, but height 800000 < min_height 800001 → EStaleTemplate
            miner::record_share(&mut ms, &mut mrs, 10_000, false, 0, 800000);

            ts::return_to_sender(&sc, ms);
            ts::return_to_sender(&sc, mrs);
        };
        ts::end(sc);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Layer 2 — pool.current_height tracking
    // ══════════════════════════════════════════════════════════════════════════

    #[test]
    fun test_pool_height_advances_on_register_template() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);

        register_at(&mut sc, 800000);
        ts::next_tx(&mut sc, ADMIN);
        {
            let pool = ts::take_shared<Pool>(&sc);
            assert!(pool::current_height(&pool) == 800000, 0);
            ts::return_shared(pool);
        };

        register_at(&mut sc, 800001);
        ts::next_tx(&mut sc, ADMIN);
        {
            let pool = ts::take_shared<Pool>(&sc);
            assert!(pool::current_height(&pool) == 800001, 1);
            ts::return_shared(pool);
        };

        ts::end(sc);
    }

    // Registering a lower-height template must not regress pool.current_height.
    #[test]
    fun test_pool_height_does_not_regress() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);

        register_at(&mut sc, 800001);
        register_at(&mut sc, 800000); // stale re-registration attempt

        ts::next_tx(&mut sc, ADMIN);
        {
            let pool = ts::take_shared<Pool>(&sc);
            assert!(pool::current_height(&pool) == 800001, 0);
            ts::return_shared(pool);
        };

        ts::end(sc);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Layer 3 — full pool::submit_share integration
    // ══════════════════════════════════════════════════════════════════════════

    // Happy path: single template, MRS anchored correctly, one share accepted.
    #[test]
    fun test_submit_share_happy_path() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        register_at(&mut sc, 800000);

        // Miner creates MRS + ShareDedup using pool's current values.
        ts::next_tx(&mut sc, MINER);
        let pool = ts::take_shared<Pool>(&sc);
        let r = pool::current_round(&pool);
        let h = pool::current_height(&pool);
        ts::return_shared(pool);
        create_round_stats_for(&mut sc, MINER, r, h);
        ts::next_tx(&mut sc, MINER);
        {
            let template = ts::take_immutable<Template>(&sc);
            let mut registry = ts::take_shared<ShareDedupRegistry>(&mut sc);
            share_dedup::create_share_dedup(&mut registry, pool::template_id(&template), ts::ctx(&mut sc));
            ts::return_shared(registry);
            ts::return_immutable(template);
        };

        ts::next_tx(&mut sc, MINER);
        {
            let template = ts::take_immutable<Template>(&sc);
            let mut ms   = ts::take_from_sender<MinerStats>(&sc);
            let mut mrs  = ts::take_from_sender<MinerRoundStats>(&sc);
            let mut sd   = ts::take_from_sender(&sc);
            let clk      = clock::create_for_testing(ts::ctx(&mut sc));

            let _receipt = pool::submit_share(
                &template, &mut ms, &mut mrs, &mut sd,
                x"aabbccdd",   // extranonce1
                x"11223344",   // extranonce2
                0u32,          // ntime (within ±7200 of template ntime=0)
                7u32,          // nonce
                ver(),
                &clk,
                ts::ctx(&mut sc),
            );

            clock::destroy_for_testing(clk);
            assert!(miner::total_shares(&ms) == 1, 0);
            assert!(miner::mrs_min_height(&mrs) == 800000, 1);

            ts::return_immutable(template);
            ts::return_to_sender(&sc, ms);
            ts::return_to_sender(&sc, mrs);
            ts::return_to_sender(&sc, sd);
        };
        ts::end(sc);
    }

    // If MRS is anchored to height N+1 but the only available template is at height N,
    // submit_share must abort with EStaleTemplate.
    #[test]
    #[expected_failure(abort_code = m1n3_v4::miner::EStaleTemplate)]
    fun test_submit_share_fails_when_mrs_anchor_exceeds_template_height() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        // Only one template, at height 800000.
        register_at(&mut sc, 800000);

        // MRS is deliberately anchored ONE ABOVE the template height —
        // simulating the case where the operator registered a newer template
        // (height 800001) before the miner created their MRS.
        // Anchor above template height.
        create_round_stats_for(&mut sc, MINER, 0, 800001);
        ts::next_tx(&mut sc, MINER);
        {
            let template = ts::take_immutable<Template>(&sc);
            let mut registry = ts::take_shared<ShareDedupRegistry>(&mut sc);
            share_dedup::create_share_dedup(&mut registry, pool::template_id(&template), ts::ctx(&mut sc));
            ts::return_shared(registry);
            ts::return_immutable(template);
        };

        ts::next_tx(&mut sc, MINER);
        {
            let template = ts::take_immutable<Template>(&sc);
            let mut ms   = ts::take_from_sender<MinerStats>(&sc);
            let mut mrs  = ts::take_from_sender<MinerRoundStats>(&sc);
            let mut sd   = ts::take_from_sender(&sc);
            let clk      = clock::create_for_testing(ts::ctx(&mut sc));

            // template.height=800000 < mrs.min_height=800001 → EStaleTemplate
            let _receipt = pool::submit_share(
                &template, &mut ms, &mut mrs, &mut sd,
                x"aabbccdd", x"11223344", 0u32, 7u32, ver(),
                &clk, ts::ctx(&mut sc),
            );

            clock::destroy_for_testing(clk);
            ts::return_immutable(template);
            ts::return_to_sender(&sc, ms);
            ts::return_to_sender(&sc, mrs);
            ts::return_to_sender(&sc, sd);
        };
        ts::end(sc);
    }

    // After submitting one share at height 800001, the ratchet blocks any subsequent
    // submission at height 800000 — verified end-to-end through submit_share.
    #[test]
    #[expected_failure(abort_code = m1n3_v4::miner::EStaleTemplate)]
    fun test_submit_share_ratchet_blocks_old_template_after_new_share() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);

        // Register T_old (height=800000) first, then T_new (height=800001).
        // ShareDedup for T_old is created while only T_old is frozen, so
        // take_immutable<Template> unambiguously returns T_old.
        register_at(&mut sc, 800000);

        ts::next_tx(&mut sc, MINER);
        {
            let t_old = ts::take_immutable<Template>(&sc);
            // Capture T_old's id for the dedup object before T_new is registered.
            let mut registry = ts::take_shared<ShareDedupRegistry>(&mut sc);
            share_dedup::create_share_dedup(&mut registry, pool::template_id(&t_old), ts::ctx(&mut sc));
            ts::return_shared(registry);
            ts::return_immutable(t_old);
        };

        // Now register the newer template.
        register_at(&mut sc, 800001);

        // Create ShareDedup for T_new and the MRS (anchored at pool.current_height=800001).
        ts::next_tx(&mut sc, MINER);
        let pool = ts::take_shared<Pool>(&sc);
        let r2 = pool::current_round(&pool);
        let h2 = pool::current_height(&pool); // = 800001
        ts::return_shared(pool);
        create_round_stats_for(&mut sc, MINER, r2, h2);
        ts::next_tx(&mut sc, MINER);
        {
            // take_immutable returns the most recently frozen object → T_new.
            let t_new = ts::take_immutable<Template>(&sc);
            let mut registry = ts::take_shared<ShareDedupRegistry>(&mut sc);
            share_dedup::create_share_dedup(&mut registry, pool::template_id(&t_new), ts::ctx(&mut sc));
            ts::return_shared(registry);
            ts::return_immutable(t_new);
        };

        // Submit one share to T_new (height=800001) — ratchets min_height to 800001.
        ts::next_tx(&mut sc, MINER);
        {
            let t_new  = ts::take_immutable<Template>(&sc);
            let mut ms = ts::take_from_sender<MinerStats>(&sc);
            let mut mrs = ts::take_from_sender<MinerRoundStats>(&sc);
            // Two ShareDedup objects exist; take_from_sender returns the most recent.
            // The most recently created dedup is for T_new.
            let mut sd_new: m1n3_v4::share_dedup::ShareDedup = ts::take_from_sender(&sc);
            let clk = clock::create_for_testing(ts::ctx(&mut sc));

            let _receipt = pool::submit_share(
                &t_new, &mut ms, &mut mrs, &mut sd_new,
                x"aabbccdd", x"11223344", 0u32, 7u32, ver(),
                &clk, ts::ctx(&mut sc),
            );

            clock::destroy_for_testing(clk);
            assert!(miner::mrs_min_height(&mrs) == 800001, 0);

            ts::return_immutable(t_new);
            ts::return_to_sender(&sc, ms);
            ts::return_to_sender(&sc, mrs);
            ts::return_to_sender(&sc, sd_new);
        };

        // Now try to submit to T_old (height=800000) — must abort with EStaleTemplate.
        ts::next_tx(&mut sc, MINER);
        {
            // T_new is most recent; take twice to reach T_old.
            let t_new = ts::take_immutable<Template>(&sc);
            let t_old = ts::take_immutable<Template>(&sc);
            let mut ms  = ts::take_from_sender<MinerStats>(&sc);
            let mut mrs = ts::take_from_sender<MinerRoundStats>(&sc);
            // sd_old was created first (before T_new was registered), so it's the
            // second take_from_sender for ShareDedup.
            let sd_new_again: m1n3_v4::share_dedup::ShareDedup = ts::take_from_sender(&sc);
            let mut sd_old: m1n3_v4::share_dedup::ShareDedup  = ts::take_from_sender(&sc);
            let clk = clock::create_for_testing(ts::ctx(&mut sc));

            // t_old.height=800000 < mrs.min_height=800001 → EStaleTemplate
            let _receipt = pool::submit_share(
                &t_old, &mut ms, &mut mrs, &mut sd_old,
                x"aabbccdd", x"11223344", 0u32, 99u32, ver(),
                &clk, ts::ctx(&mut sc),
            );

            clock::destroy_for_testing(clk);
            ts::return_immutable(t_new);
            ts::return_immutable(t_old);
            ts::return_to_sender(&sc, ms);
            ts::return_to_sender(&sc, mrs);
            ts::return_to_sender(&sc, sd_new_again);
            ts::return_to_sender(&sc, sd_old);
        };
        ts::end(sc);
    }
}
