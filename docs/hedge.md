# Mining-revenue hedge via DeepBook Predict

> A provable put-strip that caps the BTC-downside on a miner's expected
> revenue. Pure Predict integration — no Move changes, no new
> contracts, no off-chain oracles.

## Why hedge

Miners earn BTC but pay costs (electricity, hardware, our own gas) in
fiat. A 5% drop in BTC price is a 5% drop in revenue, instantly. The
m1n3 `claim_reward<BTC>` payout is denominated in sats: if BTC moves
from $100k → $95k between rounds, a 0.01 BTC reward goes from $1,000
to $950 — a $50 loss the protocol can't compensate for.

This page documents the on-testnet `/hedge` flow that offsets that
loss using DeepBook Predict's vol-surface-priced range positions.

## The construction

Let

- `q_BTC` = expected BTC revenue over the hedge horizon (the soonest
  active Predict oracle's expiry)
- `S_0` = current BTC spot
- `S_T` = settlement spot at oracle expiry

Without hedge:

```
revenue(S_T) = q_BTC × S_T   USD
```

A Predict range `R(L, H)` pays 1 DUSDC per share if `L ≤ S_T < H` and
0 otherwise. Buy `Q_i` shares of `R(L_i, M_i)` for `Q_i × ask_i`
DUSDC where `0 < ask_i < 1`.

Pick a hedge band `[F, K]` below spot — `F = S_0 × (1 - δ_hi)`,
`K = S_0 × (1 - δ_lo)` — partition it into `N` contiguous ranges on
the oracle's strike grid, and set:

```
Q_i = q_BTC × (M_i − L_i)
```

Total hedge payoff:

```
H(S_T) = Σ_i  Q_i · 1{S_T ∈ [L_i, M_i)}

         ≈ q_BTC × max(K − S_T, 0)   for S_T ∈ [F, K)
         = 0                          for S_T ≥ K
         ≈ q_BTC × (K − F)            for S_T < F   (cap)
```

Total revenue after hedge (deducting premium `P = Σ Q_i × ask_i`):

```
hedged(S_T) = q_BTC × S_T + H(S_T) − P
            ≈ q_BTC × max(S_T, K) − P    for S_T ≥ F
```

The hedged revenue is *floored at* `q_BTC × F − P` regardless of how
far BTC falls. Above the band, hedged revenue is `q_BTC × S_T − P` —
identical to unhedged minus the premium. The hedge converts arbitrary
left-tail loss into a fixed insurance cost.

Critically: because Predict prices ranges off the SVI surface, the
premium `P` is **fair value** — the trade is pure variance reduction,
not edge or disedge. Expected revenue is unchanged; only the variance
and downside tail shrink.

### Pricing the strip (smile-aware)

Each range `R(L, H)` pays 1 DUSDC iff `S_T ∈ [L, H)`, so its fair value
per share (`r ≈ 0`) is exactly the risk-neutral probability mass in that
bin:

```
value(L, H) = P(S_T > L) − P(S_T > H) = Φ(d2(L)) − Φ(d2(H))
d2(K) = [ln(F/K) − ½ σ(K)² τ] / (σ(K) √τ)
```

where `F` is the oracle's forward and **`σ(K)` is read per-strike off the
SVI smile** (`sviImpliedVol(ln K/F)`), not a single ATM number. That
per-strike vol is what makes a downside range cost more than an ATM-only
estimate implies — the skew is in the price. `priceStripFromSvi` sums
`Σ Q_i · value(L_i, H_i)` and that total is the premium displayed and
charged. The Monte-Carlo pass is now used **only** for the
distribution/variance chart, with this analytic premium as its cost — so
the displayed P&L and the quoted cost agree.

## Proof — Monte-Carlo over the SVI lognormal

We sample `S_T` from the SVI-implied lognormal at the oracle's expiry,
compute unhedged and hedged revenue for each sample, and report the
distributions. The page surfaces two specific assertions:

| Assertion | Why it must hold |
|---|---|
| `σ(hedged) < σ(unhedged)` | Variance reduction from the put-like payoff |
| `P05(hedged) > P05(unhedged)` | Tail lift from the floor at `q_BTC × F − P` |

Sample run against live testnet SVI (BTC oracle, ~100 min to expiry,
σ_ATM ≈ 27%, miner with 0.01 BTC expected revenue, drop band
0.2%–0.8%):

```
Strip: [63266, 63648], width $64/range, 6 ranges
Fair-value premium = $0.19 (0.03% of expected revenue)

Unhedged: μ=$637.74 σ=$2.459 p05=$633.73
Hedged  : μ=$637.74 σ=$2.274 p05=$634.18

Proof: σ_h < σ_u ?  YES ✓   (Δ = −7.56%)
       p05_h > p05_u ?  YES ✓   (Δ = +$0.45)
```

For longer-horizon oracles (daily / weekly) the σ reduction grows
substantially because the lognormal tail covers more of the strip.

## Band sizing — match the band to the expiry horizon

Sub-hour oracles see only sub-1% moves at the 95th percentile. A
2%–10% drop band at a 100-min expiry sits deep out-of-distribution:
premium ≈ $0 (correct fair price for an event that never happens) and
the hedge never triggers.

The `/hedge` page computes a *suggested band* of `[0.25σ, 1.25σ]`
where `σ = σ_ATM × √τ` — the SVI-implied 1σ move at the oracle's
horizon. Stay near the suggested band and the hedge is meaningful;
move far above and you're protecting against events the market
considers extraordinarily unlikely (and is pricing accordingly).

## What the page actually does

1. **Revenue projection** — reads the connected wallet's miner data
   (`useMiners`) and live hashprice (`useHashprice`), computes
   `expected_USD = hashrate_THs × hashprice × horizon_days`.
2. **Strip construction** — `buildHedgeStrip` snaps strikes to the
   oracle's tick grid, caps at 8 ranges, sizes each by
   `Q_i = q_BTC × (M_i − L_i)`.
3. **Premium** — `priceStripFromSvi` prices the strip analytically off
   the live SVI smile (per-strike digital-option value). This is the
   premium shown and charged.
4. **Cost/benefit + simulation** — `summarizeHedge` turns the priced
   strip into the miner-facing headline (premium paid, downside offset,
   revenue floor, break-even drop %). `simulateHedgePnl` runs 10,000
   Monte-Carlo samples over the SVI lognormal *using the analytic
   premium as cost* to render the p05/p50/p95 distribution + variance
   reduction + tail lift.
5. **Payoff chart** — `buildPayoffCurve` + `HedgePayoffChart` plot
   hedged-vs-unhedged revenue across settlement price, with the hedged
   band shaded and spot/floor marked.
6. **PTB construction** — single transaction chains
   `predict::create_manager` (only on first hedge), `predict_manager::deposit<DUSDC>`,
   N × `predict::mint_range<DUSDC>`. User signs once.
7. **Position display** — reads back from
   `/managers/:id/positions/summary` into a visual strike `PositionLadder`
   (each range, its DUSDC payout, and which rungs are live at spot) plus
   the payoff chart for the open strip.

## Code map

| Surface | File |
|---|---|
| Page route | [`web/app/hedge/page.tsx`](../web/app/hedge/page.tsx) |
| Dashboard composition | [`web/components/hedge/HedgeDashboard.tsx`](../web/components/hedge/HedgeDashboard.tsx) |
| Payoff chart (hedged vs unhedged) | [`web/components/hedge/HedgePayoffChart.tsx`](../web/components/hedge/HedgePayoffChart.tsx) |
| Visual strike ladder for open positions | [`web/components/hedge/PositionLadder.tsx`](../web/components/hedge/PositionLadder.tsx) |
| Math: strip, smile pricing, summary, payoff, MC | [`web/lib/hedge-math.ts`](../web/lib/hedge-math.ts) |
| Predict REST client + SVI parsing | [`web/lib/predict-client.ts`](../web/lib/predict-client.ts) |
| Testnet IDs (package, Predict object, server URL) | [`web/lib/predict-constants.ts`](../web/lib/predict-constants.ts) |
| Revenue integrator hook | [`web/hooks/useMinerHedge.ts`](../web/hooks/useMinerHedge.ts) |
| Oracle list / state hooks | [`web/hooks/usePredictOracles.ts`](../web/hooks/usePredictOracles.ts) |
| PredictManager find-or-create | [`web/hooks/usePredictManager.ts`](../web/hooks/usePredictManager.ts) |
| DUSDC quote-token registration | [`web/lib/quote-tokens.ts`](../web/lib/quote-tokens.ts) |

## Bring-up

1. Switch the dapp to testnet
   (`NEXT_PUBLIC_SUI_NETWORK=testnet`).
2. Request DUSDC at <https://tally.so/r/Xx102L> for the test wallet.
3. Hit `/hedge`. The revenue header populates from your miner state;
   the simulator picks the soonest active BTC oracle; suggested band
   defaults to the SVI 1σ move.
4. Adjust drop band sliders. Watch σ-reduction and P05-lift update.
5. **Place hedge** — first click creates the `PredictManager`,
   second click deposits DUSDC + mints the strip.
6. **Open positions** panel below shows your ranges and which ones are
   currently in-band at live spot.

## What's not in this implementation (roadmap)

- **Auto-hedge from the sidecar.** A `--auto-hedge-pct N` flag would
  let the miner-sidecar place the strip after every Nth confirmed
  batch. The math model is portable to Rust; only the binding work
  remains.
- **Auto-redeem on settlement.** Currently the user has to click
  redeem after the oracle settles (or wait — `redeem_permissionless`
  is callable by anyone, so a keeper bot can drain settled positions
  on the user's behalf).
- **Multi-strip ladders.** For miners with hours of expected revenue
  across multiple expiries, layering strips across oracles smooths the
  hedge cadence. The strip builder generalizes; the UI needs an
  oracle-selector or per-expiry inputs.
- **Composable on-chain wrapper.** A `m1n3_hedge_vault` Move package
  could let multiple miners pool their premium into one tokenized
  share token. Out of scope until the off-chain path is proven on
  mainnet.
