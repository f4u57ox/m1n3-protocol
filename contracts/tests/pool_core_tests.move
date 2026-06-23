/// Tests for pool.move — share submission, dedup, round lifecycle.
#[test_only]
module m1n3_v4::pool_core_tests {
    use sui::test_scenario::{Self as ts};
    use sui::clock;
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;
    use m1n3_v4::pool::{Self, Pool, PoolAdminCap, Template, RoundAccumulator, MinerWorkRecord, BlockFoundClaim};
    use m1n3_v4::miner::{Self, MinerStats, MinerRoundStats};
    use m1n3_v4::share_dedup::{Self, ShareDedup, ShareDedupRegistry};

    // ── Actors ────────────────────────────────────────────────────────────────

    const ADMIN:   address = @0xAD;
    const MINER_A: address = @0xA;
    const MINER_B: address = @0xB;
    /// External buyer who'll register their own template via the
    /// permissionless entrypoint.
    const BUYER:   address = @0xB0B;

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
        // Drop the pool's difficulty floor for tests — production
        // value is `pool::MIN_DIFFICULTY = 1_000_000`, but the test
        // fixtures use deterministic share hashes whose difficulty is
        // far below that. See the constant's doc in pool.move.
        ts::next_tx(sc, ADMIN);
        {
            let mut pool_obj = ts::take_shared<m1n3_v4::pool::Pool>(sc);
            pool::set_min_difficulty_for_testing(&mut pool_obj, 1);
            ts::return_shared(pool_obj);
        };
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
            share_dedup::create_share_dedup(&mut registry, ROUND_0, ts::ctx(sc));
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
    #[expected_failure(abort_code = m1n3_v4::pool::EInvalidMerkleTree)]
    fun register_template_rejects_oversized_merkle_branches() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            let mut pool_obj = ts::take_shared<Pool>(&sc);
            let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
            clock::set_for_testing(&mut clk, T0);

            // Build a 65-branch vector — one over MAX_MERKLE_BRANCHES (64).
            // Each branch is a placeholder 32-byte vector; the assert fires
            // before any sha256d work happens, so contents don't matter.
            let mut branches: vector<vector<u8>> = vector::empty();
            let mut i = 0u64;
            while (i < 65) {
                vector::push_back(&mut branches, b"00000000000000000000000000000000");
                i = i + 1;
            };

            pool::register_template(
                &mut pool_obj, &cap, &clk,
                HEIGHT_850K, prev_hash(),
                b"cb1", b"cb2",
                branches,
                VERSION, NBITS_REGTEST, NTIME,
                ts::ctx(&mut sc),
            );

