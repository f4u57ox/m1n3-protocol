/// m1n3 - Hashi Pool Deposit Manager
///
/// Manages the pool's relationship with the Hashi Bitcoin bridge:
///   deposit side  — tracks block-reward UTXOs through the Hashi deposit state machine
///   withdrawal    — documents the call miners make to get native BTC from their hBTC
///
/// ═══════════════════════════════════════════════════════════════════════════
/// ADDRESS DERIVATION  (off-chain, run by operator bot before first block)
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Hashi maps each Sui address to a unique P2TR (Taproot) Bitcoin address using
/// threshold Schnorr key derivation. Given the committee's aggregated MPC public
/// key P (a secp256k1 point) and a 32-byte Sui address as the derivation path:
///
///   t           = SHA256("TapTweak" ‖ P_compressed ‖ sui_address_bytes)
///   child_point = P + t·G            (secp256k1 point addition)
///   x_only      = child_point.x      (32-byte x-coordinate)
///   btc_address = bech32m("bc1p", x_only)   → "bc1p..." P2TR address
///
/// Implementation: fastcrypto_tbls::threshold_schnorr::key_derivation::derive_verifying_key
/// (Hashi crate: crates/hashi/src/deposits.rs → derive_deposit_address)
///
/// Off-chain script (TypeScript):
///   import { deriveBitcoinAddress } from "@mysten/hashi-sdk";
///   const btcAddr = deriveBitcoinAddress(
///     hashiCommitteeMpcPubkey,   // bytes from Hashi's RPC
///     poolObject.id,             // the HashiPoolConfig object address
///     "mainnet",
///   );
///   // → "bc1p<52 chars>"  (P2TR Taproot address, 32-byte witness program)
///
/// ═══════════════════════════════════════════════════════════════════════════
/// FULL FLOW (once Hashi is on mainnet)
/// ═══════════════════════════════════════════════════════════════════════════
///
///  1. [off-chain] Derive pool's P2TR address from HashiPoolConfig.id  ↑
///  2. [off-chain] Set pool's coinbase output to that P2TR address
///  3. [on-chain]  Block found → admin calls record_block_found()
///  4. [on-chain]  Admin calls register_with_hashi()
///                 → hashi::deposit::deposit(hashi, utxo, clock, ctx)
///  5. [on-chain]  Hashi committee calls approve_deposit() (after Bitcoin confirms)
///  6. [on-chain]  Admin calls hashi::deposit::confirm_deposit()
///                 → hBTC minted to HashiPoolConfig.derivation_address
///  7. [on-chain]  Admin calls fund_batch() in hashi_rewards.move with that hBTC
///
/// Withdrawal (miner hBTC → native BTC):
///   miner.call(
///     hashi::withdraw::request_withdrawal(
///       hashi_obj, clock,
///       coin::into_balance(hbtc_coin),
///       my_bitcoin_address,   // P2WPKH (20 bytes) or P2TR (32 bytes)
///       ctx,
///     )
///   )
///   → Hashi committee processes it and sends BTC on Bitcoin network.
#[allow(lint(self_transfer))]
module m1n3_v4::hashi_pool {
    use sui::table::{Self, Table};
    use sui::event;
    use sui::clock::{Self, Clock};
    use m1n3_v4::pool::{Self, PoolAdminCap, BlockFoundClaim};

    // ── Constants ─────────────────────────────────────────────────────────────

    /// Deposit status values — mirror Hashi's internal deposit flow.
    const DEP_UNREGISTERED: u8 = 0; // UTXO found; not yet submitted to Hashi
    const DEP_REGISTERED:   u8 = 1; // hashi::deposit::deposit() called
    const DEP_APPROVED:     u8 = 2; // Hashi committee approved (approve_deposit done)
    const DEP_CONFIRMED:    u8 = 3; // hBTC minted; hashi::deposit::confirm_deposit done
    const DEP_FAILED:       u8 = 4; // Hashi rejected the deposit

    /// Bitcoin address length constants.
    const P2TR_LEN: u64 = 32; // P2TR witness program (32 bytes)

    // ── Errors ────────────────────────────────────────────────────────────────

