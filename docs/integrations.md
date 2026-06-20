# Integrations

> What m1n3 leverages from the Sui ecosystem and how.

A quick map of each external stack we depend on, why we picked it, and
where in the code it shows up. The README's architecture diagram has
the call graph; this is the per-stack story behind it.

## Sui Move

The foundation. The protocol's core claim — every share is a Sui tx —
only works because Sui can validate share submissions in parallel.

**What we use:**

- **Owned-object parallelism.** `pool::submit_share` takes a frozen
  `&Template` and three *owned* objects (`MinerStats`,
  `MinerRoundStats`, `ShareDedup`) that bypass consensus. N miners
  submit shares simultaneously with zero shared-object contention.
- **Frozen objects for immutable proofs.** `Template`, `BlockFoundClaim`,
  `RoundHistory`, and `MinerWorkRecord` are frozen on creation. They
  become *cryptographic claims* the protocol's permissionless functions
  read as authorisation — replacing what a custodial pool would do with
  a database row + an `admin: bool` column.
- **Dynamic-field registries for one-shot dedup.** `MinerRoundRegistry`
  and `ShareDedupRegistry` are shared objects whose dynamic fields
  enforce "at most one per key" guarantees, allowing us to delete
  per-(miner, batch) claim tables entirely.
- **The standard library's `sha2_256`.** Used in `btc_math.move` to
  reconstruct the 80-byte block header and check the share against the
  pool's difficulty target — same SHA-256 as Bitcoin, no off-chain
  attestation required.

**Where:**
[`contracts/sources/pool.move`](../contracts/sources/pool.move),
[`miner.move`](../contracts/sources/miner.move),
[`share_dedup.move`](../contracts/sources/share_dedup.move),
[`btc_math.move`](../contracts/sources/btc_math.move).

## DeepBook V3

HashShares (per-round `Coin<HS_NNN>` minted 1:1 with accepted shares)
trade on DeepBook so miners can liquidate their position without
waiting for the round to close. The keeper auto-creates a
`Pool<HS_NNN, QUOTE>` the moment a HashShare slot is bound to a round.

**What we use:**

- **`@mysten/deepbook-v3` SDK 1.5+.** All swap / limit-order PTBs are
  built through the SDK rather than hand-rolled `tx.moveCall`. See
  [`web/lib/deepbook-client.ts`](../web/lib/deepbook-client.ts) for the
  client factory and
  [`web/components/market/DeepBookSwapPanel.tsx`](../web/components/market/DeepBookSwapPanel.tsx)
  for the buy/sell + limit-order UI.
- **`BalanceManager` lifecycle.** The dapp's "Limit" tab onboards users
  to a `BalanceManager` via
  [`web/hooks/useBalanceManager.ts`](../web/hooks/useBalanceManager.ts):
  `getBalanceManagerIds` for discovery,
  `createAndShareBalanceManager` / `depositIntoManager` /
  `withdrawFromManager` for the PTBs.
- **`createPermissionlessPool`.** The
  [`trustless-keeper`](../trustless-keeper/src/main.rs) crate watches
  `SlotBoundToRound` events and shells `sui client ptb` to create a
  pool — no admin cap needed.
- **`midPrice` + `accountOpenOrders`.** The limit-order panel polls
  these to show live spread and a per-user resting-order list with
  cancel buttons.

**Why DeepBook over a custom AMM:** track sponsor + the only
production-grade on-chain CLOB on Sui. Miners get real liquidity
day-one; we get to skip implementing an order book.

## Hashi

The MPC bridge that custodies BTC and mints hBTC on Sui. m1n3 uses
Hashi's per-deposit derivation to make the coinbase recipient a
deterministic function of the `HashiVault<BTC>` UID, which is the
"trick" the README leads with.

**What we use:**

- **`hashi::deposit::deposit`.** The on-chain entry point we call to
  register a confirmed signet UTXO as a deposit. Driven by our
  [`scripts/hashi-real-deposit-request.sh`](../scripts/hashi-real-deposit-request.sh).
