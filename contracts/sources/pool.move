/// Core mining pool — manages workers, active jobs, and reward distribution.
///
/// Every critical operation that the Stratum v1 server performs off-chain is
/// mirrored here on Sui:
///
/// • `post_job`       — operator registers a mining job template on-chain
/// • `register_worker`— miner registers with the extranonce1 the pool assigned them
/// • `submit_share`   — miner submits a share; contract verifies the PoW independently
/// • `claim_reward`   — miner withdraws their proportional SUI payout, permissionlessly
///
/// Share verification calls `share::verify_share`, which runs real SHA-256d + difficulty
/// comparison on-chain — no trust in the pool operator is required for attribution.
module m1n3_protocol::pool {
    use sui::object::{Self, UID};
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;
    use sui::table::{Self, Table};
    use sui::event;
    use std::string::String;
    use m1n3_protocol::share;

    // ── Errors ────────────────────────────────────────────────────────────────

    const ENotOperator:       u64 = 0;
    const EJobNotFound:       u64 = 1;
    const EJobExpired:        u64 = 2;
    const EWorkerNotFound:    u64 = 3;
    const EInvalidShare:      u64 = 4;
    const EInsufficientFunds: u64 = 5;
    const EAlreadyRegistered: u64 = 6;

    // ── Constants ─────────────────────────────────────────────────────────────

    /// Default pool share difficulty scalar (pool target = network target × scalar).
    /// Higher scalar → easier shares → more frequent submissions.
    const DEFAULT_DIFFICULTY: u64 = 1_000;

    /// Jobs expire after this many Sui epochs (~24 h each on mainnet).
    const JOB_TTL_EPOCHS: u64 = 2;

    // ── Structs ───────────────────────────────────────────────────────────────

    public struct Pool has key {
        id:           UID,
        operator:     address,
        /// Accumulated SUI held for reward payouts.
        treasury:     Coin<SUI>,
        /// Active mining jobs keyed by job_id.
        jobs:         Table<u64, Job>,
        /// Registered workers keyed by their Sui address.
        workers:      Table<address, Worker>,
        /// Monotonically increasing job counter.
        next_job_id:  u64,
        /// Pool share difficulty scalar (applied to the job's n_bits target).
        difficulty:   u64,
        /// Lifetime valid shares across all workers — used for proportional payouts.
        total_shares: u64,
    }

    public struct Job has store, drop {
        job_id:          u64,
        /// Stratum prevhash (32 bytes).
        prev_hash:       vector<u8>,
        /// Stratum coinb1 — bytes before extranonce in the coinbase transaction.
        coinbase1:       vector<u8>,
        /// Stratum coinb2 — bytes after extranonce in the coinbase transaction.
        coinbase2:       vector<u8>,
        /// Right-side merkle branch hashes from `mining.notify`.
        merkle_branches: vector<vector<u8>>,
        version:         u32,
        /// Bitcoin compact difficulty target (nBits).
        n_bits:          u32,
        n_time:          u32,
        /// Sui epoch when this job was created — used to enforce JOB_TTL_EPOCHS.
        created_epoch:   u64,
        /// SUI (MIST) locked in the treasury for this job's share rewards.
        reward_pool:     u64,
    }

    public struct Worker has store {
        worker_addr:   address,
        /// Human-readable worker name from Stratum `mining.authorize`.
        name:          String,
        /// extranonce1 assigned to this worker's session at `mining.subscribe` time.
        /// Stored on-chain so `submit_share` can reconstruct the coinbase for verification.
        extranonce1:   vector<u8>,
        /// Valid shares credited since last `claim_reward`.
        shares:        u64,
        /// Cumulative SUI earned (MIST) across all claims.
        earned:        u64,
        registered_at: u64,
    }

    // ── Events ────────────────────────────────────────────────────────────────

    public struct PoolCreated has copy, drop {
        pool_id:  address,
        operator: address,
    }

    public struct JobPosted has copy, drop {
        pool_id: address,
        job_id:  u64,
        n_bits:  u32,
        n_time:  u32,
    }

