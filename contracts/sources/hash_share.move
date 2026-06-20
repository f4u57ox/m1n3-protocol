/// HashShare minting and per-round redemption.
///
/// `mint_share<T>` is the third destination for a `ShareReceipt` (alongside
/// the existing pool-reward drop and `market::fill_buy_order` paths). It
/// consumes the receipt, marks the share as sold (so it doesn't double-pay
/// from the pool side), and mints `Coin<HASHSHARE_*>` 1:1 with the share's
/// difficulty. The minted coin is freely transferable / tradeable.
///
/// At round close, anyone permissionlessly opens a `HashShareRedemption<T>`
/// by routing the round's CONFIRMED Hashi deposit into a per-slot redemption
/// pool. Holders then burn HashShares for proportional `Coin<BTC>`. After a
/// grace deadline, residual BTC recycles back to the vault (analogous to
/// `hashi_rewards::recycle_expired_to_vault`).
///
/// Exclusivity invariant
/// ---------------------
/// `mint_share` calls `miner::record_sold_share`, which deducts the share's
/// difficulty from the miner's `MinerRoundStats.work` at accumulation time.
/// So a share routed to HashShare cannot also earn a pro-rata cut of the
/// round's pool reward. The same `sold_work` field is used by
/// `market::fill_buy_order`. Picking one of the three destinations per share
/// is the miner's call at submission time.
///
/// Redemption math
/// ---------------
/// At redemption open: `sats_per_share = record.amount_sats / total_supply`.
/// Floor division; any dust accumulates in the redemption balance and
/// recycles to the vault after the grace period.
module m1n3_v4::hash_share {
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin, TreasuryCap};
    use sui::clock::{Self, Clock};
    use sui::event;
    use openzeppelin_math::u64::mul_div;
    use openzeppelin_math::rounding;
    use m1n3_v4::pool::{Self, ShareReceipt, RoundHistory};
    use m1n3_v4::miner::{Self, MinerRoundStats};
    use m1n3_v4::hash_share_registry::{Self, HashShareRegistry};
    use m1n3_v4::hashi_pool::{Self, BlockDepositRecord};
    use m1n3_v4::hashi_vault::{Self, HashiVault};

    // ── Constants ─────────────────────────────────────────────────────────────

    /// 30-day grace period for holders to redeem before the residual balance
    /// is recycled to the vault. Mirrors `hashi_rewards::TRUSTLESS_CLAIM_WINDOW_MS`.
    const REDEMPTION_WINDOW_MS: u64 = 30 * 24 * 60 * 60 * 1000;

    // ── Errors ────────────────────────────────────────────────────────────────

    #[error]
    const EWrongCap: vector<u8> = b"Provided TreasuryCap does not match the round's bound HashShare slot";
    #[error]
    const ERoundMismatch: vector<u8> = b"BlockDepositRecord round_id does not match the RoundHistory";
    #[error]
    const EDepositNotConfirmed: vector<u8> = b"BlockDepositRecord has not been CONFIRMED by the Hashi committee";
    #[error]
    const EZeroBalance: vector<u8> = b"Deposit record amount_sats is zero; nothing to seed the redemption with";
    #[error]
    const EZeroSupply: vector<u8> = b"HashShare supply is zero; cannot open a redemption against an empty round";
    #[error]
    const EZeroAmount: vector<u8> = b"Burn amount must be greater than zero";
    #[error]
    const EWindowNotPassed: vector<u8> = b"Redemption window has not expired yet";
    #[error]
    const EAlreadyExpired: vector<u8> = b"Redemption has already expired and been recycled";
    #[error]
    const ERedemptionAlreadyOpen: vector<u8> = b"A Redemption already exists for this round";

    // ── Structs ───────────────────────────────────────────────────────────────

    /// Per-round redemption pool. Holders of `Coin<T>` burn into this pool
    /// for proportional `Coin<CoinType>` at the fixed ratio set on open.
    /// `CoinType` is the hBTC type the vault holds (typically
    /// `hashi::btc::BTC`); making it a phantom parameter keeps the code
    /// generic over any vault coin.
    public struct Redemption<phantom T, phantom CoinType> has key {
        id: UID,
        round_id: u64,
        supply_at_open: u64,
        total_sats: u64,
        outstanding_supply: u64,
        paid_sats: u64,
        balance: Balance<CoinType>,
        deadline_ms: u64,
        is_expired: bool,
    }

    // ── Events ────────────────────────────────────────────────────────────────

    public struct HashShareMinted has copy, drop {
        round_id: u64,
        miner: address,
        difficulty: u64,
        cap_id: address,
        /// Amount of HashShares retained by the miner after the protocol
        /// fee was split off.
        miner_units: u64,
        /// Amount of HashShares routed to the protocol fee recipient.
        fee_units: u64,
        /// Fee in basis points read from the registry at mint time.
        fee_bps: u64,
    }

    public struct RedemptionOpened has copy, drop {
        round_id: u64,
        cap_id: address,
        supply_at_open: u64,
        total_sats: u64,
        deadline_ms: u64,
    }

    public struct HashShareRedeemed has copy, drop {
        round_id: u64,
        holder: address,
        burned_units: u64,
        received_sats: u64,
        outstanding_supply: u64,
    }

    public struct RedemptionRecycled has copy, drop {
        round_id: u64,
        residual_sats: u64,
        paid_sats: u64,
    }

    // ── Mint ──────────────────────────────────────────────────────────────────

    /// Mint `Coin<T>` for a share, with a protocol fee split.
    ///
    /// Total supply minted for a share of difficulty D is D HashShares —
    /// 1:1 with difficulty, unchanged from the no-fee design. The split:
    ///
    ///   fee_units   = floor(D * registry.fee_bps / 10000)
    ///   miner_units = D - fee_units
    ///
    /// `miner_units` is returned to the caller (the miner); `fee_units`
    /// is sent to `registry.fee_recipient` as `Coin<T>`. Both ends end up
    /// holding the same fungible asset; the fee recipient redeems it
    /// against the round's HashShareRedemption pool just like any other
    /// holder, so protocol revenue is naturally BTC-denominated.
    ///
    /// First-mint-of-round path:
    ///   call `hash_share_registry::bind_slot_to_round(registry, round_id)`
    ///   in the same PTB before `mint_share`. Subsequent mints in the same
    ///   round skip the bind (idempotent).
    ///
    /// Aborts:
    ///   EWrongCap — `treasury_cap`'s id doesn't match the slot the registry
    ///               bound for this round.
    /// Sidecar-friendly variant: mint and transfer the resulting `Coin<T>`
    /// to `recipient` in the same PTB. Lets the miner-sidecar chain
    /// `pool::submit_share` → `mint_share_to` without a separate transfer
    /// command. The mint accounting is identical to `mint_share`.
    public fun mint_share_to<T>(
        registry: &HashShareRegistry,
        treasury_cap: &mut TreasuryCap<T>,
        receipt: ShareReceipt,
        miner_round_stats: &mut MinerRoundStats,
        recipient: address,
        ctx: &mut TxContext,
    ) {
        let coin = mint_share<T>(registry, treasury_cap, receipt, miner_round_stats, ctx);
        transfer::public_transfer(coin, recipient);
    }

    public fun mint_share<T>(
        registry: &HashShareRegistry,
        treasury_cap: &mut TreasuryCap<T>,
        receipt: ShareReceipt,
        miner_round_stats: &mut MinerRoundStats,
        ctx: &mut TxContext,
    ): Coin<T> {
        let round_id   = pool::receipt_round_id(&receipt);
        let miner      = pool::receipt_miner(&receipt);
        let difficulty = pool::receipt_difficulty(&receipt);

        let cap_id = object::id_address(treasury_cap);
        hash_share_registry::assert_cap_matches_round(registry, round_id, cap_id);

        // Exclusivity vs pool reward + market fill: same `sold_work` field.
        miner::record_sold_share(miner_round_stats, miner, difficulty, round_id);

        let mut all_minted = coin::mint<T>(treasury_cap, difficulty, ctx);

        // Split the protocol fee. Floor-divide; sub-bps remainders accrue
        // to the miner. Skip the transfer entirely when fee_bps == 0 so
        // operators can disable it via `set_fee_bps(0)`.
        let fee_bps = hash_share_registry::fee_bps(registry);
        let fee_units = mul_div(difficulty, fee_bps, hash_share_registry::bps_denom(), rounding::down()).destroy_some();
        if (fee_units > 0) {
            let fee_coin = coin::split(&mut all_minted, fee_units, ctx);
            transfer::public_transfer(
                fee_coin,
                hash_share_registry::fee_recipient(registry),
            );
        };
        let miner_units = coin::value(&all_minted);

        event::emit(HashShareMinted {
            round_id, miner, difficulty, cap_id,
            miner_units, fee_units, fee_bps,
        });
        all_minted
    }

    // ── Open redemption ──────────────────────────────────────────────────────

    /// Open the per-round HashShare redemption pool. Permissionless,
    /// trustless mirror of `hashi_rewards::open_and_fund_round_batch`:
    ///   • `deposit_record.round_id == round_history.round_id`
    ///   • `deposit_record.status == CONFIRMED`
    ///   • Drain exactly `record.amount_sats` from the vault
    ///   • Mark the record as funded (one-shot)
    ///
    /// Differs from the MWR-based path by routing funds into a per-supply
    /// proportional pool rather than a single-claim batch. Either path can
    /// coexist with the other per round, since miners pick at submission
    /// time which fraction of their work goes each direction (drop / market
    /// / mint). If both routes co-fund the same round, the operator decides
    /// off-chain how to split `record.amount_sats`; in practice the simple
    /// case is "the whole record funds one route or the other."
    public fun open_redemption<T, CoinType>(
        registry: &HashShareRegistry,
        treasury_cap: &TreasuryCap<T>,
        vault: &mut HashiVault<CoinType>,
        round_history: &RoundHistory,
        deposit_record: &mut BlockDepositRecord,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let round_id = pool::round_history_round_id(round_history);
        assert!(hashi_pool::record_round_id(deposit_record) == round_id, ERoundMismatch);
        assert!(hashi_pool::is_confirmed(deposit_record), EDepositNotConfirmed);
        assert!(!option::is_some(&hashi_pool::funded_batch_id(deposit_record)),
            ERedemptionAlreadyOpen);

        let cap_id = object::id_address(treasury_cap);
        hash_share_registry::assert_cap_matches_round(registry, round_id, cap_id);

        let supply_at_open = coin::total_supply(treasury_cap);
        assert!(supply_at_open > 0, EZeroSupply);

        let total_sats = hashi_pool::record_amount_sats(deposit_record);
        assert!(total_sats > 0, EZeroBalance);

        let drained = hashi_vault::take_exact_hbtc<CoinType>(vault, total_sats);
        let now = clock::timestamp_ms(clock);

        let mut redemption = Redemption<T, CoinType> {
            id: object::new(ctx),
            round_id,
            supply_at_open,
            total_sats,
            outstanding_supply: supply_at_open,
            paid_sats: 0,
            balance: balance::zero(),
            deadline_ms: now + REDEMPTION_WINDOW_MS,
            is_expired: false,
        };
        balance::join(&mut redemption.balance, drained);

        let redemption_id = object::uid_to_address(&redemption.id);
        // One-shot lock on the record — same fund_batch_id slot, repurposed
        // to mean "this record paid out, via redemption or batch — either way
        // it can't pay a second time."
        hashi_pool::mark_funded(deposit_record, redemption_id);

        event::emit(RedemptionOpened {
            round_id,
            cap_id,
            supply_at_open,
            total_sats,
            deadline_ms: redemption.deadline_ms,
        });
        transfer::share_object(redemption);
    }

    // ── Redeem ────────────────────────────────────────────────────────────────

    /// Burn `Coin<T>` for proportional `Coin<CoinType>`. Floor-divides; dust
    /// remains in the redemption pool's balance and recycles to the vault
    /// after the deadline.
    public fun redeem<T, CoinType>(
        redemption: &mut Redemption<T, CoinType>,
        treasury_cap: &mut TreasuryCap<T>,
        burn_coin: Coin<T>,
        clock: &Clock,
        ctx: &mut TxContext,
    ): Coin<CoinType> {
        assert!(!redemption.is_expired, EAlreadyExpired);
        assert!(clock::timestamp_ms(clock) < redemption.deadline_ms, EAlreadyExpired);

        let burned_units = coin::value(&burn_coin);
        assert!(burned_units > 0, EZeroAmount);

        let payout = mul_div(
            burned_units,
            redemption.total_sats,
            redemption.supply_at_open,
            rounding::down(),
        ).destroy_some();

        coin::burn(treasury_cap, burn_coin);

        redemption.outstanding_supply = redemption.outstanding_supply - burned_units;
        redemption.paid_sats = redemption.paid_sats + payout;

        let payout_balance = balance::split(&mut redemption.balance, payout);

        event::emit(HashShareRedeemed {
            round_id: redemption.round_id,
            holder: tx_context::sender(ctx),
            burned_units,
            received_sats: payout,
            outstanding_supply: redemption.outstanding_supply,
        });

        coin::from_balance(payout_balance, ctx)
    }

    // ── Recycle expired residual ─────────────────────────────────────────────

    /// After the deadline, sweep any residual balance (dust from floor
    /// division + un-redeemed allocations) back to the vault so it rolls
    /// into a future round's redemption / batch. Permissionless; no
    /// caller-chosen destination.
    public fun recycle_expired_redemption<T, CoinType>(
        redemption: &mut Redemption<T, CoinType>,
        vault: &mut HashiVault<CoinType>,
        clock: &Clock,
    ) {
        assert!(!redemption.is_expired, EAlreadyExpired);
        assert!(clock::timestamp_ms(clock) >= redemption.deadline_ms, EWindowNotPassed);

        let residual = balance::value(&redemption.balance);
        if (residual > 0) {
            let bal = balance::split(&mut redemption.balance, residual);
            hashi_vault::deposit_hbtc<CoinType>(vault, bal);
        };
        redemption.is_expired = true;

        event::emit(RedemptionRecycled {
            round_id: redemption.round_id,
            residual_sats: residual,
            paid_sats: redemption.paid_sats,
        });
    }

    // ── Read accessors ───────────────────────────────────────────────────────

    public fun redemption_round_id<T, CoinType>(r: &Redemption<T, CoinType>): u64 { r.round_id }
    public fun redemption_supply_at_open<T, CoinType>(r: &Redemption<T, CoinType>): u64 { r.supply_at_open }
    public fun redemption_total_sats<T, CoinType>(r: &Redemption<T, CoinType>): u64 { r.total_sats }
    public fun redemption_outstanding_supply<T, CoinType>(r: &Redemption<T, CoinType>): u64 { r.outstanding_supply }
    public fun redemption_paid_sats<T, CoinType>(r: &Redemption<T, CoinType>): u64 { r.paid_sats }
    public fun redemption_balance<T, CoinType>(r: &Redemption<T, CoinType>): u64 { balance::value(&r.balance) }
    public fun redemption_deadline_ms<T, CoinType>(r: &Redemption<T, CoinType>): u64 { r.deadline_ms }
    public fun redemption_is_expired<T, CoinType>(r: &Redemption<T, CoinType>): bool { r.is_expired }
}
