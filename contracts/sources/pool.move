/// m1n3 — Decentralized Bitcoin Mining Pool on Sui (v5, optimal design)
///
/// Scalability architecture:
///
///   SHARED objects (consensus required, touched as rarely as possible):
///     Pool         — global state; written only at round close (~once per Bitcoin block)
///
///   IMMUTABLE objects (no consensus on read — treated as constants by the scheduler):
///     Template     — mining job; frozen on creation, readable by any tx without consensus
///
///   OWNED objects (no consensus, fully parallel between miners):
///     MinerStats       — per miner, lifetime stats
///     MinerRoundStats  — per (miner, round), work accumulator
///     ShareDedup       — per (miner, template), hash dedup via dynamic fields
///
/// Hot path (submit_share): reads frozen Template (no consensus) + writes owned objects only.
/// Every miner runs in a fully independent lane — unbounded parallelism, no cross-miner
/// contention. The consensus ceiling is lifted entirely from share submission.
///
/// Round close: two-phase accumulate → finalize; Pool written exactly once per round.
///
/// Template lifecycle:
///   1. Admin calls register_template → snapshots round/difficulty → freeze_object(template)
///   2. Miners call submit_share (immutable read + owned writes — consensus-bypassed)
///   3. Block found → open_round_accumulator → accumulate_* → finalize_round
///   4. Admin calls register_template for the next round
///   5. Miner calls share_dedup::close_share_dedup to reclaim storage rent
///   Retired templates need no explicit deactivation — shares against an old round_id
///   fail ERoundMismatch in miner::record_share.
module m1n3_v4::pool {
    use sui::event;
    use sui::clock::{Self, Clock};
    use m1n3_v4::miner::{Self, MinerStats, MinerRoundStats};
    use m1n3_v4::share_dedup::{Self, ShareDedup};
    use m1n3_v4::btc_math;

    // ── Constants ─────────────────────────────────────────────────────────────

    const MIN_DIFFICULTY: u64 = 1;
    const MAX_DIFFICULTY: u64 = 1_000_000_000_000_000;
    const MAX_NTIME_OFFSET_SECONDS: u32 = 7200;
    const VERSION_ROLLING_MASK: u32 = 0x1fffe000;
    /// Miners have this long to self-accumulate after a block is found.
    const ACCUMULATION_WINDOW_MS: u64 = 5_000;

    // ── Error codes ───────────────────────────────────────────────────────────

    #[error]
    const EShareDoesNotMeetDifficulty: vector<u8> = b"Share hash does not meet the pool's difficulty target";
    #[error]
    const ENotAdmin: vector<u8> = b"Caller does not hold the PoolAdminCap";
    #[error]
    const EInvalidVersionRolling: vector<u8> = b"Miner-rolled version bits violate BIP-320 mask";
    #[error]
    const EInvalidNtime: vector<u8> = b"Share ntime is outside the allowed window (too old or too far in future)";
    #[error]
    const EWrongTemplate: vector<u8> = b"Share references a template that does not belong to this pool";
    #[error]
    const EWrongMiner: vector<u8> = b"MinerRoundStats does not belong to the transaction sender";
    #[error]
    const ERoundMismatch: vector<u8> = b"BlockFoundClaim round_id does not match pool.current_round";
    #[error]
    const EAccumulationWindowOpen: vector<u8> = b"Accumulation window is still open; finalize_round must wait";

    // ── Shared objects ────────────────────────────────────────────────────────

    /// Global pool state. Written only at round close (once per Bitcoin block).
    public struct Pool has key {
        id: UID,
        admin: address,
        total_blocks: u64,
        total_shares: u64,
        current_round: u64,
        round_start_ms: u64,
        global_min_difficulty: u64,
        /// True while a RoundAccumulator is live for current_round.
        /// Prevents duplicate accumulators per round.
        accumulator_open: bool,
        /// Block height of the most recently registered template.
        /// Read by callers of create_round_stats to anchor their MinerRoundStats
        /// so shares against superseded block heights are rejected.
        current_height: u64,
    }

