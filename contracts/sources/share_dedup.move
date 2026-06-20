/// Per-(template, miner) share deduplication object.
///
/// Each miner owns a separate ShareDedup for each template they mine against.
/// Hash lookup is O(1) via dynamic_field::exists. No shared state involved —
/// all reads and writes bypass Sui consensus entirely.
///
/// Uniqueness enforcement (C-1 fix):
///   ShareDedupRegistry is a shared object keyed by (miner, template_id).
///   create_share_dedup registers the pair and aborts if one already exists,
///   preventing a miner from creating N dedup objects for the same template and
///   submitting the same share hash N times to inflate their pool-reward work.
///   Registry entries are permanent: deleting a ShareDedup does not remove the
///   entry, so a delete-and-recreate cannot bypass the protection.
///
/// Storage rent model (Sui):
///   Each dynamic field (hash entry) costs ~40 bytes of on-chain storage.
///   When the template is deactivated the miner calls close_share_dedup to
///   reclaim all storage and the SUI rebate is credited back to the miner.
///
/// Lifecycle:
///   create_share_dedup → registers (miner, template_id) in ShareDedupRegistry;
///                        creates a ShareDedup owned by the miner
///   record_hash        → called by pool::submit_share on each accepted share
///   close_share_dedup  → miner calls after template is deactivated (drains hashes)
///   delete_share_dedup → permanently deletes the empty ShareDedup object
module m1n3_v4::share_dedup {
    use sui::dynamic_field;

    // ── Error codes ───────────────────────────────────────────────────────────

    const EDuplicateShare:   u64 = 2;
    const EAlreadyRegistered: u64 = 3;
    const ENotOwner:          u64 = 11;

    // ── Registry key ─────────────────────────────────────────────────────────

    /// Dynamic-field key for ShareDedupRegistry. One entry per (miner, template).
    public struct ShareDedupKey has copy, drop, store {
        miner: address,
        template_id: ID,
    }

    // ── Objects ───────────────────────────────────────────────────────────────

    /// Shared registry that enforces one ShareDedup per (miner, template_id) pair.
    /// Dynamic fields: ShareDedupKey → bool (true = registered).
    public struct ShareDedupRegistry has key {
        id: UID,
    }

    /// Owned by the miner. Dynamic fields store accepted share hashes.
    public struct ShareDedup has key {
        id: UID,
        template_id: ID,
        miner: address,
        count: u32,
    }

    // ── Module init ───────────────────────────────────────────────────────────

    fun init(ctx: &mut TxContext) {
        let registry = ShareDedupRegistry { id: object::new(ctx) };
        transfer::share_object(registry);
    }

    // ── Entry functions ───────────────────────────────────────────────────────

    /// Create a new ShareDedup for a (template, miner) pair.
    /// Aborts with EAlreadyRegistered if this (miner, template) pair was already registered.
    /// Call this before submitting the first share for a template.
    public fun create_share_dedup(
        registry: &mut ShareDedupRegistry,
        template_id: ID,
        ctx: &mut TxContext,
    ) {
        let sender = tx_context::sender(ctx);
        let key = ShareDedupKey { miner: sender, template_id };
        assert!(!dynamic_field::exists(&registry.id, key), EAlreadyRegistered);
        dynamic_field::add(&mut registry.id, key, true);
        let dedup = ShareDedup {
            id: object::new(ctx),
            template_id,
            miner: sender,
            count: 0,
        };
        transfer::transfer(dedup, sender);
    }

    /// Reclaim storage rent after the template is deactivated.
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
    /// Note: the registry entry for (miner, template_id) is kept permanently so
    /// this dedup cannot be recreated after deletion (prevents the delete-and-
    /// recreate bypass attack).
    public fun delete_share_dedup(dedup: ShareDedup, ctx: &mut TxContext) {
        assert!(dedup.miner == tx_context::sender(ctx), ENotOwner);
        assert!(dedup.count == 0, EDuplicateShare); // must drain first
        let ShareDedup { id, template_id: _, miner: _, count: _ } = dedup;
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

    public fun template_id(dedup: &ShareDedup): ID { dedup.template_id }
    public fun miner(dedup: &ShareDedup): address { dedup.miner }
    public fun count(dedup: &ShareDedup): u32 { dedup.count }

    // ── Test helpers ──────────────────────────────────────────────────────────

    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) { init(ctx); }
}
