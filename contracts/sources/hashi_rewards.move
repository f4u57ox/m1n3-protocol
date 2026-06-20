/// m1n3 - Hashi-Path Reward Distribution
///
/// Default payout path for all miners and investors: participants receive
/// Coin<CoinType> on Sui — intended to be Coin<hashi::btc::BTC> (hBTC) once
/// Hashi is deployed to mainnet.
///
/// To activate Hashi mainnet integration:
///   1. Add hashi as a [dependency] in Move.toml once its package address is published.
///   2. Instantiate HashiRewardBatch<hashi::btc::BTC> everywhere.
///
/// State machine per batch:
///   PENDING → FUNDED → COMPLETED
///                    → EXPIRED   (admin reclaims after claim deadline if not all claimed)
///
/// Per-miner amounts are computed on-chain at claim time using MinerWorkRecord
/// (produced during round accumulation) and RoundHistory (frozen totals).
/// The operator only needs to supply the total block reward — no off-chain
/// per-miner amount computation required.
///
/// Claim deadline: set by admin at fund time. After deadline, admin can reclaim
/// any unclaimed funds via admin_reclaim_expired, preventing permanent lock.
module m1n3_v4::hashi_rewards {
    use sui::coin::{Self};
    use sui::balance::{Self, Balance};
    use sui::event;
    use sui::clock::{Self, Clock};
    use openzeppelin_math::u128::mul_div;
    use openzeppelin_math::rounding;
    use m1n3_v4::pool::{Self, MinerWorkRecord, RoundHistory};
    use m1n3_v4::hashi_vault::{Self, HashiVault};
    use m1n3_v4::hashi_pool::{Self, BlockDepositRecord};

    // ── Constants ─────────────────────────────────────────────────────────────

    const STATUS_PENDING: u8 = 0;
    const STATUS_FUNDED: u8 = 1;
    const STATUS_COMPLETED: u8 = 2;
    const STATUS_EXPIRED: u8 = 3;

    // ── Errors ────────────────────────────────────────────────────────────────

    #[error]
    const EInvalidStatus: vector<u8> = b"HashiRewardBatch is not in the required status for this operation";
    #[error]
    const EClaimDeadlinePassed: vector<u8> = b"Claim deadline has passed; this batch can only be recycled now";
    #[error]
    const EDeadlineNotReached: vector<u8> = b"Claim deadline has not been reached; recycle is not yet allowed";
    #[error]
    const ERoundMismatch: vector<u8> = b"BlockDepositRecord round_id does not match the RoundHistory or batch";
    #[error]
    const EZeroWork: vector<u8> = b"Round total_net_work is zero; nothing to distribute";
    #[error]
    const EWrongMiner: vector<u8> = b"MinerWorkRecord belongs to a different miner than the tx sender";
    #[error]
    const EDepositNotConfirmed: vector<u8> = b"BlockDepositRecord has not been CONFIRMED by the Hashi committee";
    #[error]
    const EZeroBalance: vector<u8> = b"Deposit record amount_sats is zero";

    /// Default claim window for the trustless funding path: 30 days. Fixed
    /// (not operator-chosen) so a malicious caller can't squeeze the window.
    const TRUSTLESS_CLAIM_WINDOW_MS: u64 = 30 * 24 * 60 * 60 * 1000;

    // ── Structs ───────────────────────────────────────────────────────────────

    /// Global registry tracking all Hashi-path reward batches.
    public struct HashiRewardRegistry has key {
        id: UID,
        total_batches: u64,
        total_sats_distributed: u128,
        total_sats_expired: u128,
    }

    /// A batch of hBTC rewards for a completed round.
    ///
    /// Per-miner amounts are NOT stored — they are computed on-chain at claim time
    /// from the miner's MinerWorkRecord and the round's RoundHistory.
    ///
    /// Dedup model: NONE on the batch. Each miner's `MinerWorkRecord` is
    /// consumed by-value in `claim_reward`, and `miner::MinerRoundRegistry`
    /// guarantees at most one MWR per (miner, round). So a second claim
    /// attempt has no MWR to spend. Eliminating the `claimed` Table here
    /// removes the per-claim shared-object write, letting N miners claim
    /// in parallel within a single consensus round.
    public struct HashiRewardBatch<phantom CoinType> has key {
        id: UID,
        round_id: u64,
        /// Total block reward for this round (in base coin units).
        total_sats: u64,
        claimed_sats: u64,
        balance: Balance<CoinType>,
        status: u8,
        created_at_ms: u64,
        funded_at_ms: Option<u64>,
        claim_deadline_ms: u64,
        completed_at_ms: Option<u64>,
    }

    // ── Events ────────────────────────────────────────────────────────────────

    public struct HashiBatchCreated has copy, drop {
        batch_id: address,
        round_id: u64,
        total_sats: u64,
    }

