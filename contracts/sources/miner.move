/// Miner-owned objects for per-miner stats and per-round work tracking.
///
/// All objects here are owned (not shared), so all reads and writes bypass
/// Sui consensus entirely. N miners can operate fully in parallel.
///
/// Lifecycle:
///   register_miner  → creates MinerStats, transfers to sender
///   submit_share    → borrows &mut MinerStats + &mut MinerRoundStats (fast path)
///   close_round     → admin reads (borrows) all MinerRoundStats to sum totals
///   close_miner_round_stats → miner reclaims storage rent
module m1n3_v4::miner {
    use sui::clock::{Self, Clock};
    use sui::dynamic_field;
    use sui::event;

    // ── Error codes ───────────────────────────────────────────────────────────

    #[error]
    const ENotOwner: vector<u8> = b"Caller is not the owner of these MinerStats";
    #[error]
    const ERoundMismatch: vector<u8> = b"MinerRoundStats round_id does not match the share's round_id";
    #[error]
    const EMinerMismatch: vector<u8> = b"MinerRoundStats belongs to a different miner";
    #[error]
    const EStaleTemplate: vector<u8> = b"Template's round_id is older than pool.current_round; share rejected";
    /// `create_round_stats` called twice for the same (miner, round) pair.
    /// This dedup is what lets `hashi_rewards::claim_reward` drop its own
    /// `claimed` table — one MRS per round means one MinerWorkRecord per
    /// round means consumption-by-value is sufficient dedup at claim time.
    #[error]
    const EDuplicateRoundStats: vector<u8> = b"A MinerRoundStats already exists for this (miner, round) pair";

    // ── Round-stats uniqueness registry ───────────────────────────────────────

    /// Shared dedup for (miner, round_id) → bool. One dynamic field per
    /// pair; presence means a MinerRoundStats has already been minted for
    /// that round by that miner. Registry entries are permanent: deleting a
    /// MinerRoundStats does not free its slot, so a delete-and-recreate
    /// cannot bypass the protection.
    public struct MinerRoundRegistry has key {
        id: UID,
    }

    public struct MinerRoundKey has copy, drop, store {
        miner: address,
        round_id: u64,
    }