    /// Admin capability — a transferable object that grants pool admin rights.
    public struct PoolAdminCap has key, store { id: UID }

    /// Mining job template. Frozen (immutable) immediately after creation so that
    /// submit_share can read it without going through consensus — the transaction
    /// then only touches owned objects and is fully consensus-bypassed.
    ///
    /// The `round_id` and `min_difficulty` are snapshotted from Pool at creation
    /// so submit_share never needs to read Pool either.
    ///
    /// Retirement: no explicit deactivation. Shares submitted against a retired
    /// template's round_id fail ERoundMismatch in miner::record_share.
    public struct Template has key {
        id: UID,
        height: u64,
        prev_block_hash: vector<u8>,
        coinbase1: vector<u8>,
        coinbase2: vector<u8>,
        merkle_branches: vector<vector<u8>>,
        version: u32,
        nbits: u32,
        ntime: u32,
        owner: address,
        created_at_ms: u64,
        round_id: u64,
        min_difficulty: u64,
        cached_network_difficulty: u64,
    }

    /// Shared accumulator that collects MinerRoundStats across multiple transactions
    /// before a round is finalised. One per round, created by open_round_accumulator
    /// and destroyed by finalize_round.
    public struct RoundAccumulator has key {
        id: UID,
        round_id: u64,
        total_work: u128,
        total_shares: u64,
        created_at_ms: u64,
        /// Miner who submitted the winning share. Read from the BlockFound event
        /// by the admin and passed into open_round_accumulator for on-chain persistence.
        block_finder: address,
        /// Bitcoin block height of the winning share.
        block_found_height: u64,
    }

    /// Frozen, immutable cryptographic proof that a particular miner submitted
    /// a share whose double-SHA256 header hash met the network difficulty
    /// for `round_id` at `height`. Created and `freeze_object`'d inside
    /// `submit_share` when `is_block == true`, so the block-finder identity
    /// is the Move runtime's `tx_context::sender(ctx)` — not a value an
    /// operator can choose. Used by `open_round_accumulator_from_claim` to
    /// open the round-close pipeline permissionlessly.
    public struct BlockFoundClaim has key {
        id: UID,
        round_id: u64,
        height: u64,
        block_finder: address,
        share_hash: vector<u8>,
        found_at_ms: u64,
    }

    /// Immutable snapshot of a completed round. Created by finalize_round.
    public struct RoundHistory has key {
        id: UID,
        round_id: u64,
        total_work: u128,
        total_shares: u64,
        closed_at_ms: u64,
        /// Miner who found the block — receives the coinbase tx fees.
        block_finder: address,
        /// Bitcoin block height that was found.
        block_found_height: u64,
    }

    // ── Events ────────────────────────────────────────────────────────────────

    public struct TemplateRegistered has copy, drop {
        template_id: ID,
        height: u64,
        round_id: u64,
        owner: address,
        timestamp_ms: u64,
    }

    /// Single event per accepted share — replaces the former ShareAccepted + ShareHashRecorded pair.
    /// Halves per-share event gas cost while preserving all indexable fields.
    public struct ShareSubmitted has copy, drop {
        miner: address,
        template_id: ID,
        round_id: u64,
        share_hash: vector<u8>,
        difficulty: u64,
        is_block: bool,
        timestamp_ms: u64,
    }

    public struct BlockFound has copy, drop {
        miner: address,
        height: u64,
        round_id: u64,
        timestamp_ms: u64,
        /// Address of the frozen BlockFoundClaim object. Lets off-chain code
        /// discover the claim immediately and call open_round_accumulator_from_claim
        /// without scanning object changes.
        claim_id: address,
    }

    public struct RoundClosed has copy, drop {
        round_id: u64,
        total_work: u128,
        total_shares: u64,
        closed_at_ms: u64,
    }

    /// Emitted when a RoundAccumulator is opened so sidecars know they can accumulate.
    public struct RoundAccumulatorOpened has copy, drop {
        round_id: u64,
        accumulator_id: address,
        block_finder: address,
        block_found_height: u64,
    }

