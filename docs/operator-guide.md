# Operator Guide

How to deploy and operate an m1n3-protocol pool.

## Prerequisites

- [Sui CLI](https://docs.sui.io/guides/developer/getting-started/sui-install) installed and configured
- A funded Sui wallet on the target network (testnet or mainnet)
- A running Bitcoin node (for `getblocktemplate`) or access to a pool that provides block templates
- Rust toolchain (stable, ≥ 1.75)

## 1. Publish the contracts

```bash
# Switch to the target network
sui client switch --env testnet

# Publish the package and capture the output
sui client publish --gas-budget 200000000 contracts/ | tee publish.out

# Extract the Pool object ID from the output
grep "Pool" publish.out
```

Note the `Package ID` and the `Pool` object ID — you need both for the bridge config.

## 2. Configure the bridge

```bash
cp .env.example .env
```

Edit `.env`:

```bash
BRIDGE_HOST=0.0.0.0
BRIDGE_PORT=3333
SUI_RPC_URL=https://fullnode.testnet.sui.io:443
OPERATOR_KEY=<your_ed25519_private_key_hex>   # sui keytool export
POOL_OBJECT_ID=<pool_object_id_from_step_1>
INITIAL_DIFFICULTY=1000
```

To export your operator key:
```bash
sui keytool export --key-identity <address> --json
```

## 3. Build and run the bridge

```bash
cargo build --release --bin m1n3-bridge
./target/release/m1n3-bridge
```

The bridge will:
- Open a Stratum v1 TCP server on `BRIDGE_PORT`
- Post job templates on-chain whenever `mining.notify` is broadcast
- Log accepted connections, job postings, and any chain errors

## 4. Post the first job

Jobs are posted when the bridge's job broadcast channel fires. To trigger a job manually (for testing):

```bash
# TODO: bridge will expose a simple HTTP admin endpoint or CLI command in a future release
# For now, use the Sui CLI directly:
sui client call \
  --package <PACKAGE_ID> \
  --module pool \
  --function post_job \
  --args <POOL_OBJECT_ID> \
    '[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]' \
    '"01000000..."' '"ffffffff..."' '[]' \
    1 0x1d00ffff 0x5e9a1b2c \
    500000000 <COIN_OBJECT_ID> \
  --gas-budget 10000000
```

## 5. Monitor

Watch on-chain events via the Sui explorer or CLI:

```bash
# Stream pool events
sui client events --package <PACKAGE_ID>
```

Key events to monitor:

| Event | Meaning |
|---|---|
| `JobPosted` | New job template registered on-chain |
| `ShareAccepted` | Miner share verified and credited |
| `RewardPaid` | Miner claimed their payout |

## 6. Adjust difficulty

```bash
sui client call \
  --package <PACKAGE_ID> \
  --module pool \
  --function set_difficulty \
  --args <POOL_OBJECT_ID> <NEW_SCALAR> \
  --gas-budget 5000000
```

The scalar multiplies the Bitcoin network target — higher scalar = easier shares.

## Security notes

- Keep `OPERATOR_KEY` secret and off disk in production (use a secrets manager or HSM).
- The operator key controls `post_job` and `set_difficulty` only — it cannot touch worker funds.
- Miners' rewards are locked in the on-chain treasury and can only be withdrawn by each miner's own key via `claim_reward`.