    const EInvalidBtcAddress: u64 = 1;
    const EInvalidTxid:       u64 = 2;
    const EInvalidStatus:     u64 = 3;
    /// `mark_funded` called twice for the same `BlockDepositRecord`. Each
    /// record can fund exactly one batch; subsequent attempts abort.
    const EAlreadyFunded:     u64 = 15;

    // ── Structs ───────────────────────────────────────────────────────────────

    /// Pool's Hashi integration config (shared object).
    ///
    /// `derivation_address` is the Sui address used as the key-derivation path.
    /// Hashi deterministically maps it to `btc_deposit_address` (a P2TR address).
    /// Block-reward coinbase outputs must target `btc_deposit_address`.
    /// Confirmed Hashi deposits mint hBTC to `derivation_address`.
    public struct HashiPoolConfig has key {
        id: UID,
        /// Sui address used as Hashi key-derivation path.
        /// hBTC from confirmed deposits is minted here.
        /// Must be an account address (not a shared object).
        derivation_address: address,
        /// P2TR Bitcoin address (32-byte witness program) derived from above.
        /// Set by admin after computing off-chain using Hashi's SDK.
        btc_deposit_address: vector<u8>,
        /// Total block-reward deposits submitted to Hashi.
        total_deposits: u64,
        /// Cumulative satoshis confirmed through Hashi (hBTC minted).
        total_sats_confirmed: u128,
        /// Satoshis confirmed but not yet distributed (pending fund_batch call).
        pending_sats: u64,
        /// Deposit records: round_id → record_object_address
        deposit_index: Table<u64, address>,
    }

    /// Per-block-reward UTXO tracked through the Hashi deposit pipeline.
    public struct BlockDepositRecord has key {
        id: UID,
        round_id: u64,
        /// Bitcoin txid of the coinbase transaction (32 bytes, internal byte order).
        txid: vector<u8>,
        /// Output index of the pool's P2TR output in the coinbase tx.
        vout: u32,
        /// Amount in satoshis (coinbase reward + fees).
        amount_sats: u64,
        /// Set after hashi::deposit::deposit() is called.
        hashi_request_id: Option<address>,
        status: u8,
        created_at_ms: u64,
        confirmed_at_ms: Option<u64>,
        failure_reason: Option<vector<u8>>,
        /// One-shot lock: set by `hashi_rewards::open_and_fund_round_batch` to
        /// the new batch's address the first time this record is consumed.
        /// Subsequent funding attempts abort with `EAlreadyFunded`. Closes the
        /// re-fund vector once the vault is refilled by a later deposit.
        funded_batch_id: Option<address>,
    }

    // ── Events ────────────────────────────────────────────────────────────────

    public struct HashiPoolInitialized has copy, drop {
        config_id: address,
        derivation_address: address,
        btc_deposit_address: vector<u8>,
    }

    public struct BtcAddressUpdated has copy, drop {
        config_id: address,
        old_address: vector<u8>,
        new_address: vector<u8>,
    }

    public struct BlockRewardRecorded has copy, drop {
        record_id: address,
        round_id: u64,
        txid: vector<u8>,
        vout: u32,
        amount_sats: u64,
    }

    /// Emitted when admin calls register_with_hashi().
    /// Operator bot (or Hashi devnet client) picks this up and submits the
    /// actual hashi::deposit::deposit() transaction.
    /// Remove this event and replace with a direct Hashi call once Hashi is mainnet.
    public struct HashibDepositRequested has copy, drop {
        record_id: address,
        round_id: u64,
        txid: vector<u8>,
        vout: u32,
        amount_sats: u64,
        derivation_address: address,
    }

    public struct HashibDepositRegistered has copy, drop {
        record_id: address,
        hashi_request_id: address,
    }

    public struct HashibDepositConfirmed has copy, drop {
        record_id: address,
        round_id: u64,
        amount_sats: u64,
    }

    public struct HashibDepositFailed has copy, drop {
        record_id: address,
        round_id: u64,
        reason: vector<u8>,
    }

    // ── Admin: Setup ──────────────────────────────────────────────────────────

