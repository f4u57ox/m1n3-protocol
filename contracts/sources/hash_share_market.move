/// Two-sided standing-limit market for `Coin<HASHSHARE_*>`.
///
/// Unlike `market.move`, which can only have buyers as makers (ShareReceipts
/// are `drop`-only and can't be escrowed by sellers), `hash_share_market` is
/// symmetric: both sides post standing orders.
///
///   `BuyOrder<T>`  — buyer escrows `Balance<SUI>`, waits for a seller to
///                    arrive with `Coin<T>` and fill.
///   `SellOrder<T>` — seller escrows `Balance<T>` (their HashShares), waits
///                    for a buyer to arrive with `Coin<SUI>` and fill.
///
/// No matching engine. Each fill is a direct taker-on-maker action, one
/// order at a time. UI surfaces best-bid / best-ask off-chain via event scan
/// (`BuyOrderPlaced` / `SellOrderPlaced` / `*Filled` / `*Cancelled`).
///
/// Parallelism strategy mirrors `market.move`: shard orders via
/// `place_*_sharded` so concurrent fills on different shards don't contend
/// on a single shared object. The `MarketFeePool` reference is immutable on
/// every fill path; the 2% fee transfers directly to the admin wallet, no
/// shared-object write to bottleneck the hot path.
///
/// Pricing
/// -------
/// Both order types price in MIST per HashShare unit. A share of difficulty
/// D produces D HashShares (1:1 mint), so `price_per_unit = MIST per
/// difficulty unit`, mirroring `market::BuyOrder.price_per_difficulty`'s
/// units exactly.
module m1n3_v4::hash_share_market {
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;
    use sui::event;
    use openzeppelin_math::u64::mul_div;
    use openzeppelin_math::rounding;

    // ── Constants ─────────────────────────────────────────────────────────────

    /// 200 bps == 2%, same as `market.move`.
    const FEE_BPS:   u64 = 200;
    const BPS_DENOM: u64 = 10_000;

    // ── Errors ────────────────────────────────────────────────────────────────

    const ENotBuyer:     u64 = 1;
    const ENotSeller:    u64 = 2;
    const EOrderExhausted: u64 = 3;
    const EInsufficientHashShares: u64 = 4;
    const EOrderExpired: u64 = 6;
    const ENotExpired:   u64 = 7;
    const EZeroQty:      u64 = 8;
    const ENotAdmin:     u64 = 9;
    const EPriceTooLow:  u64 = 10;
    const ENoPendingAdmin:  u64 = 11;
    const ENotPendingAdmin: u64 = 12;

    // ── Shared objects ────────────────────────────────────────────────────────

    /// Admin object. Fees are routed directly to `admin` on every fill —
    /// this object is `&`-only on the hot path, so concurrent fills don't
    /// contend on a shared-object write here.
    ///
    /// Admin transfer is two-step: the current admin calls `propose_admin`
    /// to write `pending_admin`, and the proposed address must then call
    /// `accept_admin` to take over. A typo on the new address can be
    /// rescued by the current admin re-proposing before acceptance.
    public struct MarketFeePool has key {
        id: UID,
        admin: address,
        pending_admin: Option<address>,
        balance: Balance<SUI>,
    }

    /// Standing bid for `Coin<T>`. Buyer escrows SUI; any holder of `Coin<T>`
    /// can hit it up to budget.
    public struct BuyOrder<phantom T> has key {
        id: UID,
        buyer: address,
        price_per_unit_mist: u64,
        payment: Balance<SUI>,
        expires_epoch: Option<u64>,
    }

    /// Standing ask for `Coin<T>`. Seller escrows `Coin<T>` as inventory;
    /// any buyer with SUI can fill up to the inventory.
    public struct SellOrder<phantom T> has key {
        id: UID,
        seller: address,
        price_per_unit_mist: u64,
        inventory: Balance<T>,
        expires_epoch: Option<u64>,
    }

    // ── Events ────────────────────────────────────────────────────────────────

    public struct BuyOrderPlaced has copy, drop {
        order_id: ID,
        buyer: address,
        price_per_unit_mist: u64,
        budget_mist: u64,
        expires_epoch: Option<u64>,
    }

    public struct SellOrderPlaced has copy, drop {
        order_id: ID,
        seller: address,
        price_per_unit_mist: u64,
        inventory_units: u64,
        expires_epoch: Option<u64>,
    }

    public struct BuyOrderFilled has copy, drop {
        order_id: ID,
        seller: address,
        units: u64,
        gross_mist: u64,
        fee_mist: u64,
        net_paid_mist: u64,
        budget_remaining_mist: u64,
    }

    public struct SellOrderFilled has copy, drop {
        order_id: ID,
        buyer: address,
        units: u64,
        gross_mist: u64,
        fee_mist: u64,
        inventory_remaining: u64,
    }

