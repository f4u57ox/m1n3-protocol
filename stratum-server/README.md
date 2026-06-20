# stratum-server

Stratum v1 mining server for m1n3. Accepts miner connections, fetches block templates from Bitcoin Core, validates shares locally (< 1ms), and submits valid shares to the Sui on-chain pool.

## Modes

### Pool mode (default)

The server fetches Bitcoin templates, serves Stratum v1 on port 3333, validates
shares locally, and registers templates on Sui. Accepted shares are not submitted
with miner attribution unless you run `--miner-keypair` or put `miner-sidecar`
between the ASIC and the server.

```bash
BITCOIN_RPC_URL=http://<rpc-user>:<rpc-password>@127.0.0.1:8332 \
./target/release/stratum-server \
  --sui-package <PACKAGE_ID> \
  --pool-object <POOL_OBJECT_ID> \
  --pool-admin-cap <ADMIN_CAP_ID> \
  --sui-rpc-url https://fullnode.devnet.sui.io:443 \
  --sui-keystore ~/.sui/sui_config/sui.keystore \
  --pool-address <HEX_SCRIPTPUBKEY> \
  --port 3333
```

### Solo / trustless mode (`--miner-keypair`)

When `--miner-keypair` is set the server batches shares and signs each Sui transaction with the miner's keystore, removing the pool from the attribution chain. For hardware that can't hold a Sui key, use the `miner-sidecar` instead.

```bash
./target/release/stratum-server \
  --sui-package <PACKAGE_ID> \
  --pool-object <POOL_OBJECT_ID> \
  --dedup-registry <DEDUP_REGISTRY_ID> \
  --miner-keypair ~/.sui/sui_config/miner.keystore \
  --miner-batch-size 16 \
  --miner-batch-timeout-ms 30000
```

---

## CLI Arguments

| Flag | Env Var | Default | Description |
|------|---------|---------|-------------|
| `--bitcoin-rpc` | `BITCOIN_RPC_URL` | `""` | Bitcoin Core RPC URL (`http://<rpc-user>:<rpc-password>@host:port`) |
| `--port` / `-p` | — | `3333` | Stratum TCP listen port |
| `--sui-package` | — | **required** | m1n3 Sui package ID (0x…) |
| `--pool-object` | — | **required** | Pool shared object ID (0x…) |
| `--pool-admin-cap` | — | `""` | Pool admin cap object ID |
| `--sui-rpc-url` | — | `http://127.0.0.1:9000` | Sui JSON-RPC endpoint |
| `--sui-keystore` | — | `~/.sui/sui_config/sui.keystore` | Pool operator keystore path |
| `--pool-address` | — | `""` | Coinbase payout scriptPubKey (hex) |
| `--initial-difficulty` | — | `4096` | Starting difficulty for new miners |
| `--target-shares-per-min` | — | `10` | Global vardiff target |
| `--idle-timeout` | — | `300` | Disconnect idle miners after N seconds |
| `--mempool-refresh-secs` | — | `30` | Interval to push mempool-change jobs |
| `--miner-keypair` | — | `""` | Solo mode: miner keystore path |
| `--dedup-registry` | — | `""` | Solo mode: ShareDedupRegistry object ID |
| `--miner-batch-size` | — | `16` | Solo mode: max shares per Sui tx (1–32) |
| `--miner-batch-timeout-ms` | — | `30000` | Solo mode: batch flush timeout (ms) |
| `--gas-budget` | — | `10000000` | Gas budget per transaction (MIST) |
| `--lightweight` | — | `false` | Skip MiningShare NFT creation (~60% gas savings) |
| `--decentralized` | — | `false` | Enable decentralized template selection |
| `--staking-registry` | — | — | Staking registry ID (decentralized mode) |
| `--default-selection` | — | `stake` | Template selection mode: `stake`, `shares`, `combined` |
| `--template-cache-secs` | — | `5` | Template cache refresh interval |
| `--metrics-port` | — | `9091` | HTTP metrics port (0 = disabled) |

---

## Vardiff

**Global vardiff** adjusts difficulty for all miners based on `--target-shares-per-min`. Runs every 30 seconds.

**Per-miner vardiff** tracks each miner's share rate over a 60-second sliding window and adjusts individually using an EMA of estimated hashrate. Target: one share per 30 seconds per miner.

---

## Share Validation

Each submitted share is validated in order:

1. **Dedup** — 16-shard in-memory HashSet; duplicate shares rejected immediately
2. **Difficulty** — local SHA256d computation; must meet miner's current target
3. **Ntime** — within Bitcoin's `mintime`/`maxtime` window

Accepted shares go to the Sui transaction batch queue only in `--miner-keypair`
mode. For Avalon or other ASICs, the recommended on-chain path is:

```text
ASIC -> miner-sidecar :3334 -> stratum-server :3333 -> Sui batch submit
```

---

## Metrics Endpoint

`GET http://localhost:9091/health`
```json
{
  "status": "ok",
  "miners_connected": 3,
  "last_template_secs_ago": 4
}
```

`GET http://localhost:9091/metrics`
```json
{
  "miners_connected": 3,
  "global_difficulty": 65536,
  "shares_accepted_total": 12345,
  "shares_rejected_total": 7,
  "estimated_pool_hashrate_ths": 0.45,
  "last_template_secs_ago": 4,
  "uptime_secs": 3600
}
```

---

## Miner Connection

```
Host: <server-ip>:3333
Username: <sui_address>.worker_name
Password: x
```

The username begins with the miner's Sui address (0x…). Everything after the first `.` is the worker label.

---

## Building

```bash
cargo build --release
# Binary: target/release/stratum-server
```