    /// Create the pool's Hashi config.
    ///
    /// `derivation_address` — the Sui address Hashi will use as the key-derivation
    ///   path. hBTC from confirmed block rewards is minted to this address.
    ///   In practice this is the address of a `hashi_vault::HashiVault` object
    ///   (an OWNED object whose address can receive transferred coins via
    ///   `transfer::public_receive`). Using an owned object's address sidesteps
    ///   the "shared object can't be a transfer destination" limitation while
    ///   keeping the funds under on-chain, admin-gated custody.
    ///
    /// `btc_deposit_address` — the P2TR Bitcoin address derived off-chain:
    ///   deriveBitcoinAddress(hashiMpcPubkey, derivation_address, network)
    ///   Must be exactly 32 bytes (P2TR witness program, no bech32 prefix).
    ///   Miners put this in their coinbase transactions as the pool's payout address.
    public fun initialize(
        _cap: &PoolAdminCap,
        derivation_address: address,
        btc_deposit_address: vector<u8>,
        ctx: &mut TxContext,
    ) {
        assert!(vector::length(&btc_deposit_address) == P2TR_LEN, EInvalidBtcAddress);

        let config = HashiPoolConfig {
            id: object::new(ctx),
            derivation_address,
            btc_deposit_address,
            total_deposits: 0,
            total_sats_confirmed: 0,
            pending_sats: 0,
            deposit_index: table::new(ctx),
        };

        let config_id = object::uid_to_address(&config.id);

        event::emit(HashiPoolInitialized {
            config_id,
            derivation_address,
            btc_deposit_address,
        });

        transfer::share_object(config);
    }

    /// Rotate the pool's P2TR Bitcoin address (e.g., after Hashi epoch change).
    /// Update your block templates immediately after calling this.
    public fun update_btc_address(
        _cap: &PoolAdminCap,
        config: &mut HashiPoolConfig,
        new_btc_deposit_address: vector<u8>,
    ) {
        assert!(vector::length(&new_btc_deposit_address) == P2TR_LEN, EInvalidBtcAddress);

        let old_address = config.btc_deposit_address;
        config.btc_deposit_address = new_btc_deposit_address;

        event::emit(BtcAddressUpdated {
            config_id: object::uid_to_address(&config.id),
            old_address,
            new_address: new_btc_deposit_address,
        });
    }

    // ── Permissionless: Deposit Pipeline ──────────────────────────────────────

    /// Record a block-reward UTXO found at the pool's P2TR address.
    ///
    /// Permissionless and cryptographically bound: the `round_id` and
    /// `block_finder` are read from the frozen `BlockFoundClaim` emitted by
    /// `pool::submit_share`, so the operator cannot decouple "round that
    /// found the block" from "round whose miners get paid". The caller still
    /// supplies the Bitcoin UTXO details (`txid`, `vout`, `amount_sats`)
    /// because those are off-chain facts; Hashi's committee validates them
    /// against the actual chain state before approving the deposit, so
    /// lying here just results in Hashi rejecting the deposit.
    ///
    /// `txid` — 32-byte Bitcoin txid in internal byte order (as returned by
    ///   bitcoin-cli getblock, NOT the display-reversed hex).
    public fun record_block_found(
        config: &mut HashiPoolConfig,
        clock: &Clock,
        claim: &BlockFoundClaim,
        txid: vector<u8>,
        vout: u32,
        amount_sats: u64,
        ctx: &mut TxContext,
    ) {
        assert!(vector::length(&txid) == 32, EInvalidTxid);

        let round_id = pool::claim_round_id(claim);
        let now = clock::timestamp_ms(clock);
        let record = BlockDepositRecord {
            id: object::new(ctx),
            round_id,
            txid,
            vout,
            amount_sats,
            hashi_request_id: option::none(),
            status: DEP_UNREGISTERED,
            created_at_ms: now,
            confirmed_at_ms: option::none(),
            failure_reason: option::none(),
            funded_batch_id: option::none(),
        };

        let record_id = object::uid_to_address(&record.id);
        table::add(&mut config.deposit_index, round_id, record_id);
        config.total_deposits = config.total_deposits + 1;

        event::emit(BlockRewardRecorded {
            record_id,
            round_id,
            txid,
            vout,
            amount_sats,
        });

        transfer::share_object(record);
    }