    /// Emitted by accumulate_miner_stats — permanent per-miner accountability record.
    /// After this event exists on-chain the miner may safely delete their MinerRoundStats
    /// and recover the storage rebate without losing proof of their contribution.
    public struct MinerWorkAccumulated has copy, drop {
        miner: address,
        round_id: u64,
        work: u128,
        shares: u64,
    }

    /// Hot-potato proof that a valid share was submitted in this transaction.
    /// Proof of a miner's net work contribution for a completed round.
    /// Created by accumulate_*_stats and transferred (owned) to the miner.
    /// Consumed by reward modules to compute proportional payouts on-chain —
    /// eliminates the need for the operator to pre-compute per-miner amounts.
    public struct MinerWorkRecord has key, store {
        id: UID,
        round_id: u64,
        miner: address,
        net_work: u128,
    }

    /// Returned by submit_share and consumed by market::fill_buy_order in the same PTB.
    public struct ShareReceipt has drop {
        miner: address,
        template_owner: address,
        difficulty: u64,
        round_id: u64,
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    fun init(ctx: &mut TxContext) {
        let sender = tx_context::sender(ctx);
        let pool = Pool {
            id: object::new(ctx),
            admin: sender,
            total_blocks: 0,
            total_shares: 0,
            current_round: 0,
            round_start_ms: 0,
            global_min_difficulty: MIN_DIFFICULTY,
            accumulator_open: false,
            current_height: 0,
        };
        let cap = PoolAdminCap { id: object::new(ctx) };
        transfer::share_object(pool);
        transfer::transfer(cap, sender);
    }

    // ── Template lifecycle ────────────────────────────────────────────────────

    /// Register a mining job template. Reads Pool.current_round and
    /// Pool.global_min_difficulty once, embeds them in the Template so that
    /// subsequent share submissions never need to read Pool.
    /// Also advances pool.current_height so callers of create_round_stats
    /// can anchor their MinerRoundStats to the latest known block height.
    public fun register_template(
        pool: &mut Pool,
        _cap: &PoolAdminCap,
        clock: &Clock,
        height: u64,
        prev_block_hash: vector<u8>,
        coinbase1: vector<u8>,
        coinbase2: vector<u8>,
        merkle_branches: vector<vector<u8>>,
        version: u32,
        nbits: u32,
        ntime: u32,
        ctx: &mut TxContext,
    ) {
        let now = clock::timestamp_ms(clock);
        let round_id = pool.current_round;
        let min_difficulty = pool.global_min_difficulty;

        if (height > pool.current_height) {
            pool.current_height = height;
        };

        let template = Template {
            id: object::new(ctx),
            height,
            prev_block_hash,
            coinbase1,
            coinbase2,
            merkle_branches,
            version,
            nbits,
            ntime,
            owner: tx_context::sender(ctx),
            created_at_ms: now,
            round_id,
            min_difficulty,
            cached_network_difficulty: nbits_to_difficulty(nbits),
        };

        let tid = object::id(&template);
        event::emit(TemplateRegistered {
            template_id: tid,
            height,
            round_id,
            owner: tx_context::sender(ctx),
            timestamp_ms: now,
        });

        // Freeze makes the Template immutable — submit_share reads it without
        // consensus, turning every share submission into a fast-path owned-object tx.
        transfer::freeze_object(template);
    }

    // ── Share submission — the hot path ───────────────────────────────────────
    //
    //  Touched objects:
    //    Template        — shared, READ-ONLY (write-once after creation; never conflicts)
    //    MinerStats      — OWNED by miner, no consensus
    //    MinerRoundStats — OWNED by miner, no consensus
    //    ShareDedup      — OWNED by miner, no consensus (dynamic field per hash)
    //
    //  Pool is NOT touched. N miners run in full parallel.
    //  Template is never mutated after register_template (update_template removed);
    //  all mempool changes go through a fresh register_template call instead.

