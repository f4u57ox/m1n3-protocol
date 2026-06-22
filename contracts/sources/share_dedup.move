/// Per-(round, miner) share deduplication object.
///
/// Each miner owns ONE ShareDedup per round, reused across every Template
/// the pool publishes within that round. Hash lookup is O(1) via
/// `dynamic_field::exists`. No shared state involved on the share hot path —
/// all reads and writes bypass Sui consensus entirely.
///
/// Previously scoped per-(template, miner), which forced a fresh
/// `create_share_dedup` PTB every ~30 s as stratum rotated templates. At
/// 1 share / ~14 min on a 5 TH/s ASIC this was ~14 dedup objects/day per
/// miner. Scoping by round instead of template shrinks that to one per
/// round per miner without weakening the dedup guarantee: share hashes
/// remain globally unique across templates within a round (the coinbase
/// embeds the unique merkle root, so two templates produce different
/// share hashes for the same `(extranonce, ntime, nonce)` tuple).
///
/// Uniqueness enforcement (C-1 fix, preserved):
///   ShareDedupRegistry is a shared object keyed by (miner, round_id).
///   create_share_dedup registers the pair and aborts if one already exists,
///   preventing a miner from creating N dedup objects for the same round and
///   submitting the same share hash N times to inflate their pool-reward work.
///   Registry entries are permanent: deleting a ShareDedup does not remove the
///   entry, so a delete-and-recreate cannot bypass the protection.
///
/// Storage rent model (Sui):
///   Each dynamic field (hash entry) costs ~40 bytes of on-chain storage.
///   Once a round is finalised the miner calls close_share_dedup to drain
///   hashes and reclaim storage rent (refunded to the miner).
///
/// Lifecycle:
///   create_share_dedup → registers (miner, round_id) in ShareDedupRegistry;
///                        creates a ShareDedup owned by the miner
///   record_hash        → called by pool::submit_share on each accepted share
///   close_share_dedup  → miner calls after round is finalised (drains hashes)
///   delete_share_dedup → permanently deletes the empty ShareDedup object
module m1n3_v4::share_dedup {
    use sui::dynamic_field;

    // ── Error codes ───────────────────────────────────────────────────────────

    #[error]
    const EDuplicateShare: vector<u8> = b"This share hash has already been submitted by this miner in this round";
    #[error]
    const EAlreadyRegistered: vector<u8> = b"A ShareDedup already exists for this (miner, round) pair";
    #[error]
    const ENotOwner: vector<u8> = b"Caller is not the owner of this ShareDedup";

    // ── Registry key ─────────────────────────────────────────────────────────

    /// Dynamic-field key for ShareDedupRegistry. One entry per (miner, round).
    public struct ShareDedupKey has copy, drop, store {
        miner: address,
        round_id: u64,
    }

    // ── Objects ───────────────────────────────────────────────────────────────

    /// Shared registry that enforces one ShareDedup per (miner, round_id) pair.
    /// Dynamic fields: ShareDedupKey → bool (true = registered).
    public struct ShareDedupRegistry has key {
        id: UID,
    }

    /// Owned by the miner. Dynamic fields store accepted share hashes.
    public struct ShareDedup has key {
        id: UID,
        round_id: u64,
        miner: address,
        count: u32,
    }

    // ── Module init ───────────────────────────────────────────────────────────

    fun init(ctx: &mut TxContext) {
        let registry = ShareDedupRegistry { id: object::new(ctx) };
        transfer::share_object(registry);
    }

    // ── Entry functions ───────────────────────────────────────────────────────

    /// Create a new ShareDedup for a (round, miner) pair.
    /// Aborts with EAlreadyRegistered if this (miner, round) pair was already registered.
    /// Call this before submitting the first share for a round.
    public fun create_share_dedup(
        registry: &mut ShareDedupRegistry,
        round_id: u64,
        ctx: &mut TxContext,
    ) {
        let sender = tx_context::sender(ctx);
        let key = ShareDedupKey { miner: sender, round_id };
        assert!(!dynamic_field::exists(&registry.id, key), EAlreadyRegistered);
        dynamic_field::add(&mut registry.id, key, true);
        let dedup = ShareDedup {
            id: object::new(ctx),
            round_id,
            miner: sender,
            count: 0,
        };
        transfer::transfer(dedup, sender);
    }

    /// Reclaim storage rent after the round is finalised.
    /// Pass the hashes to remove (obtained off-chain from the miner's event log).
    /// Call multiple times if the hash list is large.
    public fun close_share_dedup(
        dedup: &mut ShareDedup,
        hashes_to_remove: vector<vector<u8>>,
        ctx: &mut TxContext,
    ) {
        assert!(dedup.miner == tx_context::sender(ctx), ENotOwner);
        let n = vector::length(&hashes_to_remove);
        let mut i = 0;
        while (i < n) {
            let h = *vector::borrow(&hashes_to_remove, i);
            if (dynamic_field::exists(&dedup.id, h)) {
                let _: bool = dynamic_field::remove(&mut dedup.id, h);
                dedup.count = dedup.count - 1;
            };
            i = i + 1;
        };
    }

    /// Permanently delete the ShareDedup object once all hashes are removed.
    /// Note: the registry entry for (miner, round_id) is kept permanently so
    /// this dedup cannot be recreated after deletion (prevents the delete-and-
    /// recreate bypass attack).
    public fun delete_share_dedup(dedup: ShareDedup, ctx: &mut TxContext) {
        assert!(dedup.miner == tx_context::sender(ctx), ENotOwner);
        assert!(dedup.count == 0, EDuplicateShare); // must drain first
        let ShareDedup { id, round_id: _, miner: _, count: _ } = dedup;
        object::delete(id);
    }

    // ── Package-internal mutator ──────────────────────────────────────────────

    /// Check dedup and record the hash. Aborts if hash already present.
    /// Called by pool::submit_share on each accepted share.
    public(package) fun check_and_record(dedup: &mut ShareDedup, hash: vector<u8>) {
        assert!(!dynamic_field::exists(&dedup.id, hash), EDuplicateShare);
        dynamic_field::add(&mut dedup.id, hash, true);
        dedup.count = dedup.count + 1;
    }

    // ── Read accessors ────────────────────────────────────────────────────────

    public fun round_id(dedup: &ShareDedup): u64 { dedup.round_id }
    public fun miner(dedup: &ShareDedup): address { dedup.miner }
    public fun count(dedup: &ShareDedup): u32 { dedup.count }

    // ── Test helpers ──────────────────────────────────────────────────────────

    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) { init(ctx); }
}