    /// Signal that this UTXO should be registered with Hashi.
    ///
    /// Pre-mainnet: emits HashibDepositRequested so the operator bot calls
    ///   hashi::deposit::deposit(hashi_obj, utxo(utxo_id(txid, vout), sats, some(derivation_address)), clock, ctx)
    ///   on Hashi's shared object.
    ///
    /// Post-mainnet: replace the event with a direct call:
    ///   use hashi::deposit;
    ///   use hashi::utxo::{Self, utxo_id};
    ///   deposit::deposit(
    ///     hashi_obj,
    ///     utxo::utxo(utxo_id(txid_as_address(record.txid), record.vout),
    ///                record.amount_sats,
    ///                option::some(config.derivation_address)),
    ///     clock, ctx,
    ///   );
    public fun register_with_hashi(
        _cap: &PoolAdminCap,
        config: &HashiPoolConfig,
        record: &mut BlockDepositRecord,
        _ctx: &mut TxContext,
    ) {
        assert!(record.status == DEP_UNREGISTERED, EInvalidStatus);

        record.status = DEP_REGISTERED;

        event::emit(HashibDepositRequested {
            record_id: object::uid_to_address(&record.id),
            round_id: record.round_id,
            txid: record.txid,
            vout: record.vout,
            amount_sats: record.amount_sats,
            derivation_address: config.derivation_address,
        });
    }

    /// Record the Hashi request ID returned by hashi::deposit::deposit().
    /// The operator bot calls this after submitting the deposit to Hashi.
    public fun set_hashi_request_id(
        _cap: &PoolAdminCap,
        record: &mut BlockDepositRecord,
        hashi_request_id: address,
    ) {
        assert!(record.status == DEP_REGISTERED, EInvalidStatus);
        record.hashi_request_id = option::some(hashi_request_id);

        event::emit(HashibDepositRegistered {
            record_id: object::uid_to_address(&record.id),
            hashi_request_id,
        });
    }

    /// Mark a deposit as approved by the Hashi committee.
    /// Call this after hashi::deposit::approve_deposit() succeeds on Hashi's object.
    public fun mark_hashi_approved(
        _cap: &PoolAdminCap,
        record: &mut BlockDepositRecord,
    ) {
        assert!(record.status == DEP_REGISTERED, EInvalidStatus);
        record.status = DEP_APPROVED;
    }

    /// Mark a deposit confirmed (hBTC minted to derivation_address).
    /// Call this after hashi::deposit::confirm_deposit() succeeds.
    /// Updates pending_sats so the admin knows how much hBTC is available
    /// to fund the next HashiRewardBatch.
    public fun mark_hashi_confirmed(
        _cap: &PoolAdminCap,
        config: &mut HashiPoolConfig,
        record: &mut BlockDepositRecord,
        clock: &Clock,
    ) {
        assert!(record.status == DEP_APPROVED, EInvalidStatus);

        let now = clock::timestamp_ms(clock);
        record.status = DEP_CONFIRMED;
        record.confirmed_at_ms = option::some(now);

        config.total_sats_confirmed = config.total_sats_confirmed + (record.amount_sats as u128);
        config.pending_sats = config.pending_sats + record.amount_sats;

        event::emit(HashibDepositConfirmed {
            record_id: object::uid_to_address(&record.id),
            round_id: record.round_id,
            amount_sats: record.amount_sats,
        });
    }

    /// Mark a deposit as failed (Hashi rejected it, e.g., UTXO not confirmed
    /// on Bitcoin, below minimum, or AML rejection).
    public fun mark_hashi_failed(
        _cap: &PoolAdminCap,
        record: &mut BlockDepositRecord,
        reason: vector<u8>,
    ) {
        assert!(
            record.status == DEP_REGISTERED || record.status == DEP_APPROVED,
            EInvalidStatus,
        );

        record.status = DEP_FAILED;
        record.failure_reason = option::some(reason);

        event::emit(HashibDepositFailed {
            record_id: object::uid_to_address(&record.id),
            round_id: record.round_id,
            reason,
        });
    }

