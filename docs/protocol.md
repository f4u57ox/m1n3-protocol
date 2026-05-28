# Protocol: Stratum v1 ↔ On-Chain Mapping

This document describes how each Stratum v1 message maps to an on-chain action, and details the exact share verification computation performed by the contract.

## Message mapping

| Stratum message (direction) | On-chain action | Who calls |
|---|---|---|
| `mining.subscribe` (miner→pool) | — (session setup only) | — |
| `mining.subscribe` response (pool→miner) | extranonce1 captured by sidecar | sidecar reads it |
| `mining.authorize` (miner→pool) | `pool::register_worker(name, extranonce1)` | sidecar, after pool accepts |
| `mining.notify` (pool→miner) | `pool::post_job(prev_hash, cb1, cb2, branches, version, nbits, ntime, reward)` | bridge |
| `mining.set_difficulty` (pool→miner) | `pool::set_difficulty(new_difficulty)` | bridge |
| `mining.submit` + `{result:true}` (miner→pool, pool→miner) | `pool::submit_share(job_id, extranonce2, ntime, nonce)` | sidecar (miner's key) |
| — | `pool::claim_reward()` | miner (any time) |

## Share verification — step by step

The `share::verify_share` function runs identically to a traditional Stratum pool's server-side check.

### Step 1 — Assemble the coinbase transaction

```
coinbase = coinbase1 || extranonce1 || extranonce2 || coinbase2
```

`coinbase1` and `coinbase2` come from the job template stored on-chain by `post_job`.  
`extranonce1` is stored in the `Worker` struct (registered at authorize time).  
`extranonce2` is submitted by the miner in `mining.submit`.

### Step 2 — Hash the coinbase

```
coinbase_txid = SHA-256d(coinbase)
             = SHA-256(SHA-256(coinbase))
```

This is the txid of the coinbase transaction in Bitcoin's internal byte order.

### Step 3 — Build the merkle root

```
root = coinbase_txid
for branch in merkle_branches:
    root = SHA-256d(root || branch)
```

`merkle_branches` is the right-side branch list from `mining.notify` (Stratum convention: coinbase is always the leftmost leaf).

### Step 4 — Serialize the 80-byte block header

Bitcoin wire format — all integers little-endian:

```
offset  size  field
──────  ────  ──────────────────────────────────────
0       4     version       (u32 LE)
4       32    prev_hash     (as-is from Stratum)
36      32    merkle_root   (from step 3)
68      4     ntime         (u32 LE, from mining.submit)
72      4     nbits         (u32 LE, from job template)
76      4     nonce         (u32 LE, from mining.submit)
──────  ────
total:  80 bytes
```

### Step 5 — Compute the block hash

```
block_hash = SHA-256d(header)
```

Result is 32 bytes in SHA-256 internal byte order.

### Step 6 — Decode the difficulty target (n_bits → 256-bit target)

Bitcoin compact format:

```
exponent = n_bits >> 24             (high byte)
mantissa = n_bits & 0x007FFFFF      (lower 3 bytes)
target   = mantissa << (8 × (exponent - 3))
```

Result: 32-byte big-endian 256-bit integer.

Example — `0x1d00ffff` (Bitcoin genesis n_bits):
```
exponent = 0x1d = 29
mantissa = 0x00ffff
target   = 0x00000000FFFF0000000000000000000000000000000000000000000000000000
```

### Step 7 — Apply pool share difficulty

```
pool_target = network_target × difficulty_scalar
```

`difficulty_scalar` is the pool's current difficulty setting (default 1000).  
A larger target is easier to satisfy — shares are found roughly `difficulty_scalar` times more often than actual blocks.

### Step 8 — Compare

```
display_hash = reverse_bytes(block_hash)   # convert internal order to display order
valid        = display_hash ≤ pool_target   # 256-bit big-endian comparison
```

The contract asserts `valid == true`. Any share that doesn't meet the target is rejected with `EInvalidShare`.

## Stratum v1 reference

This implementation follows the Stratum v1 specification as implemented in:  
<https://github.com/stratum-mining/stratum/tree/65c9688ca0e9cdcf213b32a6f51e9309fb75bbab/sv1>

Key JSON-RPC methods:

```jsonc
// mining.subscribe (miner → pool)
{"id":1,"method":"mining.subscribe","params":["cgminer/4.10.0",null]}

// mining.subscribe response (pool → miner)
{"id":1,"result":[[["mining.set_difficulty","s1"],["mining.notify","s1"]],"deadbeef",4],"error":null}
//                                                                               ^^^^^^^^  ^
//                                                                               extranonce1  extranonce2_size

// mining.authorize (miner → pool)
{"id":2,"method":"mining.authorize","params":["worker1.default","x"]}

// mining.notify (pool → miner)
{"id":null,"method":"mining.notify","params":[
  "job0001",          // job_id
  "prevhash...",      // prev_hash (32 bytes hex)
  "coinb1...",        // coinbase1
  "coinb2...",        // coinbase2
  ["branch0","..."],  // merkle_branches
  "20000000",         // version (hex)
  "1d00ffff",         // nbits (hex)
  "5e9a1b2c",         // ntime (hex)
  true                // clean_jobs
]}

// mining.submit (miner → pool)
{"id":4,"method":"mining.submit","params":["worker1.default","job0001","00000000","5e9a1b2c","12345678"]}
//                                                                       ^^^^^^^^^  ^^^^^^^^  ^^^^^^^^
//                                                                       extranonce2  ntime    nonce
```