    /// Submit a single mining share.
    ///
    /// extranonce1 is assigned by the stratum server per connection (traditional pool
    /// behaviour — partitions the nonce space, prevents hash collisions between miners).
    ///
    /// The sender must own the MinerStats object (verified below), providing
    /// unforgeable on-chain proof of who found a share or block.
    public fun submit_share(
        template: &Template,
        miner_stats: &mut MinerStats,
        miner_round_stats: &mut MinerRoundStats,
        share_dedup: &mut ShareDedup,
        extranonce1: vector<u8>,
        extranonce2: vector<u8>,
        ntime: u32,
        nonce: u32,
        version: u32,
        clock: &Clock,
        ctx: &mut TxContext,
    ): ShareReceipt {
        let sender = tx_context::sender(ctx);
        let now = clock::timestamp_ms(clock);

        // Ownership checks — miner must own the objects they pass.
        assert!(miner::miner_address(miner_stats) == sender, EWrongMiner);
        assert!(share_dedup::miner(share_dedup) == sender, EWrongMiner);
        assert!(share_dedup::template_id(share_dedup) == object::id(template), EWrongTemplate);

        // Template validity.
        assert!((version ^ template.version) & (0xFFFFFFFF ^ VERSION_ROLLING_MASK) == 0, EInvalidVersionRolling);

        let tpl_ntime = template.ntime;
        let min_ntime = if (tpl_ntime > MAX_NTIME_OFFSET_SECONDS) { tpl_ntime - MAX_NTIME_OFFSET_SECONDS } else { 0 };
        assert!(ntime >= min_ntime && ntime <= tpl_ntime + MAX_NTIME_OFFSET_SECONDS, EInvalidNtime);

        // Build coinbase: coinbase1 | extranonce1 | extranonce2 | coinbase2
        // Must match exactly what the stratum server sent the miner.
        // Miner identity is committed via MinerStats ownership on Sui (enforced above).
        let mut coinbase = vector[];
        vector::append(&mut coinbase, template.coinbase1);
        vector::append(&mut coinbase, extranonce1);
        vector::append(&mut coinbase, extranonce2);
        vector::append(&mut coinbase, template.coinbase2);
        let coinbase_hash = btc_math::sha256d(coinbase);

        // Merkle root.
        let mut current = coinbase_hash;
        let nb = vector::length(&template.merkle_branches);
        let mut b = 0u64;
        while (b < nb) {
            let branch = vector::borrow(&template.merkle_branches, b);
            let mut combined = vector[];
            vector::append(&mut combined, current);
            vector::append(&mut combined, *branch);
            current = btc_math::sha256d(combined);
            b = b + 1;
        };
        let merkle_root = current;

        // Block header.
        let mut header = vector[];
        btc_math::append_u32_le(&mut header, version);
        vector::append(&mut header, template.prev_block_hash);
        vector::append(&mut header, merkle_root);
        btc_math::append_u32_le(&mut header, ntime);
        btc_math::append_u32_le(&mut header, template.nbits);
        btc_math::append_u32_le(&mut header, nonce);
        let share_hash = btc_math::sha256d(header);

        // Difficulty check.
        let difficulty = difficulty_from_hash(&share_hash);
        assert!(difficulty >= template.min_difficulty, EShareDoesNotMeetDifficulty);

        // Dedup — O(1) dynamic field lookup, no shared state.
        share_dedup::check_and_record(share_dedup, share_hash);

        // Accumulate work into owned objects — zero consensus.
        let is_block = difficulty >= template.cached_network_difficulty;
        miner::record_share(miner_stats, miner_round_stats, difficulty, is_block, template.round_id, template.height);

        event::emit(ShareSubmitted {
            miner: sender,
            template_id: object::id(template),
            round_id: template.round_id,
            share_hash,
            difficulty,
            is_block,
            timestamp_ms: now,
        });

        if (is_block) {
            // Mint a cryptographic, frozen proof that THIS sender found the
            // block at this height/round. Trustless variant of the block-finder
            // declaration that used to live in `open_round_accumulator` — no
            // operator can lie about who found the block because the claim
            // object's `block_finder` field is the runtime-attested sender.
            let claim = BlockFoundClaim {
                id: object::new(ctx),
                round_id: template.round_id,
                height: template.height,
                block_finder: sender,
                share_hash,
                found_at_ms: now,
            };
            let claim_id = object::id_to_address(object::borrow_id(&claim));
            event::emit(BlockFound {
                miner: sender,
                height: template.height,
                round_id: template.round_id,
                timestamp_ms: now,
                claim_id,
            });
            transfer::freeze_object(claim);
        };

        ShareReceipt {
            miner: sender,
            template_owner: template.owner,
            difficulty,
            round_id: template.round_id,
        }
    }

