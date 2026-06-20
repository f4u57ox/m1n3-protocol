/// m1n3 — Hashi Vault: object-owned BTC/SUI receptacle for the pool's Hashi flow.
///
/// Why an object?
///   Hashi (see MystenLabs/hashi: packages/hashi/sources/btc/deposit.move) takes
///   the deposit's `derivation_path: Option<address>` AS-IS as the recipient
///   when minting hBTC. The mint happens via
///       sui::balance::send_funds(btc, recipient)
///   which credits the recipient's entry in the Sui funds accumulator. The
///   accumulator's `withdraw_funds_from_object<T>(obj: &mut UID, value)` lets
///   any object's address pull its credited balance.
///
///   That's the entire mechanism: this vault's UID-derived address IS the
///   `recipient`, and `claim_accumulated_hbtc` is how it pulls the credited
///   Balance<hBTC> into its on-vault balance.
///
///   For non-Hashi senders that use plain Transfer-to-Object instead of
///   send_funds, `receive_hbtc` covers the alternate path.
///
/// Flow:
///   1. Admin calls `create` → HashiVault is transferred to the admin
///      (owned). Its object address is the Sui address Hashi will use.
///   2. Admin tells Hashi to use that address as the derivation path. The
///      committee mints hBTC into the vault's address when a deposit
///      confirms.
///   3. Admin calls `receive_btc<HBTC>(vault, hbtc_receiving_ticket)` to claim
///      the incoming Coin<HBTC> into the vault's Balance<HBTC>.
///   4. When funding a HashiRewardBatch, admin calls
///      `withdraw_btc<HBTC>(vault, amount, ctx)` to peel off a Coin<HBTC>
///      and pass it into `hashi_rewards::fund_batch`.
///
/// SUI balance: incoming gas/fees can be claimed via `receive_sui` and used by
///   the admin to pay Hashi protocol fees.
///
/// Capability model: every state-changing call requires the matching
///   `PoolAdminCap` from m1n3_v4::pool — same authority that runs the pool.
module m1n3_v4::hashi_vault {
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin};
    use sui::event;
    use sui::sui::SUI;
    use sui::transfer::Receiving;
    use m1n3_v4::pool::PoolAdminCap;

    // ── Errors ────────────────────────────────────────────────────────────────

    const EZeroAmount: u64 = 1;
    const EInsufficientBalance: u64 = 2;

    // ── Object ────────────────────────────────────────────────────────────────

    /// Owned receptacle. Generic over the bridged BTC coin type
    /// (intended: `hashi::btc::BTC`).
    public struct HashiVault<phantom HBTC> has key {
        id: UID,
        hbtc: Balance<HBTC>,
        sui: Balance<SUI>,
        /// Lifetime sums for reporting.
        total_received_hbtc: u64,
        total_withdrawn_hbtc: u64,
        total_received_sui: u64,
        total_withdrawn_sui: u64,
    }

    // ── Events ────────────────────────────────────────────────────────────────

    public struct VaultCreated has copy, drop {
        vault_id: address,
        derivation_path: address,
    }

    public struct VaultReceivedHbtc has copy, drop {
        vault_id: address,
        amount: u64,
        new_balance: u64,
    }

    public struct VaultReceivedSui has copy, drop {
        vault_id: address,
        amount: u64,
        new_balance: u64,
    }

    public struct VaultWithdrewHbtc has copy, drop {
        vault_id: address,
        amount: u64,
        new_balance: u64,
    }

    // ── Construction ──────────────────────────────────────────────────────────
    //
    // SHARED-only. There is intentionally no owned-vault constructor: an
    // owned vault can't be referenced by `&mut` from arbitrary signers, so
    // the trustless funding path (`hashi_rewards::open_and_fund_round_batch`)
    // can't drive it. Forcing the shared variant is part of removing the
    // operator's control surface.

    /// Create a new vault as a SHARED object. Funds can only leave via the
    /// rewards pipeline (no external function returns a withdrawable Balance
    /// to the caller).
    public fun create_shared<HBTC>(_cap: &PoolAdminCap, ctx: &mut TxContext) {
        let vault = HashiVault<HBTC> {
            id: object::new(ctx),
            hbtc: balance::zero<HBTC>(),
            sui: balance::zero<SUI>(),
            total_received_hbtc: 0,
            total_withdrawn_hbtc: 0,
            total_received_sui: 0,
            total_withdrawn_sui: 0,
        };
        let vault_id = object::uid_to_address(&vault.id);
        event::emit(VaultCreated {
            vault_id,
            derivation_path: vault_id,
        });
        transfer::share_object(vault);
    }

    // ── Incoming: Transfer-to-Object claim ────────────────────────────────────

    /// Claim a Coin<HBTC> that was transferred to the vault's address with the
    /// standard Transfer-to-Object pattern. Use this when the sender did a
    /// plain `transfer::public_transfer(coin, vault_address)`.
    public fun receive_hbtc<HBTC>(
        vault: &mut HashiVault<HBTC>,
        receiving: Receiving<Coin<HBTC>>,
    ) {
        let coin = transfer::public_receive(&mut vault.id, receiving);
        let amount = coin::value(&coin);
        let bal = coin::into_balance(coin);
        balance::join(&mut vault.hbtc, bal);
        vault.total_received_hbtc = vault.total_received_hbtc + amount;
        event::emit(VaultReceivedHbtc {
            vault_id: object::uid_to_address(&vault.id),
            amount,
            new_balance: balance::value(&vault.hbtc),
        });
    }

    public fun receive_sui<HBTC>(
        vault: &mut HashiVault<HBTC>,
        receiving: Receiving<Coin<SUI>>,
    ) {
        let coin = transfer::public_receive(&mut vault.id, receiving);
        let amount = coin::value(&coin);
        let bal = coin::into_balance(coin);
        balance::join(&mut vault.sui, bal);
        vault.total_received_sui = vault.total_received_sui + amount;
        event::emit(VaultReceivedSui {
            vault_id: object::uid_to_address(&vault.id),
            amount,
            new_balance: balance::value(&vault.sui),
        });
    }

    // ── Incoming: Funds-accumulator claim (Hashi's mint path) ─────────────────
    //
    // Hashi's `deposit::confirm_deposit` mints `Balance<BTC>` and credits the
    // recipient via `sui::balance::send_funds(btc, recipient)` — the funds
    // accumulator, not Transfer-to-Object. When recipient is our vault's
    // address, the accumulator records an object-owned balance entry; we
    // collect it with `balance::withdraw_funds_from_object`.
    //
    // The protocol-level feature flag `enable_object_funds_withdraw` must be
    // active on the network. Sui devnet/testnet have this enabled.

    public fun claim_accumulated_hbtc<HBTC>(
        vault: &mut HashiVault<HBTC>,
        amount: u64,
    ) {
        let withdrawal = balance::withdraw_funds_from_object<HBTC>(&mut vault.id, amount);
        let bal = balance::redeem_funds(withdrawal);
        balance::join(&mut vault.hbtc, bal);
        vault.total_received_hbtc = vault.total_received_hbtc + amount;
        event::emit(VaultReceivedHbtc {
            vault_id: object::uid_to_address(&vault.id),
            amount,
            new_balance: balance::value(&vault.hbtc),
        });
    }

    public fun claim_accumulated_sui<HBTC>(
        vault: &mut HashiVault<HBTC>,
        amount: u64,
    ) {
        let withdrawal = balance::withdraw_funds_from_object<SUI>(&mut vault.id, amount);
        let bal = balance::redeem_funds(withdrawal);
        balance::join(&mut vault.sui, bal);
        vault.total_received_sui = vault.total_received_sui + amount;
        event::emit(VaultReceivedSui {
            vault_id: object::uid_to_address(&vault.id),
            amount,
            new_balance: balance::value(&vault.sui),
        });
    }

    // ── Outgoing: permissionless package-only drain ───────────────────────────
    //
    // For the trustless reward path. Only the m1n3 package can call this,
    // and the *only* in-package caller is `hashi_rewards::open_and_fund_round_batch`,
    // which atomically moves the drained balance into a public `HashiRewardBatch`.
    // No external caller, no operator cap. The HBTC cannot leave the vault
    // except into a batch that miners claim against.
    //
    // EXACT-amount semantics (Action B): drain only `amount` sats, leaving any
    // residual in the vault for the *next* round's batch. Bounding the drain
    // to the deposit's known amount closes the multi-round corruption where a
    // single caller could siphon two rounds' HBTC into one batch.

    public(package) fun take_exact_hbtc<HBTC>(
        vault: &mut HashiVault<HBTC>,
        amount: u64,
    ): Balance<HBTC> {
        assert!(amount > 0, EZeroAmount);
        assert!(balance::value(&vault.hbtc) >= amount, EInsufficientBalance);
        let part = balance::split(&mut vault.hbtc, amount);
        vault.total_withdrawn_hbtc = vault.total_withdrawn_hbtc + amount;
        event::emit(VaultWithdrewHbtc {
            vault_id: object::uid_to_address(&vault.id),
            amount,
            new_balance: balance::value(&vault.hbtc),
        });
        part
    }

    /// Receive a refund of HBTC back into the vault's internal balance.
    /// Used by `hashi_rewards::recycle_expired_to_vault` to roll unclaimed
    /// funds from an expired batch back into the next round's funding pool.
    public(package) fun deposit_hbtc<HBTC>(vault: &mut HashiVault<HBTC>, amount: Balance<HBTC>) {
        let received = balance::value(&amount);
        balance::join(&mut vault.hbtc, amount);
        vault.total_received_hbtc = vault.total_received_hbtc + received;
        event::emit(VaultReceivedHbtc {
            vault_id: object::uid_to_address(&vault.id),
            amount: received,
            new_balance: balance::value(&vault.hbtc),
        });
    }

    // ── Outgoing: see take_all_hbtc / deposit_hbtc above ──────────────────────
    //
    // HBTC cannot leave the vault except via `hashi_rewards::open_and_fund_round_batch`
    // (which calls the package-only `take_all_hbtc`). SUI accumulator drained
    // by `claim_accumulated_sui` stays inside `vault.sui` permanently — there
    // is no SUI withdrawal path. If we ever need to pay Hashi protocol fees
    // in SUI we'll add a trustless equivalent then.

    // ── Read accessors ────────────────────────────────────────────────────────

    public fun derivation_path<HBTC>(vault: &HashiVault<HBTC>): address {
        object::uid_to_address(&vault.id)
    }

    public fun hbtc_balance<HBTC>(vault: &HashiVault<HBTC>): u64 {
        balance::value(&vault.hbtc)
    }

    public fun sui_balance<HBTC>(vault: &HashiVault<HBTC>): u64 {
        balance::value(&vault.sui)
    }

    public fun lifetime_received_hbtc<HBTC>(vault: &HashiVault<HBTC>): u64 {
        vault.total_received_hbtc
    }

    public fun lifetime_withdrawn_hbtc<HBTC>(vault: &HashiVault<HBTC>): u64 {
        vault.total_withdrawn_hbtc
    }
}
