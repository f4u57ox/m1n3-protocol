# m1n3 Sui Move Contracts

On-chain implementation of the m1n3 decentralized Bitcoin mining pool, written in Sui Move.

## Build & test

```bash
sui move build --build-env mainnet
sui move test --build-env mainnet
```

## Published addresses

See `Published.toml` for testnet/mainnet package IDs.

## Modules

| Module | Description |
|---|---|
| `pool` | Core pool state, template lifecycle, share submission (hot path), two-phase round close, buyer-template lane (V1 + V2 hashpower orders, `ProtocolMPCConfig`) |
| `miner` | Per-miner state objects (`MinerStats`, `MinerRoundStats`, `MinerRoundRegistry`) and dedup helpers |
| `share_dedup` | Per-(miner, template) share hash dedup with dynamic-field O(1) lookup |
| `hash_share` | `HashShare` round-bound coin minting + the slot/treasury cap registry |
| `hash_share_registry` | 8-slot HashShare round-binding registry, FIFO slot rotation |
| `hash_share_market` | Generic `BuyOrder<T, QuoteT>` / `SellOrder<T, QuoteT>` market for HashShares against any quote coin |
| `template_registry` | (Deleted in trust-cleanup — see CLAUDE.md.) Kept as a slot in the package layout history. |
| `hashi_pool` | Hashi MPC integration scaffold (`HashiPoolConfig`, `BlockDepositRecord`, deposit lifecycle states) |
| `hashi_vault` | Shared `HashiVault<T>` BTC custody object — only drained via `take_exact_hbtc` (package-only) |
| `hashi_rewards` | Hashi-path reward batch lifecycle (PENDING → FUNDED → COMPLETED/EXPIRED), proportional hBTC claims |
| `m1n3_confidential_otc` | Twisted-ElGamal-anchored confidential OTC escrow (devnet only) |
| `m1n3` | M1N3 coin + treasury |
| `dusdc` | Demo USDC for testnet/devnet flows that need a stable quote coin without bridging |
| `hs_000` … `hs_007` | Per-slot witness modules for the 8-slot HashShare rotation |
| `btc_math` | SHA256d, varint reader, `bits_to_target`, merkle proof, byte-level coinbase verifiers (`verify_derived_coinbase`, `verify_vout_1_script`) |