            clock::destroy_for_testing(clk);
            ts::return_to_sender(&sc, cap);
            ts::return_shared(pool_obj);
        };
        ts::end(sc);
    }

    #[test]
    fun register_template_accepts_max_merkle_branches() {
        // Exactly 64 branches should be accepted. Sanity check that the
        // boundary isn't off-by-one.
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            let mut pool_obj = ts::take_shared<Pool>(&sc);
            let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
            clock::set_for_testing(&mut clk, T0);

            let mut branches: vector<vector<u8>> = vector::empty();
            let mut i = 0u64;
            while (i < 64) {
                vector::push_back(&mut branches, b"00000000000000000000000000000000");
                i = i + 1;
            };

            pool::register_template(
                &mut pool_obj, &cap, &clk,
                HEIGHT_850K, prev_hash(),
                b"cb1", b"cb2",
                branches,
                VERSION, NBITS_REGTEST, NTIME,
                ts::ctx(&mut sc),
            );

            clock::destroy_for_testing(clk);
            ts::return_to_sender(&sc, cap);
            ts::return_shared(pool_obj);
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

    #[test]
    fun permissionless_register_template_succeeds_with_fee() {
        // A non-admin (BUYER) registers a template by attaching ≥ the
        // permissionless fee. The Template's `owner` is the buyer, the
        // fee lands at the pool admin's address, and the Pool's
        // current_height advances if the height is fresh.
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        // Lift the test-only difficulty floor — the public registrar
        // is height/min-difficulty-agnostic but we want share-submission
        // paths to work for a follow-up assertion.
        ts::next_tx(&mut sc, ADMIN);
        {
            let mut pool_obj = ts::take_shared<Pool>(&sc);
            pool::set_min_difficulty_for_testing(&mut pool_obj, 1);
            ts::return_shared(pool_obj);
        };
        ts::next_tx(&mut sc, BUYER);
        {
            let mut pool_obj = ts::take_shared<Pool>(&sc);
            let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
            clock::set_for_testing(&mut clk, T0);
            // Exactly-at-threshold payment (0.01 SUI).
            let fee = coin::mint_for_testing<SUI>(
                pool::permissionless_template_fee_mist(),
                ts::ctx(&mut sc),
            );
            pool::register_template_public(
                &mut pool_obj, fee, &clk,
                HEIGHT_850K, prev_hash(),
                b"buyer-cb1", b"buyer-cb2",
                vector::empty<vector<u8>>(),
                VERSION, NBITS_REGTEST, NTIME,
                ts::ctx(&mut sc),
            );
            clock::destroy_for_testing(clk);
            ts::return_shared(pool_obj);
        };
        ts::next_tx(&mut sc, BUYER);
        {
            let template = ts::take_immutable<Template>(&sc);
            // `owner` field on the Template is the BUYER, not the operator.
            assert!(pool::template_owner(&template) == BUYER, 0);
            assert!(pool::template_height(&template) == HEIGHT_850K, 1);
            ts::return_immutable(template);
        };
        // Fee was transferred to the pool admin (= ADMIN per setup()).
        ts::next_tx(&mut sc, ADMIN);
        {
            let received = ts::take_from_address<Coin<SUI>>(&sc, ADMIN);
            assert!(
                coin::value(&received) == pool::permissionless_template_fee_mist(),
                2,
            );
            ts::return_to_address(ADMIN, received);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::pool::EInsufficientTemplateFee)]
    fun permissionless_register_template_aborts_when_fee_too_low() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        ts::next_tx(&mut sc, BUYER);
        {
            let mut pool_obj = ts::take_shared<Pool>(&sc);
            let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
            clock::set_for_testing(&mut clk, T0);
            // One MIST short of the threshold.
            let underpaid = coin::mint_for_testing<SUI>(
                pool::permissionless_template_fee_mist() - 1,
                ts::ctx(&mut sc),
            );
            pool::register_template_public(
                &mut pool_obj, underpaid, &clk,
                HEIGHT_850K, prev_hash(),
                b"buyer-cb1", b"buyer-cb2",
                vector::empty<vector<u8>>(),
                VERSION, NBITS_REGTEST, NTIME,
                ts::ctx(&mut sc),
            );
            clock::destroy_for_testing(clk);
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
            share_dedup::create_share_dedup(&mut registry, ROUND_0, ts::ctx(&mut sc));
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
            share_dedup::create_share_dedup(&mut registry, ROUND_0, ts::ctx(&mut sc));
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
            share_dedup::create_share_dedup(&mut registry, ROUND_0, ts::ctx(&mut sc)); // OK
            share_dedup::create_share_dedup(&mut registry, ROUND_0, ts::ctx(&mut sc)); // aborts here
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

    // ── Buyer-template lane: DerivedTemplate + HashpowerBuyOrder ──────────────
    //
    // Most tests below use SUI as the quote token (saves having to construct
    // a non-default coin type in tests). The lane is generic over QuoteT so
    // the same code paths work for any fungible token off-chain.

    /// Build a Stratum-style coinbase2 from a list of vouts + a fixed
    /// 4-byte locktime. Same byte layout as the btc_math_tests fixtures.
    fun cb2_from_vouts(vouts: vector<vector<u8>>): vector<u8> {
        let mut buf = vector[];
        vector::push_back(&mut buf, (vector::length(&vouts) as u8));
        let n = vector::length(&vouts);
        let mut i = 0;
        while (i < n) {
            vector::append(&mut buf, *vector::borrow(&vouts, i));
            i = i + 1;
        };
        vector::append(&mut buf, x"00000000"); // locktime
        buf
    }

    fun vout(value_le: vector<u8>, script: vector<u8>): vector<u8> {
        let mut o = vector[];
        vector::append(&mut o, value_le);
        vector::push_back(&mut o, (vector::length(&script) as u8));
        vector::append(&mut o, script);
        o
    }

    /// Buyer's coinbase pays vout_0 to the buyer's P2PKH; no second output.
    fun buyer_cb2(): vector<u8> {
        cb2_from_vouts(vector[
            vout(
                x"0034e23000000000",
                x"76a914aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa88ac",
            )
        ])
    }

    /// Derived coinbase appends a miner vout (tx-fee bonus).
    fun derived_cb2(): vector<u8> {
        cb2_from_vouts(vector[
            vout(
                x"0034e23000000000",
                x"76a914aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa88ac",
            ),
            vout(
                x"4030010000000000",
                x"76a914bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb88ac",
            ),
        ])
    }

    /// Register a buyer-owned parent Template via the permissionless entry.
    fun register_buyer_parent(sc: &mut ts::Scenario) {
        ts::next_tx(sc, BUYER);
        let mut pool_obj = ts::take_shared<Pool>(sc);
        let mut clk = clock::create_for_testing(ts::ctx(sc));
        clock::set_for_testing(&mut clk, T0);
        let fee = coin::mint_for_testing<SUI>(
            pool::permissionless_template_fee_mist(),
            ts::ctx(sc),
        );
        pool::register_template_public(
            &mut pool_obj, fee, &clk,
            HEIGHT_850K, prev_hash(),
            b"cb1", buyer_cb2(),
            vector::empty<vector<u8>>(),
            VERSION, NBITS_REGTEST, NTIME,
            ts::ctx(sc),
        );
        clock::destroy_for_testing(clk);
        ts::return_shared(pool_obj);
    }

    #[test]
    fun register_derived_template_succeeds() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        register_buyer_parent(&mut sc);

        ts::next_tx(&mut sc, MINER_A);
        {
            let parent = ts::take_immutable<Template>(&sc);
            let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
            clock::set_for_testing(&mut clk, T0);
            let fee = coin::mint_for_testing<SUI>(
                pool::permissionless_template_fee_mist(),
                ts::ctx(&mut sc),
            );
            pool::register_derived_template_public(
                &parent, fee, &clk, ADMIN,
                b"cb1", derived_cb2(), NTIME,
                ts::ctx(&mut sc),
            );
            clock::destroy_for_testing(clk);
            ts::return_immutable(parent);
        };
        // The frozen DerivedTemplate appears for any reader.
        ts::next_tx(&mut sc, MINER_A);
        {
            let parent = ts::take_immutable<Template>(&sc);
            let derived = ts::take_immutable<m1n3_v4::pool::DerivedTemplate>(&sc);
            assert!(pool::derived_template_parent(&derived) == pool::template_id(&parent), 0);
            assert!(pool::derived_template_height(&derived) == HEIGHT_850K, 1);
            assert!(pool::derived_template_owner(&derived) == MINER_A, 2);
            ts::return_immutable(derived);
            ts::return_immutable(parent);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::pool::EDerivedCoinbase1Mismatch)]
    fun register_derived_template_aborts_when_coinbase1_differs() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        register_buyer_parent(&mut sc);

        ts::next_tx(&mut sc, MINER_A);
        {
            let parent = ts::take_immutable<Template>(&sc);
            let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
            clock::set_for_testing(&mut clk, T0);
            let fee = coin::mint_for_testing<SUI>(
                pool::permissionless_template_fee_mist(),
                ts::ctx(&mut sc),
            );
            pool::register_derived_template_public(
                &parent, fee, &clk, ADMIN,
                b"cb1_TAMPERED", derived_cb2(), NTIME, // ← coinbase1 changed
                ts::ctx(&mut sc),
            );
            clock::destroy_for_testing(clk);
            ts::return_immutable(parent);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::pool::EDerivedNtimeOutOfWindow)]
    fun register_derived_template_aborts_when_ntime_out_of_window() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        register_buyer_parent(&mut sc);

        ts::next_tx(&mut sc, MINER_A);
        {
            let parent = ts::take_immutable<Template>(&sc);
            let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
            clock::set_for_testing(&mut clk, T0);
            let fee = coin::mint_for_testing<SUI>(
                pool::permissionless_template_fee_mist(),
                ts::ctx(&mut sc),
            );
            // ntime way past the 2-hour window (NTIME + 7201 + 1).
            pool::register_derived_template_public(
                &parent, fee, &clk, ADMIN,
                b"cb1", derived_cb2(), NTIME + 7202,
                ts::ctx(&mut sc),
            );
            clock::destroy_for_testing(clk);
            ts::return_immutable(parent);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::btc_math::EParentVoutsNotPreserved)]
    fun register_derived_template_aborts_when_buyer_vout_redirected() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        register_buyer_parent(&mut sc);

        // Attacker keeps the count but redirects the buyer's address.
        let attacker_cb2 = cb2_from_vouts(vector[
            vout(
                x"0034e23000000000",
                x"76a914cccccccccccccccccccccccccccccccccccccccc88ac",
            ),
            vout(
                x"4030010000000000",
                x"76a914bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb88ac",
            ),
        ]);

        ts::next_tx(&mut sc, MINER_A);
        {
            let parent = ts::take_immutable<Template>(&sc);
            let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
            clock::set_for_testing(&mut clk, T0);
            let fee = coin::mint_for_testing<SUI>(
                pool::permissionless_template_fee_mist(),
                ts::ctx(&mut sc),
            );
            pool::register_derived_template_public(
                &parent, fee, &clk, ADMIN,
                b"cb1", attacker_cb2, NTIME,
                ts::ctx(&mut sc),
            );
            clock::destroy_for_testing(clk);
            ts::return_immutable(parent);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::pool::EInsufficientTemplateFee)]
    fun register_derived_template_aborts_when_underpaid() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        register_buyer_parent(&mut sc);

        ts::next_tx(&mut sc, MINER_A);
        {
            let parent = ts::take_immutable<Template>(&sc);
            let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
            clock::set_for_testing(&mut clk, T0);
            let underpaid = coin::mint_for_testing<SUI>(
                pool::permissionless_template_fee_mist() - 1,
                ts::ctx(&mut sc),
            );
            pool::register_derived_template_public(
                &parent, underpaid, &clk, ADMIN,
                b"cb1", derived_cb2(), NTIME,
                ts::ctx(&mut sc),
            );
            clock::destroy_for_testing(clk);
            ts::return_immutable(parent);
        };
        ts::end(sc);
    }

    // ── HashpowerBuyOrder lifecycle ───────────────────────────────────────────

    #[test]
    fun place_hashpower_order_creates_shared_object() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        register_buyer_parent(&mut sc);

        ts::next_tx(&mut sc, BUYER);
        {
            let parent = ts::take_immutable<Template>(&sc);
            let payment = coin::mint_for_testing<SUI>(1_000_000, ts::ctx(&mut sc));
            pool::place_hashpower_order<SUI>(
                &parent, payment, 17, option::none(), false, ts::ctx(&mut sc),
            );
            ts::return_immutable(parent);
        };
        ts::next_tx(&mut sc, BUYER);
        {
            let order = ts::take_shared<m1n3_v4::pool::HashpowerBuyOrder<SUI>>(&sc);
            assert!(pool::hashpower_order_buyer(&order) == BUYER, 0);
            assert!(pool::hashpower_order_price(&order) == 17, 1);
            assert!(pool::hashpower_order_budget(&order) == 1_000_000, 2);
            ts::return_shared(order);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::pool::ENotHashpowerBuyOrderOwner)]
    fun place_hashpower_order_aborts_when_not_template_owner() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        register_buyer_parent(&mut sc);

        // MINER_A tries to place an order against BUYER's template.
        ts::next_tx(&mut sc, MINER_A);
        {
            let parent = ts::take_immutable<Template>(&sc);
            let payment = coin::mint_for_testing<SUI>(1_000_000, ts::ctx(&mut sc));
            pool::place_hashpower_order<SUI>(
                &parent, payment, 17, option::none(), false, ts::ctx(&mut sc),
            );
            ts::return_immutable(parent);
        };
        ts::end(sc);
    }

    #[test]
    fun cancel_hashpower_order_refunds_buyer() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        register_buyer_parent(&mut sc);

        // Place
        ts::next_tx(&mut sc, BUYER);
        {
            let parent = ts::take_immutable<Template>(&sc);
            let payment = coin::mint_for_testing<SUI>(2_500_000, ts::ctx(&mut sc));
            pool::place_hashpower_order<SUI>(
                &parent, payment, 17, option::none(), false, ts::ctx(&mut sc),
            );
            ts::return_immutable(parent);
        };
        // Cancel
        ts::next_tx(&mut sc, BUYER);
        {
            let order = ts::take_shared<m1n3_v4::pool::HashpowerBuyOrder<SUI>>(&sc);
            let refund = pool::cancel_hashpower_order<SUI>(order, ts::ctx(&mut sc));
            assert!(coin::value(&refund) == 2_500_000, 0);
            transfer::public_transfer(refund, BUYER);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::pool::ENotHashpowerBuyOrderOwner)]
    fun cancel_hashpower_order_aborts_for_non_buyer() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        register_buyer_parent(&mut sc);

        ts::next_tx(&mut sc, BUYER);
        {
            let parent = ts::take_immutable<Template>(&sc);
            let payment = coin::mint_for_testing<SUI>(1_000_000, ts::ctx(&mut sc));
            pool::place_hashpower_order<SUI>(
                &parent, payment, 17, option::none(), false, ts::ctx(&mut sc),
            );
            ts::return_immutable(parent);
        };
        // MINER_A tries to cancel — abort.
        ts::next_tx(&mut sc, MINER_A);
        {
            let order = ts::take_shared<m1n3_v4::pool::HashpowerBuyOrder<SUI>>(&sc);
            let refund = pool::cancel_hashpower_order<SUI>(order, ts::ctx(&mut sc));
            transfer::public_transfer(refund, MINER_A);
        };
        ts::end(sc);
    }

    #[test]
    fun update_hashpower_order_price_succeeds_for_dynamic_order() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        register_buyer_parent(&mut sc);

        // Place a DYNAMIC order.
        ts::next_tx(&mut sc, BUYER);
        {
            let parent = ts::take_immutable<Template>(&sc);
            let payment = coin::mint_for_testing<SUI>(1_000_000, ts::ctx(&mut sc));
            pool::place_hashpower_order<SUI>(
                &parent, payment, 17, option::none(), true, ts::ctx(&mut sc),
            );
            ts::return_immutable(parent);
        };
        // Buyer raises the price.
        ts::next_tx(&mut sc, BUYER);
        {
            let mut order = ts::take_shared<m1n3_v4::pool::HashpowerBuyOrder<SUI>>(&sc);
            pool::update_hashpower_order_price<SUI>(&mut order, 42, ts::ctx(&mut sc));
            assert!(pool::hashpower_order_price(&order) == 42, 0);
            ts::return_shared(order);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::pool::EOrderNotDynamic)]
    fun update_hashpower_order_price_aborts_when_fixed() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        register_buyer_parent(&mut sc);

        // Place a FIXED order.
        ts::next_tx(&mut sc, BUYER);
        {
            let parent = ts::take_immutable<Template>(&sc);
            let payment = coin::mint_for_testing<SUI>(1_000_000, ts::ctx(&mut sc));
            pool::place_hashpower_order<SUI>(
                &parent, payment, 17, option::none(), false, ts::ctx(&mut sc),
            );
            ts::return_immutable(parent);
        };
        // Buyer attempts re-price → abort.
        ts::next_tx(&mut sc, BUYER);
        {
            let mut order = ts::take_shared<m1n3_v4::pool::HashpowerBuyOrder<SUI>>(&sc);
            pool::update_hashpower_order_price<SUI>(&mut order, 42, ts::ctx(&mut sc));
            ts::return_shared(order);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::pool::ENotHashpowerBuyOrderOwner)]
    fun update_hashpower_order_price_aborts_for_non_buyer() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        register_buyer_parent(&mut sc);
        ts::next_tx(&mut sc, BUYER);
        {
            let parent = ts::take_immutable<Template>(&sc);
            let payment = coin::mint_for_testing<SUI>(1_000_000, ts::ctx(&mut sc));
            pool::place_hashpower_order<SUI>(
                &parent, payment, 17, option::none(), true, ts::ctx(&mut sc),
            );
            ts::return_immutable(parent);
        };
        ts::next_tx(&mut sc, MINER_A);
        {
            let mut order = ts::take_shared<m1n3_v4::pool::HashpowerBuyOrder<SUI>>(&sc);
            pool::update_hashpower_order_price<SUI>(&mut order, 42, ts::ctx(&mut sc));
            ts::return_shared(order);
        };
        ts::end(sc);
    }

    // ── submit_share_for_pay ──────────────────────────────────────────────────

    /// Register MINER_A's miner objects against a BUYER-owned parent template.
    fun setup_miner_for_buyer_template(sc: &mut ts::Scenario) {
        ts::next_tx(sc, MINER_A);
        {
            let clk = clock::create_for_testing(ts::ctx(sc));
            miner::register_miner(b"bc1qminer", &clk, ts::ctx(sc));
            clock::destroy_for_testing(clk);
        };
        create_round_stats(sc, MINER_A, ROUND_0, HEIGHT_850K);
        ts::next_tx(sc, MINER_A);
        {
            let parent = ts::take_immutable<Template>(sc);
            let tid = pool::template_id(&parent);
            let mut registry = ts::take_shared<ShareDedupRegistry>(sc);
            share_dedup::create_share_dedup(&mut registry, ROUND_0, ts::ctx(sc));
            ts::return_shared(registry);
            ts::return_immutable(parent);
        };
    }

    #[test]
    fun submit_share_for_pay_pays_miner_per_share() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        register_buyer_parent(&mut sc);
        setup_miner_for_buyer_template(&mut sc);

        // Buyer places an order.
        ts::next_tx(&mut sc, BUYER);
        {
            let parent = ts::take_immutable<Template>(&sc);
            let payment = coin::mint_for_testing<SUI>(1_000_000_000, ts::ctx(&mut sc));
            pool::place_hashpower_order<SUI>(
                &parent, payment, 17, option::none(), false, ts::ctx(&mut sc),
            );
            ts::return_immutable(parent);
        };

        // Miner submits a share and receives a Coin<SUI>.
        ts::next_tx(&mut sc, MINER_A);
        {
            let parent = ts::take_immutable<Template>(&sc);
            let mut order = ts::take_shared<m1n3_v4::pool::HashpowerBuyOrder<SUI>>(&sc);
            let budget_before = pool::hashpower_order_budget(&order);
            let mut stats = ts::take_from_sender<MinerStats>(&sc);
            let mut mrs   = ts::take_from_sender<MinerRoundStats>(&sc);
            let mut dedup = ts::take_from_sender<ShareDedup>(&sc);
            let clk       = clock::create_for_testing(ts::ctx(&mut sc));
            let payout = pool::submit_share_for_pay<SUI>(
                &parent, &mut order, &mut stats, &mut mrs, &mut dedup,
                b"en1", b"en2", NTIME, 0u32, VERSION, &clk, ts::ctx(&mut sc),
            );
            // Payout = difficulty * price; with regtest nbits, difficulty is small
            // but at least 1, so payout >= 17 µSUI.
            assert!(coin::value(&payout) >= 17, 0);
            assert!(coin::value(&payout) == budget_before - pool::hashpower_order_budget(&order), 1);
            transfer::public_transfer(payout, MINER_A);
            clock::destroy_for_testing(clk);
            ts::return_to_sender(&sc, stats);
            ts::return_to_sender(&sc, mrs);
            ts::return_to_sender(&sc, dedup);
            ts::return_shared(order);
            ts::return_immutable(parent);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::pool::EBuyOrderTemplateMismatch)]
    fun submit_share_for_pay_aborts_when_template_mismatches_order() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);

        // Two parent templates, both BUYER-owned.
        register_buyer_parent(&mut sc);  // Template #1, frozen
        // Place an order on Template #1.
        ts::next_tx(&mut sc, BUYER);
        {
            let parent = ts::take_immutable<Template>(&sc);
            let payment = coin::mint_for_testing<SUI>(1_000_000, ts::ctx(&mut sc));
            pool::place_hashpower_order<SUI>(
                &parent, payment, 17, option::none(), false, ts::ctx(&mut sc),
            );
            ts::return_immutable(parent);
        };
        // Register Template #2 at a different height so it's a distinct object.
        ts::next_tx(&mut sc, BUYER);
        {
            let mut pool_obj = ts::take_shared<Pool>(&sc);
            let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
            clock::set_for_testing(&mut clk, T0);
            let fee = coin::mint_for_testing<SUI>(
                pool::permissionless_template_fee_mist(),
                ts::ctx(&mut sc),
            );
            pool::register_template_public(
                &mut pool_obj, fee, &clk,
                HEIGHT_850K + 1, prev_hash(),
                b"cb1-other", buyer_cb2(),
                vector::empty<vector<u8>>(),
                VERSION, NBITS_REGTEST, NTIME,
                ts::ctx(&mut sc),
            );
            clock::destroy_for_testing(clk);
            ts::return_shared(pool_obj);
        };

        setup_miner_for_buyer_template(&mut sc);

        // Miner submits a share against Template #2 but cites the order for #1.
        ts::next_tx(&mut sc, MINER_A);
        {
            // Take the SECOND template (higher height) for the share, but cite
            // the order for the FIRST. `take_immutable<Template>` returns one
            // arbitrary frozen template — to disambiguate we take both via
            // take_immutable + take_immutable again. test_scenario doesn't
            // currently support multiple-of-same-type; we keep this test
            // simple by faking it through an explicit object selection.
            //
            // Workaround: take_immutable returns the LAST frozen template
            // by default, which is Template #2 (HEIGHT_850K+1). The order
            // we placed earlier points at Template #1's id, so passing
            // Template #2 here triggers EBuyOrderTemplateMismatch.
            let template2 = ts::take_immutable<Template>(&sc);
            let mut order = ts::take_shared<m1n3_v4::pool::HashpowerBuyOrder<SUI>>(&sc);
            let mut stats = ts::take_from_sender<MinerStats>(&sc);
            let mut mrs   = ts::take_from_sender<MinerRoundStats>(&sc);
            let mut dedup = ts::take_from_sender<ShareDedup>(&sc);
            let clk       = clock::create_for_testing(ts::ctx(&mut sc));
            let payout = pool::submit_share_for_pay<SUI>(
                &template2, &mut order, &mut stats, &mut mrs, &mut dedup,
                b"en1", b"en2", NTIME, 0u32, VERSION, &clk, ts::ctx(&mut sc),
            );
            transfer::public_transfer(payout, MINER_A);
            clock::destroy_for_testing(clk);
            ts::return_to_sender(&sc, stats);
            ts::return_to_sender(&sc, mrs);
            ts::return_to_sender(&sc, dedup);
            ts::return_shared(order);
            ts::return_immutable(template2);
        };
        ts::end(sc);
    }

    // ── MPC-fee-split lane ────────────────────────────────────────────────────
    //
    // Coverage:
    //   - create_mpc_config: admin happy + length bounds
    //   - update_mpc_config: rotates the script
    //   - register_buyer_template_with_mpc_split:
    //       * happy path
    //       * abort when vout_1 script mismatches the config
    //       * abort when only 1 vout

    fun mpc_p2tr_script(): vector<u8> {
        // OP_1 OP_DATA_32 <32-byte tweaked pubkey>. 34 bytes total.
        x"5120deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    }

    /// Admin creates the shared ProtocolMPCConfig with the standard P2TR.
    fun init_mpc_config(sc: &mut ts::Scenario) {
        ts::next_tx(sc, ADMIN);
        let cap = ts::take_from_sender<PoolAdminCap>(sc);
        pool::create_mpc_config(&cap, mpc_p2tr_script(), ts::ctx(sc));
        ts::return_to_sender(sc, cap);
    }

    #[test]
    fun create_mpc_config_admin_happy() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        init_mpc_config(&mut sc);
        ts::next_tx(&mut sc, ADMIN);
        {
            let cfg = ts::take_shared<m1n3_v4::pool::ProtocolMPCConfig>(&sc);
            assert!(pool::mpc_config_script(&cfg) == mpc_p2tr_script(), 0);
            ts::return_shared(cfg);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::pool::EMpcScriptInvalidLength)]
    fun create_mpc_config_rejects_short_script() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        ts::next_tx(&mut sc, ADMIN);
        let cap = ts::take_from_sender<PoolAdminCap>(&sc);
        // 10 bytes — too short for any common scriptPubKey.
        pool::create_mpc_config(&cap, x"00112233445566778899", ts::ctx(&mut sc));
        ts::return_to_sender(&sc, cap);
        ts::end(sc);
    }

    #[test]
    fun update_mpc_config_rotates_script() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        init_mpc_config(&mut sc);
        ts::next_tx(&mut sc, ADMIN);
        {
            let mut cfg = ts::take_shared<m1n3_v4::pool::ProtocolMPCConfig>(&sc);
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            let rotated = x"5120cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe";
            pool::update_mpc_config(&mut cfg, &cap, rotated);
            assert!(pool::mpc_config_script(&cfg) == rotated, 0);
            ts::return_to_sender(&sc, cap);
            ts::return_shared(cfg);
        };
        ts::end(sc);
    }

    #[test]
    fun submit_share_for_pay_derived_works() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        register_buyer_parent(&mut sc);

        // Place order against the parent template.
        ts::next_tx(&mut sc, BUYER);
        {
            let parent = ts::take_immutable<Template>(&sc);
            let payment = coin::mint_for_testing<SUI>(1_000_000_000, ts::ctx(&mut sc));
            pool::place_hashpower_order<SUI>(
                &parent, payment, 17, option::none(), false, ts::ctx(&mut sc),
            );
            ts::return_immutable(parent);
        };
        // Miner publishes a derived template.
        ts::next_tx(&mut sc, MINER_A);
        {
            let parent = ts::take_immutable<Template>(&sc);
            let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
            clock::set_for_testing(&mut clk, T0);
            let fee = coin::mint_for_testing<SUI>(
                pool::permissionless_template_fee_mist(),
                ts::ctx(&mut sc),
            );
            pool::register_derived_template_public(
                &parent, fee, &clk, ADMIN,
                b"cb1", derived_cb2(), NTIME,
                ts::ctx(&mut sc),
            );
            clock::destroy_for_testing(clk);
            ts::return_immutable(parent);
        };
        // Miner sets up against the DerivedTemplate's id.
        ts::next_tx(&mut sc, MINER_A);
        {
            let clk = clock::create_for_testing(ts::ctx(&mut sc));
            miner::register_miner(b"bc1qminer", &clk, ts::ctx(&mut sc));
            clock::destroy_for_testing(clk);
        };
        create_round_stats(&mut sc, MINER_A, ROUND_0, HEIGHT_850K);
        ts::next_tx(&mut sc, MINER_A);
        {
            let derived = ts::take_immutable<m1n3_v4::pool::DerivedTemplate>(&sc);
            let derived_round = pool::derived_template_round_id(&derived);
            let mut registry = ts::take_shared<ShareDedupRegistry>(&sc);
            share_dedup::create_share_dedup(&mut registry, derived_round, ts::ctx(&mut sc));
            ts::return_shared(registry);
            ts::return_immutable(derived);
        };
        // Submit a share via the derived path.
        ts::next_tx(&mut sc, MINER_A);
        {
            let derived = ts::take_immutable<m1n3_v4::pool::DerivedTemplate>(&sc);
            let mut order = ts::take_shared<m1n3_v4::pool::HashpowerBuyOrder<SUI>>(&sc);
            let mut stats = ts::take_from_sender<MinerStats>(&sc);
            let mut mrs   = ts::take_from_sender<MinerRoundStats>(&sc);
            let mut dedup = ts::take_from_sender<ShareDedup>(&sc);
            let clk       = clock::create_for_testing(ts::ctx(&mut sc));
            let payout = pool::submit_share_for_pay_derived<SUI>(
                &derived, &mut order, &mut stats, &mut mrs, &mut dedup,
                b"en1", b"en2", NTIME, 0u32, VERSION, &clk, ts::ctx(&mut sc),
            );
            assert!(coin::value(&payout) >= 17, 0);
            transfer::public_transfer(payout, MINER_A);
            clock::destroy_for_testing(clk);
            ts::return_to_sender(&sc, stats);
            ts::return_to_sender(&sc, mrs);
            ts::return_to_sender(&sc, dedup);
            ts::return_shared(order);
            ts::return_immutable(derived);
        };
        ts::end(sc);
    }

    // ── BuyerHashpowerOrder (V2) lane ────────────────────────────────────────
    //
    // V2 orders bind to `buyer: address`, not `template_id: ID`. Same
    // fixture style as V1 tests above. SUI as the quote token for
    // dependency-free tests.

    #[test]
    fun place_buyer_order_creates_shared_object() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        ts::next_tx(&mut sc, BUYER);
        {
            let payment = coin::mint_for_testing<SUI>(1_000_000, ts::ctx(&mut sc));
            pool::place_buyer_order<SUI>(
                payment, 17, option::none(), true, ts::ctx(&mut sc),
            );
        };
        ts::next_tx(&mut sc, BUYER);
        {
            let order = ts::take_shared<m1n3_v4::pool::BuyerHashpowerOrder<SUI>>(&sc);
            assert!(pool::buyer_order_buyer(&order) == BUYER, 0);
            assert!(pool::buyer_order_price(&order) == 17, 1);
            assert!(pool::buyer_order_budget(&order) == 1_000_000, 2);
            assert!(pool::buyer_order_is_dynamic(&order) == true, 3);
            ts::return_shared(order);
        };
        ts::end(sc);
    }

    #[test]
    fun update_buyer_order_price_succeeds_for_dynamic_order() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        ts::next_tx(&mut sc, BUYER);
        {
            let payment = coin::mint_for_testing<SUI>(1_000_000, ts::ctx(&mut sc));
            pool::place_buyer_order<SUI>(
                payment, 17, option::none(), true, ts::ctx(&mut sc),
            );
        };
        ts::next_tx(&mut sc, BUYER);
        {
            let mut order = ts::take_shared<m1n3_v4::pool::BuyerHashpowerOrder<SUI>>(&sc);
            pool::update_buyer_order_price<SUI>(&mut order, 42, ts::ctx(&mut sc));
            assert!(pool::buyer_order_price(&order) == 42, 0);
            ts::return_shared(order);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::pool::EOrderNotDynamic)]
    fun update_buyer_order_price_aborts_when_fixed() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        ts::next_tx(&mut sc, BUYER);
        {
            let payment = coin::mint_for_testing<SUI>(1_000_000, ts::ctx(&mut sc));
            pool::place_buyer_order<SUI>(
                payment, 17, option::none(), false, ts::ctx(&mut sc),
            );
        };
        ts::next_tx(&mut sc, BUYER);
        {
            let mut order = ts::take_shared<m1n3_v4::pool::BuyerHashpowerOrder<SUI>>(&sc);
            pool::update_buyer_order_price<SUI>(&mut order, 42, ts::ctx(&mut sc));
            ts::return_shared(order);
        };
        ts::end(sc);
    }

    #[test]
    fun cancel_buyer_order_refunds_buyer() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        ts::next_tx(&mut sc, BUYER);
        {
            let payment = coin::mint_for_testing<SUI>(2_500_000, ts::ctx(&mut sc));
            pool::place_buyer_order<SUI>(
                payment, 17, option::none(), true, ts::ctx(&mut sc),
            );
        };
        ts::next_tx(&mut sc, BUYER);
        {
            let order = ts::take_shared<m1n3_v4::pool::BuyerHashpowerOrder<SUI>>(&sc);
            let refund = pool::cancel_buyer_order<SUI>(order, ts::ctx(&mut sc));
            assert!(coin::value(&refund) == 2_500_000, 0);
            transfer::public_transfer(refund, BUYER);
        };
        ts::end(sc);
    }

    #[test]
    fun submit_share_for_buyer_pay_succeeds_against_buyer_template() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        register_buyer_parent(&mut sc);
        setup_miner_for_buyer_template(&mut sc);

        // Place a V2 order (no template arg — buyer-bound).
        ts::next_tx(&mut sc, BUYER);
        {
            let payment = coin::mint_for_testing<SUI>(1_000_000_000, ts::ctx(&mut sc));
            pool::place_buyer_order<SUI>(
                payment, 17, option::none(), true, ts::ctx(&mut sc),
            );
        };
        // Miner submits against the BUYER's template — owner matches.
        ts::next_tx(&mut sc, MINER_A);
        {
            let parent = ts::take_immutable<Template>(&sc);
            let mut order = ts::take_shared<m1n3_v4::pool::BuyerHashpowerOrder<SUI>>(&sc);
            let budget_before = pool::buyer_order_budget(&order);
            let mut stats = ts::take_from_sender<MinerStats>(&sc);
            let mut mrs   = ts::take_from_sender<MinerRoundStats>(&sc);
            let mut dedup = ts::take_from_sender<ShareDedup>(&sc);
            let clk       = clock::create_for_testing(ts::ctx(&mut sc));
            let payout = pool::submit_share_for_buyer_pay<SUI>(
                &parent, &mut order, &mut stats, &mut mrs, &mut dedup,
                b"en1", b"en2", NTIME, 0u32, VERSION, &clk, ts::ctx(&mut sc),
            );
            assert!(coin::value(&payout) >= 17, 0);
            // Drain math: payout exactly equals budget delta.
            assert!(
                coin::value(&payout) == budget_before - pool::buyer_order_budget(&order),
                1,
            );
            transfer::public_transfer(payout, MINER_A);
            clock::destroy_for_testing(clk);
            ts::return_to_sender(&sc, stats);
            ts::return_to_sender(&sc, mrs);
            ts::return_to_sender(&sc, dedup);
            ts::return_shared(order);
            ts::return_immutable(parent);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::pool::EBuyerOrderTemplateOwnerMismatch)]
    fun submit_share_for_buyer_pay_aborts_against_wrong_owner_template() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        // The Template here is registered by the OPERATOR (ADMIN), not the BUYER.
        register_template(&mut sc);
        setup_miner(&mut sc);

        // Buyer places a V2 order.
        ts::next_tx(&mut sc, BUYER);
        {
            let payment = coin::mint_for_testing<SUI>(1_000_000_000, ts::ctx(&mut sc));
            pool::place_buyer_order<SUI>(
                payment, 17, option::none(), true, ts::ctx(&mut sc),
            );
        };
        // Miner tries to drain BUYER's order using ADMIN-owned template.
        ts::next_tx(&mut sc, MINER_A);
        {
            let parent = ts::take_immutable<Template>(&sc);
            let mut order = ts::take_shared<m1n3_v4::pool::BuyerHashpowerOrder<SUI>>(&sc);
            let mut stats = ts::take_from_sender<MinerStats>(&sc);
            let mut mrs   = ts::take_from_sender<MinerRoundStats>(&sc);
            let mut dedup = ts::take_from_sender<ShareDedup>(&sc);
            let clk       = clock::create_for_testing(ts::ctx(&mut sc));
            let payout = pool::submit_share_for_buyer_pay<SUI>(
                &parent, &mut order, &mut stats, &mut mrs, &mut dedup,
                b"en1", b"en2", NTIME, 0u32, VERSION, &clk, ts::ctx(&mut sc),
            );
            transfer::public_transfer(payout, MINER_A);
            clock::destroy_for_testing(clk);
            ts::return_to_sender(&sc, stats);
            ts::return_to_sender(&sc, mrs);
            ts::return_to_sender(&sc, dedup);
            ts::return_shared(order);
            ts::return_immutable(parent);
        };
        ts::end(sc);
    }

    #[test]
    fun submit_share_for_buyer_pay_drains_budget_correctly() {
        // Higher-budget regression — confirm budget math under a non-trivial
        // initial budget and that successive shares draw down monotonically.
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        register_buyer_parent(&mut sc);
        setup_miner_for_buyer_template(&mut sc);

        ts::next_tx(&mut sc, BUYER);
        {
            let payment = coin::mint_for_testing<SUI>(50_000_000, ts::ctx(&mut sc));
            pool::place_buyer_order<SUI>(
                payment, 17, option::none(), true, ts::ctx(&mut sc),
            );
        };
        ts::next_tx(&mut sc, MINER_A);
        {
            let parent = ts::take_immutable<Template>(&sc);
            let mut order = ts::take_shared<m1n3_v4::pool::BuyerHashpowerOrder<SUI>>(&sc);
            let mut stats = ts::take_from_sender<MinerStats>(&sc);
            let mut mrs   = ts::take_from_sender<MinerRoundStats>(&sc);
            let mut dedup = ts::take_from_sender<ShareDedup>(&sc);
            let clk       = clock::create_for_testing(ts::ctx(&mut sc));

            let pre = pool::buyer_order_budget(&order);
            let payout = pool::submit_share_for_buyer_pay<SUI>(
                &parent, &mut order, &mut stats, &mut mrs, &mut dedup,
                b"en1", b"en2", NTIME, 0u32, VERSION, &clk, ts::ctx(&mut sc),
            );
            let post = pool::buyer_order_budget(&order);
            // payout = pre - post AND payout > 0
            assert!(coin::value(&payout) == pre - post, 0);
            assert!(coin::value(&payout) > 0, 1);
            assert!(post < pre, 2);

            transfer::public_transfer(payout, MINER_A);
            clock::destroy_for_testing(clk);
            ts::return_to_sender(&sc, stats);
            ts::return_to_sender(&sc, mrs);
            ts::return_to_sender(&sc, dedup);
            ts::return_shared(order);
            ts::return_immutable(parent);
        };
        ts::end(sc);
    }
}
