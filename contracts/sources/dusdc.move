/// `dusdc::DUSDC` — a 6-decimal stand-in for USDC used as the pay leg
/// of the `m1n3_confidential_otc` flow on devnet.
///
/// Why: the real DUSDC on devnet is issued by the Mysten Labs faucet
/// operator. Bringing it onto the `MystenLabs/confidential-transfers`
/// rail (Phase B) would require its `TreasuryCap`, which we don't
/// hold. So we issue our own demo coin and the OTC flow uses it as a
/// stablecoin stand-in. The shape is identical to a real stablecoin
/// from the user's POV (6 decimals, permissionless faucet for testing).
module m1n3_v4::dusdc {
    use sui::coin;

    public struct DUSDC has drop {}

    /// Per-mint amount the permissionless faucet hands out (1,000 DUSDC).
    const FAUCET_AMOUNT: u64 = 1_000_000_000;

    fun init(witness: DUSDC, ctx: &mut TxContext) {
        let (cap, meta) = coin::create_currency<DUSDC>(
            witness,
            6,
            b"DUSDC",
            b"m1n3 Demo USDC",
            b"Devnet OTC pay leg. NOT a real stablecoin.",
            option::none(),
            ctx,
        );
        transfer::public_freeze_object(meta);
        transfer::public_share_object(cap);
    }

    /// Permissionless faucet for the devnet demo. Anyone can mint
    /// `FAUCET_AMOUNT` to themselves.
    public fun faucet(
        cap: &mut coin::TreasuryCap<DUSDC>,
        ctx: &mut TxContext,
    ) {
        let c = coin::mint<DUSDC>(cap, FAUCET_AMOUNT, ctx);
        transfer::public_transfer(c, tx_context::sender(ctx));
    }

    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) {
        init(DUSDC {}, ctx);
    }
}
