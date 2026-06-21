/// Atomic OTC settlement for m1n3.
///
/// Design and limitations
/// ----------------------
/// What this module ships:
///   - **Atomic 1-PTB swap**: seller locks `Coin<DeliverableT>` into a
///     shared `Escrow` committing to buyer + price. The buyer signs a
///     single PTB that pays `Coin<PayT>` worth `pay_amount` to the
///     seller and receives the deliverable. Either both legs happen or
///     neither — the PTB reverts atomically.
///   - **Cancel path**: the seller can withdraw their deliverable if no
///     buyer has settled yet (i.e. abandon the trade).
///
/// What this module does NOT do (and why):
///   - **Confidential pay leg.** The pay leg ships plaintext. Going
///     fully confidential on chain would require importing
///     `MystenLabs/confidential-transfers` as a Move dep, which on
///     devnet today has Sui-framework version skew (uses APIs only
///     present in specific framework revs) that's not resolvable in the
///     hackathon window. The off-chain SDK *can* still wrap the
///     buyer's settled deliverable into a confidential `TokenAccount`
///     in the SAME PTB after `settle` returns — but the amount of that
///     wrap is public via `WrapEvent`. So a chain observer learns the
///     trade size either way.
///   - **Confidential trade size.** The escrow object publishes
///     `(deliverable_amount, pay_amount)`. The OTC's *aggregate*
///     behavior across many trades is the meaningful privacy gain only
///     when paired with the Phase B confidential pay leg.
///
/// What remains private even in Phase A:
///   - The buyer's broader confidential `TokenAccount<DeliverableT>`
///     state after they wrap the received deliverable. A competitor
///     can see "buyer X received Y HS via this OTC", but not the
///     buyer's overall HashShare holdings, other concurrent OTCs they
///     settled, or their subsequent confidential transfers to other
///     wallets.
///
/// Phase B (planned): import confidential-transfers as a Move dep,
/// make the pay leg `contra::batched_transfer<PayT>` from buyer →
/// seller, bind the encrypted amount to `escrow.pay_amount` via a
/// `nizk::DdhProof` of equality, and verify on chain inside `settle`.
module m1n3_v4::m1n3_confidential_otc {
    use sui::coin::Coin;
    use sui::event;

    // === Errors ===

    const ENotBuyer: u64 = 0;
    const ENotSeller: u64 = 1;
    const EZeroAmount: u64 = 2;
    const EInsufficientPayment: u64 = 3;

    // === Objects ===

    /// A pending atomic OTC trade. Holds the plaintext deliverable
    /// coin until the buyer settles by paying the pay-asset.
    public struct Escrow<phantom DeliverableT, phantom PayT> has key {
        id: UID,
        deliverable: Coin<DeliverableT>,
        seller: address,
        buyer: address,
        /// Amount of `PayT` the buyer must hand over for the deliverable.
        pay_amount: u64,
        /// Free-form memo set at lock time, echoed in settle event.
        memo: vector<u8>,
    }

    // === Events ===

    public struct EscrowOpened has copy, drop {
        escrow_id: address,
        seller: address,
        buyer: address,
        deliverable_amount: u64,
        pay_amount: u64,
        memo: vector<u8>,
    }

    public struct EscrowSettled has copy, drop {
        escrow_id: address,
        seller: address,
        buyer: address,
        deliverable_amount: u64,
        pay_amount: u64,
    }

    public struct EscrowCancelled has copy, drop {
        escrow_id: address,
        seller: address,
    }

    // === Entrypoints ===

    /// Seller locks `deliverable` into a shared escrow committing to
    /// deliver it to `buyer` for `pay_amount` units of `PayT`.
    public fun lock_escrow<DeliverableT, PayT>(
        deliverable: Coin<DeliverableT>,
        buyer: address,
        pay_amount: u64,
        memo: vector<u8>,
        ctx: &mut TxContext,
    ) {
        let seller = tx_context::sender(ctx);
        let deliverable_amount = deliverable.value();
        assert!(deliverable_amount > 0, EZeroAmount);
        assert!(pay_amount > 0, EZeroAmount);

        let escrow = Escrow<DeliverableT, PayT> {
            id: object::new(ctx),
            deliverable,
            seller,
            buyer,
            pay_amount,
            memo,
        };
        let escrow_id = object::uid_to_address(&escrow.id);
        event::emit(EscrowOpened {
            escrow_id,
            seller,
            buyer,
            deliverable_amount,
            pay_amount,
            memo,
        });
        transfer::share_object(escrow);
    }

    /// Buyer-driven atomic settle.
    ///
    /// The buyer signs a PTB that hands `payment` (at least
    /// `escrow.pay_amount` units of `Coin<PayT>`) to this function;
    /// it forwards the payment to the seller and returns the
    /// `Coin<DeliverableT>` to the buyer. Any excess payment is
    /// returned to the buyer as change.
    public fun settle<DeliverableT, PayT>(
        escrow: Escrow<DeliverableT, PayT>,
        mut payment: Coin<PayT>,
        ctx: &mut TxContext,
    ): Coin<DeliverableT> {
        let buyer = tx_context::sender(ctx);
        assert!(buyer == escrow.buyer, ENotBuyer);
        assert!(payment.value() >= escrow.pay_amount, EInsufficientPayment);

        let escrow_id = object::uid_to_address(&escrow.id);
        let Escrow {
            id,
            deliverable,
            seller,
            buyer: escrow_buyer,
            pay_amount,
            memo: _,
        } = escrow;

        // Split off the exact pay amount and send it to the seller.
        let exact = payment.split(pay_amount, ctx);
        transfer::public_transfer(exact, seller);
        // Return any change to the buyer.
        if (payment.value() > 0) {
            transfer::public_transfer(payment, buyer);
        } else {
            payment.destroy_zero();
        };

        let deliverable_amount = deliverable.value();
        event::emit(EscrowSettled {
            escrow_id,
            seller,
            buyer: escrow_buyer,
            deliverable_amount,
            pay_amount,
        });
        id.delete();
        deliverable
    }

    /// Seller can cancel an outstanding escrow and recover the
    /// deliverable. The buyer can no longer settle once cancelled.
    public fun cancel<DeliverableT, PayT>(
        escrow: Escrow<DeliverableT, PayT>,
        ctx: &TxContext,
    ): Coin<DeliverableT> {
        let sender = tx_context::sender(ctx);
        assert!(sender == escrow.seller, ENotSeller);
        let escrow_id = object::uid_to_address(&escrow.id);
        let Escrow {
            id,
            deliverable,
            seller,
            buyer: _,
            pay_amount: _,
            memo: _,
        } = escrow;
        event::emit(EscrowCancelled { escrow_id, seller });
        id.delete();
        deliverable
    }

    // === Test-only ===

    #[test_only]
    public fun escrow_buyer<DeliverableT, PayT>(escrow: &Escrow<DeliverableT, PayT>): address {
        escrow.buyer
    }

    #[test_only]
    public fun escrow_seller<DeliverableT, PayT>(escrow: &Escrow<DeliverableT, PayT>): address {
        escrow.seller
    }

    #[test_only]
    public fun escrow_pay_amount<DeliverableT, PayT>(escrow: &Escrow<DeliverableT, PayT>): u64 {
        escrow.pay_amount
    }

    #[test_only]
    public fun escrow_deliverable_amount<DeliverableT, PayT>(escrow: &Escrow<DeliverableT, PayT>): u64 {
        escrow.deliverable.value()
    }
}
