# miner-sidecar

Trustless Stratum v1 proxy. Mining hardware talks to the sidecar; the sidecar proxies work and submissions to the pool's stratum server. When a share is accepted by the pool, the sidecar submits it to Sui using the **miner's own keypair** — the pool operator is never in the submission path.

---

## How It Works

```
Mining hardware (e.g. Avalon / BitAxe)
        │  Stratum v1 (port 3334)
        ▼
   miner-sidecar
        │  Stratum v1 (port 3333)
        ▼
   stratum-server (pool)
        │  accepted share response
        ▼
   miner-sidecar
        │  Sui PTB — signed with MINER keypair
        ▼
   Sui blockchain (MinerRoundStats object updated)
```

The pool validates the share and records the difficulty credit, but the on-chain attribution belongs to the miner's Sui address — not the pool operator's.

---

## CLI Arguments

| Flag | Default | Description |
|------|---------|-------------|
| `--stratum-host` | `127.0.0.1:3333` | Pool stratum server address |
| `--listen-port` | `3334` | Local Stratum listen port (mining hardware points here) |
| `--sui-keystore` | `~/.sui/sui_config/sui.keystore` | Sui keystore file (signs share submissions) |
| `--sui-rpc` | `http://127.0.0.1:9000` | Sui JSON-RPC endpoint |
| `--sui-package` | **required** | m1n3 package ID (0x…) |
| `--pool-object` | **required** | Pool shared object ID (0x…) |
| `--dedup-registry` | empty | Optional ShareDedupRegistry object ID (0x...) |
| `--batch-size` | `16` | Max shares per Sui transaction (1–32) |
| `--batch-timeout-ms` | `5000` | Max wait before flushing a partial batch (ms) |

---

## Running

```bash
./target/release/miner-sidecar \
  --stratum-host pool.example.com:3333 \
  --listen-port 3334 \
  --sui-keystore ~/.sui/sui_config/sui.keystore \
  --sui-rpc https://fullnode.devnet.sui.io:443 \
  --sui-package <PACKAGE_ID> \
  --pool-object <POOL_OBJECT_ID>
```

Then configure your mining hardware to connect to `<your-machine-ip>:3334`.

---

## ASIC Configuration

In the Avalon / ASIC web UI:
- **Pool Host:** IP of the machine running miner-sidecar
- **Pool Port:** `3334`
- **Username:** `<your_sui_address>.avalon`
- **Password:** `x`

---

## Security Properties

- Pool operator counts shares toward round totals but cannot alter on-chain attribution
- The miner keypair never leaves the machine running the sidecar
- If the sidecar dies, mining hardware continues submitting to the pool (Sui submissions resume on restart; previously credited shares are safe)

---

## Building

```bash
cargo build --release
# Binary: target/release/miner-sidecar
```
