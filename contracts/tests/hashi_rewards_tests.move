/// Tests for hashi_rewards.move after the trustless cleanup (A+B+C+D+E).
///
/// All flows go through `open_and_fund_round_batch` (no admin cap, drains
/// exactly `record.amount_sats` from the vault, one-shot per record) and
/// `claim_reward` (no batch.claimed table — MWR consumption + MRS registry
/// dedup are sufficient). Recycle path goes through `recycle_expired_to_vault`
/// instead of `admin_reclaim_expired`.
#[test_only]
#[allow(unused_const)]
module m1n3_v4::hashi_rewards_tests {
    use sui::test_scenario::{Self as ts};
    use sui::clock;
    use sui::coin;
    use sui::sui::SUI;
    use sui::transfer;

    use m1n3_v4::pool::{Self, PoolAdminCap, RoundHistory};
    use m1n3_v4::hashi_rewards::{Self, HashiRewardRegistry, HashiRewardBatch};
    use m1n3_v4::hashi_vault::{Self, HashiVault};
    use m1n3_v4::hashi_pool::{Self, BlockDepositRecord};

    // ── Actors ────────────────────────────────────────────────────────────────

    const ADMIN:        address = @0xAD;
    const MINER_A:      address = @0xA;
    const MINER_B:      address = @0xB;
    const STRANGER:     address = @0xFF;
    const BLOCK_FINDER: address = @0xA;
    const BLOCK_HEIGHT: u64     = 800_000;

    // ── Constants ─────────────────────────────────────────────────────────────

    const T0:                 u64 = 1_000_000;
    /// Trustless claim window — must match TRUSTLESS_CLAIM_WINDOW_MS in source.
    const CLAIM_WINDOW_MS:    u64 = 30 * 24 * 60 * 60 * 1000;
    const POST_DEADLINE:      u64 = T0 + 30 * 24 * 60 * 60 * 1000 + 1;

    const TOTAL:       u64  = 10_000_000;
    const TOTAL_WORK:  u128 = 10_000_000;
    const WORK_A:      u128 = 5_000_000;
    const WORK_B:      u128 = 3_000_000;
    const SATS_A:      u64  = 5_000_000;
    const SATS_B:      u64  = 3_000_000;
    const ROUND_ID:    u64  = 42;

    // ── Setup helpers ─────────────────────────────────────────────────────────

    fun setup(scenario: &mut ts::Scenario) {
        ts::next_tx(scenario, ADMIN);
        { pool::init_for_testing(ts::ctx(scenario)); };
        ts::next_tx(scenario, ADMIN);
        { hashi_rewards::init_for_testing(ts::ctx(scenario)); };
    }

    /// Mint a shared vault and load it with `seed` sats of "minted hBTC".
    /// SUI stands in for hBTC in these tests — the rewards module is generic.
    fun create_funded_vault(scenario: &mut ts::Scenario, seed: u64) {
        ts::next_tx(scenario, ADMIN);
        {
            let cap = ts::take_from_sender<PoolAdminCap>(scenario);
            hashi_vault::create_shared<SUI>(&cap, ts::ctx(scenario));
            ts::return_to_sender(scenario, cap);
        };
        if (seed > 0) {
            ts::next_tx(scenario, ADMIN);
            {
                let mut vault = ts::take_shared<HashiVault<SUI>>(scenario);
                let c = coin::mint_for_testing<SUI>(seed, ts::ctx(scenario));
                hashi_vault::deposit_hbtc<SUI>(&mut vault, coin::into_balance(c));
                ts::return_shared(vault);
            };
        };
    }

    /// Freeze a RoundHistory for `round_id`.
    fun freeze_round_history(scenario: &mut ts::Scenario, round_id: u64) {
        freeze_round_history_with_work(scenario, round_id, TOTAL_WORK);
    }

    /// Parametric variant: lets a single test set its own total_work.
    fun freeze_round_history_with_work(
        scenario: &mut ts::Scenario, round_id: u64, total_work: u128,
    ) {
        ts::next_tx(scenario, ADMIN);
        {
            pool::create_round_history_for_testing(
                round_id, total_work, 3, BLOCK_FINDER, BLOCK_HEIGHT, ts::ctx(scenario),
            );
        };
    }