    public struct OrderCancelled has copy, drop {
        order_id: ID,
        owner: address,
        refund_amount: u64,
        side_is_buy: bool,
    }

    public struct PriceUpdated has copy, drop {
        order_id: ID,
        owner: address,
        old_price: u64,
        new_price: u64,
        side_is_buy: bool,
    }

    public struct AdminProposed has copy, drop {
        fee_pool_id: ID,
        current_admin: address,
        pending_admin: address,
    }

    public struct AdminTransferred has copy, drop {
        fee_pool_id: ID,
        old_admin: address,
        new_admin: address,
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    fun init(ctx: &mut TxContext) {
        transfer::share_object(MarketFeePool {
            id: object::new(ctx),
            admin: tx_context::sender(ctx),
            pending_admin: option::none(),
            balance: balance::zero(),
        });
    }

    // ── BuyOrder API ──────────────────────────────────────────────────────────

    /// Place a buy order. `expires_epoch = 0` means never expires.
    public fun place_buy_order<T>(
        price_per_unit_mist: u64,
        expires_epoch: u64,
        payment: Coin<SUI>,
        ctx: &mut TxContext,
    ) {
        assert!(price_per_unit_mist > 0, EPriceTooLow);
        let budget_mist = coin::value(&payment);
        let buyer = tx_context::sender(ctx);
        let exp = if (expires_epoch == 0) { option::none() } else { option::some(expires_epoch) };

        let order = BuyOrder<T> {
            id: object::new(ctx),
            buyer,
            price_per_unit_mist,
            payment: coin::into_balance(payment),
            expires_epoch: exp,
        };
        event::emit(BuyOrderPlaced {
            order_id: object::id(&order),
            buyer,
            price_per_unit_mist,
            budget_mist,
            expires_epoch: exp,
        });
        transfer::share_object(order);
    }

    /// Seller hits a posted bid, paying `Coin<T>` and receiving net SUI.
    /// `units_to_sell` controls partial fill; passing `coin::value(&payment)`
    /// sells the whole coin.
    public fun fill_buy_order<T>(
        order: &mut BuyOrder<T>,
        fee_pool: &MarketFeePool,
        payment_in: Coin<T>,
        ctx: &mut TxContext,
    ) {
        if (option::is_some(&order.expires_epoch)) {
            assert!(
                tx_context::epoch(ctx) < *option::borrow(&order.expires_epoch),
                EOrderExpired,
            );
        };
        let units = coin::value(&payment_in);
        assert!(units > 0, EZeroQty);

        let gross = mul_div(units, order.price_per_unit_mist, 1, rounding::down()).destroy_some();
        assert!(balance::value(&order.payment) >= gross, EOrderExhausted);

        let seller = tx_context::sender(ctx);
        let fee = mul_div(gross, FEE_BPS, BPS_DENOM, rounding::down()).destroy_some();
        let net = gross - fee;

        let mut sui_out = balance::split(&mut order.payment, gross);
        let fee_balance = balance::split(&mut sui_out, fee);

        // Hand HashShare inventory to the buyer.
        transfer::public_transfer(coin::from_balance(coin::into_balance(payment_in), ctx), order.buyer);
        // Net SUI to seller.
        transfer::public_transfer(coin::from_balance(sui_out, ctx), seller);
        // Fee direct to admin — no shared-object write on fee_pool.
        transfer::public_transfer(coin::from_balance(fee_balance, ctx), fee_pool.admin);

        event::emit(BuyOrderFilled {
            order_id: object::id(order),
            seller,
            units,
            gross_mist: gross,
            fee_mist: fee,
            net_paid_mist: net,
            budget_remaining_mist: balance::value(&order.payment),
        });
    }

    /// Top up the budget of an existing BuyOrder.
    public fun top_up_buy_order<T>(
        order: &mut BuyOrder<T>,
        payment: Coin<SUI>,
    ) {
        balance::join(&mut order.payment, coin::into_balance(payment));
    }

    /// Buyer-only. Replaces the price; doesn't touch budget or inventory.
    public fun update_buy_order_price<T>(
        order: &mut BuyOrder<T>,
        new_price_per_unit_mist: u64,
        ctx: &TxContext,
    ) {
        assert!(order.buyer == tx_context::sender(ctx), ENotBuyer);
        assert!(new_price_per_unit_mist > 0, EPriceTooLow);
        let old = order.price_per_unit_mist;
        order.price_per_unit_mist = new_price_per_unit_mist;
        event::emit(PriceUpdated {
            order_id: object::id(order),
            owner: order.buyer,
            old_price: old,
            new_price: new_price_per_unit_mist,
            side_is_buy: true,
        });
    }

