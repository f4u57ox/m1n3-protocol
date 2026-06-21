# m1n3 architecture

> The "how" behind the [protocol's claim in the README](../README.md):
> every share is a signed Sui tx, every payout is an on-chain claim,
> and the BTC reward address is a function of Sui state.

This doc walks the end-to-end share → round → claim flow once, then
calls out the invariants the Move type system enforces and the
parallelism strategy that keeps per-share gas affordable.

## End-to-end reward flow

```text
miner: submit_share → (on is_block)
                       └─ freeze BlockFoundClaim { round_id, block_finder=sender }

keeper/anyone: open_round_accumulator_from_claim(claim) → shared RoundAccumulator

each miner:    accumulate_miner_stats(my_mrs[]) → consumed;
                  per-miner MinerWorkRecord transferred to the miner

keeper/anyone: finalize_round (after ACCUMULATION_WINDOW_MS)
                  → frozen RoundHistory

operator: record_block_found(config, claim, txid, vout, amount)
                  → shared BlockDepositRecord (UNREGISTERED)

operator: register_with_hashi → Hashi committee asynchronously
                                  approves + confirms

keeper/anyone: open_and_fund_round_batch(registry, vault, round_history, record)
                  → shared HashiRewardBatch<BTC> (FUNDED)

each miner: claim_reward<BTC>(batch, my_mwr, round_history)
                  → Coin<BTC> proportional to net_work
```

The `trustless-keeper` crate is the public watcher binary that runs the
"anyone" steps. It needs only gas, no privileged keys.

## Object lifetimes at a glance

| Object | Created by | Lifetime | Owner |
|---|---|---|---|
| `Template` | `register_template` (operator) | Frozen, immutable forever | Immutable |
| `MinerStats` | `register_miner` | Per-miner, persists across rounds | Miner (owned) |
| `MinerRoundStats` | `create_round_stats` (miner) | One per `(miner, round)` | Miner (owned) |
| `ShareDedup` | `create_share_dedup` | Per-(miner, template) | Miner (owned) |
| `BlockFoundClaim` | `submit_share` when `is_block` | Frozen forever | Immutable |
| `RoundAccumulator` | `open_round_accumulator_from_claim` | Open until `finalize_round` | Shared |
| `MinerWorkRecord` | `accumulate_miner_stats` | Until `claim_reward` consumes it | Miner (owned) |
| `RoundHistory` | `finalize_round` | Frozen forever | Immutable |
| `BlockDepositRecord` | `hashi_pool::record_block_found` | Until funded → marked one-shot | Shared |
| `HashiRewardBatch<BTC>` | `open_and_fund_round_batch` | Until claim window expires | Shared |
| `HashiVault<BTC>` | `hashi_vault::create_shared` | Permanent | Shared |

`MinerRoundRegistry` (a shared dynamic-field map) ensures at most one
`MinerRoundStats` exists per `(miner, round)`. Without that, a miner
could fabricate multiple work records for the same round and double-claim.

## Two layers of parallelism

**Owned objects on the hot path.** `submit_share` takes a frozen
`&Template` (immutable, can be read by any tx concurrently) and three
*owned* objects (`MinerStats`, `MinerRoundStats`, `ShareDedup`) that
belong to the miner. Owned-object mutations skip Sui consensus
entirely. The `Pool` shared object is only touched at round boundaries
(open accumulator, finalize round) and at template registration.

**Result:** N miners submit shares in parallel with zero shared-object
contention. The whole protocol's throughput is gated by Bitcoin's
block target, not by Sui consensus latency.

## Invariants enforced by the Move type system

The four guarantees from the README, where they live in the contract:

| Invariant | Enforcement |
|---|---|
| Block-finder identity is the runtime sender of the share TX | `pool::submit_share` sets `claim.block_finder = tx_context::sender(ctx)`; operator cannot forge. |
| Round can only be opened with a real block-found proof | `pool::open_round_accumulator_from_claim(&BlockFoundClaim)` — asserts `claim.round_id == pool.current_round`. The legacy admin-gated path was deleted. |
| Round close is permissionless after the window | `pool::finalize_round` — no cap, gated by `ACCUMULATION_WINDOW_MS`. |
| One `MinerRoundStats` per `(miner, round)` | `miner::MinerRoundRegistry` is a shared dynamic-field dedup, threaded through `miner::create_round_stats`. This is what lets `claim_reward` skip the per-miner `batch.claimed` Table — MWR consumption is sufficient dedup. |
| HBTC can only leave the vault into a `HashiRewardBatch` | `HashiVault.hbtc` is drained only by `hashi_vault::take_exact_hbtc` (`public(package)`-visible). The only in-package caller is `hashi_rewards::open_and_fund_round_batch`. No `withdraw_hbtc` exists. |
| Funding is bound to a CONFIRMED Hashi deposit for the right round | `open_and_fund_round_batch` asserts `record.round_id == round_history.round_id` AND `hashi_pool::is_confirmed(record)`, then drains `record.amount_sats` exactly (NOT all of `vault.hbtc`). |
| Each `BlockDepositRecord` funds at most one batch | `record.funded_batch_id: Option<address>`, set by `hashi_pool::mark_funded` (`public(package)`). Re-funding aborts with `EAlreadyFunded`. |
| Vault is shared, never owned | Only `hashi_vault::create_shared` exists; the owned-vault constructor was deleted. Owned vaults can't be driven by permissionless callers (`&mut` on owned objects requires owner signature). |
| Claim window is a fixed constant | `TRUSTLESS_CLAIM_WINDOW_MS` in `hashi_rewards.move`. Not a caller arg. |
| Unclaimed funds recycle to the vault, never to an operator | `recycle_expired_to_vault` after `claim_deadline_ms`. The `admin_reclaim_expired` function was deleted. |

## What still requires `PoolAdminCap`

The cap remains gated on three things, intentionally:

- `pool::register_template` — admin publishes Bitcoin job templates.
- `pool::reset_difficulty` / `set_difficulty`.
- `hashi_pool::initialize`, `update_btc_address`, `register_with_hashi`,
  `mark_hashi_approved`/`confirmed`/`failed`.

All of these are *off-the-reward-path* — they can't be used to redirect
funds. The cap is a publishing tool, not a custody key. If a future
change can move one of these to permissionless without breaking trust,
the `BlockFoundClaim` design is the template: bind to an on-chain proof
object, not to a caller.

## Where to look next

- The trick the README leads with — the BTC reward address derivation —
  is broken out in [`trustless-address.md`](trustless-address.md).
- Per-integration notes (DeepBook V3, Hashi, OZ contracts-sui) are in
  [`integrations.md`](integrations.md).
- How miners choose between verification-only, auto-sell, and the
  roadmap auto-fill-bids modes is documented in
  [`miner-modes.md`](miner-modes.md), including dynamic-pricing patterns
  for market-adaptive miners.
- The Move source itself is fully commented:
  [`contracts/sources/pool.move`](../contracts/sources/pool.move),
  [`hashi_rewards.move`](../contracts/sources/hashi_rewards.move),
  [`hashi_vault.move`](../contracts/sources/hashi_vault.move).
