# Contract API Reference

Full reference for all Move modules in the `m1n3_protocol` package.

## Module: `pool`

The core shared object. Manages job templates, worker registration, share verification, and reward distribution.

### Entry functions

#### `create_pool(ctx)`

Deploy a new pool instance. The caller becomes the sole operator.

```move
public entry fun create_pool(ctx: &mut TxContext)
```

Emits: `PoolCreated { pool_id, operator }`

---

#### `post_job(pool, prev_hash, coinbase1, coinbase2, merkle_branches, version, n_bits, n_time, reward_mist, payment, ctx)`

Register a new Bitcoin mining job template on-chain. Operator-only.

```move
public entry fun post_job(
    pool:            &mut Pool,
    prev_hash:       vector<u8>,      // 32 bytes — Stratum prevhash field
    coinbase1:       vector<u8>,      // Bytes before extranonce in coinbase tx
    coinbase2:       vector<u8>,      // Bytes after extranonce in coinbase tx
    merkle_branches: vector<vector<u8>>,  // Right-side merkle branch hashes
    version:         u32,
    n_bits:          u32,             // Bitcoin compact difficulty target
    n_time:          u32,
    reward_mist:     u64,             // SUI (MIST) to lock for this job's rewards
    payment:         &mut Coin<SUI>,
    ctx:             &mut TxContext,
)
```

Errors: `ENotOperator`, `EInsufficientFunds`  
Emits: `JobPosted { pool_id, job_id, n_bits, n_time }`

---

#### `set_difficulty(pool, new_difficulty, ctx)`

Update the pool share difficulty scalar. Operator-only.

```move
public entry fun set_difficulty(
    pool:           &mut Pool,
    new_difficulty: u64,
    ctx:            &mut TxContext,
)
```

Errors: `ENotOperator`

---

#### `register_worker(pool, name, extranonce1, ctx)`

Register a miner on-chain. Called by the miner's sidecar after `mining.authorize` succeeds.

```move
public entry fun register_worker(
    pool:        &mut Pool,
    name:        String,       // Worker name from mining.authorize
    extranonce1: vector<u8>,   // Assigned by the pool at mining.subscribe
    ctx:         &mut TxContext,
)
```

`ctx.sender()` is stored as the worker's Sui address.

Errors: `EAlreadyRegistered`

---

#### `submit_share(pool, job_id, extranonce2, n_time, nonce, ctx)`

Submit a proof-of-work share for on-chain verification. Called by the miner's sidecar, signed with the miner's own key.

```move
public entry fun submit_share(
    pool:        &mut Pool,
    job_id:      u64,
    extranonce2: vector<u8>,   // From mining.submit
    n_time:      u32,          // From mining.submit
    nonce:       u32,          // From mining.submit
    ctx:         &mut TxContext,
)
```

The contract independently verifies the PoW by calling `share::verify_share`. Shares that don't meet the pool difficulty target are rejected.

Errors: `EWorkerNotFound`, `EJobNotFound`, `EJobExpired`, `EInvalidShare`  
Emits: `ShareAccepted { pool_id, job_id, worker, nonce, difficulty }`

---

#### `claim_reward(pool, ctx)`

Withdraw the caller's proportional share of the treasury. Permissionless — no operator approval required.

```move
public entry fun claim_reward(pool: &mut Pool, ctx: &mut TxContext)
```

Payout = `treasury_balance × (worker_shares / total_shares)`.  
Resets worker's share counter after claim.

Errors: `EWorkerNotFound`, `EInvalidShare` (no shares to claim)  
Emits: `RewardPaid { pool_id, worker, amount }`

---

### Error codes

| Code | Constant | Meaning |
|---|---|---|
| 0 | `ENotOperator` | Caller is not the pool operator |
| 1 | `EJobNotFound` | Submitted share references a non-existent job_id |
| 2 | `EJobExpired` | Job is older than `JOB_TTL_EPOCHS` (2 epochs) |
| 3 | `EWorkerNotFound` | Caller is not registered as a worker |
| 4 | `EInvalidShare` | PoW verification failed or no shares to claim |
| 5 | `EInsufficientFunds` | Payment coin has insufficient balance |
| 6 | `EAlreadyRegistered` | Worker already registered at this address |

---

## Module: `share`

Pure cryptographic functions — no state, no object mutations. Used internally by `pool::submit_share` and available for off-chain tooling and unit tests.

### Public functions

| Function | Description |
|---|---|
| `build_coinbase(cb1, en1, en2, cb2)` | Concatenate Stratum coinbase fields |
| `coinbase_hash(cb1, en1, en2, cb2)` | SHA-256d of the assembled coinbase |
| `compute_merkle_root(coinbase_txid, branches)` | Walk the merkle branch with SHA-256d |
| `pack_header(version, prev_hash, merkle, ntime, nbits, nonce)` | Serialize 80-byte block header |
| `block_hash(header)` | SHA-256d of the header |
| `nbits_to_target(n_bits)` | Decode compact n_bits into 32-byte big-endian target |
| `scale_target(target, scalar)` | Multiply target by difficulty scalar |
| `meets_target(hash, target)` | `reverse(hash) ≤ target` comparison |
| `verify_share(cb1, cb2, en1, en2, branches, version, prev_hash, nbits, ntime, nonce, scalar)` | Full end-to-end share verification |

---

## Module: `difficulty`

Stateful VARDIFF algorithm. Not yet integrated into Pool — planned for per-worker difficulty tracking.

### Functions

| Function | Description |
|---|---|
| `new(initial, epoch)` | Create a new `DifficultyState` |
| `record_share(state)` | Increment the share counter |
| `retarget(state, epoch)` | Compute new difficulty; clamps to ±4× |
| `current(state)` | Read current difficulty |

### Constants

| Constant | Value | Meaning |
|---|---|---|
| `TARGET_INTERVAL_SEC` | 10 | Target seconds between shares |
| `MIN_DIFFICULTY` | 256 | Hard floor |
| `MAX_DIFFICULTY` | `0xFFFF_FFFF_FFFF` | Hard ceiling |
| `MAX_RETARGET_FACTOR` | 4 | Max adjustment per retarget |
