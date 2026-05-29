# Miner Sidecar Setup

The miner sidecar is a lightweight process that runs alongside your mining hardware. It proxies your Stratum connection to the pool and, whenever the pool accepts a share, independently submits that share to the Sui blockchain using your own private key.

**No trust in the pool operator is required** — the on-chain record is signed by you.

## How it works

```
Your ASIC (Avalon)  ──→  sidecar :3334  ──→  pool :3333
                              │
                              │  pool accepted mining.authorize
                              ▼
                       Sui devnet: pool::register_worker  ← signed with YOUR key

                              │  pool accepted share
                              ▼
                       Sui devnet: pool::submit_share     ← signed with YOUR key
```

The sidecar is 100% transparent: your ASIC never knows it's there, and the pool never knows either. Worker registration and share submission happen automatically with no manual steps.

## Prerequisites

- Rust toolchain (stable, ≥ 1.75) — only needed to build
- A Sui wallet funded with some devnet SUI for gas (~1 SUI covers thousands of share submissions)
- The Pool object ID and Package ID from the operator

## 1. Generate your Sui keypair

If you don't already have a Sui wallet:

```bash
sui client switch --env devnet
sui keytool generate ed25519
```

Get devnet SUI from the faucet:
```bash
sui client faucet
```

Export your private key for the sidecar:

```bash
sui keytool export --key-identity <your_address>
# Copy the "privateKey" value — starts with suiprivkey1…
```

## 2. Build the sidecar

```bash
git clone https://github.com/f4u57ox/m1n3-protocol.git
cd m1n3-protocol
cargo build --release --bin m1n3-sidecar
```

## 3. Configure

```bash
cp .env.example .env.sidecar
```

Edit `.env.sidecar` — fill in the sidecar section:

```bash
POOL_HOST=192.168.1.10       # IP of the machine running stratum-bridge
POOL_PORT=3333
SIDECAR_PORT=3334            # Point your Avalon at this port
SUI_RPC_URL=https://fullnode.devnet.sui.io:443
MINER_KEY=suiprivkey1...     # from sui keytool export
POOL_OBJECT_ID=0x...         # from the pool operator
PACKAGE_ID=0x...             # from the pool operator
RUST_LOG=info
```

## 4. Run the sidecar

```bash
env $(grep -v '^#' .env.sidecar | xargs) ./target/release/m1n3-sidecar
```

Expected log output:
```
INFO m1n3-sidecar proxy listening listen=0.0.0.0:3334 upstream=192.168.1.10:3333
INFO sidecar chain submitter initialized miner=0x... pool=0x... package=0x...
```

## 5. Configure the Avalon miner

In the Avalon web UI (or via CGMiner's config), set:

```
Pool 1 URL: stratum+tcp://<sidecar-machine-ip>:3334
Worker:     <anything>.worker1   (this becomes your on-chain worker name)
Password:   x
```

After connecting, the sidecar logs will show:
```
INFO ASIC connected to sidecar peer=...
INFO captured extranonce1 from subscribe extranonce1=...
INFO worker registered on-chain worker=<username> digest=0x...
```

Registration is now automatic — no manual `sui client call` needed.

## 6. Verify on-chain state

After running for a few minutes:

```bash
# Check for WorkerRegistered and ShareAccepted events
sui client events --package <PACKAGE_ID>

# Inspect your worker entry in the pool
sui client object <POOL_OBJECT_ID> --json | jq '.data.content.fields.workers'
```

## 7. Claim your rewards

At any time, withdraw your proportional earnings:

```bash
sui client call \
  --package <PACKAGE_ID> \
  --module pool \
  --function claim_reward \
  --args <POOL_OBJECT_ID> \
  --gas-budget 5000000
```

Funds go directly to your wallet — no operator approval needed.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `POOL_HOST is required` | Missing env var — check `.env.sidecar` |
| `invalid MINER_KEY` | Key format wrong — must be `suiprivkey1…` from `sui keytool export` |
| `PACKAGE_ID is required` | Get this from the pool operator |
| `operator has no SUI coins` | Run `sui client faucet` to top up |
| `EAlreadyRegistered` in logs | Worker already registered — safe to ignore |
| `EInvalidShare` in Sui logs | extranonce1 mismatch — restart sidecar to re-register |
| Gas errors | Insufficient SUI — run `sui client faucet` |
