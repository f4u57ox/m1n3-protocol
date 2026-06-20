/// Registry that maps mining rounds to the pre-published `Coin<HASHSHARE_*>`
/// type used to tokenize that round's shares.
///
/// Design context
/// --------------
/// Sui's OTW invariant forces a one-to-one mapping between coin types and
/// published modules. To get per-round coin-type isolation without ever
/// recycling, we publish N coin-type modules ahead of time (`hs_000.move`,
/// `hs_001.move`, …), each declaring its own OTW and sharing its
/// `TreasuryCap` on init. Those caps register themselves here as a flat FIFO
/// of available slots. The first miner of round R pops the next slot and
/// binds it to R; subsequent miners in R look the binding up.
///
/// Slot consumption rate equals the pool's block-finding rate (≈
/// `pool_hashrate / network_hashrate × 144 / day`), so even at a 1% pool
/// share, N=500 covers ~1 year of operation. There is no force-recycle:
/// once the buffer is consumed, anyone can publish another batch of
/// `hs_*.move` modules and register them via `register_slot`.
///
/// Trust model
/// -----------
/// All entries are permissionless:
///   `register_slot`        — anyone registers a (treasury_cap, slot_label).
///   `bind_slot_to_round`   — anyone binds the next available slot to a
///                             round_id; idempotent if already bound.
/// The only privileged data is the publisher's choice of which packages to
/// register. If someone registers a malicious coin type, no one mints
/// against it (consumer-side hash check on the module bytecode, off-chain);
/// the malicious slot sits unused.
module m1n3_v4::hash_share_registry {
    use sui::dynamic_field;
    use sui::event;
    use sui::table::{Self, Table};
    use m1n3_v4::pool::PoolAdminCap;

    // ── Constants ─────────────────────────────────────────────────────────────

    /// Protocol fee taken at mint time, in basis points (100 = 1.00%).
    /// Default; tuneable via `set_fee_bps`.
    const DEFAULT_FEE_BPS: u64 = 100;
    /// 10000 == 100.00% — bps denominator.
    const BPS_DENOM: u64 = 10_000;
    /// Hard cap on the fee so a future admin can't quietly tax everyone to
    /// death. 1000 == 10%.
    const MAX_FEE_BPS: u64 = 1_000;

    // ── Errors ────────────────────────────────────────────────────────────────

    #[error]
    const ENoAvailableSlots: vector<u8> = b"No HashShare slots available — publish more hs_NNN packages and call register_slot";
    #[error]
    const ESlotAlreadyRegistered: vector<u8> = b"This TreasuryCap has already been registered into the slot buffer";
    #[error]
    const EWrongCap: vector<u8> = b"The provided TreasuryCap does not match the round's bound slot";
    #[error]
    const EFeeTooHigh: vector<u8> = b"Fee bps exceeds the protocol cap (MAX_FEE_BPS)";

    // ── Structs ───────────────────────────────────────────────────────────────

    /// One entry of pre-published unused HashShare type. `cap_id` is the
    /// shared `TreasuryCap<T>`'s object ID. The `label` is a human-readable
    /// tag (e.g. b"HS_000") shipped in the registering tx so off-chain
    /// callers can resolve the package + type without scanning bytecode.
    public struct AvailableSlot has copy, drop, store {
        cap_id: address,
        label: vector<u8>,
    }

    /// Set on `bind_slot_to_round`. Held inside `HashShareRegistry.rounds`.
    public struct RoundBinding has copy, drop, store {
        cap_id: address,
        label: vector<u8>,
        bound_at_round_idx: u64,  // position in the available list when bound
    }

    /// Used internally to dedup slot registration by cap_id.
    public struct RegisteredCapKey has copy, drop, store { cap_id: address }

    public struct HashShareRegistry has key {
        id: UID,
        /// FIFO of pre-published, unbound HashShare slots.
        available_slots: vector<AvailableSlot>,
        /// round_id → which slot was bound for that round.
        rounds: Table<u64, RoundBinding>,
        /// Monotonic counter — # of slots ever bound. Used as the slot index
        /// in `RoundBinding.bound_at_round_idx` so off-chain observers can
        /// see the order in which slots were claimed.
        total_bound: u64,
        /// Monotonic counter — # of slots ever registered (lifetime supply).
        total_registered: u64,
        /// Protocol fee taken at mint time, in basis points. 100 = 1.00%.
        fee_bps: u64,
        /// Address that receives mint-fee HashShares. The fee is paid in the
        /// same `Coin<HS_NNN>` the miner mints, so the recipient redeems
        /// against the round's redemption pool to convert their fee accrual
        /// into BTC — same path as any other HashShare holder.
        fee_recipient: address,
    }

    // ── Events ────────────────────────────────────────────────────────────────

    public struct SlotRegistered has copy, drop {
        cap_id: address,
        label: vector<u8>,
        index_in_buffer: u64,
    }

    public struct SlotBoundToRound has copy, drop {
        round_id: u64,
        cap_id: address,
        label: vector<u8>,
        bound_at_round_idx: u64,
    }

    public struct FeeBpsUpdated has copy, drop {
        old_bps: u64,
        new_bps: u64,
    }