    public fun cancel_buy_order<T>(order: BuyOrder<T>, ctx: &mut TxContext) {
        assert!(order.buyer == tx_context::sender(ctx), ENotBuyer);
        let BuyOrder { id, buyer, price_per_unit_mist: _, payment, expires_epoch: _ } = order;
        let refund = balance::value(&payment);
        event::emit(OrderCancelled {
            order_id: object::uid_to_inner(&id),
            owner: buyer,
            refund_amount: refund,
            side_is_buy: true,
        });
        object::delete(id);
        if (refund > 0) {
            transfer::public_transfer(coin::from_balance(payment, ctx), buyer);
        } else {
            balance::destroy_zero(payment);
        };
    }

    /// Permissionless cleanup of an expired BuyOrder. Refunds residual to
    /// the original buyer.
    public fun cleanup_expired_buy_order<T>(order: BuyOrder<T>, ctx: &mut TxContext) {
        assert!(option::is_some(&order.expires_epoch), ENotExpired);
        assert!(
            tx_context::epoch(ctx) >= *option::borrow(&order.expires_epoch),
            ENotExpired,
        );
        let BuyOrder { id, buyer, price_per_unit_mist: _, payment, expires_epoch: _ } = order;
        let refund = balance::value(&payment);
        event::emit(OrderCancelled {
            order_id: object::uid_to_inner(&id),
            owner: buyer,
            refund_amount: refund,
            side_is_buy: true,
        });
        object::delete(id);
        if (refund > 0) {
            transfer::public_transfer(coin::from_balance(payment, ctx), buyer);
        } else {
            balance::destroy_zero(payment);
        };
    }

    // ── SellOrder API ─────────────────────────────────────────────────────────

    public fun place_sell_order<T>(
        price_per_unit_mist: u64,
        expires_epoch: u64,
        inventory: Coin<T>,
        ctx: &mut TxContext,
    ) {
        assert!(price_per_unit_mist > 0, EPriceTooLow);
        let inventory_units = coin::value(&inventory);
        assert!(inventory_units > 0, EZeroQty);
        let seller = tx_context::sender(ctx);
        let exp = if (expires_epoch == 0) { option::none() } else { option::some(expires_epoch) };

        let order = SellOrder<T> {
            id: object::new(ctx),
            seller,
            price_per_unit_mist,
            inventory: coin::into_balance(inventory),
            expires_epoch: exp,
        };
        event::emit(SellOrderPlaced {
            order_id: object::id(&order),
            seller,
            price_per_unit_mist,
            inventory_units,
            expires_epoch: exp,
        });
        transfer::share_object(order);
    }

    /// Buyer hits a posted ask. `units_to_buy` controls partial fill;
    /// caller's payment must cover `units_to_buy × price`. Any overpayment
    /// is refunded.
    public fun fill_sell_order<T>(
        order: &mut SellOrder<T>,
        fee_pool: &MarketFeePool,
        mut payment: Coin<SUI>,
        units_to_buy: u64,
        ctx: &mut TxContext,
    ) {
        if (option::is_some(&order.expires_epoch)) {
            assert!(
                tx_context::epoch(ctx) < *option::borrow(&order.expires_epoch),
                EOrderExpired,
            );
        };
        assert!(units_to_buy > 0, EZeroQty);
        assert!(balance::value(&order.inventory) >= units_to_buy, EInsufficientHashShares);

        let gross = mul_div(units_to_buy, order.price_per_unit_mist, 1, rounding::down()).destroy_some();
        assert!(coin::value(&payment) >= gross, EOrderExhausted);

        let buyer = tx_context::sender(ctx);
        let fee = mul_div(gross, FEE_BPS, BPS_DENOM, rounding::down()).destroy_some();
        // Pay seller (gross - fee), admin (fee), refund any overpayment.
        let mut payment_balance = coin::into_balance(payment);
        let mut to_pay = balance::split(&mut payment_balance, gross);
        let fee_balance = balance::split(&mut to_pay, fee);

        // Inventory to buyer.
        let hashshares_out = balance::split(&mut order.inventory, units_to_buy);
        transfer::public_transfer(coin::from_balance(hashshares_out, ctx), buyer);
        // Net SUI to seller.
        transfer::public_transfer(coin::from_balance(to_pay, ctx), order.seller);
        // Fee direct to admin.
        transfer::public_transfer(coin::from_balance(fee_balance, ctx), fee_pool.admin);
        // Refund overpayment to buyer.
        if (balance::value(&payment_balance) > 0) {
            transfer::public_transfer(coin::from_balance(payment_balance, ctx), buyer);
        } else {
            balance::destroy_zero(payment_balance);
        };

        event::emit(SellOrderFilled {
            order_id: object::id(order),
            buyer,
            units: units_to_buy,
            gross_mist: gross,
            fee_mist: fee,
            inventory_remaining: balance::value(&order.inventory),
        });
    }

