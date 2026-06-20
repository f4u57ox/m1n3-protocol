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
| `pool` | Core pool state, template management, share submission, two-phase round close |
| `hashi_rewards` | Hashi-path Bitcoin reward deposit lifecycle and proportional hBTC claim receipts |
| `btc_math` | SHA256d, bits_to_target, merkle proof, endianness helpers |
| `market` | Escrowed bid/ask marketplace for current-round full `MiningShare` NFTs using generic quote coins such as USDC |
| `m1n3` | M1N3 coin + treasury |