    // ── Round close — batched, unbounded miner count ─────────────────────────
    //
    //  Sui transactions cap input objects at ~2048. A single close_round call
    //  accepting all MinerRoundStats would fail above that threshold. Instead we
    //  use a two-phase pattern:
    //
    //    Phase 1 — accumulate (1..N calls, each up to ~500 MinerRoundStats):
    //      open_round_accumulator  → creates a RoundAccumulator for pool.current_round
    //      accumulate_round_stats  → drains a batch of MinerRoundStats into it
    //
    //    Phase 2 — finalise (1 call):
    //      finalize_round          → snapshots totals, advances pool.current_round,
    //                                destroys the accumulator
    //
    //  The accumulator is a shared object so the operator-bot can drive multiple
    //  accumulate_round_stats transactions in parallel from different signers if needed.

    /// Create a RoundAccumulator for the current round.
    /// Permissionless trustless open: the caller passes the frozen
    /// `BlockFoundClaim` emitted by `submit_share` when a block-difficulty
    /// share was accepted. The claim's `block_finder` and `height` are
    /// cryptographically attested by the Move runtime — no operator
    /// discretion. Anyone can run this (the finder, a watcher, another
    /// miner). Idempotent-safe like its admin sibling.
    ///
    /// The claim's `round_id` must equal the pool's current round; stale
    /// or wrong-round claims abort rather than silently transitioning into
    /// the wrong round.
    public fun open_round_accumulator_from_claim(
        pool: &mut Pool,
        claim: &BlockFoundClaim,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(claim.round_id == pool.current_round, ERoundMismatch);
        if (pool.accumulator_open) { return };
        pool.accumulator_open = true;
        let now = clock::timestamp_ms(clock);
        let acc = RoundAccumulator {
            id: object::new(ctx),
            round_id: pool.current_round,
            total_work: 0,
            total_shares: 0,
            created_at_ms: now,
            block_finder: claim.block_finder,
            block_found_height: claim.height,
        };
        let accumulator_id = object::id_to_address(object::borrow_id(&acc));
        event::emit(RoundAccumulatorOpened {
            round_id: pool.current_round,
            accumulator_id,
            block_finder: claim.block_finder,
            block_found_height: claim.height,
        });
        transfer::share_object(acc);
    }

    // ── Read accessors for BlockFoundClaim ────────────────────────────────────

    public fun claim_round_id(c: &BlockFoundClaim): u64 { c.round_id }
    public fun claim_height(c: &BlockFoundClaim): u64 { c.height }
    public fun claim_block_finder(c: &BlockFoundClaim): address { c.block_finder }
    public fun claim_share_hash(c: &BlockFoundClaim): vector<u8> { c.share_hash }
    public fun claim_found_at_ms(c: &BlockFoundClaim): u64 { c.found_at_ms }

