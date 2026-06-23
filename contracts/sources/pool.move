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
    use sui::coin::{Self, Coin};
    use sui::balance::{Self, Balance};
    use sui::sui::SUI;
    use m1n3_v4::miner::{Self, MinerStats, MinerRoundStats};
    use m1n3_v4::share_dedup::{Self, ShareDedup};
    use m1n3_v4::btc_math;

    // ── Constants ─────────────────────────────────────────────────────────────

    /// Floor on the per-share difficulty the pool will accept. Has to
    /// satisfy a load-bearing relationship with the HashShare bundle
    /// factor + the mint fee rate:
    ///
    ///   MIN_DIFFICULTY >= hash_share::BUNDLE_FACTOR
    ///       so every accepted share mints at least 1 Coin<HS_NNN>
    ///       (smaller shares would credit the round accumulator but
    ///       produce a zero-value mint — work without tradeable
    ///       representation, which is a UX bug).
    ///
    ///   MIN_DIFFICULTY >= BUNDLE_FACTOR × (bps_denom / fee_bps)
    ///       so the protocol fee never floor-divides to zero. With
    ///       BUNDLE_FACTOR=10_000 and fee_bps=100 (1%), that's
    ///       10_000 × 100 = 1_000_000.
    ///
    /// If `hash_share_registry::set_fee_bps` ever lowers the fee, the
    /// fee invariant relaxes (smaller multiplier). If it raises the
    /// fee, the floor here stays valid. If `BUNDLE_FACTOR` changes,
    /// this must be re-checked.
    const MIN_DIFFICULTY: u64 = 1_000_000;
    const MAX_DIFFICULTY: u64 = 1_000_000_000_000_000;
    const MAX_NTIME_OFFSET_SECONDS: u32 = 7200;
    const VERSION_ROLLING_MASK: u32 = 0x1fffe000;
    /// Miners have this long to self-accumulate after a block is found.
    const ACCUMULATION_WINDOW_MS: u64 = 5_000;
    /// Anti-spam fee for the permissionless `register_template_public`
    /// entrypoint, in MIST (1 MIST = 1e-9 SUI). Paid to `pool.admin`.
    /// At 0.01 SUI per template, spamming the pool costs ~$0.05 / tpl at
    /// SUI = $5 — high enough to deter griefers, low enough that a
    /// legitimate buyer publishing one template per Bitcoin block (~144
    /// per day) pays ~$7/day. The operator's PoolAdminCap path bypasses
    /// this fee entirely (`register_template`).
    const PERMISSIONLESS_TEMPLATE_FEE_MIST: u64 = 10_000_000;
    /// Hard cap on `Template.merkle_branches.length`. Bitcoin's merkle tree
    /// has depth ceil(log2(N_tx)); a block with 2^32 transactions would have
    /// 32 branches, and Bitcoin's protocol-level tx-count limit is far lower.
    /// 64 gives a generous safety margin while bounding the per-share gas
    /// cost of `submit_share`'s merkle-root recomputation loop — without
    /// this cap, a single `register_template_public` call (0.01 SUI) can
    /// publish a template with millions of fake branches, forcing every
    /// miner that hashes against it to pay unbounded SHA256d gas.
    const MAX_MERKLE_BRANCHES: u64 = 64;

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
    const EWrongTemplate: vector<u8> = b"ShareDedup.round_id does not match the template's round_id";
    #[error]
    const EWrongMiner: vector<u8> = b"MinerRoundStats does not belong to the transaction sender";
    #[error]
    const ERoundMismatch: vector<u8> = b"BlockFoundClaim round_id does not match pool.current_round";
    #[error]
    const EAccumulationWindowOpen: vector<u8> = b"Accumulation window is still open; finalize_round must wait";
    #[error]
    const EInsufficientTemplateFee: vector<u8> = b"Coin<SUI> attached to register_template_public is below PERMISSIONLESS_TEMPLATE_FEE_MIST";
    #[error]
    const EDerivedCoinbase1Mismatch: vector<u8> = b"DerivedTemplate.coinbase1 must equal parent.coinbase1 byte-for-byte (extranonce position is fixed by the buyer)";
    #[error]
    const EDerivedNtimeOutOfWindow: vector<u8> = b"DerivedTemplate.ntime is outside MAX_NTIME_OFFSET_SECONDS of parent.ntime";
    #[error]
    const EBuyOrderTemplateMismatch: vector<u8> = b"Share submitted against a template that does not belong to this HashpowerBuyOrder";
    #[error]
    const EInsufficientHashpowerBudget: vector<u8> = b"HashpowerBuyOrder budget does not cover the payout for this share";
    #[error]
    const ENotHashpowerBuyOrderOwner: vector<u8> = b"Only the buy order's buyer can cancel / top up";
    #[error]
    const EHashpowerOrderExpired: vector<u8> = b"HashpowerBuyOrder.expires_epoch has passed; the order cannot accept new shares";
    #[error]
    const EZeroPrice: vector<u8> = b"HashpowerBuyOrder price_per_difficulty must be > 0";
    #[error]
    const EInvalidMerkleTree: vector<u8> = b"Template.merkle_branches.length exceeds MAX_MERKLE_BRANCHES";
    #[error]
    const EOrderNotDynamic: vector<u8> = b"HashpowerBuyOrder.is_dynamic == false; the buyer committed to a fixed price at creation";
    #[error]
    const EMpcScriptInvalidLength: vector<u8> = b"ProtocolMPCConfig.btc_script_pubkey must be a valid Bitcoin scriptPubKey length (22-34 bytes for common forms)";
    #[error]
    const EBuyerOrderTemplateOwnerMismatch: vector<u8> = b"Template owner is not this buyer; cannot drain this BuyerHashpowerOrder";

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
        register_template_inner(
            pool,
            clock,
            height,
            prev_block_hash,
            coinbase1,
            coinbase2,
            merkle_branches,
            version,
            nbits,
            ntime,
            ctx,
        );
    }

    /// Permissionless variant of `register_template`. Anyone can publish
    /// a Bitcoin block template (coinbase fields are caller-controlled,
    /// so the buyer's own scriptPubKey lands in the coinbase output —
    /// any block found against this template pays the BTC reward to
    /// whoever the caller chose), paying `PERMISSIONLESS_TEMPLATE_FEE_MIST`
    /// MIST in SUI as anti-spam. The fee is forwarded to `pool.admin`.
    ///
    /// Use case: a buyer running their own bitcoind wants miners to
    /// hash their template (e.g. to include specific transactions, or
    /// because they're committing to a particular set of OP_RETURN
    /// data) and is willing to pay USDC for the resulting HashShares.
    /// Combined with the existing market path (the buyer separately
    /// posts a `BuyOrder<HS_NNN, USDC>`) this turns into a "buy
    /// hashpower against my block template" rail.
    ///
    /// The resulting `Template.owner` is the calling buyer's address,
    /// so off-chain tooling can filter `TemplateRegistered` events by
    /// owner to surface "templates from buyer X" on the dapp.
    public fun register_template_public(
        pool: &mut Pool,
        fee: Coin<SUI>,
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
        assert!(
            coin::value(&fee) >= PERMISSIONLESS_TEMPLATE_FEE_MIST,
            EInsufficientTemplateFee,
        );
        transfer::public_transfer(fee, pool.admin);

        register_template_inner(
            pool,
            clock,
            height,
            prev_block_hash,
            coinbase1,
            coinbase2,
            merkle_branches,
            version,
            nbits,
            ntime,
            ctx,
        );
    }

    /// Shared body — handles the height ratchet, Template materialization,
    /// `TemplateRegistered` event, and freeze. Both entrypoints
    /// (`register_template` with the admin cap and `register_template_public`
    /// with the SUI fee) call into this; capability/fee checks are
    /// performed by the caller before we enter here, so the inner is
    /// trust-agnostic.
    fun register_template_inner(
        pool: &mut Pool,
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
        // Bound merkle depth — `submit_share` walks every branch in a
        // SHA256d loop, and `register_template_public` is permissionless,
        // so without this an attacker spending 0.01 SUI can publish a
        // template that forces every miner who hashes it to pay
        // unbounded gas. DerivedTemplate inherits `parent.merkle_branches`
        // so the bound carries through to the buyer-pay lane too.
        assert!(vector::length(&merkle_branches) <= MAX_MERKLE_BRANCHES, EInvalidMerkleTree);

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

    /// Off-chain helper: returns the MIST fee required by
    /// `register_template_public`. Lets tooling avoid hardcoding the
    /// constant and survive a future fee adjustment via package upgrade.
    public fun permissionless_template_fee_mist(): u64 {
        PERMISSIONLESS_TEMPLATE_FEE_MIST
    }

    // ── Protocol MPC config (fee-split lane) ──────────────────────────────────
    //
    // Holds the scriptPubKey of the BTC address that receives the tx-fee
    // portion of any block found against an MPC-split buyer template. The
    // protocol-controlled custodian (single P2TR for the MVP; multisig or
    // threshold MPC in the future) signs distribution txs off-chain to
    // forward those fees to miners per the order's policy.
    //
    // One shared `ProtocolMPCConfig` per package, created by the admin
    // via `create_mpc_config`. The address is rotatable through
    // `update_mpc_config` (also cap-gated). Lives on its own object so a
    // rotation tx doesn't touch the Pool.

    public struct ProtocolMPCConfig has key {
        id: UID,
        btc_script_pubkey: vector<u8>,
    }

    public struct ProtocolMPCConfigCreated has copy, drop {
        config_id: ID,
        btc_script_pubkey: vector<u8>,
    }

    public struct ProtocolMPCConfigUpdated has copy, drop {
        config_id: ID,
        old_script: vector<u8>,
        new_script: vector<u8>,
    }

    /// Admin creates the shared MPC config. Called once after the
    /// register_template_with_mpc upgrade lands. The script length is
    /// loosely validated against common Bitcoin scriptPubKey sizes; any
    /// future exotic script (taproot policies, etc.) can be enabled by
    /// expanding the bounds.
    public fun create_mpc_config(
        _cap: &PoolAdminCap,
        btc_script_pubkey: vector<u8>,
        ctx: &mut TxContext,
    ) {
        let n = vector::length(&btc_script_pubkey);
        // P2WPKH=22, P2PKH=25, P2SH=23, P2WSH=34, P2TR=34. Allow 22..=42 to
        // cover common forms plus a small forward-compat margin.
        assert!(n >= 22 && n <= 42, EMpcScriptInvalidLength);
        let cfg = ProtocolMPCConfig {
            id: object::new(ctx),
            btc_script_pubkey,
        };
        event::emit(ProtocolMPCConfigCreated {
            config_id: object::id(&cfg),
            btc_script_pubkey: cfg.btc_script_pubkey,
        });
        transfer::share_object(cfg);
    }

    /// Rotate the MPC script. Used when the custodian rotates keys or
    /// the protocol upgrades to a different multisig / real MPC.
    public fun update_mpc_config(
        cfg: &mut ProtocolMPCConfig,
        _cap: &PoolAdminCap,
        new_script: vector<u8>,
    ) {
        let n = vector::length(&new_script);
        assert!(n >= 22 && n <= 42, EMpcScriptInvalidLength);
        let old_script = cfg.btc_script_pubkey;
        cfg.btc_script_pubkey = new_script;
        event::emit(ProtocolMPCConfigUpdated {
            config_id: object::id(cfg),
            old_script,
            new_script: cfg.btc_script_pubkey,
        });
    }

    public fun mpc_config_script(cfg: &ProtocolMPCConfig): vector<u8> {
        cfg.btc_script_pubkey
    }

    // No on-chain coinbase-verification entry. Buyers use the existing
    // `register_template_public` for both lanes; miners verify off-chain
    // (against `mpc_config.btc_script_pubkey`) before committing
    // hashpower to a template that promises an MPC fee split. The
    // `verify_vout_1_script` helper in `btc_math` is kept available as a
    // pure utility for off-chain callers (WASM, indexers, future on-chain
    // hooks if the design tightens later).

    // ── Buyer-template lane: derived templates + hashpower buy orders ─────────
    //
    //  A second template lane that runs in parallel with the operator/round
    //  pipeline above. Whereas the operator's `Template` flows through round
    //  accumulation and HashShare→hBTC redemption, this lane is a direct
    //  exchange of mining work for USDC (or any quote coin) with no round
    //  binding, no HashShare mint, and no consensus on the hot path beyond
    //  the buy-order's Balance write.
    //
    //  Block-found bonus split:
    //    - Parent `Template` (registered by the buyer) has the buyer's BTC
    //      address as vout_0 of the coinbase. If the buyer wants the miner
    //      to receive tx fees as a bonus, they set vout_0's value to just
    //      the block subsidy, leaving the tx fees unallocated.
    //    - A miner who wants the bonus first calls
    //      `register_derived_template_public(&parent, ...)` to publish a
    //      `DerivedTemplate` that appends a second output paying their own
    //      BTC address. The contract verifies via byte-level coinbase parse
    //      that parent's vouts are preserved unchanged — the miner cannot
    //      redirect the buyer's reward.
    //    - The miner submits shares via `submit_share_for_pay_derived`.
    //      If a block is found, Bitcoin pays the buyer the subsidy at
    //      vout_0 and the miner the tx fees at vout_1.
    //    - A miner who skips the bonus (mines parent directly) calls
    //      `submit_share_for_pay` — saves the 0.01 SUI template fee but
    //      forfeits the tx-fee bonus.

    /// Buyer's parent template + miner's appended outputs. Same observable
    /// behavior as `Template` for `submit_share_for_pay_derived` (height,
    /// prev_block_hash, version, nbits, ntime, coinbase1, coinbase2,
    /// merkle_branches all participate in the same Bitcoin header hash),
    /// plus `parent_template_id` recording which buyer's template this
    /// derived from. Frozen at creation, just like `Template`.
    public struct DerivedTemplate has key {
        id: UID,
        parent_template_id: ID,
        /// Inherited from the parent at derivation time. Lets `submit_share_for_pay`
        /// share the per-(miner, round) ShareDedup scoping with the regular path.
        round_id: u64,
        height: u64,
        prev_block_hash: vector<u8>,
        coinbase1: vector<u8>,
        coinbase2: vector<u8>,
        merkle_branches: vector<vector<u8>>,
        version: u32,
        nbits: u32,
        ntime: u32,
        owner: address,            // the miner who published this derivation
        created_at_ms: u64,
        min_difficulty: u64,
        cached_network_difficulty: u64,
    }

    /// Buyer-funded order to purchase hashpower against `template_id`.
    /// Miners drain `budget` per share at `price_per_difficulty` µQuote
    /// per difficulty-1 unit of work. No round binding — payout happens
    /// inside `submit_share_for_pay(_derived)` and the miner receives the
    /// Coin<QuoteT> in the same PTB.
    public struct HashpowerBuyOrder<phantom QuoteT> has key {
        id: UID,
        buyer: address,
        /// The buyer's parent `Template`. Direct-mining shares must come
        /// from this template id; derived-template shares must reference
        /// a `DerivedTemplate` whose `parent_template_id == template_id`.
        template_id: ID,
        /// µQuote paid per difficulty-1 unit of share work. e.g. 17 means
        /// 17 µUSDC per difficulty-1; a difficulty-12 share earns 204 µUSDC.
        price_per_difficulty: u64,
        budget: Balance<QuoteT>,
        /// Optional epoch cutoff. Shares accepted only while
        /// tx_context::epoch(ctx) <= expires_epoch (or None).
        expires_epoch: Option<u64>,
        /// When `false`, the order's `price_per_difficulty` is immutable
        /// — `update_hashpower_order_price` aborts with `EOrderNotDynamic`.
        /// Lets miners distinguish "committed" buyers (fixed) from
        /// market-makers who'll re-price as hashrate cost moves
        /// (dynamic). Set at creation time; cannot be flipped later.
        is_dynamic: bool,
    }

    // ── Events for the buyer-template lane ────────────────────────────────────

    public struct DerivedTemplateRegistered has copy, drop {
        derived_template_id: ID,
        parent_template_id: ID,
        height: u64,
        miner: address,
        timestamp_ms: u64,
    }

    public struct HashpowerBuyOrderPlaced has copy, drop {
        order_id: ID,
        buyer: address,
        template_id: ID,
        price_per_difficulty: u64,
        initial_budget: u64,
        expires_epoch: Option<u64>,
        is_dynamic: bool,
    }

    public struct HashpowerBuyOrderPriceUpdated has copy, drop {
        order_id: ID,
        old_price: u64,
        new_price: u64,
    }

    public struct HashpowerBuyOrderToppedUp has copy, drop {
        order_id: ID,
        added: u64,
        new_budget: u64,
    }

    public struct HashpowerBuyOrderCanceled has copy, drop {
        order_id: ID,
        refunded: u64,
    }

    public struct HashpowerShareFilled has copy, drop {
        order_id: ID,
        miner: address,
        template_id: ID,
        /// `Some(derived_template_id)` if mined against a DerivedTemplate,
        /// `None` if mined against the parent Template directly.
        derived_template_id: Option<ID>,
        difficulty: u64,
        payout: u64,
        is_block: bool,
        timestamp_ms: u64,
    }

    // ── DerivedTemplate registration ──────────────────────────────────────────

    /// Permissionless: a miner publishes a derived template that appends
    /// their own coinbase output(s) on top of the buyer's `parent`. The
    /// contract verifies the derivation is honest — parent's coinbase
    /// vouts are preserved byte-for-byte, header fields match, ntime is
    /// within the standard rolling window. Charges the same anti-spam fee
    /// as `register_template_public`.
    public fun register_derived_template_public(
        parent: &Template,
        fee: Coin<SUI>,
        clock: &Clock,
        admin: address,
        coinbase1: vector<u8>,
        coinbase2: vector<u8>,
        ntime: u32,
        ctx: &mut TxContext,
    ) {
        assert!(
            coin::value(&fee) >= PERMISSIONLESS_TEMPLATE_FEE_MIST,
            EInsufficientTemplateFee,
        );
        transfer::public_transfer(fee, admin);

        // ── Header-equivalence: derived must hash to the same Bitcoin
        // block as parent (height, prev_hash, nbits, merkle_branches,
        // version). ntime within MAX_NTIME_OFFSET_SECONDS of parent's.
        let parent_ntime = parent.ntime;
        let min_ntime = if (parent_ntime > MAX_NTIME_OFFSET_SECONDS) {
            parent_ntime - MAX_NTIME_OFFSET_SECONDS
        } else { 0 };
        assert!(
            ntime >= min_ntime && ntime <= parent_ntime + MAX_NTIME_OFFSET_SECONDS,
            EDerivedNtimeOutOfWindow,
        );

        // coinbase1 (everything up to and including the extranonce position
        // in scriptSig) must be byte-exact — same scriptSig prefix means
        // the buyer's BIP34 height + their nonce bytes are preserved.
        assert!(coinbase1 == parent.coinbase1, EDerivedCoinbase1Mismatch);

        // coinbase2 — full byte-level structural check.
        // Aborts inside `verify_derived_coinbase` if parent's outputs are
        // not preserved at the same offsets, or if derived has the same/
        // fewer outputs, or if locktimes differ.
        btc_math::verify_derived_coinbase(&parent.coinbase2, &coinbase2);

        let now = clock::timestamp_ms(clock);
        let sender = tx_context::sender(ctx);
        let derived = DerivedTemplate {
            id: object::new(ctx),
            parent_template_id: object::id(parent),
            round_id: parent.round_id,
            height: parent.height,
            prev_block_hash: parent.prev_block_hash,
            coinbase1,
            coinbase2,
            merkle_branches: parent.merkle_branches,
            version: parent.version,
            nbits: parent.nbits,
            ntime,
            owner: sender,
            created_at_ms: now,
            min_difficulty: parent.min_difficulty,
            cached_network_difficulty: parent.cached_network_difficulty,
        };

        event::emit(DerivedTemplateRegistered {
            derived_template_id: object::id(&derived),
            parent_template_id: object::id(parent),
            height: parent.height,
            miner: sender,
            timestamp_ms: now,
        });

        transfer::freeze_object(derived);
    }

    // ── HashpowerBuyOrder lifecycle ───────────────────────────────────────────

    /// Buyer posts a hashpower order against their own parent template.
    /// Asserts the caller owns the template (so miners can rely on
    /// `template.owner == order.buyer` off-chain).
    ///
    /// `is_dynamic = true` makes the order's price re-pricable later via
    /// `update_hashpower_order_price`. `false` locks the price for the
    /// life of the order — useful for committed-rate "I'll pay X per
    /// share regardless of where hashprice moves" orders.
    public fun place_hashpower_order<QuoteT>(
        parent: &Template,
        payment: Coin<QuoteT>,
        price_per_difficulty: u64,
        expires_epoch: Option<u64>,
        is_dynamic: bool,
        ctx: &mut TxContext,
    ) {
        let sender = tx_context::sender(ctx);
        assert!(parent.owner == sender, ENotHashpowerBuyOrderOwner);
        assert!(price_per_difficulty > 0, EZeroPrice);

        let initial_budget = coin::value(&payment);
        let template_id = object::id(parent);
        let order = HashpowerBuyOrder<QuoteT> {
            id: object::new(ctx),
            buyer: sender,
            template_id,
            price_per_difficulty,
            budget: coin::into_balance(payment),
            expires_epoch,
            is_dynamic,
        };
        event::emit(HashpowerBuyOrderPlaced {
            order_id: object::id(&order),
            buyer: sender,
            template_id,
            price_per_difficulty,
            initial_budget,
            expires_epoch,
            is_dynamic,
        });
        transfer::share_object(order);
    }

    /// Buyer adjusts the per-difficulty payout. Only the buyer can call;
    /// only valid when the order was opened with `is_dynamic = true`. The
    /// new price must be > 0 (set to 0 → cancel via the order lifecycle).
    public fun update_hashpower_order_price<QuoteT>(
        order: &mut HashpowerBuyOrder<QuoteT>,
        new_price_per_difficulty: u64,
        ctx: &TxContext,
    ) {
        let sender = tx_context::sender(ctx);
        assert!(order.buyer == sender, ENotHashpowerBuyOrderOwner);
        assert!(order.is_dynamic, EOrderNotDynamic);
        assert!(new_price_per_difficulty > 0, EZeroPrice);
        let old_price = order.price_per_difficulty;
        order.price_per_difficulty = new_price_per_difficulty;
        event::emit(HashpowerBuyOrderPriceUpdated {
            order_id: object::id(order),
            old_price,
            new_price: new_price_per_difficulty,
        });
    }

    /// Buyer adds budget to an existing order. Anyone can technically call
    /// this (it doesn't require buyer signature on the budget) but the
    /// event still attributes the budget to the order itself.
    public fun top_up_hashpower_order<QuoteT>(
        order: &mut HashpowerBuyOrder<QuoteT>,
        payment: Coin<QuoteT>,
    ) {
        let added = coin::value(&payment);
        balance::join(&mut order.budget, coin::into_balance(payment));
        event::emit(HashpowerBuyOrderToppedUp {
            order_id: object::id(order),
            added,
            new_budget: balance::value(&order.budget),
        });
    }

    /// Buyer reclaims the remaining budget and tears down the order.
    /// The order object is consumed (shared object → deleted). Any miner
    /// share submission referencing this order id will then fail at
    /// `&mut order` resolution.
    public fun cancel_hashpower_order<QuoteT>(
        order: HashpowerBuyOrder<QuoteT>,
        ctx: &mut TxContext,
    ): Coin<QuoteT> {
        let sender = tx_context::sender(ctx);
        assert!(order.buyer == sender, ENotHashpowerBuyOrderOwner);
        let HashpowerBuyOrder { id, buyer: _, template_id: _, price_per_difficulty: _, mut budget, expires_epoch: _, is_dynamic: _ } = order;
        let order_id_addr = object::uid_to_address(&id);
        let refunded = balance::value(&budget);
        let refund = coin::from_balance(balance::withdraw_all(&mut budget), ctx);
        balance::destroy_zero(budget);
        event::emit(HashpowerBuyOrderCanceled {
            order_id: object::id_from_address(order_id_addr),
            refunded,
        });
        object::delete(id);
        refund
    }

    // ── Share submission against a HashpowerBuyOrder ──────────────────────────

    /// Direct-mine path: miner submits a share against the buyer's parent
    /// `template` (no derived template, no tx-fee bonus). Pays out
    /// `difficulty * order.price_per_difficulty` µQuote, returned as a
    /// `Coin<QuoteT>` for the miner's PTB to handle (transfer to self,
    /// merge with existing balance, etc.).
    ///
    /// Same share-validation logic as `submit_share`, including the dedup
    /// check and the BlockFoundClaim mint on block-difficulty shares.
    public fun submit_share_for_pay<QuoteT>(
        template: &Template,
        order: &mut HashpowerBuyOrder<QuoteT>,
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
    ): Coin<QuoteT> {
        // Link the order to this exact template — prevents a miner from
        // claiming USDC from order A by submitting shares against a totally
        // unrelated template B.
        assert!(object::id(template) == order.template_id, EBuyOrderTemplateMismatch);
        check_order_not_expired(order, ctx);

        let (sender, share_hash, difficulty, is_block, now) = validate_share_against_template(
            template,
            miner_stats,
            miner_round_stats,
            share_dedup,
            extranonce1,
            extranonce2,
            ntime,
            nonce,
            version,
            clock,
            ctx,
        );

        let payout = compute_payout(difficulty, order.price_per_difficulty);
        let coin_out = drain_order_budget(order, payout, ctx);

        event::emit(HashpowerShareFilled {
            order_id: object::id(order),
            miner: sender,
            template_id: object::id(template),
            derived_template_id: option::none(),
            difficulty,
            payout,
            is_block,
            timestamp_ms: now,
        });

        maybe_freeze_block_claim(
            is_block,
            template.round_id,
            template.height,
            sender,
            share_hash,
            now,
            ctx,
        );

        coin_out
    }

    /// Bonus-mine path: miner submits a share against a `DerivedTemplate`
    /// whose `parent_template_id == order.template_id`. The DerivedTemplate
    /// was already byte-verified against the buyer's parent at registration
    /// time, so by the time we get here we just need to check the parent
    /// linkage. Same payout math + Coin<QuoteT> return.
    public fun submit_share_for_pay_derived<QuoteT>(
        derived: &DerivedTemplate,
        order: &mut HashpowerBuyOrder<QuoteT>,
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
    ): Coin<QuoteT> {
        // The DerivedTemplate was verified against this parent at
        // registration time. Here we just check the buy order references
        // the same parent.
        assert!(derived.parent_template_id == order.template_id, EBuyOrderTemplateMismatch);
        check_order_not_expired(order, ctx);

        let (sender, share_hash, difficulty, is_block, now) = validate_share_against_derived(
            derived,
            miner_stats,
            miner_round_stats,
            share_dedup,
            extranonce1,
            extranonce2,
            ntime,
            nonce,
            version,
            clock,
            ctx,
        );

        let payout = compute_payout(difficulty, order.price_per_difficulty);
        let coin_out = drain_order_budget(order, payout, ctx);

        event::emit(HashpowerShareFilled {
            order_id: object::id(order),
            miner: sender,
            template_id: derived.parent_template_id,
            derived_template_id: option::some(object::id(derived)),
            difficulty,
            payout,
            is_block,
            timestamp_ms: now,
        });

        // For the derived path the round_id is NOT meaningful (this lane
        // is round-agnostic) but a BlockFoundClaim is still useful: any
        // observer can confirm a block-difficulty share came from this
        // miner. We use round_id = 0 as a sentinel for "buyer-template
        // lane" — there is no live RoundAccumulator to open.
        maybe_freeze_block_claim(
            is_block,
            0,
            derived.height,
            sender,
            share_hash,
            now,
            ctx,
        );

        coin_out
    }

    // ── Internal helpers for the buyer-template lane ──────────────────────────

    fun check_order_not_expired<QuoteT>(
        order: &HashpowerBuyOrder<QuoteT>,
        ctx: &TxContext,
    ) {
        if (option::is_some(&order.expires_epoch)) {
            let cutoff = *option::borrow(&order.expires_epoch);
            assert!(tx_context::epoch(ctx) <= cutoff, EHashpowerOrderExpired);
        };
    }

    fun compute_payout(difficulty: u64, price_per_difficulty: u64): u64 {
        // u64 * u64 fits in u128. Saturate at u64::MAX (impractical edge,
        // but better than wrap). Real values: difficulty ~1e6..1e9,
        // price ~10..1000 → payout ~1e7..1e12 µQuote.
        let p128 = (difficulty as u128) * (price_per_difficulty as u128);
        if (p128 > (18_446_744_073_709_551_615u128)) {
            18_446_744_073_709_551_615u64
        } else {
            p128 as u64
        }
    }

    fun drain_order_budget<QuoteT>(
        order: &mut HashpowerBuyOrder<QuoteT>,
        amount: u64,
        ctx: &mut TxContext,
    ): Coin<QuoteT> {
        assert!(balance::value(&order.budget) >= amount, EInsufficientHashpowerBudget);
        let part = balance::split(&mut order.budget, amount);
        coin::from_balance(part, ctx)
    }

    /// Share validation shared between `submit_share` and the new
    /// `submit_share_for_pay`. Returns (sender, share_hash, difficulty,
    /// is_block, now). Inlined here rather than refactoring `submit_share`
    /// to use it because `submit_share` is on the proven hot path and we
    /// don't want to perturb its gas profile or owned-object access
    /// pattern in this upgrade.
    fun validate_share_against_template(
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
    ): (address, vector<u8>, u64, bool, u64) {
        let sender = tx_context::sender(ctx);
        let now = clock::timestamp_ms(clock);

        assert!(miner::miner_address(miner_stats) == sender, EWrongMiner);
        assert!(share_dedup::miner(share_dedup) == sender, EWrongMiner);
        assert!(share_dedup::round_id(share_dedup) == template.round_id, EWrongTemplate);

        assert!((version ^ template.version) & (0xFFFFFFFF ^ VERSION_ROLLING_MASK) == 0, EInvalidVersionRolling);

        let tpl_ntime = template.ntime;
        let min_ntime = if (tpl_ntime > MAX_NTIME_OFFSET_SECONDS) { tpl_ntime - MAX_NTIME_OFFSET_SECONDS } else { 0 };
        assert!(ntime >= min_ntime && ntime <= tpl_ntime + MAX_NTIME_OFFSET_SECONDS, EInvalidNtime);

        let mut coinbase = vector[];
        vector::append(&mut coinbase, template.coinbase1);
        vector::append(&mut coinbase, extranonce1);
        vector::append(&mut coinbase, extranonce2);
        vector::append(&mut coinbase, template.coinbase2);
        let coinbase_hash = btc_math::sha256d(coinbase);

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

        let mut header = vector[];
        btc_math::append_u32_le(&mut header, version);
        vector::append(&mut header, template.prev_block_hash);
        vector::append(&mut header, merkle_root);
        btc_math::append_u32_le(&mut header, ntime);
        btc_math::append_u32_le(&mut header, template.nbits);
        btc_math::append_u32_le(&mut header, nonce);
        let share_hash = btc_math::sha256d(header);

        let difficulty = difficulty_from_hash(&share_hash);
        assert!(difficulty >= template.min_difficulty, EShareDoesNotMeetDifficulty);

        share_dedup::check_and_record(share_dedup, share_hash);

        let is_block = difficulty >= template.cached_network_difficulty;
        miner::record_share(miner_stats, miner_round_stats, difficulty, is_block, template.round_id, template.height);

        (sender, share_hash, difficulty, is_block, now)
    }

    /// Same as `validate_share_against_template` but reads from a
    /// `DerivedTemplate`. The derived path has no `round_id` (the buyer-
    /// template lane is round-agnostic) so `miner::record_share` is
    /// called with round_id = miner_round_stats's existing round to keep
    /// the per-miner accounting consistent.
    fun validate_share_against_derived(
        derived: &DerivedTemplate,
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
    ): (address, vector<u8>, u64, bool, u64) {
        let sender = tx_context::sender(ctx);
        let now = clock::timestamp_ms(clock);

        assert!(miner::miner_address(miner_stats) == sender, EWrongMiner);
        assert!(share_dedup::miner(share_dedup) == sender, EWrongMiner);
        assert!(share_dedup::round_id(share_dedup) == derived.round_id, EWrongTemplate);

        assert!((version ^ derived.version) & (0xFFFFFFFF ^ VERSION_ROLLING_MASK) == 0, EInvalidVersionRolling);

        let tpl_ntime = derived.ntime;
        let min_ntime = if (tpl_ntime > MAX_NTIME_OFFSET_SECONDS) { tpl_ntime - MAX_NTIME_OFFSET_SECONDS } else { 0 };
        assert!(ntime >= min_ntime && ntime <= tpl_ntime + MAX_NTIME_OFFSET_SECONDS, EInvalidNtime);

        let mut coinbase = vector[];
        vector::append(&mut coinbase, derived.coinbase1);
        vector::append(&mut coinbase, extranonce1);
        vector::append(&mut coinbase, extranonce2);
        vector::append(&mut coinbase, derived.coinbase2);
        let coinbase_hash = btc_math::sha256d(coinbase);

        let mut current = coinbase_hash;
        let nb = vector::length(&derived.merkle_branches);
        let mut b = 0u64;
        while (b < nb) {
            let branch = vector::borrow(&derived.merkle_branches, b);
            let mut combined = vector[];
            vector::append(&mut combined, current);
            vector::append(&mut combined, *branch);
            current = btc_math::sha256d(combined);
            b = b + 1;
        };
        let merkle_root = current;

        let mut header = vector[];
        btc_math::append_u32_le(&mut header, version);
        vector::append(&mut header, derived.prev_block_hash);
        vector::append(&mut header, merkle_root);
        btc_math::append_u32_le(&mut header, ntime);
        btc_math::append_u32_le(&mut header, derived.nbits);
        btc_math::append_u32_le(&mut header, nonce);
        let share_hash = btc_math::sha256d(header);

        let difficulty = difficulty_from_hash(&share_hash);
        assert!(difficulty >= derived.min_difficulty, EShareDoesNotMeetDifficulty);

        share_dedup::check_and_record(share_dedup, share_hash);

        let is_block = difficulty >= derived.cached_network_difficulty;
        // Derived lane has no round; use the MRS's existing round_id so
        // miner accounting still works for off-chain readers.
        let mrs_round = miner::mrs_round_id(miner_round_stats);
        miner::record_share(miner_stats, miner_round_stats, difficulty, is_block, mrs_round, derived.height);

        (sender, share_hash, difficulty, is_block, now)
    }

    fun maybe_freeze_block_claim(
        is_block: bool,
        round_id: u64,
        height: u64,
        block_finder: address,
        share_hash: vector<u8>,
        now: u64,
        ctx: &mut TxContext,
    ) {
        if (is_block) {
            let claim = BlockFoundClaim {
                id: object::new(ctx),
                round_id,
                height,
                block_finder,
                share_hash,
                found_at_ms: now,
            };
            let claim_id = object::id_to_address(object::borrow_id(&claim));
            event::emit(BlockFound {
                miner: block_finder,
                height,
                round_id,
                timestamp_ms: now,
                claim_id,
            });
            transfer::freeze_object(claim);
        };
    }

    // ── Read accessors for the buyer-template lane ────────────────────────────

    public fun derived_template_parent(d: &DerivedTemplate): ID { d.parent_template_id }
    public fun derived_template_height(d: &DerivedTemplate): u64 { d.height }
    public fun derived_template_round_id(d: &DerivedTemplate): u64 { d.round_id }
    public fun derived_template_owner(d: &DerivedTemplate): address { d.owner }
    public fun derived_template_min_difficulty(d: &DerivedTemplate): u64 { d.min_difficulty }
    public fun derived_template_network_difficulty(d: &DerivedTemplate): u64 { d.cached_network_difficulty }

    public fun hashpower_order_buyer<QuoteT>(o: &HashpowerBuyOrder<QuoteT>): address { o.buyer }
    public fun hashpower_order_template_id<QuoteT>(o: &HashpowerBuyOrder<QuoteT>): ID { o.template_id }
    public fun hashpower_order_price<QuoteT>(o: &HashpowerBuyOrder<QuoteT>): u64 { o.price_per_difficulty }
    public fun hashpower_order_budget<QuoteT>(o: &HashpowerBuyOrder<QuoteT>): u64 { balance::value(&o.budget) }
    public fun hashpower_order_is_dynamic<QuoteT>(o: &HashpowerBuyOrder<QuoteT>): bool { o.is_dynamic }

    // ── Buyer-bound hashpower lane (V2) ───────────────────────────────────────
    //
    //  `HashpowerBuyOrder<QuoteT>` above pins the order to a specific
    //  `Template.id`. Real-world buyers running their own bitcoind publish
    //  a fresh `Template` whenever the Bitcoin tip rolls or the mempool
    //  shifts — within minutes the pinned template is stale and the buyer
    //  is forced into a cancel + re-place cycle for every template publish.
    //
    //  `BuyerHashpowerOrder<QuoteT>` (this section) binds to the buyer's
    //  *identity* instead. `submit_share_for_buyer_pay` asserts
    //  `template.owner == order.buyer` so any template the buyer has
    //  registered drains the same order. The V1 lane stays in place for
    //  back-compat / existing zombies.

    public struct BuyerHashpowerOrder<phantom QuoteT> has key {
        id: UID,
        buyer: address,
        /// µQuote paid per difficulty-1 unit of share work. Same units
        /// and semantics as `HashpowerBuyOrder.price_per_difficulty`.
        price_per_difficulty: u64,
        budget: Balance<QuoteT>,
        /// Optional epoch cutoff. Shares accepted only while
        /// `tx_context::epoch(ctx) <= expires_epoch` (or `None`).
        expires_epoch: Option<u64>,
        /// `false` locks the price for the order's life;
        /// `update_buyer_order_price` aborts with `EOrderNotDynamic`.
        is_dynamic: bool,
    }

    // ── V2 events (mirror V1 set, drop `template_id`) ─────────────────────────

    public struct BuyerHashpowerOrderPlaced has copy, drop {
        order_id: ID,
        buyer: address,
        price_per_difficulty: u64,
        initial_budget: u64,
        expires_epoch: Option<u64>,
        is_dynamic: bool,
    }

    public struct BuyerHashpowerOrderPriceUpdated has copy, drop {
        order_id: ID,
        old_price: u64,
        new_price: u64,
    }

    public struct BuyerHashpowerOrderToppedUp has copy, drop {
        order_id: ID,
        added: u64,
        new_budget: u64,
    }

    public struct BuyerHashpowerOrderCanceled has copy, drop {
        order_id: ID,
        refunded: u64,
    }

    public struct BuyerHashpowerShareFilled has copy, drop {
        order_id: ID,
        miner: address,
        /// Which buyer-owned template the share was hashed against.
        /// Always satisfies `template.owner == order.buyer`.
        template_id: ID,
        /// `Some(derived_template_id)` if mined against a DerivedTemplate,
        /// `None` if mined against a Template directly.
        derived_template_id: Option<ID>,
        difficulty: u64,
        payout: u64,
        is_block: bool,
        timestamp_ms: u64,
    }

    // ── V2 lifecycle entries ──────────────────────────────────────────────────

    /// Place a buyer-bound hashpower order. No template binding — any
    /// `Template` whose `owner == sender` can later drain this order
    /// via `submit_share_for_buyer_pay`.
    public fun place_buyer_order<QuoteT>(
        payment: Coin<QuoteT>,
        price_per_difficulty: u64,
        expires_epoch: Option<u64>,
        is_dynamic: bool,
        ctx: &mut TxContext,
    ) {
        let sender = tx_context::sender(ctx);
        assert!(price_per_difficulty > 0, EZeroPrice);

        let initial_budget = coin::value(&payment);
        let order = BuyerHashpowerOrder<QuoteT> {
            id: object::new(ctx),
            buyer: sender,
            price_per_difficulty,
            budget: coin::into_balance(payment),
            expires_epoch,
            is_dynamic,
        };
        event::emit(BuyerHashpowerOrderPlaced {
            order_id: object::id(&order),
            buyer: sender,
            price_per_difficulty,
            initial_budget,
            expires_epoch,
            is_dynamic,
        });
        transfer::share_object(order);
    }

    /// Buyer adjusts per-difficulty payout. Only valid when
    /// `is_dynamic = true`; only the buyer can call.
    public fun update_buyer_order_price<QuoteT>(
        order: &mut BuyerHashpowerOrder<QuoteT>,
        new_price_per_difficulty: u64,
        ctx: &TxContext,
    ) {
        let sender = tx_context::sender(ctx);
        assert!(order.buyer == sender, ENotHashpowerBuyOrderOwner);
        assert!(order.is_dynamic, EOrderNotDynamic);
        assert!(new_price_per_difficulty > 0, EZeroPrice);
        let old_price = order.price_per_difficulty;
        order.price_per_difficulty = new_price_per_difficulty;
        event::emit(BuyerHashpowerOrderPriceUpdated {
            order_id: object::id(order),
            old_price,
            new_price: new_price_per_difficulty,
        });
    }

    /// Anyone can top up the budget (typically the buyer).
    public fun top_up_buyer_order<QuoteT>(
        order: &mut BuyerHashpowerOrder<QuoteT>,
        payment: Coin<QuoteT>,
    ) {
        let added = coin::value(&payment);
        balance::join(&mut order.budget, coin::into_balance(payment));
        event::emit(BuyerHashpowerOrderToppedUp {
            order_id: object::id(order),
            added,
            new_budget: balance::value(&order.budget),
        });
    }

    /// Buyer reclaims remaining budget and tears down the order.
    public fun cancel_buyer_order<QuoteT>(
        order: BuyerHashpowerOrder<QuoteT>,
        ctx: &mut TxContext,
    ): Coin<QuoteT> {
        let sender = tx_context::sender(ctx);
        assert!(order.buyer == sender, ENotHashpowerBuyOrderOwner);
        let BuyerHashpowerOrder {
            id,
            buyer: _,
            price_per_difficulty: _,
            mut budget,
            expires_epoch: _,
            is_dynamic: _,
        } = order;
        let order_id_addr = object::uid_to_address(&id);
        let refunded = balance::value(&budget);
        let refund = coin::from_balance(balance::withdraw_all(&mut budget), ctx);
        balance::destroy_zero(budget);
        event::emit(BuyerHashpowerOrderCanceled {
            order_id: object::id_from_address(order_id_addr),
            refunded,
        });
        object::delete(id);
        refund
    }

    // ── V2 share submission ───────────────────────────────────────────────────

    /// Direct-mine path: share is valid against `template`, which must be
    /// owned by `order.buyer`. Pays out `difficulty * price` in
    /// `Coin<QuoteT>`. Same hot-path semantics as `submit_share_for_pay`
    /// minus the template-id binding.
    public fun submit_share_for_buyer_pay<QuoteT>(
        template: &Template,
        order: &mut BuyerHashpowerOrder<QuoteT>,
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
    ): Coin<QuoteT> {
        assert!(template.owner == order.buyer, EBuyerOrderTemplateOwnerMismatch);
        check_buyer_order_not_expired(order, ctx);

        let (sender, share_hash, difficulty, is_block, now) =
            validate_share_against_template(
                template,
                miner_stats,
                miner_round_stats,
                share_dedup,
                extranonce1,
                extranonce2,
                ntime,
                nonce,
                version,
                clock,
                ctx,
            );

        let payout = compute_payout(difficulty, order.price_per_difficulty);
        let coin_out = drain_buyer_order_budget(order, payout, ctx);

        event::emit(BuyerHashpowerShareFilled {
            order_id: object::id(order),
            miner: sender,
            template_id: object::id(template),
            derived_template_id: option::none(),
            difficulty,
            payout,
            is_block,
            timestamp_ms: now,
        });

        maybe_freeze_block_claim(
            is_block,
            template.round_id,
            template.height,
            sender,
            share_hash,
            now,
            ctx,
        );

        coin_out
    }

    /// Derived-template mine path: `derived` was built atop `parent`, and
    /// `parent.owner` must equal `order.buyer`. We thread `parent`
    /// explicitly because `DerivedTemplate` only stores the parent's id,
    /// not the parent's owner.
    public fun submit_share_for_buyer_pay_derived<QuoteT>(
        derived: &DerivedTemplate,
        parent: &Template,
        order: &mut BuyerHashpowerOrder<QuoteT>,
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
    ): Coin<QuoteT> {
        assert!(
            derived.parent_template_id == object::id(parent),
            EBuyOrderTemplateMismatch,
        );
        assert!(parent.owner == order.buyer, EBuyerOrderTemplateOwnerMismatch);
        check_buyer_order_not_expired(order, ctx);

        let (sender, share_hash, difficulty, is_block, now) =
            validate_share_against_derived(
                derived,
                miner_stats,
                miner_round_stats,
                share_dedup,
                extranonce1,
                extranonce2,
                ntime,
                nonce,
                version,
                clock,
                ctx,
            );

        let payout = compute_payout(difficulty, order.price_per_difficulty);
        let coin_out = drain_buyer_order_budget(order, payout, ctx);

        event::emit(BuyerHashpowerShareFilled {
            order_id: object::id(order),
            miner: sender,
            template_id: derived.parent_template_id,
            derived_template_id: option::some(object::id(derived)),
            difficulty,
            payout,
            is_block,
            timestamp_ms: now,
        });

        // For the derived path the round_id is sentinel-0 — buyer lane
        // is round-agnostic, same as V1's `_derived` flavor.
        maybe_freeze_block_claim(
            is_block,
            0,
            derived.height,
            sender,
            share_hash,
            now,
            ctx,
        );

        coin_out
    }

    // ── V2 internal helpers (mirror V1) ───────────────────────────────────────

    fun check_buyer_order_not_expired<QuoteT>(
        order: &BuyerHashpowerOrder<QuoteT>,
        ctx: &TxContext,
    ) {
        if (option::is_some(&order.expires_epoch)) {
            let cutoff = *option::borrow(&order.expires_epoch);
            assert!(tx_context::epoch(ctx) <= cutoff, EHashpowerOrderExpired);
        };
    }

    fun drain_buyer_order_budget<QuoteT>(
        order: &mut BuyerHashpowerOrder<QuoteT>,
        amount: u64,
        ctx: &mut TxContext,
    ): Coin<QuoteT> {
        assert!(
            balance::value(&order.budget) >= amount,
            EInsufficientHashpowerBudget,
        );
        let part = balance::split(&mut order.budget, amount);
        coin::from_balance(part, ctx)
    }

    // ── V2 view functions ─────────────────────────────────────────────────────

    public fun buyer_order_buyer<QuoteT>(o: &BuyerHashpowerOrder<QuoteT>): address { o.buyer }
    public fun buyer_order_price<QuoteT>(o: &BuyerHashpowerOrder<QuoteT>): u64 { o.price_per_difficulty }
    public fun buyer_order_budget<QuoteT>(o: &BuyerHashpowerOrder<QuoteT>): u64 { balance::value(&o.budget) }
    public fun buyer_order_is_dynamic<QuoteT>(o: &BuyerHashpowerOrder<QuoteT>): bool { o.is_dynamic }
    public fun buyer_order_expires_epoch<QuoteT>(o: &BuyerHashpowerOrder<QuoteT>): Option<u64> { o.expires_epoch }

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
        assert!(share_dedup::round_id(share_dedup) == template.round_id, EWrongTemplate);

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

    /// Test-only escape hatch: lower the pool's `global_min_difficulty`
    /// below `MIN_DIFFICULTY`. Production `set_difficulty` asserts
    /// `diff >= MIN_DIFFICULTY` so this is unreachable at runtime.
    /// Tests use it to submit synthesized low-difficulty shares without
    /// having to grind for high-diff nonces every fixture.
    #[test_only]
    public fun set_min_difficulty_for_testing(pool: &mut Pool, diff: u64) {
        pool.global_min_difficulty = diff;
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
