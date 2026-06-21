/// Tests for hash_share_registry + hash_share + hash_share_market.
///
/// The flow under test:
///   1. At deploy, hs_000..hs_007 publish and share their TreasuryCaps.
///      register_slot enrolls each cap into the FIFO buffer.
///   2. First miner of round R calls bind_slot_to_round(R) — pops the next
///      slot. Subsequent miners read the binding.
///   3. mint_share<T> consumes a ShareReceipt, bumps mrs.sold_work, mints
///      Coin<T> = difficulty.
///   4. open_redemption<T, CoinType> consumes the round's CONFIRMED
///      BlockDepositRecord, drains the vault by record.amount_sats, freezes
///      the redemption ratio.
///   5. redeem<T, CoinType> burns Coin<T>, returns proportional Coin<CoinType>.
///   6. hash_share_market::{place,fill,cancel}_{buy,sell}_order trades Coin<T>.
#[test_only]
#[allow(unused_const)]
module m1n3_v4::hash_share_tests {
    use sui::clock;
    use sui::coin::{Self, TreasuryCap};
    use sui::sui::SUI;
    use sui::test_scenario::{Self as ts};

    use m1n3_v4::pool::{Self, PoolAdminCap, RoundHistory};
    use m1n3_v4::miner::{Self, MinerStats, MinerRoundStats, MinerRoundRegistry};
    use m1n3_v4::share_dedup::{Self, ShareDedup, ShareDedupRegistry};
    use m1n3_v4::hash_share_registry::{Self, HashShareRegistry};
    use m1n3_v4::hash_share::{Self, Redemption};
    use m1n3_v4::hash_share_market::{Self, BuyOrder, SellOrder, MarketFeePool};
    use m1n3_v4::hashi_vault::{Self, HashiVault};
    use m1n3_v4::hashi_pool::{Self, BlockDepositRecord};
    use m1n3_v4::hs_000::HS_000;
    use m1n3_v4::hs_001::HS_001;

    const ADMIN:   address = @0xAD;
    const MINER_A: address = @0xA;
    const MINER_B: address = @0xB;
    const BUYER:   address = @0xBB;
    const STRANGER: address = @0xFF;

    const ROUND_0:    u64 = 0;
    const ROUND_1:    u64 = 1;
    const HEIGHT_85K: u64 = 850_000;
    const T0:         u64 = 1_000_000;
    const POST_REDEMPTION: u64 = T0 + 30 * 24 * 60 * 60 * 1000 + 1;

    // Real share-submission fixture — regtest difficulty so any nonce qualifies.
    const NBITS_REGTEST: u32 = 0x207fffff;
    const VERSION:       u32 = 0x20000000;
    const NTIME:         u32 = 1234567890;

    fun prev_hash(): vector<u8> {
        x"0000000000000000000000000000000000000000000000000000000000000000"
    }

    // ── Setup helpers ─────────────────────────────────────────────────────────

    fun setup_packages(sc: &mut ts::Scenario) {
        ts::next_tx(sc, ADMIN); { pool::init_for_testing(ts::ctx(sc)); };
        ts::next_tx(sc, ADMIN); { share_dedup::init_for_testing(ts::ctx(sc)); };
        ts::next_tx(sc, ADMIN); { miner::init_for_testing(ts::ctx(sc)); };
        ts::next_tx(sc, ADMIN); { hash_share_registry::init_for_testing(ts::ctx(sc)); };
        ts::next_tx(sc, ADMIN); { hash_share_market::init_for_testing<SUI>(ts::ctx(sc)); };
        // Per-slot coin packages: their `init` doesn't auto-run in the test
        // scenario, so we invoke each `init_for_testing` to materialize the
        // shared TreasuryCap that `register_two_slots` expects.
        ts::next_tx(sc, ADMIN); { m1n3_v4::hs_000::init_for_testing(ts::ctx(sc)); };
        ts::next_tx(sc, ADMIN); { m1n3_v4::hs_001::init_for_testing(ts::ctx(sc)); };
        // Production MIN_DIFFICULTY is 1,000,000 (paired with the
        // 10,000:1 HashShare bundle factor + 1% mint fee so every
        // accepted share mints ≥100 Coins AND the fee never rounds to
        // zero — see the constant's doc in `pool.move`). Tests don't
        // grind for high-diff nonces; lower the pool's floor to 1 in
        // tests so existing test inputs still produce accepted shares.
        ts::next_tx(sc, ADMIN);
        {
            let mut pool_obj = ts::take_shared<m1n3_v4::pool::Pool>(sc);
            pool::set_min_difficulty_for_testing(&mut pool_obj, 1);
            ts::return_shared(pool_obj);
        };
    }

    /// Register slot 0 (HS_000) and slot 1 (HS_001) into the registry.
    /// In a real deployment this happens once at deploy by the script that
    /// publishes the package.
    fun register_two_slots(sc: &mut ts::Scenario) {
        // The hs_000 / hs_001 init functions run at package publish time,
        // sharing their TreasuryCaps. In test_scenario, init runs as part
        // of the test framework's package init, so the caps are shared on
        // the FIRST tx of the scenario. We take_shared them on the next tx.
        ts::next_tx(sc, ADMIN);
        {
            let cap_0 = ts::take_shared<TreasuryCap<HS_000>>(sc);
            let cap_1 = ts::take_shared<TreasuryCap<HS_001>>(sc);
            let mut reg = ts::take_shared<HashShareRegistry>(sc);
            hash_share_registry::register_slot(
                &mut reg, object::id_address(&cap_0), b"HS000",
            );
            hash_share_registry::register_slot(
                &mut reg, object::id_address(&cap_1), b"HS001",
            );
            ts::return_shared(cap_0);
            ts::return_shared(cap_1);
            ts::return_shared(reg);
        };
    }