    /// Share a synthetic CONFIRMED BlockDepositRecord with `amount_sats`.
    fun mint_confirmed_record(scenario: &mut ts::Scenario, round_id: u64, amount_sats: u64) {
        ts::next_tx(scenario, ADMIN);
        {
            hashi_pool::create_confirmed_record_for_testing(
                round_id, amount_sats, ts::ctx(scenario),
            );
        };
    }

    /// Run the trustless funding path. Returns immediately; the resulting
    /// HashiRewardBatch is then takeable as a shared object.
    fun trustless_fund(scenario: &mut ts::Scenario, caller: address, clock_ms: u64) {
        ts::next_tx(scenario, caller);
        {
            let mut registry      = ts::take_shared<HashiRewardRegistry>(scenario);
            let mut vault         = ts::take_shared<HashiVault<SUI>>(scenario);
            let round_history     = ts::take_immutable<RoundHistory>(scenario);
            let mut deposit_record = ts::take_shared<BlockDepositRecord>(scenario);
            let mut clk           = clock::create_for_testing(ts::ctx(scenario));
            clock::set_for_testing(&mut clk, clock_ms);

            hashi_rewards::open_and_fund_round_batch<SUI>(
                &mut registry, &mut vault, &round_history, &mut deposit_record,
                &clk, ts::ctx(scenario),
            );

            clock::destroy_for_testing(clk);
            ts::return_shared(registry);
            ts::return_shared(vault);
            ts::return_immutable(round_history);
            ts::return_shared(deposit_record);
        };
    }

    /// Transfer a synthetic MinerWorkRecord to `miner`.
    fun give_work_record(scenario: &mut ts::Scenario, miner: address, work: u128, round_id: u64) {
        ts::next_tx(scenario, ADMIN);
        {
            let record = pool::create_work_record_for_testing(
                round_id, miner, work, ts::ctx(scenario),
            );
            transfer::public_transfer(record, miner);
        };
    }

    // ── Happy paths ───────────────────────────────────────────────────────────

