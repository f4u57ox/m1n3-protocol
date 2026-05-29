/// Core mining pool — manages registered workers, active jobs, and reward distribution.
module m1n3_protocol::pool {
    use sui::object::{Self, UID};
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;
    use sui::table::{Self, Table};
    use sui::event;
    use std::string::String;

    // ── Errors ──────────────────────────────────────────────────────────────

    const ENotOperator:    u64 = 0;
    const EJobNotFound:    u64 = 1;
    const EJobExpired:     u64 = 2;
    const EWorkerNotFound: u64 = 3;
    const EInvalidShare:   u64 = 4;
    const EInsufficientFunds: u64 = 5;

    // ── Constants ───────────────────────────────────────────────────────────

    /// Minimum difficulty target (nBits-like scalar, higher = easier).
    const DEFAULT_DIFFICULTY: u64 = 1_000;
    /// How many Sui epochs a job stays valid before expiring.
    const JOB_TTL_EPOCHS: u64 = 2;

    // ── Structs ─────────────────────────────────────────────────────────────

    public struct Pool has key {
        id: UID,
        operator: address,
        /// Accumulated fees held for reward payouts.
        treasury: Coin<SUI>,
        /// Active mining jobs keyed by job_id.
        jobs: Table<u64, Job>,
        /// Registered workers keyed by worker address.
        workers: Table<address, Worker>,
        /// Monotonically increasing job counter.
        next_job_id: u64,
        /// Current network difficulty scalar.
        difficulty: u64,
        /// Total valid shares submitted across all time.
        total_shares: u64,
    }

    public struct Job has store, drop {
        job_id:      u64,
        /// Stratum prevhash field (32 bytes as vector).
        prev_hash:   vector<u8>,
        /// Stratum coinb1 (bytes before extranonce).
        coinbase1:   vector<u8>,
        /// Stratum coinb2 (bytes after extranonce).
        coinbase2:   vector<u8>,
        /// Merkle branch hashes.
        merkle_branches: vector<vector<u8>>,
        version:     u32,
        n_bits:      u32,
        n_time:      u32,
        /// Epoch this job was created — used for TTL check.
        created_epoch: u64,
        /// Reward in MIST allocated for this job's shares.
        reward_pool: u64,
    }

    public struct Worker has store {
        worker_addr:   address,
        /// Human-readable name registered via Stratum login.
        name:          String,
        /// Valid shares contributed.
        shares:        u64,
        /// Total SUI earned (MIST).
        earned:        u64,
        registered_at: u64,
    }

    // ── Events ───────────────────────────────────────────────────────────────

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

    // ── Initializer ──────────────────────────────────────────────────────────

    public entry fun create_pool(ctx: &mut TxContext) {
        let pool = Pool {
            id: object::new(ctx),
            operator: tx_context::sender(ctx),
            treasury: coin::zero<SUI>(ctx),
            jobs: table::new(ctx),
            workers: table::new(ctx),
            next_job_id: 0,
            difficulty: DEFAULT_DIFFICULTY,
            total_shares: 0,
        };
        let pool_addr = object::uid_to_address(&pool.id);
        event::emit(PoolCreated { pool_id: pool_addr, operator: tx_context::sender(ctx) });
        transfer::share_object(pool);
    }

    // ── Operator functions ────────────────────────────────────────────────────

    /// Operator broadcasts a new Stratum-derived mining job on-chain.
    public entry fun post_job(
        pool:     &mut Pool,
        prev_hash:        vector<u8>,
        coinbase1:        vector<u8>,
        coinbase2:        vector<u8>,
        merkle_branches:  vector<vector<u8>>,
        version:          u32,
        n_bits:           u32,
        n_time:           u32,
        reward_mist:      u64,
        payment:          &mut Coin<SUI>,
        ctx:              &mut TxContext,
    ) {
        assert!(tx_context::sender(ctx) == pool.operator, ENotOperator);
        assert!(coin::value(payment) >= reward_mist, EInsufficientFunds);

        let fee = coin::split(payment, reward_mist, ctx);
        coin::join(&mut pool.treasury, fee);

        let job_id = pool.next_job_id;
        pool.next_job_id = pool.next_job_id + 1;

        let job = Job {
            job_id,
            prev_hash,
            coinbase1,
            coinbase2,
            merkle_branches,
            version,
            n_bits,
            n_time,
            created_epoch: tx_context::epoch(ctx),
            reward_pool: reward_mist,
        };

        let pool_addr = object::uid_to_address(&pool.id);
        event::emit(JobPosted { pool_id: pool_addr, job_id, n_bits, n_time });

        table::add(&mut pool.jobs, job_id, job);
    }

