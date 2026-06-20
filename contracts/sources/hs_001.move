/// HashShare slot 001 — one of the pre-published `Coin<HASHSHARE_*>` types
/// the `hash_share_registry` distributes to rounds. See
/// `hash_share_registry.move` for the design rationale.
///
/// Every `hs_NNN.move` module is structurally identical: declare a unique
/// OTW type, mint the currency, share the `TreasuryCap` so anyone can mint
/// (gated by the registry), and freeze the metadata. To scale beyond the
/// initial buffer, copy this file with the next slot number and run a
/// post-deploy script that calls `hash_share_registry::register_slot` for
/// each new shared cap.
#[allow(deprecated_usage)]
module m1n3_v4::hs_001 {
    use sui::coin;

    public struct HS_001 has drop {}

    fun init(witness: HS_001, ctx: &mut TxContext) {
        let (cap, meta) = coin::create_currency<HS_001>(
            witness,
            0,                 // decimals: HashShares are integer counts of difficulty
            b"HS001",
            b"m1n3 HashShare 000",
            b"Per-round tokenized mining share, slot 001",
            option::none(),
            ctx,
        );
        transfer::public_freeze_object(meta);
        transfer::public_share_object(cap);
    }

    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) { init(HS_001 {}, ctx); }
}
