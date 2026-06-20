#[allow(deprecated_usage)]
module m1n3_v4::m1n3 {
    use sui::coin::{Self, TreasuryCap};
    use m1n3_v4::pool::{Self, Pool};

    // ======== Error Codes ========
    const ENotAdmin: u64 = 0;

    /// One-Time-Witness for the M1N3 coin
    public struct M1N3 has drop {}

    /// Shared treasury object holding the TreasuryCap
    public struct M1N3Treasury has key {
        id: UID,
        cap: TreasuryCap<M1N3>,
        total_minted: u64,
    }

    /// Module initializer - creates the M1N3 currency
    fun init(witness: M1N3, ctx: &mut TxContext) {
        let (treasury_cap, metadata) = coin::create_currency<M1N3>(
            witness,
            8, // 8 decimals (same as Bitcoin)
            b"m1n3",
            b"m1n3 Token",
            b"Bitcoin block verification reward token",
            option::none(),
            ctx,
        );

        // Freeze metadata so it can't be changed
        transfer::public_freeze_object(metadata);

        // Share the treasury so block_registry can mint rewards
        let treasury = M1N3Treasury {
            id: object::new(ctx),
            cap: treasury_cap,
            total_minted: 0,
        };
        transfer::share_object(treasury);
    }

    /// Mint M1N3 tokens to a recipient. Only callable within this package.
    public(package) fun mint_reward(
        treasury: &mut M1N3Treasury,
        amount: u64,
        recipient: address,
        ctx: &mut TxContext,
    ) {
        let minted = coin::mint(&mut treasury.cap, amount, ctx);
        treasury.total_minted = treasury.total_minted + amount;
        transfer::public_transfer(minted, recipient);
    }

    /// Admin-only mint for testing and airdrops.
    /// Authorized by the Pool admin address (deployer).
    /// In production, remove or gate behind governance.
    public entry fun admin_mint_for_testing(
        treasury: &mut M1N3Treasury,
        pool: &Pool,
        amount: u64,
        recipient: address,
        ctx: &mut TxContext,
    ) {
        assert!(tx_context::sender(ctx) == pool::admin(pool), ENotAdmin);
        let minted = coin::mint(&mut treasury.cap, amount, ctx);
        treasury.total_minted = treasury.total_minted + amount;
        transfer::public_transfer(minted, recipient);
    }

    /// Returns the total amount of M1N3 ever minted
    public fun total_minted(treasury: &M1N3Treasury): u64 {
        treasury.total_minted
    }

    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) {
        init(M1N3 {}, ctx);
    }
}