    /// Operator adjusts the difficulty scalar.
    public entry fun set_difficulty(
        pool: &mut Pool,
        new_difficulty: u64,
        ctx: &mut TxContext,
    ) {
        assert!(tx_context::sender(ctx) == pool.operator, ENotOperator);
        pool.difficulty = new_difficulty;
    }

    // ── Worker functions ──────────────────────────────────────────────────────

    /// Workers register on-chain before submitting shares (mirrors Stratum mining.authorize).
    public entry fun register_worker(
        pool: &mut Pool,
        name: String,
        ctx: &mut TxContext,
    ) {
        let sender = tx_context::sender(ctx);
        if (!table::contains(&pool.workers, sender)) {
            let worker = Worker {
                worker_addr:   sender,
                name,
                shares:        0,
                earned:        0,
                registered_at: tx_context::epoch(ctx),
            };
            table::add(&mut pool.workers, sender, worker);
        }
    }

    /// Submit a valid share for a given job (mirrors Stratum mining.submit).
    /// The bridge validates proof-of-work off-chain; this records share credit.
    public entry fun submit_share(
        pool:   &mut Pool,
        job_id: u64,
        nonce:  u32,
        ctx:    &mut TxContext,
    ) {
        let sender = tx_context::sender(ctx);
        assert!(table::contains(&pool.workers, sender), EWorkerNotFound);
        assert!(table::contains(&pool.jobs, job_id), EJobNotFound);

        let current_epoch = tx_context::epoch(ctx);
        let job = table::borrow(&pool.jobs, job_id);
        assert!(current_epoch <= job.created_epoch + JOB_TTL_EPOCHS, EJobExpired);

        // Credit the share.
        let worker = table::borrow_mut(&mut pool.workers, sender);
        worker.shares = worker.shares + 1;
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

    /// Worker claims proportional reward from the treasury.
    public entry fun claim_reward(
        pool: &mut Pool,
        ctx:  &mut TxContext,
    ) {
        let sender = tx_context::sender(ctx);
        assert!(table::contains(&pool.workers, sender), EWorkerNotFound);
        assert!(pool.total_shares > 0, EInvalidShare);

        let worker = table::borrow_mut(&mut pool.workers, sender);
        let worker_shares = worker.shares;
        assert!(worker_shares > 0, EInvalidShare);

        let total = coin::value(&pool.treasury);
        let payout = (total as u128) * (worker_shares as u128) / (pool.total_shares as u128);
        let payout = (payout as u64);

        // Reset worker shares after claim to avoid double-claiming.
        worker.shares = 0;
        worker.earned = worker.earned + payout;

        let reward = coin::split(&mut pool.treasury, payout, ctx);
        let pool_addr = object::uid_to_address(&pool.id);
        event::emit(RewardPaid { pool_id: pool_addr, worker: sender, amount: payout });
        transfer::public_transfer(reward, sender);
    }

    // ── Read helpers ──────────────────────────────────────────────────────────

    public fun difficulty(pool: &Pool): u64 { pool.difficulty }
    public fun total_shares(pool: &Pool): u64 { pool.total_shares }
    public fun treasury_balance(pool: &Pool): u64 { coin::value(&pool.treasury) }

    public fun worker_shares(pool: &Pool, addr: address): u64 {
        if (table::contains(&pool.workers, addr)) {
            table::borrow(&pool.workers, addr).shares
        } else { 0 }
    }
}
