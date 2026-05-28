# m1n3 Protocol

m1n3 is an open protocol for operating Bitcoin mining pools where **reward accountability and custody are enforced by smart contracts**, not by trusting a pool operator.

It is designed to be a composable primitive: any operator can deploy the contracts, point a standard Stratum v1 server at them, and immediately have cryptographically-enforced attribution and payout — without a central custodian.

Built on the **Sui network**, using the [Stratum v1](https://github.com/stratum-mining/stratum/tree/65c9688ca0e9cdcf213b32a6f51e9309fb75bbab/sv1) wire protocol.

## Architecture

```
Bitcoin Miners (ASIC / CPU)
        │  Stratum v1 TCP (port 3333)
        ▼
┌─────────────────────────┐
│   stratum-bridge (Rust) │  ← validates PoW, maps workers to Sui addresses
└────────────┬────────────┘
             │  Sui PTB (submit_share / post_job)
             ▼
┌─────────────────────────┐
│  m1n3_protocol (Move)   │  ← on-chain pool, shares, VARDIFF, rewards
└─────────────────────────┘
```

| Component | Language | Path |
|---|---|---|
| On-chain pool | Move (Sui) | `contracts/sources/` |
| Stratum v1 server | Rust | `stratum-bridge/` |

## Why

Traditional mining pools are trusted custodians. They receive block rewards, track shares in private databases, and pay out on their own terms. Miners have no recourse if a pool operator underpays, disappears, or is compelled by a third party.

m1n3 replaces that trust with on-chain accounting:

- **Share attribution** is recorded on Sui at submission time — no operator can revise history.
- **Reward custody** lives in a smart contract treasury — payouts are permissionless and proportional.
- **Job integrity** is anchored on-chain — the operator cannot silently swap work templates.
- **Any operator** can deploy their own pool without forking or modifying the protocol.

## Quick Start

### 1. Deploy the Move contracts

```bash
sui client publish --gas-budget 100000000 contracts/
```

Copy the `Pool` object ID from the output and set `POOL_OBJECT_ID` in `.env`.

### 2. Configure the bridge

```bash
cp .env.example .env
# edit .env with your keys and pool object ID
```

### 3. Run the bridge

```bash
cargo run --bin m1n3-bridge
```

Miners can now point to `stratum+tcp://<your-ip>:3333`.

## Contracts

| Module | Purpose |
|---|---|
| `pool` | Core pool object — jobs, workers, treasury, reward claims |
| `difficulty` | VARDIFF retargeting algorithm |
| `share` | Pure helpers for coinbase/merkle/header serialization |

### Key entry points

```move
pool::create_pool(ctx)                          // deploy a new pool instance
pool::post_job(pool, prev_hash, ..., ctx)       // operator: broadcast a mining job
pool::register_worker(pool, name, ctx)          // miner: authorize on-chain
pool::submit_share(pool, job_id, nonce, ctx)    // miner: record a valid share
pool::claim_reward(pool, ctx)                   // miner: proportional payout, permissionless
```

## Stratum v1 reference

The bridge implements the server side of the Stratum v1 wire protocol as specified in [stratum-mining/stratum sv1](https://github.com/stratum-mining/stratum/tree/65c9688ca0e9cdcf213b32a6f51e9309fb75bbab/sv1):

| Method | Role |
|---|---|
| `mining.subscribe` | Session handshake, extranonce1 assignment |
| `mining.authorize` | Worker registration → on-chain `register_worker` |
| `mining.notify` | Job broadcast |
| `mining.set_difficulty` | VARDIFF updates |
| `mining.submit` | Share submission → validated off-chain, recorded on-chain |

## Roadmap

- [ ] Wire `SuiChainClient` with `sui-sdk` PTB builder
- [ ] Full SHA-256d PoW verification in the bridge
- [ ] Per-worker VARDIFF using `difficulty.move`
- [ ] Multi-pool federation
- [ ] Move Prover invariants for reward accounting

## License

Apache 2.0
