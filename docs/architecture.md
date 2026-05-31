# Architecture

m1n3-protocol runs every traditional mining pool operation in parallel on-chain. The on-chain path is independent — it does not trust the operator to report correct results.

## System diagram

```
                         ┌─────────────────────────────────────────────────────┐
                         │  Pool Operator                                       │
                         │                                                     │
                         │  ┌──────────────────┐    ┌───────────────────────┐  │
                         │  │  Bitcoin node     │    │  stratum-bridge       │  │
                         │  │  (getblocktemplate│───▶│  (Rust)               │  │
                         │  │   / bitcoind)     │    │                       │  │
                         │  └──────────────────┘    │  • Stratum v1 server  │  │
                         │                          │  • post_job on-chain  │  │
                         └──────────────────────────┴──────────┬────────────┘  │
                                                               │               │
                         Stratum mining.notify (TCP)           │ pool::post_job│
                         ◀──────────────────────────           │ (PTB / Sui)   │
                                                               ▼               │
┌──────────────────┐                                  ┌────────────────────┐   │
│  Miner hardware  │                                  │   Sui blockchain   │   │
│  (ASIC / GPU)    │                                  │                    │   │
│                  │──mining.submit──▶┌─────────────┐ │  m1n3_protocol     │   │
│                  │◀─────result──────│miner-sidecar│ │  ┌──────────────┐  │   │
└──────────────────┘                 │  (Rust)      │ │  │  Pool object │  │   │
                                     │              │ │  │              │  │   │
                                     │ • TCP proxy  │ │  │  jobs{}      │  │   │
                                     │ • intercepts │ │  │  workers{}   │  │   │
                                     │   accepted   │─┼─▶│  treasury    │  │   │
                                     │   shares     │ │  └──────────────┘  │   │
                                     │ • miner key  │ │                    │   │
                                     └─────────────┘ └────────────────────┘   │
                                                                               │
```

## Components

### stratum-bridge (operator-side)

A Rust binary run by the pool operator alongside their Bitcoin node.

| Responsibility | How |
|---|---|
| Accept miner connections | Standard Stratum v1 TCP server on port 3333 |
| Broadcast mining jobs | `mining.notify` per Stratum spec |
| Register jobs on-chain | Calls `pool::post_job` via Sui PTB after each `mining.notify` |
| Adjust difficulty | Calls `pool::set_difficulty` when VARDIFF fires |

The bridge **never** submits shares on behalf of miners.

### miner-sidecar (miner-side)

A Rust binary run by each miner on their local machine or rig controller.

| Responsibility | How |
|---|---|
| Proxy Stratum traffic | Transparent TCP proxy: ASIC → sidecar → pool |
| Track current job | Parses incoming `mining.notify` messages |
| Buffer pending shares | Captures `mining.submit` before forwarding |
| Submit accepted shares | On pool `{result: true}`, signs and posts `pool::submit_share` with miner's key |

The sidecar signs every transaction with the **miner's own Sui private key**. The pool operator has no ability to forge or suppress share records.

### m1n3_protocol (Move contracts on Sui)

Three Move modules deployed as a single package:

| Module | Role |
|---|---|
| `pool` | Shared Pool object — jobs, workers, treasury, claim logic |
| `share` | Pure PoW verification — SHA-256d, merkle, header, nbits→target |
| `difficulty` | VARDIFF retargeting state and algorithm |

## Data flow: job lifecycle

```
1. Operator calls post_job(prev_hash, coinbase1, coinbase2, branches, version, nbits, ntime)
   → stored in Pool.jobs[job_id]
   → event: JobPosted

2. Miner sidecar receives mining.notify → stores job template locally

3. Miner hardware finds a nonce → sends mining.submit(job_id, en2, ntime, nonce)

4. Pool validates off-chain (traditional path) → responds {result: true}

5. Sidecar intercepts the acceptance → calls pool::submit_share(job_id, en2, ntime, nonce)
   signed with miner's key

6. Contract verifies:
   coinbase = coinbase1 + extranonce1 + extranonce2 + coinbase2
   cb_hash  = sha256d(coinbase)
   merkle   = sha256d(cb_hash || branch[0]) || sha256d(... || branch[n])
   header   = pack(version, prev_hash, merkle, ntime, nbits, nonce)
   hash     = sha256d(header)
   target   = nbits_to_target(nbits) × difficulty_scalar
   assert reverse(hash) ≤ target

7. On success: worker.shares++, event: ShareAccepted

8. Miner calls claim_reward() at any time → proportional SUI payout from treasury
```

## Trust model

| Action | Who is trusted |
|---|---|
| Job template correctness | Nobody — job data is public, any miner can verify |
| Share attribution | Nobody — miner signs with their own key, `ctx.sender()` = miner |
| Reward calculation | Nobody — on-chain proportional formula, permissionless claim |
| PoW validity | Nobody — contract runs SHA-256d independently |
