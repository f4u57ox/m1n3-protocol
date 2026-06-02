# m1n3 Protocol

m1n3 is an open protocol for operating Bitcoin mining pools where **share attribution and PoW verification are enforced by smart contracts**, not by trusting a pool operator.

Built on the **Sui network**, using the [Stratum v1](https://github.com/stratum-mining/stratum/tree/65c9688ca0e9cdcf213b32a6f51e9309fb75bbab/sv1) wire protocol.

---

## Architecture

```
Pool Operator
  ├─ stratum-bridge ──────────────────────────── miners (Stratum v1)
  └─ stratum-bridge ──────────────────────────── Sui: pool::post_job (per block template)

Miner
  ├─ ASIC → mining.submit ───────────────────── pool (traditional path)
  └─ miner-sidecar ──────────────────────────── Sui: pool::submit_share
       transparent TCP proxy                         signed with miner's own key
       intercepts accepted shares                     on-chain SHA-256d PoW check
       no operator trust required

Pool Dashboard
  └─ web/ ────────────────────────────────────── Next.js frontend
       /pool   — live block templates              reads Sui events via JSON-RPC
       /shares — accepted share feed
```

| Component | Language | Path | Role |
|---|---|---|---|
| On-chain pool | Move (Sui) | `contracts/` | Job registry, share verification, worker accounting |
| Stratum bridge | Rust | `stratum-bridge/` | Stratum v1 server + on-chain job posting |
| Miner sidecar | Rust | `miner-sidecar/` | Transparent proxy + trustless share submission |
| Dashboard | TypeScript | `web/` | Pool monitoring frontend |

---

## Why

Traditional mining pools are trusted custodians. They record shares in private databases and pay out on their own terms. Miners have no recourse if a pool operator underpays, disappears, or is coerced.

m1n3 replaces that trust with on-chain accounting:

- **Share attribution** — recorded at submission time, signed by the miner's own Sui key; the operator cannot forge or suppress records
- **PoW verification** — the Move contract runs SHA-256d independently on-chain; invalid shares are rejected cryptographically
- **Job integrity** — every block template is registered on-chain before miners work on it; shares are tied to specific templates
- **Self-sovereign** — miners run their own sidecar; no pool software holds their private key

---

## Quick Start

### 1. Deploy the contracts

```bash
sui client switch --env devnet
sui client publish --gas-budget 200000000 contracts/

# Note the Package ID and Pool object ID from the output.
# Run create_pool to initialise:
sui client call \
  --package <PACKAGE_ID> \
  --module pool \
  --function create_pool \
  --gas-budget 10000000
```

### 2. Configure environment

```bash
cp .env.example .env
# Required:
#   OPERATOR_KEY      — operator's Sui private key (suiprivkey1… format)
#   POOL_OBJECT_ID    — Pool object ID from create_pool
#   PACKAGE_ID        — deployed package ID
#   BITCOIN_RPC_URL   — e.g. http://127.0.0.1:8332
#   BITCOIN_RPC_USER / BITCOIN_RPC_PASS
```

### 3. Run the bridge (operator)

```bash
cargo run --bin m1n3-bridge
# Listens on 0.0.0.0:3333 by default (BRIDGE_PORT)
```

### 4. Run the sidecar (per miner)

```bash
# Sidecar env (separate from bridge .env):
#   MINER_KEY         — miner's Sui private key
#   POOL_HOST / POOL_PORT — bridge address
#   POOL_OBJECT_ID / PACKAGE_ID — same as bridge
#   SUI_RPC_URL
cargo run --bin m1n3-sidecar
# Point your ASIC at localhost:3334 (SIDECAR_LISTEN_PORT)
```

### 5. Run the web dashboard

```bash
cd web
npm install
npm run dev
# Open http://localhost:3000
```

---

## Contracts

### Modules

| Module | Purpose |
|---|---|
| `pool` | Shared Pool object — job registry, worker table, share accounting |
| `share` | Pure PoW verification — SHA-256d, merkle root, nbits→target, difficulty scalar |

### Share verification (on-chain)

`pool::submit_share` reconstructs and verifies the Bitcoin block header on-chain:

```
coinbase  = coinbase1 || extranonce1 || extranonce2 || coinbase2
cb_txid   = sha256d(coinbase)
merkle    = sha256d(cb_txid || branch[0]) → … → sha256d(… || branch[n])
header    = version || prev_hash || merkle || ntime || nbits || nonce  (80 bytes LE)
hash      = sha256d(header)
target    = nbits_to_target(nbits) × pool.difficulty
assert      reverse(hash) ≤ target
```

### Public entry points

```move
pool::create_pool(ctx)                                                    // deploy a pool instance
pool::post_job(pool, prev_hash, cb1, cb2, branches, version, nbits, ntime, ctx)  // operator: post template
pool::set_difficulty(pool, scalar, ctx)                                   // operator: set pool scalar
pool::register_worker(pool, name, extranonce1, ctx)                       // miner: register (sidecar auto)
pool::submit_share(pool, job_id, extranonce2, ntime, nonce, version, ctx) // miner: submit verified share
```

### Error codes

| Code | Name | Meaning |
|---|---|---|
| 0 | `ENotOperator` | Caller is not the pool operator |
| 1 | `EJobNotFound` | `job_id` not in pool's job table |
| 2 | `EJobExpired` | Job older than `JOB_TTL_EPOCHS` (2 epochs ≈ 48h) |
| 3 | `EWorkerNotFound` | Miner address not registered |
| 4 | `EInvalidShare` | SHA-256d PoW check failed |
| 5 | `EAlreadyRegistered` | Worker address already in pool |

---

## Stratum v1 protocol mapping

| Stratum method | Bridge action | Sidecar action |
|---|---|---|
| `mining.subscribe` | Assign extranonce1 | Capture extranonce1 |
| `mining.authorize` | Accept any username | → `pool::register_worker` |
| `mining.notify` | Broadcast job from `getblocktemplate` | Update stored template |
| `mining.configure` | — (not forwarded) | Respond `version-rolling: true` (BIP320) |
| `mining.submit` | SHA-256d off-chain check | On accepted → `pool::submit_share` |

**Difficulty:** The bridge sends `mining.set_difficulty: INITIAL_DIFFICULTY` once on subscribe. This is a fixed floor — miners may mine at any difficulty above it; the on-chain pool scalar enforces the minimum. Higher-difficulty shares cost gas to submit; miners self-regulate via economic incentive.

---

## Configuration reference

### Bridge (`stratum-bridge/`)

| Variable | Default | Description |
|---|---|---|
| `BRIDGE_HOST` | `0.0.0.0` | Stratum bind address |
| `BRIDGE_PORT` | `3333` | Stratum bind port |
| `SUI_RPC_URL` | devnet | Sui full-node endpoint |
| `OPERATOR_KEY` | — | Bech32 `suiprivkey1…` or 64-char hex Ed25519 |
| `POOL_OBJECT_ID` | — | Shared Pool object ID |
| `PACKAGE_ID` | — | Deployed Move package ID |
| `INITIAL_DIFFICULTY` | `512` | Minimum share difficulty (pool scalar floor) |
| `BITCOIN_RPC_URL` | — | e.g. `http://127.0.0.1:8332` |
| `BITCOIN_RPC_USER` | — | Bitcoin Core RPC username |
| `BITCOIN_RPC_PASS` | — | Bitcoin Core RPC password |
| `JOB_REFRESH_SECS` | `30` | `getblocktemplate` polling interval |

### Sidecar (`miner-sidecar/`)

| Variable | Default | Description |
|---|---|---|
| `MINER_KEY` | — | Miner's Sui private key (`suiprivkey1…`) |
| `POOL_HOST` | — | Bridge hostname |
| `POOL_PORT` | `3333` | Bridge Stratum port |
| `SIDECAR_LISTEN_PORT` | `3334` | Local port for ASIC connections |
| `SUI_RPC_URL` | devnet | Sui full-node endpoint |
| `POOL_OBJECT_ID` | — | Shared Pool object ID |
| `PACKAGE_ID` | — | Deployed Move package ID |

---

## Roadmap

### Done
- [x] Stratum v1 server — subscribe, authorize, notify, submit, configure
- [x] Real Bitcoin coinbase and merkle branch construction
- [x] Off-chain SHA-256d share validation in bridge
- [x] On-chain PTB for `pool::post_job` (bridge)
- [x] On-chain PTB for `pool::submit_share` (sidecar, miner's own key)
- [x] Transparent TCP proxy sidecar with share interception
- [x] Automatic `register_worker` after first `mining.authorize`
- [x] BIP320 version-rolling support (sidecar intercept)
- [x] Job ID sync — bridge reads `pool.next_job_id` before each broadcast
- [x] `prev_hash` byte-order correctness in on-chain `post_job`
- [x] Gas coin serialization in sidecar (prevents concurrent-submission conflicts)
- [x] Pool + shares web dashboard

### Planned
- [ ] Duplicate share detection (nonce deduplication per job)
- [ ] `ntime` range validation (mintime ≤ ntime ≤ curtime + 7200)
- [ ] Retry logic in sidecar for stale object ref errors
- [ ] SegWit witness commitment in coinbase (mainnet requirement)
- [ ] Block assembly and `submitblock` RPC submission
- [ ] Move Prover invariants for reward accounting

---

## License

Apache 2.0