    public struct HashiBatchFunded has copy, drop {
        batch_id: address,
        round_id: u64,
        total_sats: u64,
        claim_deadline_ms: u64,
    }

    public struct HashiRewardClaimed has copy, drop {
        batch_id: address,
        round_id: u64,
        miner: address,
        amount_sats: u64,
    }

    public struct HashiBatchCompleted has copy, drop {
        batch_id: address,
        round_id: u64,
        total_sats: u64,
    }

    public struct HashiBatchExpired has copy, drop {
        batch_id: address,
        round_id: u64,
        reclaimed_sats: u64,
        claimed_sats: u64,
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    fun init(ctx: &mut TxContext) {
        transfer::share_object(HashiRewardRegistry {
            id: object::new(ctx),
            total_batches: 0,
            total_sats_distributed: 0,
            total_sats_expired: 0,
        });
    }

    // ── Trustless reward path ─────────────────────────────────────────────────
    //
    // The only way HBTC can leave the vault, in one atomic call:
    //
    //   1. Bind `round_history.round_id == deposit_record.round_id` — proves
    //      the deposit is the one for this finalized round (not some unrelated
    //      one the caller chose).
    //   2. Bind `hashi_pool::is_confirmed(deposit_record)` — proves Hashi's
    //      committee actually approved + confirmed the deposit (status CONFIRMED).
    //   3. Drain *exactly* `record.amount_sats` from the vault — bounding the
    //      drain to this deposit's amount prevents a single caller from
    //      siphoning a later round's HBTC into this round's batch when
    //      multiple deposits have accumulated.
    //   4. Use a fixed claim window constant — no caller-chosen deadline.
    //   5. Mark the record as funded so it can't fund a second batch after
    //      the vault is replenished.
    //
    // Result: no operator cap involved in funding. Anyone — finder, miner,
    // public watcher — can call this. Operator can't withhold, can't squeeze
    // the window, can't divert funds, can't double-fund.

    public fun open_and_fund_round_batch<CoinType>(
        registry: &mut HashiRewardRegistry,
        vault: &mut HashiVault<CoinType>,
        round_history: &RoundHistory,
        deposit_record: &mut BlockDepositRecord,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(
            hashi_pool::record_round_id(deposit_record) == pool::round_history_round_id(round_history),
            ERoundMismatch,
        );
        assert!(hashi_pool::is_confirmed(deposit_record), EDepositNotConfirmed);

        let total_sats = hashi_pool::record_amount_sats(deposit_record);
        assert!(total_sats > 0, EZeroBalance);

        // INVARIANT: this must run *before* `hashi_pool::mark_funded` below.
        // If the vault is short of `total_sats`, `take_exact_hbtc` aborts via
        // `EInsufficientBalance`, the whole tx reverts, and the deposit
        // record stays UNFUNDED — preventing a double-fund race where two
        // concurrent callers each see `record.funded_batch_id == none` and
        // race to drain the same deposit. Sui's atomic-tx model is what
        // makes this sequencing safe; don't reorder.
        let drained = hashi_vault::take_exact_hbtc<CoinType>(vault, total_sats);

        let now = clock::timestamp_ms(clock);
        let round_id = pool::round_history_round_id(round_history);
        let mut batch = HashiRewardBatch<CoinType> {
            id: object::new(ctx),
            round_id,
            total_sats,
            claimed_sats: 0,
            balance: balance::zero(),
            status: STATUS_FUNDED,
            created_at_ms: now,
            funded_at_ms: option::some(now),
            claim_deadline_ms: now + TRUSTLESS_CLAIM_WINDOW_MS,
            completed_at_ms: option::none(),
        };
        batch.balance.join(drained);

        registry.total_batches = registry.total_batches + 1;
        let batch_id = object::uid_to_address(&batch.id);

        // One-shot lock — aborts EAlreadyFunded if this record already funded a batch.
        hashi_pool::mark_funded(deposit_record, batch_id);

        event::emit(HashiBatchCreated { batch_id, round_id, total_sats });
        event::emit(HashiBatchFunded {
            batch_id,
            round_id,
            total_sats,
            claim_deadline_ms: batch.claim_deadline_ms,
        });

        let _ = ctx;
        transfer::share_object(batch);
    }