    /// Clear pending_sats once the admin has funded a HashiRewardBatch.
    /// Call this after hashi_rewards::fund_batch() to keep the accounting tidy.
    public fun clear_pending_sats(
        _cap: &PoolAdminCap,
        config: &mut HashiPoolConfig,
        amount: u64,
    ) {
        if (amount >= config.pending_sats) {
            config.pending_sats = 0;
        } else {
            config.pending_sats = config.pending_sats - amount;
        };
    }

    // ── View Functions ────────────────────────────────────────────────────────

    public fun derivation_address(config: &HashiPoolConfig): address {
        config.derivation_address
    }

    public fun btc_deposit_address(config: &HashiPoolConfig): vector<u8> {
        config.btc_deposit_address
    }

    public fun pending_sats(config: &HashiPoolConfig): u64 {
        config.pending_sats
    }

    public fun total_deposits(config: &HashiPoolConfig): u64 {
        config.total_deposits
    }

    public fun total_sats_confirmed(config: &HashiPoolConfig): u128 {
        config.total_sats_confirmed
    }

    public fun deposit_record_id_for_round(config: &HashiPoolConfig, round_id: u64): address {
        *table::borrow(&config.deposit_index, round_id)
    }

    public fun record_status(record: &BlockDepositRecord): u8 { record.status }
    public fun record_round_id(record: &BlockDepositRecord): u64 { record.round_id }

    /// True iff this record's Hashi deposit reached the CONFIRMED state
    /// (committee approved + confirm_deposit executed + hBTC minted).
    /// Used by `hashi_rewards::open_and_fund_round_batch` as the trustless
    /// gate keeping the vault locked until Hashi has actually credited it.
    public fun is_confirmed(record: &BlockDepositRecord): bool {
        record.status == DEP_CONFIRMED
    }
    public fun record_txid(record: &BlockDepositRecord): vector<u8> { record.txid }
    public fun record_vout(record: &BlockDepositRecord): u32 { record.vout }
    public fun record_amount_sats(record: &BlockDepositRecord): u64 { record.amount_sats }
    public fun record_hashi_request_id(record: &BlockDepositRecord): Option<address> {
        record.hashi_request_id
    }
    public fun funded_batch_id(record: &BlockDepositRecord): Option<address> {
        record.funded_batch_id
    }

    /// Package-internal one-shot lock used by
    /// `hashi_rewards::open_and_fund_round_batch`. Aborts if the record has
    /// already funded a batch — this is what prevents a re-fund attack
    /// after the vault is replenished by a later deposit.
    public(package) fun mark_funded(
        record: &mut BlockDepositRecord,
        batch_id: address,
    ) {
        assert!(option::is_none(&record.funded_batch_id), EAlreadyFunded);
        record.funded_batch_id = option::some(batch_id);
    }

    public fun dep_unregistered(): u8 { DEP_UNREGISTERED }
    public fun dep_registered(): u8 { DEP_REGISTERED }
    public fun dep_approved(): u8 { DEP_APPROVED }
    public fun dep_confirmed(): u8 { DEP_CONFIRMED }
    public fun dep_failed(): u8 { DEP_FAILED }

    // ── Test Helpers ──────────────────────────────────────────────────────────

    #[test_only]
    public fun p2tr_len(): u64 { P2TR_LEN }

    #[test_only]
    public fun p2wpkh_len(): u64 { 20 }

    /// Test helper: synthesise a CONFIRMED BlockDepositRecord without going
    /// through the full register→approve→confirm pipeline. Used by tests
    /// for the trustless `open_and_fund_round_batch` path.
    #[test_only]
    public fun create_confirmed_record_for_testing(
        round_id: u64,
        amount_sats: u64,
        ctx: &mut TxContext,
    ) {
        let record = BlockDepositRecord {
            id: object::new(ctx),
            round_id,
            txid: x"0000000000000000000000000000000000000000000000000000000000000001",
            vout: 0,
            amount_sats,
            hashi_request_id: option::none(),
            status: DEP_CONFIRMED,
            created_at_ms: 0,
            confirmed_at_ms: option::some(0),
            failure_reason: option::none(),
            funded_batch_id: option::none(),
        };
        transfer::share_object(record);
    }
}