    /// Drain your own MinerRoundStats into the accumulator. No PoolAdminCap
    /// required.
    ///
    /// Each MinerRoundStats is CONSUMED (deleted) after being counted — not returned.
    /// This prevents a miner from accumulating the same object multiple times.
    /// The MinerWorkAccumulated event is the permanent on-chain proof of contribution;
    /// the miner reclaims the storage deposit when the object is deleted here.
    #[allow(lint(self_transfer))]
    public fun accumulate_miner_stats(
        acc: &mut RoundAccumulator,
        mut mrs_vec: vector<MinerRoundStats>,
        ctx: &mut TxContext,
    ) {
        let caller = tx_context::sender(ctx);
        while (!vector::is_empty(&mrs_vec)) {
            let mrs = vector::pop_back(&mut mrs_vec);
            // Only count MRS that belong to the caller and match the open round.
            // Silently skip (and delete) stale or mismatched objects.
            assert!(miner::mrs_miner(&mrs) == caller, EWrongMiner);
            if (miner::mrs_round_id(&mrs) == acc.round_id) {
                let work        = miner::mrs_work(&mrs);
                let shares      = miner::mrs_shares(&mrs);
                let sold_work   = miner::mrs_sold_work(&mrs);
                let sold_shares = miner::mrs_sold_shares(&mrs);
                let net_work    = if (sold_work >= work) { 0u128 } else { work - sold_work };
                let net_shares  = if (sold_shares >= shares) { 0u64 } else { shares - sold_shares };
                acc.total_work   = acc.total_work   + net_work;
                acc.total_shares = acc.total_shares + net_shares;
                // Skip record creation for fully-sold miners: they have nothing to claim (M-4).
                if (net_work > 0) {
                    event::emit(MinerWorkAccumulated {
                        miner:    caller,
                        round_id: acc.round_id,
                        work:     net_work,
                        shares:   net_shares,
                    });
                    transfer::transfer(MinerWorkRecord {
                        id: object::new(ctx),
                        round_id: acc.round_id,
                        miner: caller,
                        net_work,
                    }, caller);
                };
            };
            // Consume the object — prevents double-accumulation.
            miner::delete_round_stats(mrs);
        };
        vector::destroy_empty(mrs_vec);
    }

    /// Finalise the round once all MinerRoundStats have been accumulated.
    /// Permissionless — anyone can call this after ACCUMULATION_WINDOW_MS has elapsed.
    /// Advances pool.current_round, emits RoundClosed, creates an immutable
    /// RoundHistory snapshot, and destroys the accumulator.
    public fun finalize_round(
        pool: &mut Pool,
        acc: RoundAccumulator,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(acc.round_id == pool.current_round, ERoundMismatch);
        let now = clock::timestamp_ms(clock);
        assert!(now >= acc.created_at_ms + ACCUMULATION_WINDOW_MS, EAccumulationWindowOpen);

        let closing_round = acc.round_id;
        let total_work = acc.total_work;
        let total_shares = acc.total_shares;
        let block_finder = acc.block_finder;
        let block_found_height = acc.block_found_height;

        let RoundAccumulator { id, round_id: _, total_work: _, total_shares: _, created_at_ms: _, block_finder: _, block_found_height: _ } = acc;
        object::delete(id);

        pool.accumulator_open = false;
        pool.current_round = pool.current_round + 1;
        pool.total_blocks = pool.total_blocks + 1;
        pool.total_shares = pool.total_shares + total_shares;
        pool.round_start_ms = now;

        event::emit(RoundClosed {
            round_id: closing_round,
            total_work,
            total_shares,
            closed_at_ms: now,
        });

        let rh = RoundHistory {
            id: object::new(ctx),
            round_id: closing_round,
            total_work,
            total_shares,
            closed_at_ms: now,
            block_finder,
            block_found_height,
        };
        transfer::freeze_object(rh);
    }

    // ── Admin functions ───────────────────────────────────────────────────────

    public fun reset_difficulty(pool: &mut Pool, _cap: &PoolAdminCap) {
        pool.global_min_difficulty = MIN_DIFFICULTY;
    }

    public fun set_difficulty(pool: &mut Pool, _cap: &PoolAdminCap, diff: u64) {
        assert!(diff >= MIN_DIFFICULTY && diff <= MAX_DIFFICULTY, ENotAdmin);
        pool.global_min_difficulty = diff;
    }

    // ── Math helpers ──────────────────────────────────────────────────────────

