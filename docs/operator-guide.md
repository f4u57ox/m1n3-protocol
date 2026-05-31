# Operator Guide

How to deploy and operate an m1n3-protocol pool.

## Prerequisites

- [Sui CLI](https://docs.sui.io/guides/developer/getting-started/sui-install) installed and configured for **devnet**
- A funded devnet wallet (`sui client faucet` or faucet.devnet.sui.io)
- A Bitcoin Core full node with RPC enabled (`getblocktemplate` requires the node to be synced)
- Rust toolchain (stable, ≥ 1.75)
- An Avalon miner (or any Stratum v1-compatible hardware) on the local network

## 1. Configure Bitcoin Core

Ensure `bitcoin.conf` (or the command-line flags) include:

```ini
server=1
rpcuser=m1n3user
rpcpassword=<strong_random_password>
rpcallowip=127.0.0.1
# Required for getblocktemplate:
txindex=1
```

Restart bitcoind and verify:

```bash
bitcoin-cli getblocktemplate '{"rules":["segwit"]}'
# Should return a JSON object with version, previousblockhash, bits, etc.
```

## 2. Publish the contracts to Sui devnet

```bash
# Switch to devnet
sui client switch --env devnet

# Get devnet SUI from the faucet
sui client faucet

# Publish the package and capture the output
sui client publish --gas-budget 200000000 contracts/ | tee publish.out

# Extract Package ID and Pool object ID
grep -E "PackageID|Created Objects" -A5 publish.out
```

Note both:
- **Package ID** — the `0x…` address of the published Move package
- **Pool object ID** — the `Pool` shared object created by `init`

## 3. Configure the bridge

```bash
cp .env.example .env
```

Edit `.env` — fill in the operator section:

```bash
SUI_RPC_URL=https://fullnode.devnet.sui.io:443
OPERATOR_KEY=suiprivkey1...      # from: sui keytool export --key-identity <address>
POOL_OBJECT_ID=0x...             # from step 2
PACKAGE_ID=0x...                 # from step 2
REWARD_MIST=100000000            # 0.1 SUI per job posted
INITIAL_DIFFICULTY=1000

BITCOIN_RPC_URL=http://127.0.0.1:8332
BITCOIN_RPC_USER=m1n3user
BITCOIN_RPC_PASS=<your_password>
JOB_REFRESH_SECS=30
```

To export your operator key:
```bash
sui keytool export --key-identity <your_address>
# Copy the "privateKey" field value (starts with suiprivkey1…)
```

## 4. Build and run the bridge

```bash
cargo build --release --bin m1n3-bridge

env $(grep -v '^#' .env | xargs) ./target/release/m1n3-bridge
```

The bridge will:
- Connect to Bitcoin Core and start polling `getblocktemplate` every `JOB_REFRESH_SECS` seconds
- Open a Stratum v1 TCP server on `BRIDGE_PORT` (default 3333)
- Post each job template on-chain via `pool::post_job` PTB
- Broadcast `mining.notify` to all connected miners
- Validate shares with off-chain SHA-256d before responding `true`

Expected log output within 30 seconds:
```
INFO m1n3-protocol bridge starting on 0.0.0.0:3333
INFO Sui chain client initialized operator=0x... pool=0x... package=0x...
INFO new job from getblocktemplate job_id=1 height=870000 n_bits=...
INFO job posted on-chain digest=0x...
```

## 5. Connect the Avalon miner

### Option A: Direct connection (no sidecar)

In the Avalon web UI (or via CGMiner config), set:

```
Pool URL: stratum+tcp://<bridge-ip>:3333
Worker:   <anything>
Password: x
```

The miner will receive real Bitcoin mainnet block templates and submit shares at pool difficulty.

### Option B: Via sidecar (recommended — enables on-chain share recording)

See [sidecar-setup.md](sidecar-setup.md). The Avalon should point at the sidecar port (3334) and the sidecar proxies upstream to the bridge (3333).

## 6. Monitor on-chain state

```bash
# Stream pool events (jobs, shares, registrations)
sui client events --package <PACKAGE_ID>

# Check pool object state
sui client object <POOL_OBJECT_ID> --json | jq .
```

Key events:

| Event | Meaning |
|---|---|
| `JobPosted` | New Bitcoin block template registered on-chain |
| `WorkerRegistered` | Miner registered after `mining.authorize` |
| `ShareAccepted` | Miner share verified on-chain (PoW correct) |
| `RewardPaid` | Miner claimed their payout |

## 7. Adjust pool difficulty

```bash
sui client call \
  --package <PACKAGE_ID> \
  --module pool \
  --function set_difficulty \
  --args <POOL_OBJECT_ID> <NEW_SCALAR> \
  --gas-budget 5000000
```

Higher scalar = lower effective difficulty = easier shares. For an Avalon miner start with `INITIAL_DIFFICULTY=1` and increase until shares arrive at ~1/minute.

## Security notes

- Keep `OPERATOR_KEY` out of version control and off disk in production (use a secrets manager).
- The operator key controls `post_job` and `set_difficulty` only — it cannot access worker funds.
- Miner rewards are locked in the on-chain treasury and can only be withdrawn by each miner's own key via `claim_reward`.
- Never commit real private keys — `.env` is in `.gitignore`; only `.env.example` is tracked.