    /// Permissionless replacement for the admin reclaim path: after the
    /// claim deadline, sweep any unclaimed balance back into the vault so
    /// it rolls into the *next* round's `open_and_fund_round_batch` call.
    /// No operator cap, no caller-chosen destination — funds always end up
    /// in the same vault they came from.
    public fun recycle_expired_to_vault<CoinType>(
        registry: &mut HashiRewardRegistry,
        batch: &mut HashiRewardBatch<CoinType>,
        vault: &mut HashiVault<CoinType>,
        clock: &Clock,
    ) {
        assert!(batch.status == STATUS_FUNDED, EInvalidStatus);
        assert!(clock::timestamp_ms(clock) >= batch.claim_deadline_ms, EDeadlineNotReached);

        let reclaimed = batch.balance.value();
        let claimed_sats = batch.claimed_sats;

        if (reclaimed > 0) {
            let bal = batch.balance.split(reclaimed);
            hashi_vault::deposit_hbtc<CoinType>(vault, bal);
        };

        batch.status = STATUS_EXPIRED;
        registry.total_sats_distributed =
            registry.total_sats_distributed + (claimed_sats as u128);
        registry.total_sats_expired =
            registry.total_sats_expired + (reclaimed as u128);

        event::emit(HashiBatchExpired {
            batch_id: object::uid_to_address(&batch.id),
            round_id: batch.round_id,
            reclaimed_sats: reclaimed,
            claimed_sats,
        });
    }

    // ── Miner Functions ───────────────────────────────────────────────────────

    /// Miner claims their proportional hBTC share.
    ///
    /// Consumes the MinerWorkRecord produced during round accumulation.
    /// Amount = (miner_net_work / round_total_work) * total_sats, computed on-chain.
    /// No operator pre-computation required.
    public fun claim_reward<CoinType>(
        registry: &mut HashiRewardRegistry,
        batch: &mut HashiRewardBatch<CoinType>,
        record: MinerWorkRecord,
        round_history: &RoundHistory,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(batch.status == STATUS_FUNDED, EInvalidStatus);
        assert!(clock::timestamp_ms(clock) < batch.claim_deadline_ms, EClaimDeadlinePassed);

        let (record_round_id, miner, net_work) = pool::consume_work_record(record);

        assert!(record_round_id == batch.round_id, ERoundMismatch);
        assert!(record_round_id == pool::round_history_round_id(round_history), ERoundMismatch);
        assert!(miner == tx_context::sender(ctx), EWrongMiner);
        // No `batch.claimed` lookup: `MinerWorkRecord` was consumed-by-value
        // above (`pool::consume_work_record`), and `MinerRoundRegistry`
        // guarantees one MWR per (miner, round). Double-claim is impossible.

        let total_work = pool::round_history_total_work(round_history);
        assert!(total_work > 0, EZeroWork);

        // Proportional amount: floor division; any dust stays in balance and is
        // recycled to the vault by `recycle_expired_to_vault` after the deadline.
        // Result fits in u64: net_work / total_work <= 1, so output <= total_sats (u64).
        let amount = mul_div(
            net_work,
            (batch.total_sats as u128),
            total_work,
            rounding::down(),
        ).destroy_some() as u64;

        batch.claimed_sats = batch.claimed_sats + amount;

        let reward = coin::from_balance(batch.balance.split(amount), ctx);
        transfer::public_transfer(reward, miner);

        event::emit(HashiRewardClaimed {
            batch_id: object::uid_to_address(&batch.id),
            round_id: batch.round_id,
            miner,
            amount_sats: amount,
        });

        // If balance is fully drained, mark complete.
        if (batch.balance.value() == 0) {
            let now = clock::timestamp_ms(clock);
            batch.status = STATUS_COMPLETED;
            batch.completed_at_ms = option::some(now);
            registry.total_sats_distributed =
                registry.total_sats_distributed + (batch.claimed_sats as u128);
            event::emit(HashiBatchCompleted {
                batch_id: object::uid_to_address(&batch.id),
                round_id: batch.round_id,
                total_sats: batch.total_sats,
            });
        };
    }

    // ── View Functions ────────────────────────────────────────────────────────

    public fun get_batch_status<CoinType>(batch: &HashiRewardBatch<CoinType>): u8 { batch.status }
    public fun get_batch_round_id<CoinType>(batch: &HashiRewardBatch<CoinType>): u64 { batch.round_id }
    public fun get_batch_total_sats<CoinType>(batch: &HashiRewardBatch<CoinType>): u64 { batch.total_sats }
    public fun get_batch_claimed_sats<CoinType>(batch: &HashiRewardBatch<CoinType>): u64 { batch.claimed_sats }
    public fun get_batch_balance<CoinType>(batch: &HashiRewardBatch<CoinType>): u64 { batch.balance.value() }
    public fun get_claim_deadline<CoinType>(batch: &HashiRewardBatch<CoinType>): u64 { batch.claim_deadline_ms }
    public fun get_registry_stats(registry: &HashiRewardRegistry): (u64, u128, u128) {
        (registry.total_batches, registry.total_sats_distributed, registry.total_sats_expired)
    }

    public fun status_pending(): u8 { STATUS_PENDING }
    public fun status_funded(): u8 { STATUS_FUNDED }
    public fun status_completed(): u8 { STATUS_COMPLETED }
    public fun status_expired(): u8 { STATUS_EXPIRED }

    // ── Test Helpers ──────────────────────────────────────────────────────────

    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) { init(ctx); }
}