    /// Compact difficulty formula matching the stratum server:
    /// read the top 8 significant bytes of the hash (scanning from byte[31] = display
    /// byte[0] downward), then compute (0xFFFF * 2^exp) / top_bytes.
    /// This gives granular values even for sub-difficulty-1 hashes (devnet/regtest).
    fun difficulty_from_hash(hash: &vector<u8>): u64 {
        // Find the most-significant non-zero byte scanning from index 31 downward.
        // byte[31] corresponds to display byte[0] (Bitcoin reverses for display).
        let mut msb: u64 = 31;
        while (msb > 0 && *vector::borrow(hash, msb) == 0) {
            msb = msb - 1;
        };

        // Read up to 8 bytes starting at msb, big-endian within that window.
        let bytes_to_read: u64 = if (msb >= 7) { 8 } else { msb + 1 };
        let mut hash_val: u64 = 0;
        let mut i: u64 = 0;
        while (i < bytes_to_read) {
            hash_val = (hash_val << 8) | (*vector::borrow(hash, msb - i) as u64);
            i = i + 1;
        };
        if (hash_val == 0) { return MAX_DIFFICULTY };

        // lsb_pos = index of the least-significant byte we read.
        // exp = 208 - 8 * lsb_pos  (same anchor as Bitcoin's diff1 = 0xFFFF << 208)
        let lsb_pos: u64 = msb - bytes_to_read + 1;
        // exp can be negative (large hash → easy share); use u256 to handle both sides.
        let diff1: u256 = 0xFFFFu256;
        if (lsb_pos <= 26) {
            // exp = 208 - 8*lsb_pos >= 0  →  numerator = diff1 << exp
            let exp: u8 = ((208 - 8 * lsb_pos) as u8);
            let numerator: u256 = diff1 << exp;
            let d = numerator / (hash_val as u256);
            if (d == 0) { 1 }
            else if (d > (MAX_DIFFICULTY as u256)) { MAX_DIFFICULTY }
            else { (d as u64) }
        } else {
            // exp < 0  →  lsb_pos > 26  →  hash is harder than diff1 (very rare on devnet)
            let neg_exp: u8 = ((8 * lsb_pos - 208) as u8);
            let denominator: u256 = (hash_val as u256) << neg_exp;
            let d = diff1 / denominator;
            if (d == 0) { 1 }
            else { (d as u64) }
        }
    }

    fun nbits_to_difficulty(nbits: u32): u64 {
        let exponent = ((nbits >> 24) & 0xFF) as u64;
        let mantissa = (nbits & 0x00FFFFFF) as u256;
        if (mantissa == 0 || exponent == 0) { return MAX_DIFFICULTY };
        let target: u256 = if (exponent >= 3) {
            let shift = (exponent - 3) * 8;
            if (shift >= 256) { return 1 };
            mantissa << (shift as u8)
        } else {
            let shift = (3 - exponent) * 8;
            if (shift >= 64) { return MAX_DIFFICULTY };
            mantissa >> (shift as u8)
        };
        if (target == 0) { return MAX_DIFFICULTY };
        let diff1: u256 = (0xFFFFu256) << 208;
        let d = diff1 / target;
        if (d > (MAX_DIFFICULTY as u256)) { MAX_DIFFICULTY }
        else if (d == 0) { 1 }
        else { (d as u64) }
    }

    // ── Read accessors ────────────────────────────────────────────────────────

    public fun current_round(pool: &Pool): u64 { pool.current_round }
    public fun current_height(pool: &Pool): u64 { pool.current_height }
    public fun total_blocks(pool: &Pool): u64 { pool.total_blocks }
    public fun total_shares(pool: &Pool): u64 { pool.total_shares }
    public fun admin(pool: &Pool): address { pool.admin }
    public fun global_min_difficulty(pool: &Pool): u64 { pool.global_min_difficulty }

    public fun template_round_id(t: &Template): u64 { t.round_id }
    public fun template_height(t: &Template): u64 { t.height }
    public fun template_min_difficulty(t: &Template): u64 { t.min_difficulty }
    public fun template_network_difficulty(t: &Template): u64 { t.cached_network_difficulty }
    public fun template_id(t: &Template): ID { object::id(t) }
    public fun template_owner(t: &Template): address { t.owner }