    fun init(ctx: &mut TxContext) {
        transfer::share_object(MinerRoundRegistry { id: object::new(ctx) });
    }

    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) { init(ctx); }

    // ── Objects ───────────────────────────────────────────────────────────────

    /// Lifetime statistics for a miner. Owned by the miner — no consensus on writes.
    public struct MinerStats has key {
        id: UID,
        miner: address,
        total_shares: u64,
        blocks_found: u64,
        registered_at_ms: u64,
        /// Bitcoin payout address (ASCII bytes, e.g. "bc1q..."). Set at registration,
        /// updatable by the owner. Used by the Hashi bridge to anchor BTC payouts.
        btc_payout_address: vector<u8>,
    }

    /// Per-round work accumulator. Created at first share of each round.
    /// Owned by the miner — no consensus on writes.
    ///
    /// `sold_work` / `sold_shares` track shares filled via market::fill_buy_order.
    /// The accumulator subtracts these from the miner's pool-reward contribution,
    /// enforcing exclusivity: a share sold on the market does not also earn pool rewards.
    ///
    /// `min_height` is a monotonic ratchet: set to pool.current_height at creation,
    /// then advanced to the template height on each accepted share. Prevents a miner
    /// from submitting shares against a stale block-height template within the same round.
    ///
    /// Needs `store` so it can be passed as vector<MinerRoundStats> in a PTB.
    public struct MinerRoundStats has key, store {
        id: UID,
        round_id: u64,
        miner: address,
        work: u128,        // sum of difficulty for all accepted shares this round
        shares: u64,
        sold_work: u128,   // work deducted via market fills (excluded from pool rewards)
        sold_shares: u64,
        min_height: u64,   // ratchet: miner can only submit to height >= this value
    }

    // ── Events ────────────────────────────────────────────────────────────────

    public struct MinerRegistered has copy, drop {
        miner: address,
        timestamp_ms: u64,
    }

    // ── Entry functions ───────────────────────────────────────────────────────

    /// Register a new miner. Creates a MinerStats object owned by the sender.
    /// `btc_payout_address` is the ASCII-encoded Bitcoin address where block rewards
    /// will be sent (e.g. b"bc1q..."). Can be updated later with set_btc_payout_address.
    public fun register_miner(btc_payout_address: vector<u8>, clock: &Clock, ctx: &mut TxContext) {
        let sender = tx_context::sender(ctx);
        let now = clock::timestamp_ms(clock);

        let stats = MinerStats {
            id: object::new(ctx),
            miner: sender,
            total_shares: 0,
            blocks_found: 0,
            registered_at_ms: now,
            btc_payout_address,
        };

        event::emit(MinerRegistered { miner: sender, timestamp_ms: now });
        transfer::transfer(stats, sender);
    }

    /// Update the Bitcoin payout address. Only the owning miner can call this.
    public fun set_btc_payout_address(stats: &mut MinerStats, new_address: vector<u8>, ctx: &TxContext) {
        assert!(stats.miner == tx_context::sender(ctx), ENotOwner);
        stats.btc_payout_address = new_address;
    }

    /// Create a MinerRoundStats for the given round. Call once per round before
    /// the first share. Object is owned by the sender (the miner).
    ///
    /// Dedup: `MinerRoundRegistry` rejects a second `create_round_stats`
    /// for the same `(sender, round_id)` pair. This is the on-chain
    /// guarantee that lets the reward claim path drop its `batch.claimed`
    /// shared-object write — exactly one MinerWorkRecord per (miner,
    /// round) means consumption-by-value of the MWR is sufficient dedup.
    ///
    /// `min_height` should be set to pool.current_height at call time so the miner
    /// cannot submit shares against a block height that was already superseded.
    #[allow(lint(self_transfer))]
    public fun create_round_stats(
        registry: &mut MinerRoundRegistry,
        round_id: u64,
        min_height: u64,
        ctx: &mut TxContext,
    ) {
        let sender = tx_context::sender(ctx);
        let key = MinerRoundKey { miner: sender, round_id };
        assert!(!dynamic_field::exists(&registry.id, key), EDuplicateRoundStats);
        dynamic_field::add(&mut registry.id, key, true);
        let mrs = MinerRoundStats {
            id: object::new(ctx),
            round_id,
            miner: sender,
            work: 0,
            shares: 0,
            sold_work: 0,
            sold_shares: 0,
            min_height,
        };
        transfer::transfer(mrs, sender);
    }

    /// Reclaim storage rent for a completed round's stats.
    public fun close_miner_round_stats(mrs: MinerRoundStats, ctx: &mut TxContext) {
        let sender = tx_context::sender(ctx);
        assert!(mrs.miner == sender, ENotOwner);
        let MinerRoundStats { id, round_id: _, miner: _, work: _, shares: _, sold_work: _, sold_shares: _, min_height: _ } = mrs;
        object::delete(id);
    }

    // ── Package-internal mutators ─────────────────────────────────────────────

    /// Consume and delete a MinerRoundStats object after counting.
    /// Called by pool::accumulate_*_stats — prevents double-accumulation.
    public(package) fun delete_round_stats(mrs: MinerRoundStats) {
        let MinerRoundStats { id, round_id: _, miner: _, work: _, shares: _, sold_work: _, sold_shares: _, min_height: _ } = mrs;
        object::delete(id);
    }

    public(package) fun record_share(
        stats: &mut MinerStats,
        mrs: &mut MinerRoundStats,
        difficulty: u64,
        is_block: bool,
        expected_round: u64,
        height: u64,
    ) {
        assert!(mrs.round_id == expected_round, ERoundMismatch);
        assert!(mrs.miner == stats.miner, ENotOwner);
        assert!(height >= mrs.min_height, EStaleTemplate);

        stats.total_shares = stats.total_shares + 1;
        if (is_block) {
            stats.blocks_found = stats.blocks_found + 1;
        };

        mrs.work = mrs.work + (difficulty as u128);
        mrs.shares = mrs.shares + 1;
        mrs.min_height = height;
    }

    /// Called by market::fill_buy_order to deduct a sold share from pool-reward accounting.
    /// The miner must pass their own MRS for the matching round.
    public(package) fun record_sold_share(
        mrs: &mut MinerRoundStats,
        miner: address,
        difficulty: u64,
        round_id: u64,
    ) {
        assert!(mrs.round_id == round_id, ERoundMismatch);
        assert!(mrs.miner == miner, EMinerMismatch);
        mrs.sold_work   = mrs.sold_work   + (difficulty as u128);
        mrs.sold_shares = mrs.sold_shares + 1;
    }

    // ── Test Helpers ──────────────────────────────────────────────────────────

    #[test_only]
    public fun record_share_for_testing(
        stats: &mut MinerStats,
        mrs: &mut MinerRoundStats,
        difficulty: u64,
        is_block: bool,
        expected_round: u64,
        height: u64,
    ) {
        record_share(stats, mrs, difficulty, is_block, expected_round, height);
    }

    #[test_only]
    public fun record_sold_share_for_testing(
        mrs: &mut MinerRoundStats,
        miner: address,
        difficulty: u64,
        round_id: u64,
    ) {
        record_sold_share(mrs, miner, difficulty, round_id);
    }

    // ── Read accessors ────────────────────────────────────────────────────────

    public fun miner_address(stats: &MinerStats): address { stats.miner }
    public fun total_shares(stats: &MinerStats): u64 { stats.total_shares }
    public fun blocks_found(stats: &MinerStats): u64 { stats.blocks_found }
    public fun btc_payout_address(stats: &MinerStats): vector<u8> { stats.btc_payout_address }

    public fun mrs_round_id(mrs: &MinerRoundStats): u64 { mrs.round_id }
    public fun mrs_miner(mrs: &MinerRoundStats): address { mrs.miner }
    public fun mrs_work(mrs: &MinerRoundStats): u128 { mrs.work }
    public fun mrs_shares(mrs: &MinerRoundStats): u64 { mrs.shares }
    public fun mrs_sold_work(mrs: &MinerRoundStats): u128 { mrs.sold_work }
    public fun mrs_sold_shares(mrs: &MinerRoundStats): u64 { mrs.sold_shares }
    public fun mrs_min_height(mrs: &MinerRoundStats): u64 { mrs.min_height }
}