- **`derivation_path`-shaped derivation.** Hashi accepts an
  `Option<address>` as a per-deposit derivation path. We pass the
  vault's UID. The committee derives a child key per
  BIP-340 (HKDF-SHA3-256 over `master_x || sui_addr`, scalar add) and
  applies a BIP-341 Taproot tweak. Full math in
  [`hashi-derive/src/main.rs`](../hashi-derive/src/main.rs).
- **MPC threshold signing for spends.** The committee is the only party
  that can sign a spend from the derived P2TR. The mint side
  (BTC → hBTC) is similarly committee-signed.
- **devnet only, currently.** Hashi isn't on testnet or mainnet yet.
  Our testnet deployment skips the hBTC path; `claim_reward` works
  with `Coin<SUI>` as a stand-in via the generic `CoinType`. When
  Hashi promotes to testnet/mainnet we point at it via env vars only —
  no contract change required.

**Where to look:**
[`contracts/sources/hashi_vault.move`](../contracts/sources/hashi_vault.move) for the
UID-as-derivation-path emission;
[`hashi-derive/src/main.rs`](../hashi-derive/src/main.rs) for the
client-side BIP-340/341 derivation;
[`docs/trustless-address.md`](trustless-address.md) for the worked
example.

## OpenZeppelin contracts-sui

Audited math for the reward distribution. We adopted this during a
mid-development security pass when the hand-rolled `(a * b) / c`
patterns started accumulating in three modules.

**What we use:**

- **`openzeppelin_math::u64::mul_div(a, b, c, rounding::down())`**
  for `units × price` in
  [`hash_share_market.move`](../contracts/sources/hash_share_market.move),
  fee bps math in
  [`hash_share.move`](../contracts/sources/hash_share.move), and
  `units × fee_bps / bps_denom` in two places. Replaces three hand-rolled
  u128-cast patterns; aborts on overflow via `Option::destroy_some`.
- **`openzeppelin_math::u128::mul_div`** for the proportional-claim
  arithmetic in
  [`hashi_rewards::claim_reward`](../contracts/sources/hashi_rewards.move) —
  `net_work × total_sats / total_work` where `net_work` and `total_work`
  are u128.
- **`rounding::down()`** as an explicit rounding mode. Dust always
  recycles to the vault via `recycle_expired_to_vault`, never to the
  operator.

We added two regression tests (`mul_div_floor_one_percent_of_thousand_yields_ten`,
`mul_div_floor_dust_rounds_down`) so a future SDK update can't silently
change the rounding behaviour.

**Why:** OpenZeppelin is a hackathon prize sponsor and the standard
for on-chain financial math. Adopting their library signals the audit
posture we'd want before any mainnet push.

## bboerst/stratum-work (reference)

The reference UI for the block-template detail panel on the dapp's
`/templates` page. We didn't fork — the repo has no LICENSE — but the
information layout (80-byte header strip, coinbase tx parse with type
detection, merkle tree viz) matched what we wanted to ship. Our
implementation is in
[`web/components/TemplateCard.tsx`](../web/components/TemplateCard.tsx)
and
[`web/lib/bitcoin-utils.ts`](../web/lib/bitcoin-utils.ts),
written fresh against `bitcoinjs-lib`.

## Bitcoin Core + mempool.space

Bitcoin Core's JSON-RPC (`getblocktemplate`, `submitblock`) is what
`stratum-server` polls every 30s to build jobs.
[mempool.space](https://mempool.space/)'s signet block explorer + REST
API is what `hashi-status.sh` queries for confirmation counts, and what
the dapp's price + hashprice charts pull live data from.

---

## Why this stack, not another

A summary of the integration choices, in one line each:

- **Sui Move over Solana / Aptos**: owned-object parallelism is the
  thing that makes per-share Sui transactions cheap enough for real
  mining (60+ shares/min per miner).
- **DeepBook V3 over a bespoke AMM**: production-grade CLOB on the same
  L1; no oracle dependency for HashShare liquidation.
- **Hashi over wrapped-BTC-via-multisig**: MPC committee + on-chain
  derivation means the BTC recipient is provably not operator-chosen.
- **OpenZeppelin contracts-sui over hand-rolled math**: hackathon
  judging weights real-world application 50%; standard libraries
  signal we're building for a real audit, not just a demo.