    public fun receipt_miner(r: &ShareReceipt): address { r.miner }
    public fun receipt_template_owner(r: &ShareReceipt): address { r.template_owner }
    public fun receipt_difficulty(r: &ShareReceipt): u64 { r.difficulty }
    public fun receipt_round_id(r: &ShareReceipt): u64 { r.round_id }

    public fun round_history_round_id(rh: &RoundHistory): u64 { rh.round_id }
    public fun round_history_total_work(rh: &RoundHistory): u128 { rh.total_work }
    public fun round_history_total_shares(rh: &RoundHistory): u64 { rh.total_shares }
    public fun round_history_block_finder(rh: &RoundHistory): address { rh.block_finder }
    public fun round_history_block_found_height(rh: &RoundHistory): u64 { rh.block_found_height }

    public fun work_record_round_id(r: &MinerWorkRecord): u64 { r.round_id }
    public fun work_record_miner(r: &MinerWorkRecord): address { r.miner }
    public fun work_record_net_work(r: &MinerWorkRecord): u128 { r.net_work }

    /// Consume a MinerWorkRecord and return its fields. Called by reward modules
    /// (same package) to compute proportional payouts and prevent double-claiming.
    public(package) fun consume_work_record(r: MinerWorkRecord): (u64, address, u128) {
        let MinerWorkRecord { id, round_id, miner, net_work } = r;
        object::delete(id);
        (round_id, miner, net_work)
    }

    // ── Test helpers ──────────────────────────────────────────────────────────

    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) {
        init(ctx);
    }

    #[test_only]
    public fun accumulator_round_id(acc: &RoundAccumulator): u64 { acc.round_id }

    #[test_only]
    public fun accumulator_total_work(acc: &RoundAccumulator): u128 { acc.total_work }

    #[test_only]
    public fun template_id_as_address(t: &Template): address {
        object::id_to_address(&object::id(t))
    }

    #[test_only]
    public fun create_work_record_for_testing(
        round_id: u64,
        miner: address,
        net_work: u128,
        ctx: &mut TxContext,
    ): MinerWorkRecord {
        MinerWorkRecord { id: object::new(ctx), round_id, miner, net_work }
    }

    #[test_only]
    public fun create_round_history_for_testing(
        round_id: u64,
        total_work: u128,
        total_shares: u64,
        block_finder: address,
        block_found_height: u64,
        ctx: &mut TxContext,
    ) {
        transfer::freeze_object(RoundHistory {
            id: object::new(ctx),
            round_id,
            total_work,
            total_shares,
            closed_at_ms: 0,
            block_finder,
            block_found_height,
        });
    }

    /// Synthesize a `ShareReceipt` for tests that need a specific difficulty
    /// value (`submit_share` against the regtest fixture always produces
    /// difficulty=1, which makes fee-percentage math degenerate to zero
    /// after floor-division). The receipt is `drop`-only and can be
    /// consumed by any function that takes one — but tests using it must
    /// also call `miner::record_sold_share` (or one of the receipt-consuming
    /// entries) to keep `MinerRoundStats` accounting consistent.
    #[test_only]
    public fun create_share_receipt_for_testing(
        miner: address,
        template_owner: address,
        difficulty: u64,
        round_id: u64,
    ): ShareReceipt {
        ShareReceipt { miner, template_owner, difficulty, round_id }
    }

    /// Freeze a synthetic BlockFoundClaim so tests can drive
    /// `hashi_pool::record_block_found` (which now requires a claim) without
    /// running the full submit_share dance.
    #[test_only]
    public fun create_block_found_claim_for_testing(
        round_id: u64,
        height: u64,
        block_finder: address,
        ctx: &mut TxContext,
    ) {
        transfer::freeze_object(BlockFoundClaim {
            id: object::new(ctx),
            round_id,
            height,
            block_finder,
            share_hash: x"0000000000000000000000000000000000000000000000000000000000000000",
            found_at_ms: 0,
        });
    }
}