    public struct ShareAccepted has copy, drop {
        pool_id:    address,
        job_id:     u64,
        worker:     address,
        nonce:      u32,
        difficulty: u64,
    }

    public struct RewardPaid has copy, drop {
        pool_id: address,
        worker:  address,
        amount:  u64,
    }

    // ── Pool creation ─────────────────────────────────────────────────────────

    /// Deploy a new pool instance. The caller becomes the sole operator.
    /// The returned Pool is a shared object — accessible by all parties.
    public entry fun create_pool(ctx: &mut TxContext) {
        let pool = Pool {
            id:           object::new(ctx),
            operator:     tx_context::sender(ctx),
            treasury:     coin::zero<SUI>(ctx),
            jobs:         table::new(ctx),
            workers:      table::new(ctx),
            next_job_id:  0,
            difficulty:   DEFAULT_DIFFICULTY,
            total_shares: 0,
        };
        let pool_addr = object::uid_to_address(&pool.id);
        event::emit(PoolCreated { pool_id: pool_addr, operator: tx_context::sender(ctx) });
        transfer::share_object(pool);
    }

    // ── Operator functions ────────────────────────────────────────────────────

    /// Register a new mining job on-chain. Called by the bridge in parallel with
    /// the Stratum server's `mining.notify` broadcast to miners.
    ///
    /// The operator funds the job's reward pool by providing payment. The bridge
    /// reads these parameters from the GBT (getblocktemplate) response and the
    /// Stratum server's current job state.
    public entry fun post_job(
        pool:            &mut Pool,
        prev_hash:       vector<u8>,
        coinbase1:       vector<u8>,
        coinbase2:       vector<u8>,
        merkle_branches: vector<vector<u8>>,
        version:         u32,
        n_bits:          u32,
        n_time:          u32,
        reward_mist:     u64,
        payment:         &mut Coin<SUI>,
        ctx:             &mut TxContext,
    ) {
        assert!(tx_context::sender(ctx) == pool.operator, ENotOperator);
        assert!(coin::value(payment) >= reward_mist, EInsufficientFunds);

        let fee = coin::split(payment, reward_mist, ctx);
        coin::join(&mut pool.treasury, fee);

        let job_id = pool.next_job_id;
        pool.next_job_id = pool.next_job_id + 1;

        let pool_addr = object::uid_to_address(&pool.id);
        event::emit(JobPosted { pool_id: pool_addr, job_id, n_bits, n_time });

        table::add(&mut pool.jobs, job_id, Job {
            job_id,
            prev_hash,
            coinbase1,
            coinbase2,
            merkle_branches,
            version,
            n_bits,
            n_time,
            created_epoch: tx_context::epoch(ctx),
            reward_pool:   reward_mist,
        });
    }

    /// Update the pool share difficulty scalar. The bridge calls this when VARDIFF
    /// adjusts the per-worker difficulty in the Stratum server.
    public entry fun set_difficulty(
        pool:           &mut Pool,
        new_difficulty: u64,
        ctx:            &mut TxContext,
    ) {
        assert!(tx_context::sender(ctx) == pool.operator, ENotOperator);
        pool.difficulty = new_difficulty;
    }

    // ── Worker functions ──────────────────────────────────────────────────────

    /// Register a worker on-chain. Called by the miner's sidecar immediately after
    /// the Stratum server responds to `mining.subscribe` (which assigns extranonce1).
    ///
    /// `extranonce1` must match exactly what the pool assigned — it is stored here
    /// so `submit_share` can reconstruct the coinbase for cryptographic verification.
    public entry fun register_worker(
        pool:        &mut Pool,
        name:        String,
        extranonce1: vector<u8>,
        ctx:         &mut TxContext,
    ) {
        let sender = tx_context::sender(ctx);
        assert!(!table::contains(&pool.workers, sender), EAlreadyRegistered);
        table::add(&mut pool.workers, sender, Worker {
            worker_addr:   sender,
            name,
            extranonce1,
            shares:        0,
            earned:        0,
            registered_at: tx_context::epoch(ctx),
        });
    }