    public struct FeeRecipientUpdated has copy, drop {
        old_recipient: address,
        new_recipient: address,
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    fun init(ctx: &mut TxContext) {
        transfer::share_object(HashShareRegistry {
            id: object::new(ctx),
            available_slots: vector[],
            rounds: table::new(ctx),
            total_bound: 0,
            total_registered: 0,
            fee_bps: DEFAULT_FEE_BPS,
            fee_recipient: tx_context::sender(ctx),
        });
    }

    // ── Fee admin ─────────────────────────────────────────────────────────────

    public fun set_fee_bps(
        registry: &mut HashShareRegistry,
        _cap: &PoolAdminCap,
        new_bps: u64,
    ) {
        assert!(new_bps <= MAX_FEE_BPS, EFeeTooHigh);
        let old = registry.fee_bps;
        registry.fee_bps = new_bps;
        event::emit(FeeBpsUpdated { old_bps: old, new_bps });
    }

    public fun set_fee_recipient(
        registry: &mut HashShareRegistry,
        _cap: &PoolAdminCap,
        new_recipient: address,
    ) {
        let old = registry.fee_recipient;
        registry.fee_recipient = new_recipient;
        event::emit(FeeRecipientUpdated {
            old_recipient: old,
            new_recipient,
        });
    }

    // ── Registration ──────────────────────────────────────────────────────────

    /// Register a pre-published `Coin<T>`'s shared TreasuryCap as an unbound
    /// slot. Caller supplies the cap's address (NOT a reference — registration
    /// is metadata-only; the cap stays shared and freely mintable once bound).
    ///
    /// Caps register themselves by their `id`; we don't accept the cap by
    /// reference because doing so would require `T` as a type-parameter on
    /// the registry, defeating the point of a single registry shared object.
    /// Off-chain consumers verify the registered package's bytecode hash
    /// against the canonical hs_*.move template before minting against it.
    public fun register_slot(
        registry: &mut HashShareRegistry,
        cap_id: address,
        label: vector<u8>,
    ) {
        let dedup_key = RegisteredCapKey { cap_id };
        assert!(!dynamic_field::exists(&registry.id, dedup_key), ESlotAlreadyRegistered);
        dynamic_field::add(&mut registry.id, dedup_key, true);

        let index_in_buffer = vector::length(&registry.available_slots);
        vector::push_back(&mut registry.available_slots, AvailableSlot {
            cap_id,
            label,
        });
        registry.total_registered = registry.total_registered + 1;

        event::emit(SlotRegistered { cap_id, label, index_in_buffer });
    }

    // ── Binding ───────────────────────────────────────────────────────────────

    /// Bind the next available slot to `round_id`. Idempotent: silently
    /// returns the existing binding if already bound. Aborts if no slots
    /// remain in the buffer — caller's cue to publish a new batch of
    /// `hs_*.move` modules and call `register_slot` for each.
    public fun bind_slot_to_round(
        registry: &mut HashShareRegistry,
        round_id: u64,
    ): RoundBinding {
        if (table::contains(&registry.rounds, round_id)) {
            return *table::borrow(&registry.rounds, round_id)
        };
        assert!(!vector::is_empty(&registry.available_slots), ENoAvailableSlots);

        let slot = vector::remove(&mut registry.available_slots, 0);
        let bound_at_round_idx = registry.total_bound;
        registry.total_bound = registry.total_bound + 1;

        let binding = RoundBinding {
            cap_id: slot.cap_id,
            label: slot.label,
            bound_at_round_idx,
        };
        table::add(&mut registry.rounds, round_id, binding);

        event::emit(SlotBoundToRound {
            round_id,
            cap_id: slot.cap_id,
            label: slot.label,
            bound_at_round_idx,
        });

        binding
    }

    // ── Read API ──────────────────────────────────────────────────────────────

    public fun has_round_binding(registry: &HashShareRegistry, round_id: u64): bool {
        table::contains(&registry.rounds, round_id)
    }

    public fun round_binding(registry: &HashShareRegistry, round_id: u64): RoundBinding {
        *table::borrow(&registry.rounds, round_id)
    }

    public fun binding_cap_id(b: &RoundBinding): address { b.cap_id }
    public fun binding_label(b: &RoundBinding): vector<u8> { b.label }
    public fun binding_round_idx(b: &RoundBinding): u64 { b.bound_at_round_idx }

    public fun available_slots(registry: &HashShareRegistry): u64 {
        vector::length(&registry.available_slots)
    }

    public fun total_registered(registry: &HashShareRegistry): u64 {
        registry.total_registered
    }

    public fun total_bound(registry: &HashShareRegistry): u64 {
        registry.total_bound
    }

    public fun fee_bps(registry: &HashShareRegistry): u64 { registry.fee_bps }
    public fun fee_recipient(registry: &HashShareRegistry): address { registry.fee_recipient }
    public fun bps_denom(): u64 { BPS_DENOM }

    /// Helper used by `hash_share::mint_share` to assert the caller passed
    /// the correct `TreasuryCap` for the bound slot.
    public fun assert_cap_matches_round(
        registry: &HashShareRegistry,
        round_id: u64,
        cap_id: address,
    ) {
        assert!(table::contains(&registry.rounds, round_id), ENoAvailableSlots);
        let b = table::borrow(&registry.rounds, round_id);
        assert!(b.cap_id == cap_id, EWrongCap);
    }

    // ── Test helpers ──────────────────────────────────────────────────────────

    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) { init(ctx); }
}
