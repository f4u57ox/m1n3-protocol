# Miner Sidecar Setup

The miner sidecar is a lightweight process that runs alongside your mining hardware. It proxies your Stratum connection to the pool and, whenever the pool accepts a share, independently submits that share to the Sui blockchain using your own private key.

**No trust in the pool operator is required** — the on-chain record is signed by you.

## How it works

```
Your ASIC  ──→  sidecar :3334  ──→  pool :3333
                    │
                    │  pool accepted share
                    ▼
             Sui blockchain
             pool::submit_share  ← signed with YOUR key
```

The sidecar is 100% transparent: your ASIC never knows it's there, and the pool never knows either.

## Prerequisites

- Rust toolchain (stable, ≥ 1.75) — only needed to build
- A Sui wallet with a small amount of SUI for gas (~0.5 SUI is plenty to start)
- The Pool object ID from the operator

## 1. Generate your Sui keypair

If you don't already have a Sui wallet:

```bash
sui keytool generate ed25519
```

This outputs your address and private key. Fund the address with some SUI for gas fees.

Export your private key for the sidecar:

```bash
sui keytool export --key-identity <your_address>
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

Edit `.env.sidecar` — only the sidecar section matters:

```bash
POOL_HOST=pool.example.com    # Address of the m1n3-protocol pool
POOL_PORT=3333
SIDECAR_PORT=3334             # Local port — point your ASIC here
SUI_RPC_URL=https://fullnode.testnet.sui.io:443
MINER_KEY=<your_ed25519_key_hex>
POOL_OBJECT_ID=<pool_object_id_from_operator>
RUST_LOG=info
```

## 4. Register on-chain

Before submitting shares, you must register your worker on-chain once. The sidecar will eventually do this automatically; for now use the Sui CLI:

```bash
# Your extranonce1 appears in the sidecar logs after the first mining.subscribe
# Look for: "captured extranonce1 from subscribe response"

sui client call \
  --package <PACKAGE_ID> \
  --module pool \
  --function register_worker \
  --args <POOL_OBJECT_ID> '"worker1.default"' '"<extranonce1_hex>"' \
  --gas-budget 5000000
```

## 5. Run the sidecar

```bash
env $(cat .env.sidecar | xargs) ./target/release/m1n3-sidecar
```

Then point your ASIC at:
```
stratum+tcp://localhost:3334
```

(Replace `localhost` with the sidecar machine's IP if the ASIC is on a different host.)

## 6. Verify

After running for a few minutes, check your on-chain share count:

```bash
sui client object <POOL_OBJECT_ID>
```

Or watch for `ShareAccepted` events:

```bash
sui client events --package <PACKAGE_ID> | grep ShareAccepted
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
| `MINER_KEY is required` | Missing or empty key |
| Shares not appearing on-chain | Worker not registered — see step 4 |
| `EInvalidShare` in Sui logs | extranonce1 mismatch — re-register with correct value from logs |
| Gas errors | Insufficient SUI in wallet — top up and retry |