    /// Submit a share for on-chain verification. Called by the miner's sidecar,
    /// signed with the miner's own Sui private key, so `ctx.sender()` is the miner.
    ///
    /// The contract independently verifies the proof-of-work using SHA-256d against
    /// the job template registered by the operator — no trust in the pool is required.
    ///
    /// Parameters match the Stratum `mining.submit` fields:
    ///   job_id, extranonce2, ntime, nonce
    public entry fun submit_share(
        pool:        &mut Pool,
        job_id:      u64,
        extranonce2: vector<u8>,
        n_time:      u32,
        nonce:       u32,
        ctx:         &mut TxContext,
    ) {
        let sender = tx_context::sender(ctx);

        assert!(table::contains(&pool.workers, sender),  EWorkerNotFound);
        assert!(table::contains(&pool.jobs, job_id),     EJobNotFound);

        let current_epoch = tx_context::epoch(ctx);
        let job    = table::borrow(&pool.jobs, job_id);
        let worker = table::borrow(&pool.workers, sender);

        assert!(current_epoch <= job.created_epoch + JOB_TTL_EPOCHS, EJobExpired);

        // ── On-chain PoW verification ─────────────────────────────────────────
        // Reconstruct the block hash from the share fields and check it meets
        // the pool's share difficulty target. This is identical to what the
        // traditional Stratum server does off-chain.
        let valid = share::verify_share(
            &job.coinbase1,
            &job.coinbase2,
            &worker.extranonce1,
            &extranonce2,
            &job.merkle_branches,
            job.version,
            job.prev_hash,
            job.n_bits,
            n_time,
            nonce,
            pool.difficulty,
        );
        assert!(valid, EInvalidShare);

        // Credit the share.
        let worker_mut = table::borrow_mut(&mut pool.workers, sender);
        worker_mut.shares = worker_mut.shares + 1;
        pool.total_shares = pool.total_shares + 1;

        let pool_addr = object::uid_to_address(&pool.id);
        event::emit(ShareAccepted {
            pool_id:    pool_addr,
            job_id,
            worker:     sender,
            nonce,
            difficulty: pool.difficulty,
        });
    }

    /// Withdraw the caller's proportional share of the treasury.
    /// Resets the worker's share counter — subsequent earnings accumulate toward the next claim.
    /// This is permissionless: no operator approval needed.
    public entry fun claim_reward(pool: &mut Pool, ctx: &mut TxContext) {
        let sender = tx_context::sender(ctx);
        assert!(table::contains(&pool.workers, sender), EWorkerNotFound);
        assert!(pool.total_shares > 0, EInvalidShare);

        let worker_shares = table::borrow(&pool.workers, sender).shares;
        assert!(worker_shares > 0, EInvalidShare);

        let total  = coin::value(&pool.treasury);
        let payout = (total as u128) * (worker_shares as u128) / (pool.total_shares as u128);
        let payout = (payout as u64);

        {
            let worker_mut = table::borrow_mut(&mut pool.workers, sender);
            worker_mut.shares = 0;
            worker_mut.earned = worker_mut.earned + payout;
        };

        let reward    = coin::split(&mut pool.treasury, payout, ctx);
        let pool_addr = object::uid_to_address(&pool.id);
        event::emit(RewardPaid { pool_id: pool_addr, worker: sender, amount: payout });
        transfer::public_transfer(reward, sender);
    }

    // ── Read helpers ──────────────────────────────────────────────────────────

    public fun difficulty(pool: &Pool): u64      { pool.difficulty }
    public fun total_shares(pool: &Pool): u64    { pool.total_shares }
    public fun treasury_balance(pool: &Pool): u64 { coin::value(&pool.treasury) }

    public fun worker_shares(pool: &Pool, addr: address): u64 {
        if (table::contains(&pool.workers, addr)) {
            table::borrow(&pool.workers, addr).shares
        } else { 0 }
    }
}