    fun register_template(sc: &mut ts::Scenario) {
        ts::next_tx(sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(sc);
            let mut pool_obj = ts::take_shared<m1n3_v4::pool::Pool>(sc);
            let mut clk = clock::create_for_testing(ts::ctx(sc));
            clock::set_for_testing(&mut clk, T0);
            pool::register_template(
                &mut pool_obj, &cap, &clk,
                HEIGHT_85K, prev_hash(),
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

    fun setup_miner(sc: &mut ts::Scenario, addr: address) {
        ts::next_tx(sc, addr);
        {
            let clk = clock::create_for_testing(ts::ctx(sc));
            miner::register_miner(b"bc1q", &clk, ts::ctx(sc));
            clock::destroy_for_testing(clk);
        };
        ts::next_tx(sc, addr);
        {
            let mut reg = ts::take_shared<MinerRoundRegistry>(sc);
            miner::create_round_stats(&mut reg, ROUND_0, HEIGHT_85K, ts::ctx(sc));
            ts::return_shared(reg);
        };
        ts::next_tx(sc, addr);
        {
            let template = ts::take_immutable<m1n3_v4::pool::Template>(sc);
            let tid = pool::template_id(&template);
            let mut registry = ts::take_shared<ShareDedupRegistry>(sc);
            share_dedup::create_share_dedup(&mut registry, tid, ts::ctx(sc));
            ts::return_shared(registry);
            ts::return_immutable(template);
        };
    }

    fun create_vault_with(sc: &mut ts::Scenario, seed: u64) {
        ts::next_tx(sc, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(sc);
            hashi_vault::create_shared<SUI>(&cap, ts::ctx(sc));
            ts::return_to_sender(sc, cap);
        };
        if (seed > 0) {
            ts::next_tx(sc, ADMIN);
            {
                let mut vault = ts::take_shared<HashiVault<SUI>>(sc);
                let c = coin::mint_for_testing<SUI>(seed, ts::ctx(sc));
                hashi_vault::deposit_hbtc<SUI>(&mut vault, coin::into_balance(c));
                ts::return_shared(vault);
            };
        };
    }

    fun freeze_round_history(sc: &mut ts::Scenario, round_id: u64, total_work: u128) {
        ts::next_tx(sc, ADMIN);
        pool::create_round_history_for_testing(
            round_id, total_work, 3, MINER_A, HEIGHT_85K, ts::ctx(sc),
        );
    }

    fun share_confirmed_record(sc: &mut ts::Scenario, round_id: u64, amount: u64) {
        ts::next_tx(sc, ADMIN);
        hashi_pool::create_confirmed_record_for_testing(round_id, amount, ts::ctx(sc));
    }

    // ── Registry tests ────────────────────────────────────────────────────────

    #[test]
    fun bind_slot_to_round_first_caller_wins() {
        let mut sc = ts::begin(ADMIN);
        setup_packages(&mut sc);
        register_two_slots(&mut sc);

        ts::next_tx(&mut sc, MINER_A);
        {
            let mut reg = ts::take_shared<HashShareRegistry>(&sc);
            assert!(!hash_share_registry::has_round_binding(&reg, ROUND_0), 0);
            let b = hash_share_registry::bind_slot_to_round(&mut reg, ROUND_0);
            assert!(hash_share_registry::has_round_binding(&reg, ROUND_0), 1);
            assert!(hash_share_registry::binding_label(&b) == b"HS000", 2);
            assert!(hash_share_registry::available_slots(&reg) == 1, 3);
            assert!(hash_share_registry::total_bound(&reg) == 1, 4);
            ts::return_shared(reg);
        };

        // Second call is idempotent: returns the existing binding, no slot pop.
        ts::next_tx(&mut sc, MINER_B);
        {
            let mut reg = ts::take_shared<HashShareRegistry>(&sc);
            let b = hash_share_registry::bind_slot_to_round(&mut reg, ROUND_0);
            assert!(hash_share_registry::binding_label(&b) == b"HS000", 0);
            assert!(hash_share_registry::available_slots(&reg) == 1, 1);
            ts::return_shared(reg);
        };

        // Round 1 binds the next slot (HS_001).
        ts::next_tx(&mut sc, MINER_A);
        {
            let mut reg = ts::take_shared<HashShareRegistry>(&sc);
            let b = hash_share_registry::bind_slot_to_round(&mut reg, ROUND_1);
            assert!(hash_share_registry::binding_label(&b) == b"HS001", 0);
            assert!(hash_share_registry::available_slots(&reg) == 0, 1);
            assert!(hash_share_registry::total_bound(&reg) == 2, 2);
            ts::return_shared(reg);
        };

        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::hash_share_registry::ENoAvailableSlots)]
    fun bind_aborts_when_buffer_empty() {
        let mut sc = ts::begin(ADMIN);
        setup_packages(&mut sc);
        // Skip register_two_slots — buffer is empty.

        ts::next_tx(&mut sc, MINER_A);
        {
            let mut reg = ts::take_shared<HashShareRegistry>(&sc);
            let _ = hash_share_registry::bind_slot_to_round(&mut reg, ROUND_0);
            ts::return_shared(reg);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::hash_share_registry::ESlotAlreadyRegistered)]
    fun register_same_cap_twice_aborts() {
        let mut sc = ts::begin(ADMIN);
        setup_packages(&mut sc);
        ts::next_tx(&mut sc, ADMIN);
        {
            let cap = ts::take_shared<TreasuryCap<HS_000>>(&sc);
            let mut reg = ts::take_shared<HashShareRegistry>(&sc);
            hash_share_registry::register_slot(&mut reg, object::id_address(&cap), b"HS000");
            // Second registration of the same cap_id → aborts.
            hash_share_registry::register_slot(&mut reg, object::id_address(&cap), b"HS000");
            ts::return_shared(cap);
            ts::return_shared(reg);
        };
        ts::end(sc);
    }

    // ── Mint tests ────────────────────────────────────────────────────────────

    #[test]
    fun mint_share_produces_difficulty_units_and_marks_sold_work() {
        let mut sc = ts::begin(ADMIN);
        setup_packages(&mut sc);
        register_two_slots(&mut sc);
        register_template(&mut sc);
        setup_miner(&mut sc, MINER_A);

        // MINER_A's first share of round 0 binds slot 0 (HS_000) then mints.
        ts::next_tx(&mut sc, MINER_A);
        {
            let mut reg = ts::take_shared<HashShareRegistry>(&sc);
            let _ = hash_share_registry::bind_slot_to_round(&mut reg, ROUND_0);
            ts::return_shared(reg);
        };

        ts::next_tx(&mut sc, MINER_A);
        {
            let reg     = ts::take_shared<HashShareRegistry>(&sc);
            let mut cap = ts::take_shared<TreasuryCap<HS_000>>(&sc);
            let template = ts::take_immutable<m1n3_v4::pool::Template>(&sc);
            let mut stats = ts::take_from_sender<MinerStats>(&sc);
            let mut mrs   = ts::take_from_sender<MinerRoundStats>(&sc);
            let mut dedup = ts::take_from_sender<ShareDedup>(&sc);
            let clk = clock::create_for_testing(ts::ctx(&mut sc));

            let receipt = pool::submit_share(
                &template, &mut stats, &mut mrs, &mut dedup,
                b"en1", b"en2", NTIME, 0u32, VERSION, &clk, ts::ctx(&mut sc),
            );

            let difficulty = pool::receipt_difficulty(&receipt);
            let coin = hash_share::mint_share<HS_000>(
                &reg, &mut cap, receipt, &mut mrs, ts::ctx(&mut sc),
            );

            // Mint applies the 10,000:1 bundle factor — see hash_share::BUNDLE_FACTOR.
            // Pool's `sold_work` / `work` accumulators stay in RAW difficulty units,
            // so reward distribution is unaffected by the bundle.
            let bundled = difficulty / hash_share::bundle_factor();
            // 1% fee taken at mint from the bundled amount.
            let fee_units = (bundled * 100) / 10_000;
            assert!(coin::value(&coin) == bundled - fee_units, 0);
            assert!(miner::mrs_sold_work(&mrs) == (difficulty as u128), 1);
            // The share's work was also recorded in mrs.work via record_share,
            // so net_work at accumulate time = work - sold_work = 0.
            assert!(miner::mrs_work(&mrs) == (difficulty as u128), 2);

            transfer::public_transfer(coin, MINER_A);
            clock::destroy_for_testing(clk);
            ts::return_immutable(template);
            ts::return_to_sender(&sc, stats);
            ts::return_to_sender(&sc, mrs);
            ts::return_to_sender(&sc, dedup);
            ts::return_shared(reg);
            ts::return_shared(cap);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::hash_share_registry::EWrongCap)]
    fun mint_with_wrong_cap_aborts() {
        // Round 0 was bound to slot 0 (HS_000); attempting to mint HS_001
        // for round 0 must abort.
        let mut sc = ts::begin(ADMIN);
        setup_packages(&mut sc);
        register_two_slots(&mut sc);
        register_template(&mut sc);
        setup_miner(&mut sc, MINER_A);

        ts::next_tx(&mut sc, MINER_A);
        {
            let mut reg = ts::take_shared<HashShareRegistry>(&sc);
            let _ = hash_share_registry::bind_slot_to_round(&mut reg, ROUND_0);
            ts::return_shared(reg);
        };

        ts::next_tx(&mut sc, MINER_A);
        {
            let reg = ts::take_shared<HashShareRegistry>(&sc);
            let mut wrong_cap = ts::take_shared<TreasuryCap<HS_001>>(&sc);
            let template = ts::take_immutable<m1n3_v4::pool::Template>(&sc);
            let mut stats = ts::take_from_sender<MinerStats>(&sc);
            let mut mrs   = ts::take_from_sender<MinerRoundStats>(&sc);
            let mut dedup = ts::take_from_sender<ShareDedup>(&sc);
            let clk = clock::create_for_testing(ts::ctx(&mut sc));

            let receipt = pool::submit_share(
                &template, &mut stats, &mut mrs, &mut dedup,
                b"en1", b"en2", NTIME, 0u32, VERSION, &clk, ts::ctx(&mut sc),
            );

            let coin = hash_share::mint_share<HS_001>(
                &reg, &mut wrong_cap, receipt, &mut mrs, ts::ctx(&mut sc),
            );
            transfer::public_transfer(coin, MINER_A);
            clock::destroy_for_testing(clk);
            ts::return_immutable(template);
            ts::return_to_sender(&sc, stats);
            ts::return_to_sender(&sc, mrs);
            ts::return_to_sender(&sc, dedup);
            ts::return_shared(reg);
            ts::return_shared(wrong_cap);
        };
        ts::end(sc);
    }

    // ── Redemption end-to-end ────────────────────────────────────────────────

    #[test]
    fun open_redemption_and_redeem_proportionally() {
        // Two miners mint a total of 2 shares of difficulty D each →
        // total HashShare supply = 2D. Round earns 1000 SUI (stand-in for hBTC).
        // Each holder's 1D HashShares should redeem for 500 SUI.
        let mut sc = ts::begin(ADMIN);
        setup_packages(&mut sc);
        register_two_slots(&mut sc);
        register_template(&mut sc);
        setup_miner(&mut sc, MINER_A);
        setup_miner(&mut sc, MINER_B);

        ts::next_tx(&mut sc, MINER_A);
        {
            let mut reg = ts::take_shared<HashShareRegistry>(&sc);
            let _ = hash_share_registry::bind_slot_to_round(&mut reg, ROUND_0);
            ts::return_shared(reg);
        };

        // Synthesize high-difficulty receipts (>= BUNDLE_FACTOR) so the
        // bundled mint produces a non-zero Coin. `pool::submit_share`
        // derives difficulty from the share hash and the test scenario
        // doesn't grind for a high-diff hash; the redemption flow under
        // test is unaffected by which constructor is used.
        let diff_a: u64 = 5_000_000;
        let diff_b: u64 = 3_000_000;
        ts::next_tx(&mut sc, MINER_A);
        {
            let reg = ts::take_shared<HashShareRegistry>(&sc);
            let mut cap = ts::take_shared<TreasuryCap<HS_000>>(&sc);
            let mut mrs = ts::take_from_sender<MinerRoundStats>(&sc);

            let receipt = pool::create_share_receipt_for_testing(
                MINER_A, ADMIN, diff_a, ROUND_0,
            );
            let c = hash_share::mint_share<HS_000>(&reg, &mut cap, receipt, &mut mrs, ts::ctx(&mut sc));
            transfer::public_transfer(c, MINER_A);

            ts::return_to_sender(&sc, mrs);
            ts::return_shared(reg);
            ts::return_shared(cap);
        };
        ts::next_tx(&mut sc, MINER_B);
        {
            let reg = ts::take_shared<HashShareRegistry>(&sc);
            let mut cap = ts::take_shared<TreasuryCap<HS_000>>(&sc);
            let mut mrs = ts::take_from_sender<MinerRoundStats>(&sc);

            let receipt = pool::create_share_receipt_for_testing(
                MINER_B, ADMIN, diff_b, ROUND_0,
            );
            let c = hash_share::mint_share<HS_000>(&reg, &mut cap, receipt, &mut mrs, ts::ctx(&mut sc));
            transfer::public_transfer(c, MINER_B);

            ts::return_to_sender(&sc, mrs);
            ts::return_shared(reg);
            ts::return_shared(cap);
        };

        // Both miners' HashShare holdings are bundled (diff / BUNDLE_FACTOR).
        // The redemption math is proportional, so total supply at
        // redemption-open time is (diff_a + diff_b) / BUNDLE_FACTOR.
        let bundled_a = diff_a / hash_share::bundle_factor();
        let bundled_b = diff_b / hash_share::bundle_factor();
        let total_supply = bundled_a + bundled_b;
        let round_payout = total_supply * 1000; // arbitrary unit price

        // Vault gets `round_payout` SUI; round_history; confirmed record for that amount.
        create_vault_with(&mut sc, round_payout);
        freeze_round_history(&mut sc, ROUND_0, (total_supply as u128));
        share_confirmed_record(&mut sc, ROUND_0, round_payout);

        // Anyone opens the redemption pool.
        ts::next_tx(&mut sc, STRANGER);
        {
            let reg = ts::take_shared<HashShareRegistry>(&sc);
            let cap = ts::take_shared<TreasuryCap<HS_000>>(&sc);
            let mut vault = ts::take_shared<HashiVault<SUI>>(&sc);
            let round_history = ts::take_immutable<RoundHistory>(&sc);
            let mut record = ts::take_shared<BlockDepositRecord>(&sc);
            let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
            clock::set_for_testing(&mut clk, T0);

            hash_share::open_redemption<HS_000, SUI>(
                &reg, &cap, &mut vault, &round_history, &mut record, &clk, ts::ctx(&mut sc),
            );

            clock::destroy_for_testing(clk);
            ts::return_shared(reg);
            ts::return_shared(cap);
            ts::return_shared(vault);
            ts::return_immutable(round_history);
            ts::return_shared(record);
        };

        // After the 1% mint fee on the bundled mint, MINER_A holds
        // (bundled_a - fee_a) HashShares. Total supply at redemption-open
        // time is the full bundled mint (fee_a was transferred to ADMIN,
        // not burned). Per-HashShare payout = round_payout / total_supply
        // = 1000. MINER_A's redemption payout = (bundled_a - fee_a) * 1000.
        let fee_a = (bundled_a * 100) / 10_000;
        let expected_a_payout = (bundled_a - fee_a) * 1000;
        ts::next_tx(&mut sc, MINER_A);
        {
            let mut redemption = ts::take_shared<Redemption<HS_000, SUI>>(&sc);
            let mut cap = ts::take_shared<TreasuryCap<HS_000>>(&sc);
            let burn_coin = ts::take_from_sender<sui::coin::Coin<HS_000>>(&sc);
            let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
            clock::set_for_testing(&mut clk, T0 + 1);

            let payout = hash_share::redeem<HS_000, SUI>(
                &mut redemption, &mut cap, burn_coin, &clk, ts::ctx(&mut sc),
            );
            assert!(coin::value(&payout) == expected_a_payout, 0);
            transfer::public_transfer(payout, MINER_A);

            clock::destroy_for_testing(clk);
            ts::return_shared(redemption);
            ts::return_shared(cap);
        };

        ts::end(sc);
    }

    #[test]
    fun recycle_expired_redemption_returns_residual_to_vault() {
        // Open redemption, leave some balance un-redeemed, advance past
        // deadline, recycle. Residual should land back in the vault.
        let mut sc = ts::begin(ADMIN);
        setup_packages(&mut sc);
        register_two_slots(&mut sc);
        register_template(&mut sc);
        setup_miner(&mut sc, MINER_A);

        ts::next_tx(&mut sc, MINER_A);
        {
            let mut reg = ts::take_shared<HashShareRegistry>(&sc);
            let _ = hash_share_registry::bind_slot_to_round(&mut reg, ROUND_0);
            ts::return_shared(reg);
        };

        // Synthesize a high-difficulty receipt so the bundled mint is
        // non-zero. See the rationale in `open_redemption_and_redeem`.
        let diff_a: u64 = 5_000_000;
        ts::next_tx(&mut sc, MINER_A);
        {
            let reg = ts::take_shared<HashShareRegistry>(&sc);
            let mut cap = ts::take_shared<TreasuryCap<HS_000>>(&sc);
            let mut mrs = ts::take_from_sender<MinerRoundStats>(&sc);

            let receipt = pool::create_share_receipt_for_testing(
                MINER_A, ADMIN, diff_a, ROUND_0,
            );
            let c = hash_share::mint_share<HS_000>(&reg, &mut cap, receipt, &mut mrs, ts::ctx(&mut sc));
            transfer::public_transfer(c, MINER_A);

            ts::return_to_sender(&sc, mrs);
            ts::return_shared(reg);
            ts::return_shared(cap);
        };

        // Supply at redemption-open time is the bundled mint.
        let bundled_a = diff_a / hash_share::bundle_factor();
        let payout = bundled_a * 1000;
        create_vault_with(&mut sc, payout);
        freeze_round_history(&mut sc, ROUND_0, (bundled_a as u128));
        share_confirmed_record(&mut sc, ROUND_0, payout);

        ts::next_tx(&mut sc, STRANGER);
        {
            let reg = ts::take_shared<HashShareRegistry>(&sc);
            let cap = ts::take_shared<TreasuryCap<HS_000>>(&sc);
            let mut vault = ts::take_shared<HashiVault<SUI>>(&sc);
            let round_history = ts::take_immutable<RoundHistory>(&sc);
            let mut record = ts::take_shared<BlockDepositRecord>(&sc);
            let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
            clock::set_for_testing(&mut clk, T0);

            hash_share::open_redemption<HS_000, SUI>(
                &reg, &cap, &mut vault, &round_history, &mut record, &clk, ts::ctx(&mut sc),
            );

            clock::destroy_for_testing(clk);
            ts::return_shared(reg);
            ts::return_shared(cap);
            ts::return_shared(vault);
            ts::return_immutable(round_history);
            ts::return_shared(record);
        };

        // Skip past deadline; nobody redeemed.
        ts::next_tx(&mut sc, STRANGER);
        {
            let mut redemption = ts::take_shared<Redemption<HS_000, SUI>>(&sc);
            let mut vault = ts::take_shared<HashiVault<SUI>>(&sc);
            let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
            clock::set_for_testing(&mut clk, POST_REDEMPTION);

            hash_share::recycle_expired_redemption<HS_000, SUI>(
                &mut redemption, &mut vault, &clk,
            );

            assert!(hash_share::redemption_balance(&redemption) == 0, 0);
            assert!(hash_share::redemption_is_expired(&redemption), 1);
            // Vault should hold the full original payout again.
            assert!(hashi_vault::hbtc_balance(&vault) == payout, 2);

            clock::destroy_for_testing(clk);
            ts::return_shared(redemption);
            ts::return_shared(vault);
        };

        ts::end(sc);
    }

    // ── Market tests ──────────────────────────────────────────────────────────

    #[test]
    fun place_and_fill_buy_order_on_hashshare() {
        // MINER_A mints HS_000, BUYER posts a BuyOrder<HS_000>, MINER_A fills.
        let mut sc = ts::begin(ADMIN);
        setup_packages(&mut sc);
        register_two_slots(&mut sc);
        register_template(&mut sc);
        setup_miner(&mut sc, MINER_A);

        ts::next_tx(&mut sc, MINER_A);
        {
            let mut reg = ts::take_shared<HashShareRegistry>(&sc);
            let _ = hash_share_registry::bind_slot_to_round(&mut reg, ROUND_0);
            ts::return_shared(reg);
        };

        // Synthesize a high-difficulty receipt so the bundled mint is
        // a workable size for the market fill assertions.
        let diff: u64 = 5_000_000;
        ts::next_tx(&mut sc, MINER_A);
        {
            let reg = ts::take_shared<HashShareRegistry>(&sc);
            let mut cap = ts::take_shared<TreasuryCap<HS_000>>(&sc);
            let mut mrs = ts::take_from_sender<MinerRoundStats>(&sc);

            let receipt = pool::create_share_receipt_for_testing(
                MINER_A, ADMIN, diff, ROUND_0,
            );
            let c = hash_share::mint_share<HS_000>(&reg, &mut cap, receipt, &mut mrs, ts::ctx(&mut sc));
            transfer::public_transfer(c, MINER_A);

            ts::return_to_sender(&sc, mrs);
            ts::return_shared(reg);
            ts::return_shared(cap);
        };

        // The mint applies the 10,000:1 bundle factor — MINER_A's HashShare
        // inventory is diff / BUNDLE_FACTOR, not diff.
        let bundled = diff / hash_share::bundle_factor();
        // BUYER places a BuyOrder<HS_000, SUI> at 100 MIST/unit, budget large
        // enough to absorb MINER_A's bundled holdings several times over.
        let budget = bundled * 200;
        let price = 100;
        ts::next_tx(&mut sc, BUYER);
        {
            let payment = coin::mint_for_testing<SUI>(budget, ts::ctx(&mut sc));
            hash_share_market::place_buy_order<HS_000, SUI>(price, 0, payment, ts::ctx(&mut sc));
        };

        // 1% mint fee on the BUNDLED amount.
        let fee_units = (bundled * 100) / 10_000;
        let miner_units = bundled - fee_units;

        // MINER_A fills the BuyOrder with their HashShares.
        ts::next_tx(&mut sc, MINER_A);
        {
            let mut order = ts::take_shared<BuyOrder<HS_000, SUI>>(&sc);
            let fee_pool = ts::take_shared<MarketFeePool<SUI>>(&sc);
            let coin = ts::take_from_sender<sui::coin::Coin<HS_000>>(&sc);

            hash_share_market::fill_buy_order<HS_000, SUI>(
                &mut order, &fee_pool, coin, ts::ctx(&mut sc),
            );

            assert!(hash_share_market::buy_budget(&order) == budget - miner_units * price, 0);
            ts::return_shared(order);
            ts::return_shared(fee_pool);
        };

        // MINER_A nets gross * 0.98 where gross = miner_units * price.
        ts::next_tx(&mut sc, MINER_A);
        {
            let sui_coin = ts::take_from_sender<sui::coin::Coin<SUI>>(&sc);
            let gross = miner_units * price;
            let expected_net = gross - (gross * 200) / 10_000;
            assert!(coin::value(&sui_coin) == expected_net, 0);
            ts::return_to_sender(&sc, sui_coin);
        };

        ts::end(sc);
    }

    #[test]
    fun place_and_fill_sell_order_on_hashshare() {
        // Mirror image: MINER_A posts a SellOrder, BUYER fills.
        let mut sc = ts::begin(ADMIN);
        setup_packages(&mut sc);
        register_two_slots(&mut sc);
        register_template(&mut sc);
        setup_miner(&mut sc, MINER_A);

        ts::next_tx(&mut sc, MINER_A);
        {
            let mut reg = ts::take_shared<HashShareRegistry>(&sc);
            let _ = hash_share_registry::bind_slot_to_round(&mut reg, ROUND_0);
            ts::return_shared(reg);
        };

        // Synthesize a high-difficulty receipt — see the buy-order test
        // for the rationale (test scenarios don't grind for high-diff
        // hashes; we test the market path, not difficulty derivation).
        let diff: u64 = 5_000_000;
        ts::next_tx(&mut sc, MINER_A);
        {
            let reg = ts::take_shared<HashShareRegistry>(&sc);
            let mut cap = ts::take_shared<TreasuryCap<HS_000>>(&sc);
            let mut mrs = ts::take_from_sender<MinerRoundStats>(&sc);

            let receipt = pool::create_share_receipt_for_testing(
                MINER_A, ADMIN, diff, ROUND_0,
            );
            let c = hash_share::mint_share<HS_000>(&reg, &mut cap, receipt, &mut mrs, ts::ctx(&mut sc));
            transfer::public_transfer(c, MINER_A);

            ts::return_to_sender(&sc, mrs);
            ts::return_shared(reg);
            ts::return_shared(cap);
        };

        // MINER_A places a SellOrder<HS_000, SUI> at 100 MIST/unit, all inventory.
        // After 10,000:1 bundle + 1% mint fee, MINER_A has
        // (diff/BUNDLE_FACTOR - fee_units) HashShares.
        let bundled = diff / hash_share::bundle_factor();
        let fee_units = (bundled * 100) / 10_000;
        let miner_units = bundled - fee_units;
        let price = 100;
        ts::next_tx(&mut sc, MINER_A);
        {
            let inventory = ts::take_from_sender<sui::coin::Coin<HS_000>>(&sc);
            hash_share_market::place_sell_order<HS_000, SUI>(price, 0, inventory, ts::ctx(&mut sc));
        };

        // BUYER fills with exact payment for the whole inventory.
        let gross = miner_units * price;
        ts::next_tx(&mut sc, BUYER);
        {
            let mut order = ts::take_shared<SellOrder<HS_000, SUI>>(&sc);
            let fee_pool = ts::take_shared<MarketFeePool<SUI>>(&sc);
            let payment = coin::mint_for_testing<SUI>(gross, ts::ctx(&mut sc));

            hash_share_market::fill_sell_order<HS_000, SUI>(
                &mut order, &fee_pool, payment, miner_units, ts::ctx(&mut sc),
            );

            assert!(hash_share_market::sell_inventory(&order) == 0, 0);
            ts::return_shared(order);
            ts::return_shared(fee_pool);
        };

        // BUYER got the HashShares; MINER_A got the SUI minus fee.
        ts::next_tx(&mut sc, BUYER);
        {
            let received = ts::take_from_sender<sui::coin::Coin<HS_000>>(&sc);
            assert!(coin::value(&received) == miner_units, 0);
            ts::return_to_sender(&sc, received);
        };
        ts::next_tx(&mut sc, MINER_A);
        {
            let sui_received = ts::take_from_sender<sui::coin::Coin<SUI>>(&sc);
            let expected = gross - (gross * 200) / 10_000;
            assert!(coin::value(&sui_received) == expected, 0);
            ts::return_to_sender(&sc, sui_received);
        };

        ts::end(sc);
    }

    // ── Mint fee tests ────────────────────────────────────────────────────────

    #[test]
    fun mint_fee_routes_one_percent_to_recipient() {
        // Default fee_recipient at init is ADMIN. With a 5,000,000-difficulty
        // synthesized receipt, the 10,000:1 bundle factor produces 500 bundled
        // Coins; 1% fee on that = 5; miner keeps 495.
        let mut sc = ts::begin(ADMIN);
        setup_packages(&mut sc);
        register_two_slots(&mut sc);
        register_template(&mut sc);
        setup_miner(&mut sc, MINER_A);

        ts::next_tx(&mut sc, MINER_A);
        {
            let mut reg = ts::take_shared<HashShareRegistry>(&sc);
            let _ = hash_share_registry::bind_slot_to_round(&mut reg, ROUND_0);
            ts::return_shared(reg);
        };

        let diff: u64 = 5_000_000;
        ts::next_tx(&mut sc, MINER_A);
        {
            let reg = ts::take_shared<HashShareRegistry>(&sc);
            let mut cap = ts::take_shared<TreasuryCap<HS_000>>(&sc);
            let mut mrs = ts::take_from_sender<MinerRoundStats>(&sc);

            // Synthesize a high-difficulty ShareReceipt so the 1% floor-div
            // produces a non-zero fee. record_sold_share inside mint_share
            // requires mrs.miner == receipt.miner and mrs.round_id == receipt.round_id.
            let receipt = pool::create_share_receipt_for_testing(
                MINER_A, ADMIN, diff, ROUND_0,
            );
            let coin = hash_share::mint_share<HS_000>(
                &reg, &mut cap, receipt, &mut mrs, ts::ctx(&mut sc),
            );
            transfer::public_transfer(coin, MINER_A);

            ts::return_to_sender(&sc, mrs);
            ts::return_shared(reg);
            ts::return_shared(cap);
        };

        let bundled = diff / hash_share::bundle_factor();
        let fee_units = (bundled * 100) / 10_000;
        assert!(fee_units == 5, 0);

        // ADMIN holds the fee HashShares.
        ts::next_tx(&mut sc, ADMIN);
        {
            let fee_coin = ts::take_from_address<sui::coin::Coin<HS_000>>(&sc, ADMIN);
            assert!(coin::value(&fee_coin) == fee_units, 1);
            ts::return_to_address(ADMIN, fee_coin);
        };

        // MINER_A holds the rest.
        ts::next_tx(&mut sc, MINER_A);
        {
            let miner_coin = ts::take_from_address<sui::coin::Coin<HS_000>>(&sc, MINER_A);
            assert!(coin::value(&miner_coin) == bundled - fee_units, 2);
            ts::return_to_address(MINER_A, miner_coin);
        };

        ts::end(sc);
    }

    #[test]
    fun set_fee_bps_changes_the_split() {
        // Lower the fee to 0 — miner gets the full mint, no fee coin sent.
        let mut sc = ts::begin(ADMIN);
        setup_packages(&mut sc);
        register_two_slots(&mut sc);
        register_template(&mut sc);
        setup_miner(&mut sc, MINER_A);

        ts::next_tx(&mut sc, ADMIN);
        {
            let mut reg = ts::take_shared<HashShareRegistry>(&sc);
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            hash_share_registry::set_fee_bps(&mut reg, &cap, 0);
            assert!(hash_share_registry::fee_bps(&reg) == 0, 0);
            ts::return_to_sender(&sc, cap);
            ts::return_shared(reg);
        };

        ts::next_tx(&mut sc, MINER_A);
        {
            let mut reg = ts::take_shared<HashShareRegistry>(&sc);
            let _ = hash_share_registry::bind_slot_to_round(&mut reg, ROUND_0);
            ts::return_shared(reg);
        };

        let diff: u64;
        ts::next_tx(&mut sc, MINER_A);
        {
            let reg = ts::take_shared<HashShareRegistry>(&sc);
            let mut cap = ts::take_shared<TreasuryCap<HS_000>>(&sc);
            let template = ts::take_immutable<m1n3_v4::pool::Template>(&sc);
            let mut stats = ts::take_from_sender<MinerStats>(&sc);
            let mut mrs = ts::take_from_sender<MinerRoundStats>(&sc);
            let mut dedup = ts::take_from_sender<ShareDedup>(&sc);
            let clk = clock::create_for_testing(ts::ctx(&mut sc));

            let receipt = pool::submit_share(
                &template, &mut stats, &mut mrs, &mut dedup,
                b"en1", b"en2", NTIME, 0u32, VERSION, &clk, ts::ctx(&mut sc),
            );
            diff = pool::receipt_difficulty(&receipt);
            let coin = hash_share::mint_share<HS_000>(&reg, &mut cap, receipt, &mut mrs, ts::ctx(&mut sc));
            // With fee_bps=0, miner_units == diff / BUNDLE_FACTOR.
            assert!(coin::value(&coin) == diff / hash_share::bundle_factor(), 0);
            transfer::public_transfer(coin, MINER_A);

            clock::destroy_for_testing(clk);
            ts::return_immutable(template);
            ts::return_to_sender(&sc, stats);
            ts::return_to_sender(&sc, mrs);
            ts::return_to_sender(&sc, dedup);
            ts::return_shared(reg);
            ts::return_shared(cap);
        };

        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::hash_share_registry::EFeeTooHigh)]
    fun set_fee_bps_aborts_above_cap() {
        let mut sc = ts::begin(ADMIN);
        setup_packages(&mut sc);
        ts::next_tx(&mut sc, ADMIN);
        {
            let mut reg = ts::take_shared<HashShareRegistry>(&sc);
            let cap = ts::take_from_sender<PoolAdminCap>(&sc);
            // MAX_FEE_BPS = 1000 (10%); 1001 must abort.
            hash_share_registry::set_fee_bps(&mut reg, &cap, 1001);
            ts::return_to_sender(&sc, cap);
            ts::return_shared(reg);
        };
        ts::end(sc);
    }

    // ── Two-step admin transfer ───────────────────────────────────────────────

    /// Wrong-address accept: ADMIN proposes ADMIN_NEW, STRANGER tries to
    /// accept — must abort.
    #[test]
    #[expected_failure(abort_code = m1n3_v4::hash_share_market::ENotPendingAdmin)]
    fun two_step_admin_transfer_wrong_acceptor_aborts() {
        let mut sc = ts::begin(ADMIN);
        setup_packages(&mut sc);
        ts::next_tx(&mut sc, ADMIN);
        {
            let mut fp = ts::take_shared<MarketFeePool<SUI>>(&sc);
            hash_share_market::propose_admin(&mut fp, MINER_A, ts::ctx(&mut sc));
            ts::return_shared(fp);
        };
        ts::next_tx(&mut sc, STRANGER);
        {
            let mut fp = ts::take_shared<MarketFeePool<SUI>>(&sc);
            hash_share_market::accept_admin(&mut fp, ts::ctx(&mut sc));
            ts::return_shared(fp);
        };
        ts::end(sc);
    }

    /// Happy path: propose + accept flips admin.
    #[test]
    fun two_step_admin_transfer_completes() {
        let mut sc = ts::begin(ADMIN);
        setup_packages(&mut sc);
        ts::next_tx(&mut sc, ADMIN);
        {
            let mut fp = ts::take_shared<MarketFeePool<SUI>>(&sc);
            assert!(hash_share_market::fee_pool_admin(&fp) == ADMIN, 0);
            hash_share_market::propose_admin(&mut fp, MINER_A, ts::ctx(&mut sc));
            // Admin not yet changed.
            assert!(hash_share_market::fee_pool_admin(&fp) == ADMIN, 1);
            ts::return_shared(fp);
        };
        ts::next_tx(&mut sc, MINER_A);
        {
            let mut fp = ts::take_shared<MarketFeePool<SUI>>(&sc);
            hash_share_market::accept_admin(&mut fp, ts::ctx(&mut sc));
            assert!(hash_share_market::fee_pool_admin(&fp) == MINER_A, 2);
            ts::return_shared(fp);
        };
        ts::end(sc);
    }

    /// Accept without a pending proposal aborts.
    #[test]
    #[expected_failure(abort_code = m1n3_v4::hash_share_market::ENoPendingAdmin)]
    fun accept_admin_without_pending_aborts() {
        let mut sc = ts::begin(ADMIN);
        setup_packages(&mut sc);
        ts::next_tx(&mut sc, ADMIN);
        {
            let mut fp = ts::take_shared<MarketFeePool<SUI>>(&sc);
            hash_share_market::accept_admin(&mut fp, ts::ctx(&mut sc));
            ts::return_shared(fp);
        };
        ts::end(sc);
    }

    /// Proposing @0x0 clears a prior pending nomination.
    #[test]
    #[expected_failure(abort_code = m1n3_v4::hash_share_market::ENoPendingAdmin)]
    fun propose_zero_clears_pending() {
        let mut sc = ts::begin(ADMIN);
        setup_packages(&mut sc);
        ts::next_tx(&mut sc, ADMIN);
        {
            let mut fp = ts::take_shared<MarketFeePool<SUI>>(&sc);
            hash_share_market::propose_admin(&mut fp, MINER_A, ts::ctx(&mut sc));
            hash_share_market::propose_admin(&mut fp, @0x0, ts::ctx(&mut sc));
            ts::return_shared(fp);
        };
        // After clearing, MINER_A's accept should abort with ENoPendingAdmin.
        ts::next_tx(&mut sc, MINER_A);
        {
            let mut fp = ts::take_shared<MarketFeePool<SUI>>(&sc);
            hash_share_market::accept_admin(&mut fp, ts::ctx(&mut sc));
            ts::return_shared(fp);
        };
        ts::end(sc);
    }

    #[test]
    fun cancel_buy_order_refunds_buyer() {
        let mut sc = ts::begin(ADMIN);
        setup_packages(&mut sc);

        ts::next_tx(&mut sc, BUYER);
        {
            let payment = coin::mint_for_testing<SUI>(10_000, ts::ctx(&mut sc));
            hash_share_market::place_buy_order<HS_000, SUI>(50, 0, payment, ts::ctx(&mut sc));
        };
        ts::next_tx(&mut sc, BUYER);
        {
            let order = ts::take_shared<BuyOrder<HS_000, SUI>>(&sc);
            hash_share_market::cancel_buy_order<HS_000, SUI>(order, ts::ctx(&mut sc));
        };
        ts::next_tx(&mut sc, BUYER);
        {
            let refund = ts::take_from_sender<sui::coin::Coin<SUI>>(&sc);
            assert!(coin::value(&refund) == 10_000, 0);
            ts::return_to_sender(&sc, refund);
        };
        ts::end(sc);
    }
}