    #[test]
    fun trustless_funding_drains_only_record_amount() {
        // Two confirmed deposits' worth of hBTC in the vault. Funding for
        // ROUND_ID must only drain TOTAL, leaving the remainder for the next
        // round's batch. This is the C-1 fix.
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        create_funded_vault(&mut sc, TOTAL * 3);   // pretend two prior deposits + this one
        freeze_round_history(&mut sc, ROUND_ID);
        mint_confirmed_record(&mut sc, ROUND_ID, TOTAL);
        trustless_fund(&mut sc, STRANGER, T0);

        ts::next_tx(&mut sc, STRANGER);
        {
            let batch = ts::take_shared<HashiRewardBatch<SUI>>(&sc);
            let vault = ts::take_shared<HashiVault<SUI>>(&sc);
            assert!(hashi_rewards::get_batch_total_sats(&batch) == TOTAL, 0);
            assert!(hashi_rewards::get_batch_balance(&batch) == TOTAL, 1);
            // Vault should retain TOTAL * 2 for future rounds.
            assert!(hashi_vault::hbtc_balance(&vault) == TOTAL * 2, 2);
            ts::return_shared(batch);
            ts::return_shared(vault);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::hashi_pool::EAlreadyFunded)]
    fun trustless_funding_aborts_on_double_fund() {
        // Even after the vault is refilled, the record's funded_batch_id is
        // still Some, so a re-fund attempt aborts. Closes the replay vector.
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        create_funded_vault(&mut sc, TOTAL);
        freeze_round_history(&mut sc, ROUND_ID);
        mint_confirmed_record(&mut sc, ROUND_ID, TOTAL);
        trustless_fund(&mut sc, STRANGER, T0);

        // Refill the vault and try again with the same record.
        ts::next_tx(&mut sc, ADMIN);
        {
            let mut vault = ts::take_shared<HashiVault<SUI>>(&sc);
            let c = coin::mint_for_testing<SUI>(TOTAL, ts::ctx(&mut sc));
            hashi_vault::deposit_hbtc<SUI>(&mut vault, coin::into_balance(c));
            ts::return_shared(vault);
        };
        trustless_fund(&mut sc, STRANGER, T0 + 1);
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::hashi_rewards::ERoundMismatch)]
    fun trustless_funding_aborts_on_round_mismatch() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        create_funded_vault(&mut sc, TOTAL);
        // RoundHistory is for ROUND_ID; record is for ROUND_ID+1.
        freeze_round_history(&mut sc, ROUND_ID);
        mint_confirmed_record(&mut sc, ROUND_ID + 1, TOTAL);
        trustless_fund(&mut sc, STRANGER, T0);
        ts::end(sc);
    }

    #[test]
    fun single_miner_claims_full_share() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        create_funded_vault(&mut sc, TOTAL);
        freeze_round_history(&mut sc, ROUND_ID);
        mint_confirmed_record(&mut sc, ROUND_ID, TOTAL);
        trustless_fund(&mut sc, STRANGER, T0);
        give_work_record(&mut sc, MINER_A, WORK_A, ROUND_ID);

        ts::next_tx(&mut sc, MINER_A);
        {
            let mut registry      = ts::take_shared<HashiRewardRegistry>(&sc);
            let mut batch         = ts::take_shared<HashiRewardBatch<SUI>>(&sc);
            let round_history     = ts::take_immutable<RoundHistory>(&sc);
            let record            = ts::take_from_sender<pool::MinerWorkRecord>(&sc);
            let mut clk           = clock::create_for_testing(ts::ctx(&mut sc));
            clock::set_for_testing(&mut clk, T0 + 1);

            hashi_rewards::claim_reward<SUI>(
                &mut registry, &mut batch, record, &round_history, &clk, ts::ctx(&mut sc),
            );

            assert!(hashi_rewards::get_batch_claimed_sats(&batch) == SATS_A, 0);
            assert!(hashi_rewards::get_batch_balance(&batch) == TOTAL - SATS_A, 1);

            clock::destroy_for_testing(clk);
            ts::return_shared(registry);
            ts::return_shared(batch);
            ts::return_immutable(round_history);
        };
        ts::end(sc);
    }

    #[test]
    fun parallel_claims_no_batch_table() {
        // After dropping `batch.claimed`, two independent miner claims can
        // both succeed back-to-back without a per-miner shared-object write.
        // (Sui sequences these in the test scenario, but on a live network
        // they would interleave; this test proves the *logic* permits it.)
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        create_funded_vault(&mut sc, TOTAL);
        freeze_round_history(&mut sc, ROUND_ID);
        mint_confirmed_record(&mut sc, ROUND_ID, TOTAL);
        trustless_fund(&mut sc, STRANGER, T0);
        give_work_record(&mut sc, MINER_A, WORK_A, ROUND_ID);
        give_work_record(&mut sc, MINER_B, WORK_B, ROUND_ID);

        ts::next_tx(&mut sc, MINER_A);
        {
            let mut registry      = ts::take_shared<HashiRewardRegistry>(&sc);
            let mut batch         = ts::take_shared<HashiRewardBatch<SUI>>(&sc);
            let round_history     = ts::take_immutable<RoundHistory>(&sc);
            let record            = ts::take_from_sender<pool::MinerWorkRecord>(&sc);
            let mut clk           = clock::create_for_testing(ts::ctx(&mut sc));
            clock::set_for_testing(&mut clk, T0 + 1);

            hashi_rewards::claim_reward<SUI>(
                &mut registry, &mut batch, record, &round_history, &clk, ts::ctx(&mut sc),
            );

            clock::destroy_for_testing(clk);
            ts::return_shared(registry);
            ts::return_shared(batch);
            ts::return_immutable(round_history);
        };

        ts::next_tx(&mut sc, MINER_B);
        {
            let mut registry      = ts::take_shared<HashiRewardRegistry>(&sc);
            let mut batch         = ts::take_shared<HashiRewardBatch<SUI>>(&sc);
            let round_history     = ts::take_immutable<RoundHistory>(&sc);
            let record            = ts::take_from_sender<pool::MinerWorkRecord>(&sc);
            let mut clk           = clock::create_for_testing(ts::ctx(&mut sc));
            clock::set_for_testing(&mut clk, T0 + 2);

            hashi_rewards::claim_reward<SUI>(
                &mut registry, &mut batch, record, &round_history, &clk, ts::ctx(&mut sc),
            );

            assert!(hashi_rewards::get_batch_claimed_sats(&batch) == SATS_A + SATS_B, 0);

            clock::destroy_for_testing(clk);
            ts::return_shared(registry);
            ts::return_shared(batch);
            ts::return_immutable(round_history);
        };
        ts::end(sc);
    }

    #[test]
    fun recycle_after_claims_returns_dust_to_vault() {
        // MINER_A claims their proportional share. After the deadline,
        // the recycle path moves the residual back into the vault.
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        create_funded_vault(&mut sc, TOTAL);
        freeze_round_history(&mut sc, ROUND_ID);
        mint_confirmed_record(&mut sc, ROUND_ID, TOTAL);
        trustless_fund(&mut sc, STRANGER, T0);
        give_work_record(&mut sc, MINER_A, WORK_A, ROUND_ID);

        ts::next_tx(&mut sc, MINER_A);
        {
            let mut registry  = ts::take_shared<HashiRewardRegistry>(&sc);
            let mut batch     = ts::take_shared<HashiRewardBatch<SUI>>(&sc);
            let round_history = ts::take_immutable<RoundHistory>(&sc);
            let record        = ts::take_from_sender<pool::MinerWorkRecord>(&sc);
            let mut clk       = clock::create_for_testing(ts::ctx(&mut sc));
            clock::set_for_testing(&mut clk, T0 + 1);
            hashi_rewards::claim_reward<SUI>(
                &mut registry, &mut batch, record, &round_history, &clk, ts::ctx(&mut sc),
            );
            clock::destroy_for_testing(clk);
            ts::return_shared(registry);
            ts::return_shared(batch);
            ts::return_immutable(round_history);
        };

        // Recycle the residual (TOTAL - SATS_A) back to the vault.
        ts::next_tx(&mut sc, STRANGER);
        {
            let mut registry  = ts::take_shared<HashiRewardRegistry>(&sc);
            let mut batch     = ts::take_shared<HashiRewardBatch<SUI>>(&sc);
            let mut vault     = ts::take_shared<HashiVault<SUI>>(&sc);
            let mut clk       = clock::create_for_testing(ts::ctx(&mut sc));
            clock::set_for_testing(&mut clk, POST_DEADLINE);

            hashi_rewards::recycle_expired_to_vault<SUI>(
                &mut registry, &mut batch, &mut vault, &clk,
            );

            assert!(hashi_rewards::get_batch_balance(&batch) == 0, 0);
            assert!(hashi_vault::hbtc_balance(&vault) == TOTAL - SATS_A, 1);
            assert!(hashi_rewards::get_batch_status(&batch) == hashi_rewards::status_expired(), 2);

            clock::destroy_for_testing(clk);
            ts::return_shared(registry);
            ts::return_shared(batch);
            ts::return_shared(vault);
        };
        ts::end(sc);
    }

    // ── mul_div regression ────────────────────────────────────────────────────

    /// Worst-case proportional split: a miner with exactly 1% of total_net_work
    /// claiming against a 1000-sat batch should get exactly 10 sats — never 11
    /// or 9. This pins down the floor-rounding semantics of the OZ mul_div.
    #[test]
    fun mul_div_floor_one_percent_of_thousand_yields_ten() {
        let one_pct_work: u128 = 1;
        let total_work_w:  u128 = 100;
        let total:         u64  = 1000;

        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        create_funded_vault(&mut sc, total);
        freeze_round_history_with_work(&mut sc, ROUND_ID, total_work_w);
        mint_confirmed_record(&mut sc, ROUND_ID, total);
        trustless_fund(&mut sc, STRANGER, T0);
        give_work_record(&mut sc, MINER_A, one_pct_work, ROUND_ID);

        ts::next_tx(&mut sc, MINER_A);
        {
            let mut registry  = ts::take_shared<HashiRewardRegistry>(&sc);
            let mut batch     = ts::take_shared<HashiRewardBatch<SUI>>(&sc);
            let round_history = ts::take_immutable<RoundHistory>(&sc);
            let record        = ts::take_from_sender<pool::MinerWorkRecord>(&sc);
            let mut clk       = clock::create_for_testing(ts::ctx(&mut sc));
            clock::set_for_testing(&mut clk, T0 + 1);

            hashi_rewards::claim_reward<SUI>(
                &mut registry, &mut batch, record, &round_history, &clk, ts::ctx(&mut sc),
            );
            // Exactly 10 — not 9 (would mean we floor-divided then dropped)
            // and not 11 (would mean we round-up'd).
            assert!(hashi_rewards::get_batch_claimed_sats(&batch) == 10, 0);

            clock::destroy_for_testing(clk);
            ts::return_shared(registry);
            ts::return_shared(batch);
            ts::return_immutable(round_history);
        };
        ts::end(sc);
    }

    /// Dust-floor case: 1 of 7 against a 10-sat batch is 10/7 = 1.42 → 1.
    /// Exercises floor-rounding when the dividend doesn't divide evenly.
    #[test]
    fun mul_div_floor_dust_rounds_down() {
        let one_seventh:  u128 = 1;
        let total_work_w: u128 = 7;
        let total:        u64  = 10;

        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        create_funded_vault(&mut sc, total);
        freeze_round_history_with_work(&mut sc, ROUND_ID, total_work_w);
        mint_confirmed_record(&mut sc, ROUND_ID, total);
        trustless_fund(&mut sc, STRANGER, T0);
        give_work_record(&mut sc, MINER_A, one_seventh, ROUND_ID);

        ts::next_tx(&mut sc, MINER_A);
        {
            let mut registry  = ts::take_shared<HashiRewardRegistry>(&sc);
            let mut batch     = ts::take_shared<HashiRewardBatch<SUI>>(&sc);
            let round_history = ts::take_immutable<RoundHistory>(&sc);
            let record        = ts::take_from_sender<pool::MinerWorkRecord>(&sc);
            let mut clk       = clock::create_for_testing(ts::ctx(&mut sc));
            clock::set_for_testing(&mut clk, T0 + 1);

            hashi_rewards::claim_reward<SUI>(
                &mut registry, &mut batch, record, &round_history, &clk, ts::ctx(&mut sc),
            );
            assert!(hashi_rewards::get_batch_claimed_sats(&batch) == 1, 0);

            clock::destroy_for_testing(clk);
            ts::return_shared(registry);
            ts::return_shared(batch);
            ts::return_immutable(round_history);
        };
        ts::end(sc);
    }

    // ── Negative paths ────────────────────────────────────────────────────────

    #[test]
    #[expected_failure(abort_code = m1n3_v4::hashi_rewards::EClaimDeadlinePassed)]
    fun reject_claim_after_deadline() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        create_funded_vault(&mut sc, TOTAL);
        freeze_round_history(&mut sc, ROUND_ID);
        mint_confirmed_record(&mut sc, ROUND_ID, TOTAL);
        trustless_fund(&mut sc, STRANGER, T0);
        give_work_record(&mut sc, MINER_A, WORK_A, ROUND_ID);

        ts::next_tx(&mut sc, MINER_A);
        {
            let mut registry  = ts::take_shared<HashiRewardRegistry>(&sc);
            let mut batch     = ts::take_shared<HashiRewardBatch<SUI>>(&sc);
            let round_history = ts::take_immutable<RoundHistory>(&sc);
            let record        = ts::take_from_sender<pool::MinerWorkRecord>(&sc);
            let mut clk       = clock::create_for_testing(ts::ctx(&mut sc));
            clock::set_for_testing(&mut clk, POST_DEADLINE);
            hashi_rewards::claim_reward<SUI>(
                &mut registry, &mut batch, record, &round_history, &clk, ts::ctx(&mut sc),
            );
            clock::destroy_for_testing(clk);
            ts::return_shared(registry);
            ts::return_shared(batch);
            ts::return_immutable(round_history);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::hashi_rewards::EDeadlineNotReached)]
    fun reject_recycle_before_deadline() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        create_funded_vault(&mut sc, TOTAL);
        freeze_round_history(&mut sc, ROUND_ID);
        mint_confirmed_record(&mut sc, ROUND_ID, TOTAL);
        trustless_fund(&mut sc, STRANGER, T0);

        ts::next_tx(&mut sc, STRANGER);
        {
            let mut registry = ts::take_shared<HashiRewardRegistry>(&sc);
            let mut batch    = ts::take_shared<HashiRewardBatch<SUI>>(&sc);
            let mut vault    = ts::take_shared<HashiVault<SUI>>(&sc);
            let mut clk      = clock::create_for_testing(ts::ctx(&mut sc));
            clock::set_for_testing(&mut clk, T0 + 1);  // before deadline
            hashi_rewards::recycle_expired_to_vault<SUI>(
                &mut registry, &mut batch, &mut vault, &clk,
            );
            clock::destroy_for_testing(clk);
            ts::return_shared(registry);
            ts::return_shared(batch);
            ts::return_shared(vault);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::hashi_rewards::EInvalidStatus)]
    fun reject_recycle_on_expired_batch() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        create_funded_vault(&mut sc, TOTAL);
        freeze_round_history(&mut sc, ROUND_ID);
        mint_confirmed_record(&mut sc, ROUND_ID, TOTAL);
        trustless_fund(&mut sc, STRANGER, T0);

        // First recycle: succeeds.
        ts::next_tx(&mut sc, STRANGER);
        {
            let mut registry = ts::take_shared<HashiRewardRegistry>(&sc);
            let mut batch    = ts::take_shared<HashiRewardBatch<SUI>>(&sc);
            let mut vault    = ts::take_shared<HashiVault<SUI>>(&sc);
            let mut clk      = clock::create_for_testing(ts::ctx(&mut sc));
            clock::set_for_testing(&mut clk, POST_DEADLINE);
            hashi_rewards::recycle_expired_to_vault<SUI>(
                &mut registry, &mut batch, &mut vault, &clk,
            );
            clock::destroy_for_testing(clk);
            ts::return_shared(registry);
            ts::return_shared(batch);
            ts::return_shared(vault);
        };
        // Second recycle on the now-EXPIRED batch: aborts.
        ts::next_tx(&mut sc, STRANGER);
        {
            let mut registry = ts::take_shared<HashiRewardRegistry>(&sc);
            let mut batch    = ts::take_shared<HashiRewardBatch<SUI>>(&sc);
            let mut vault    = ts::take_shared<HashiVault<SUI>>(&sc);
            let mut clk      = clock::create_for_testing(ts::ctx(&mut sc));
            clock::set_for_testing(&mut clk, POST_DEADLINE + 1);
            hashi_rewards::recycle_expired_to_vault<SUI>(
                &mut registry, &mut batch, &mut vault, &clk,
            );
            clock::destroy_for_testing(clk);
            ts::return_shared(registry);
            ts::return_shared(batch);
            ts::return_shared(vault);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = m1n3_v4::hashi_rewards::EWrongMiner)]
    fun reject_claim_wrong_miner() {
        // Hand MINER_A's MWR to MINER_B and have B try to claim.
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);
        create_funded_vault(&mut sc, TOTAL);
        freeze_round_history(&mut sc, ROUND_ID);
        mint_confirmed_record(&mut sc, ROUND_ID, TOTAL);
        trustless_fund(&mut sc, STRANGER, T0);
        give_work_record(&mut sc, MINER_A, WORK_A, ROUND_ID);

        ts::next_tx(&mut sc, MINER_B);
        {
            let mut registry  = ts::take_shared<HashiRewardRegistry>(&sc);
            let mut batch     = ts::take_shared<HashiRewardBatch<SUI>>(&sc);
            let round_history = ts::take_immutable<RoundHistory>(&sc);
            // Forge: take MINER_A's record from address MINER_A.
            let record        = ts::take_from_address<pool::MinerWorkRecord>(&sc, MINER_A);
            let mut clk       = clock::create_for_testing(ts::ctx(&mut sc));
            clock::set_for_testing(&mut clk, T0 + 1);
            hashi_rewards::claim_reward<SUI>(
                &mut registry, &mut batch, record, &round_history, &clk, ts::ctx(&mut sc),
            );
            clock::destroy_for_testing(clk);
            ts::return_shared(registry);
            ts::return_shared(batch);
            ts::return_immutable(round_history);
        };
        ts::end(sc);
    }
}
