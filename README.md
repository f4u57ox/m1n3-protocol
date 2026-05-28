# m1n3 Protocol

m1n3 is an open protocol for operating Bitcoin mining pools where **reward accountability and custody are enforced by smart contracts**, not by trusting a pool operator.

It is designed to be a composable primitive: any operator can deploy the contracts, point a standard Stratum v1 server at them, and immediately have cryptographically-enforced attribution and payout — without a central custodian.

Built on the **Sui network**, using the [Stratum v1](https://github.com/stratum-mining/stratum/tree/65c9688ca0e9cdcf213b32a6f51e9309fb75bbab/sv1) wire protocol.

## Architecture

Every operation a traditional mining pool does off-chain, m1n3 does in parallel on-chain:

```
Pool Operator
  ├─ Stratum server  ─────────────────────────────────────────▶  miners (traditional path)
  └─ stratum-bridge  ─────────────────────────────────────────▶  Sui: pool::post_job

Miner
  ├─ ASIC → mining.submit  ──────────────────────────────────▶  pool (traditional path)
  └─ miner-sidecar  ─────────────────────────────────────────▶  Sui: pool::submit_share
       intercepts accepted shares                                 (signed with miner's own key)
       signs with miner's Sui key                                 on-chain SHA-256d PoW check
```

| Component | Language | Path | Role |
|---|---|---|---|
| On-chain pool | Move (Sui) | `contracts/` | Jobs, share verification, rewards |
| Stratum v1 server | Rust | `stratum-bridge/` | Traditional pool + job posting |
| Miner sidecar | Rust | `miner-sidecar/` | TCP proxy + trustless on-chain submission |

## Why

Traditional mining pools are trusted custodians. They record shares in private databases and pay out on their own terms. Miners have no recourse if a pool operator underpays, disappears, or is compelled by a third party.

m1n3 replaces that trust with on-chain accounting:

- **Share attribution** — recorded at submission time by the miner's own key; the operator cannot forge or suppress records
- **PoW verification** — the contract runs real SHA-256d independently; invalid shares are rejected on-chain
- **Reward custody** — locked in the contract treasury; payouts are proportional, permissionless, and immediate
- **Job integrity** — templates are anchored on-chain; miners can verify they received the right work

## Quick Start

### Deploy the contracts

```bash
sui client publish --gas-budget 200000000 contracts/
```

Note the `Pool` object ID from the output.

### Run the bridge (operator)

```bash
cp .env.example .env
# fill in OPERATOR_KEY, POOL_OBJECT_ID
cargo run --bin m1n3-bridge
```

### Run the sidecar (miner)

```bash
# fill in MINER_KEY, POOL_HOST, POOL_OBJECT_ID
cargo run --bin m1n3-sidecar
# point your ASIC at localhost:3334
```

Full setup instructions: [docs/operator-guide.md](docs/operator-guide.md) | [docs/sidecar-setup.md](docs/sidecar-setup.md)

## Contracts

| Module | Purpose |
|---|---|
| `pool` | Shared Pool object — jobs, workers, treasury, reward claims |
| `share` | Pure PoW verification — SHA-256d, merkle root, nbits→target, difficulty check |
| `difficulty` | VARDIFF retargeting algorithm |

### Share verification

`pool::submit_share` performs the same steps as a traditional Stratum server, on-chain:

```
coinbase  = coinbase1 + extranonce1 + extranonce2 + coinbase2
cb_txid   = sha256d(coinbase)
merkle    = sha256d(cb_txid || branch[0]) → … → sha256d(… || branch[n])
header    = version || prev_hash || merkle || ntime || nbits || nonce  (80 bytes)
hash      = sha256d(header)
target    = nbits_to_target(nbits) × difficulty_scalar
assert      reverse(hash) ≤ target
```

See [docs/protocol.md](docs/protocol.md) for the full step-by-step breakdown.

### Key entry points

```move
pool::create_pool(ctx)                                      // deploy a pool
pool::post_job(pool, prev_hash, cb1, cb2, branches, ...)    // operator: register job template
pool::register_worker(pool, name, extranonce1, ctx)         // miner: authorize on-chain
pool::submit_share(pool, job_id, extranonce2, ntime, nonce) // miner: submit share (PoW verified)
pool::claim_reward(pool, ctx)                               // miner: proportional payout
```

Full API reference: [docs/contracts.md](docs/contracts.md)

## Stratum v1 reference

Protocol implementation based on [stratum-mining/stratum sv1](https://github.com/stratum-mining/stratum/tree/65c9688ca0e9cdcf213b32a6f51e9309fb75bbab/sv1):

| Method | On-chain mapping |
|---|---|
| `mining.subscribe` | extranonce1 captured by sidecar |
| `mining.authorize` | → `pool::register_worker` |
| `mining.notify` | → `pool::post_job` (bridge) |
| `mining.set_difficulty` | → `pool::set_difficulty` (bridge) |
| `mining.submit` + accepted | → `pool::submit_share` (sidecar, miner's key) |

## Documentation

| Document | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Full system diagram and data flow |
| [docs/protocol.md](docs/protocol.md) | Stratum ↔ on-chain mapping, share verification steps |
| [docs/operator-guide.md](docs/operator-guide.md) | Deploy and operate a pool |
| [docs/sidecar-setup.md](docs/sidecar-setup.md) | Miner sidecar install and configuration |
| [docs/contracts.md](docs/contracts.md) | Move API reference |

## Roadmap

- [ ] Wire `SuiChainClient::post_job` with Sui PTB builder (operator → chain)
- [ ] Wire `ChainSubmitter::submit_share` with Sui PTB builder (sidecar → chain)
- [ ] Automatic `register_worker` in sidecar after first `mining.subscribe`
- [ ] Per-worker VARDIFF using `difficulty.move`
- [ ] Off-chain SHA-256d validation in the bridge before responding to miners
- [ ] Move Prover invariants for reward accounting

## License

Apache 2.0