    /// Seller-only. Replaces the price; doesn't touch inventory.
    public fun update_sell_order_price<T>(
        order: &mut SellOrder<T>,
        new_price_per_unit_mist: u64,
        ctx: &TxContext,
    ) {
        assert!(order.seller == tx_context::sender(ctx), ENotSeller);
        assert!(new_price_per_unit_mist > 0, EPriceTooLow);
        let old = order.price_per_unit_mist;
        order.price_per_unit_mist = new_price_per_unit_mist;
        event::emit(PriceUpdated {
            order_id: object::id(order),
            owner: order.seller,
            old_price: old,
            new_price: new_price_per_unit_mist,
            side_is_buy: false,
        });
    }

    public fun top_up_sell_order<T>(
        order: &mut SellOrder<T>,
        more_inventory: Coin<T>,
    ) {
        balance::join(&mut order.inventory, coin::into_balance(more_inventory));
    }

    public fun cancel_sell_order<T>(order: SellOrder<T>, ctx: &mut TxContext) {
        assert!(order.seller == tx_context::sender(ctx), ENotSeller);
        let SellOrder { id, seller, price_per_unit_mist: _, inventory, expires_epoch: _ } = order;
        let refund = balance::value(&inventory);
        event::emit(OrderCancelled {
            order_id: object::uid_to_inner(&id),
            owner: seller,
            refund_amount: refund,
            side_is_buy: false,
        });
        object::delete(id);
        if (refund > 0) {
            transfer::public_transfer(coin::from_balance(inventory, ctx), seller);
        } else {
            balance::destroy_zero(inventory);
        };
    }

    public fun cleanup_expired_sell_order<T>(order: SellOrder<T>, ctx: &mut TxContext) {
        assert!(option::is_some(&order.expires_epoch), ENotExpired);
        assert!(
            tx_context::epoch(ctx) >= *option::borrow(&order.expires_epoch),
            ENotExpired,
        );
        let SellOrder { id, seller, price_per_unit_mist: _, inventory, expires_epoch: _ } = order;
        let refund = balance::value(&inventory);
        event::emit(OrderCancelled {
            order_id: object::uid_to_inner(&id),
            owner: seller,
            refund_amount: refund,
            side_is_buy: false,
        });
        object::delete(id);
        if (refund > 0) {
            transfer::public_transfer(coin::from_balance(inventory, ctx), seller);
        } else {
            balance::destroy_zero(inventory);
        };
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    /// Step 1 of admin handoff. Current admin nominates `new_admin`. Setting
    /// `new_admin == @0x0` clears any pending proposal.
    public fun propose_admin(
        fee_pool: &mut MarketFeePool,
        new_admin: address,
        ctx: &TxContext,
    ) {
        assert!(tx_context::sender(ctx) == fee_pool.admin, ENotAdmin);
        fee_pool.pending_admin = if (new_admin == @0x0) {
            option::none()
        } else {
            option::some(new_admin)
        };
        event::emit(AdminProposed {
            fee_pool_id: object::uid_to_inner(&fee_pool.id),
            current_admin: fee_pool.admin,
            pending_admin: new_admin,
        });
    }

    /// Step 2 of admin handoff. Must be called by the proposed address.
    public fun accept_admin(
        fee_pool: &mut MarketFeePool,
        ctx: &TxContext,
    ) {
        assert!(option::is_some(&fee_pool.pending_admin), ENoPendingAdmin);
        let proposed = *option::borrow(&fee_pool.pending_admin);
        assert!(tx_context::sender(ctx) == proposed, ENotPendingAdmin);
        let old = fee_pool.admin;
        fee_pool.admin = proposed;
        fee_pool.pending_admin = option::none();
        event::emit(AdminTransferred {
            fee_pool_id: object::uid_to_inner(&fee_pool.id),
            old_admin: old,
            new_admin: proposed,
        });
    }

    // ── Read accessors ────────────────────────────────────────────────────────

    public fun buy_buyer<T>(o: &BuyOrder<T>): address { o.buyer }
    public fun buy_price<T>(o: &BuyOrder<T>): u64 { o.price_per_unit_mist }
    public fun buy_budget<T>(o: &BuyOrder<T>): u64 { balance::value(&o.payment) }
    public fun buy_expires<T>(o: &BuyOrder<T>): Option<u64> { o.expires_epoch }

    public fun sell_seller<T>(o: &SellOrder<T>): address { o.seller }
    public fun sell_price<T>(o: &SellOrder<T>): u64 { o.price_per_unit_mist }
    public fun sell_inventory<T>(o: &SellOrder<T>): u64 { balance::value(&o.inventory) }
    public fun sell_expires<T>(o: &SellOrder<T>): Option<u64> { o.expires_epoch }

    public fun fee_pool_admin(fp: &MarketFeePool): address { fp.admin }

    // ── Test helpers ──────────────────────────────────────────────────────────

    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) { init(ctx); }
}
