# Miner operating modes

> Three ways to run a miner on m1n3, in order of trust delegation.
> Pick the one that matches how active you want to be on the market.

| Mode | What it does | Active? | Status |
|---|---|---|---|
| **1. Verification only** | Submit accepted shares to Sui. Hold the resulting HashShares in your wallet. Sell manually whenever. | passive | ✓ shipped |
| **2. Auto-sell at floor** | Same as above, plus after every accepted batch place a single SellOrder at a price you set. | semi-active | ✓ shipped |
| **2b. Auto-sell peg-to-market** | Variant of Mode 2. Each batch retargets the resting order price to track best bid / mid / best ask ± offset. | semi-active | ✓ shipped |
| **3. Auto-fill bids** | Instead of placing a resting ask, immediately fill any open BuyOrder above your floor. Falls through to auto-sell when no bid matches. | active | ✓ shipped |

All three modes use the **same on-chain primitives** and the **same
sidecar binary** — they differ only in the CLI flags you set.

---

## Mode 1 — Verification only

The baseline. Every share your ASIC submits gets relayed through the
sidecar to the pool's stratum server, and once the pool accepts it, the
sidecar wraps it in a Sui PTB signed with your own key. Your
`MinerRoundStats` object increments; you accumulate share difficulty
toward the round's `total_net_work`; when the round closes and gets
funded, you call `claim_reward<BTC>` against your `MinerWorkRecord`.

You retain custody of any HashShares minted along the way. Trade them
later through `/marketplace` (DeepBook for non-SUI quotes, the in-house
`hash_share_market` for SUI).

### Run

```bash
./target/release/miner-sidecar \
  --stratum-host pool.example.com:3333 \
  --listen-port 3334 \
  --sui-keystore ~/.sui/sui_config/sui.keystore \
  --sui-rpc https://fullnode.testnet.sui.io:443 \
  --sui-package $SUI_PACKAGE \
  --pool-object $POOL_OBJECT \
  --dedup-registry $DEDUP_REGISTRY \
  --miner-round-registry $MINER_ROUND_REGISTRY \
  --hashshare-registry $HASHSHARE_REGISTRY_ID \
  --batch-size 4 \
  --batch-timeout-ms 5000 \
  --gas-budget 50000000
```

Point your ASIC at `stratum+tcp://<your-host>:3334`. That's it.

### When to use

- You want predictable behaviour and full control over when you sell.
- You're treating m1n3 like a custodial pool replacement and only care
  about on-chain attribution.
- You don't trust price signals enough to automate.

---

## Mode 2 — Auto-sell at floor

Identical to Mode 1, except after every batch the sidecar adds a single
`hash_share_market::place_sell_order` call to the same PTB. It merges
all your owned HashShare coins into one, then puts the entire balance
up at the price you configured.

### Run

Add two flags to the Mode 1 command:

```bash
  --auto-sell-price-mist 1000 \
  --auto-sell-expires-ms 0
```

| Flag | Meaning | Example |
|---|---|---|
| `--auto-sell-price-mist N` | MIST per HashShare unit (1 SUI = 10⁹ MIST). 0 disables auto-sell. | `1000` = 0.000001 SUI per unit |
| `--auto-sell-expires-ms T` | Unix epoch ms after which the order auto-cancels. `0` = no expiry. | `0` |

The sidecar log will print one line per auto-sell:

```
INFO miner_sidecar::stratum_proxy: Auto-sell placed: <order-tx-digest>
  (<N> units @ <P> MIST/unit)
```

### Pricing math

`price_per_unit_mist = floor (MIST per HashShare unit)`. A share of
difficulty D mints D HashShare units (1:1 with difficulty). So a share
at difficulty 10,000 sold at `--auto-sell-price-mist 1000` posts a
SellOrder of 10,000 units × 1,000 MIST = 0.01 SUI total.

If you want to think in dollar terms, the dapp's `/marketplace` quotes
all prices in USDC/USD via the live SUI rate from
[`useHashprice`](../web/hooks/useHashprice.ts) — set your floor where
the converted USD price covers your electricity + gas. The conservative
break-even today is around **1,000 MIST/unit** at SUI ≈ $0.70 and the
auditable `/info` cost chart at `/info`.

### When to use

- You want a continuous off-ramp and you know your minimum acceptable
  price. The market reads as buyer-sided (lots of resting bids), so any
  ask above the highest bid will sit until a buyer hits it.
- You're willing to live with one resting order at a time per round
  slot. Auto-sell **replaces** any previous resting order from the same
  batch — it doesn't accumulate multiple orders.

### Things to know

- **One open order per slot at a time.** The sidecar places a fresh
  `SellOrder` after each batch. Previous resting orders from that miner
  are *not* automatically cancelled. If you want to dynamically retarget
  price without leaving stale orders behind, manually
  `cancel_sell_order` first (use the dapp's `/marketplace` "your open
  orders" list) or wait for the resting order to fill.
- **Auto-sell PTB chain.** The PTB layout is:
  `merge all HS coins → split exact amount → place_sell_order`. All in
  one atomic tx, so a failed fill at the end reverts the merge too.
- **No floor on the order — only on the price.** If your inventory
  balance is very small (say, 1 HashShare unit at 1000 MIST), DeepBook's
  / `hash_share_market`'s minimum-order rules may reject the order.
  Configure `--batch-size` so accumulated inventory clears the minimum.

---

## Mode 2b — Auto-sell peg-to-market

Variant of Mode 2 where the resting-order price tracks the live
orderbook instead of being a fixed config value. On each batch the
sidecar:

1. Reads the live best bid + best ask via `BuyOrderPlaced` /
   `SellOrderPlaced` event scan + per-order content reads.
2. Picks an `anchor` (`mid` | `bid` | `ask`) and computes
   `target = anchor × (1 + offset_bps / 10000)`.
3. If the miner has a live `SellOrder<HS_NNN>`, calls
   `top_up_sell_order` to add the new batch's inventory + optionally
   `update_sell_order_price` to retarget.
4. Otherwise places a fresh `SellOrder` at `target`.

### Run

```bash
  --auto-sell-peg mid \
  --auto-sell-offset-bps 100 \
  --auto-sell-fallback-mist 1000
```

| Flag | Meaning |
|---|---|
| `--auto-sell-peg mid\|bid\|ask` | Orderbook anchor. Empty string disables peg mode. |
| `--auto-sell-offset-bps N` | Signed bps offset (e.g. `+100` = 1% above anchor, `-50` = 0.5% below). |
| `--auto-sell-fallback-mist N` | Used when the orderbook is empty (no live bids or asks). `0` skips the batch instead. |
| `--auto-sell-expires-ms M` | Same as Mode 2 — Unix-ms order expiry. `0` = none. |

When peg is set, `--auto-sell-price-mist` is ignored.

### Sidecar log

Successful retarget:

```
INFO Auto-sell (pegged): <digest>
  (peg Mid±100bps → topped order 0x4d3da2…0bba08f9 with 13860 units)
```

Fresh placement:

```
INFO Auto-sell (pegged): <digest>
  (peg Mid±100bps → placed 13860 units @ 1230 MIST/unit)
```

### When to use

- You want to sit just above mid passively and let aggressive bids hit
  your ask. Set `--auto-sell-offset-bps +100` (or higher).
- You want to undercut the resting asks to fill faster. Set
  `--auto-sell-peg ask --auto-sell-offset-bps -1` to sit one tick
  below the best resting ask.
- You're confident enough in the live book that you'd rather track
  market than hold a hard floor. The `--auto-sell-fallback-mist` gives
  you a safety net when the book empties out (otherwise the batch is
  skipped and your inventory accumulates).

---

## Mode 3 — Auto-fill resting bids

Scan the orderbook for any resting `BuyOrder<HS_NNN>` whose
`price_per_unit_mist ≥ your_floor`, then call `fill_buy_order` against
the highest-priced match in the same PTB. The PTB merges your owned
HashShare coins, splits off `min(my_inventory, order_budget / price)`,
and hands the split coin to `fill_buy_order`. Funds settle to your
wallet immediately; no resting order is created.

**Fall-through to auto-sell.** When no bid meets the floor on a given
batch, the sidecar falls through to `auto-sell-peg` (if set) or fixed
`auto-sell` (if set). So you can combine modes: *take aggressive bids
when they exist, otherwise post a resting ask*.

### Run

```bash
  --auto-fill-bid-floor-mist 950 \
  --market-fee-pool 0x4d3da2…0bba08f9 \
  # plus any auto-sell-* fall-through config
```

| Flag | Meaning |
|---|---|
| `--auto-fill-bid-floor-mist N` | Minimum acceptable bid price in MIST/unit. `0` disables auto-fill. |
| `--market-fee-pool 0x…` | Shared `MarketFeePool` object ID. Required because `fill_buy_order` takes `&MarketFeePool`. |

### Sidecar log

When a bid above floor matches:

```
INFO Auto-fill matched: <digest>
  (filled 8500 units @ 1180 MIST/unit on order 0x9c5a…0e3f)
```

When no bid meets the floor, the line is absent and the sidecar quietly
falls through to whichever auto-sell mode is configured.

### Why you'd choose it over Mode 2

- Better fills when the orderbook has aggressive bids above your floor:
  you take the bid's price (which is at or above your floor) instead of
  waiting at your own price.
- Zero resting-order management on the day-to-day side: no cancel
  sweeps, no `update_*_price` calls — fills are immediate or don't
  happen.
- The trade-off: no upside. You always sell at the bid's price even if
  your fixed floor would have priced higher.

### Caveats

- **One fill per batch.** The current loop hits the highest-priced
  matching bid only. If you have leftover inventory it carries to the
  next batch (or the auto-sell fall-through posts it as a resting ask).
- **Event-scan ceiling.** We walk the last 100 `BuyOrderPlaced` events;
  if the orderbook has more than ~100 active bids across all coin
  types, deeper bids may not be seen on a given batch. For testnet
  this is way more than enough.

---

## Dynamic price adjustment

The Move layer ships the full surface for repricing orders without
cancel-and-replace:

| Move function | What it does |
|---|---|
| `place_buy_order(price, expires, payment, ctx)` | Open a new resting bid. |
| `place_sell_order(price, expires, inventory, ctx)` | Open a new resting ask. |
| `update_buy_order_price(order, new_price, ctx)` | Buyer-only. Repricing keeps budget and inventory intact, just changes price. |
| `update_sell_order_price(order, new_price, ctx)` | Seller-only. Same — keeps inventory, changes price. |
| `top_up_buy_order(order, payment)` | Add more `Coin<SUI>` to a bid's budget without changing price. |
| `top_up_sell_order(order, inventory)` | Add more `Coin<HS_NNN>` to an ask's inventory without changing price. |
| `cancel_buy_order(order, ctx)` | Buyer-only. Refunds remaining budget. |
| `cancel_sell_order(order, ctx)` | Seller-only. Refunds remaining inventory. |

### Pattern A — Manual repricing from the dapp

Today the `/marketplace` "your open orders" list supports **cancel**.
Adding **reprice** is a one-hook addition that builds a PTB calling
`update_sell_order_price` — same shape as the existing cancel handler
in
[`web/components/market/OrderBookSidebar.tsx:115`](../web/components/market/OrderBookSidebar.tsx).
Status: ⚪ UI work pending. The Move primitive is live and callable
directly via `sui client ptb` today.

### Pattern B — Sidecar peg-to-mid

Shipped as **Mode 2b** above. See [Mode 2b](#mode-2b--auto-sell-peg-to-market)
for the full flag set, behaviour, and log lines. Status: ✓ shipped.

For more sophisticated strategies (grid market-making, EWMA-smoothed
mid, asymmetric bid/ask laddering), the
[`MystenLabs/deepbook-sandbox`](https://github.com/MystenLabs/deepbook-sandbox)
market-maker bot at `scripts/market-maker/` is the reference design.
Porting parts of its grid strategy into our `operator-bot` crate is the
right next step — keeps the sidecar lean and lets a dedicated process
run the full book.

### Pattern C — External keeper bot

The protocol doesn't care where the price update comes from — it only
cares that the tx is signed by the order owner. So a third-party
service (or your own off-chain script running on a cron) can watch
events and call `update_sell_order_price` on your behalf using a
delegated capability key, without any sidecar changes. This is how
production CEX market-makers operate; m1n3 inherits the pattern for
free.

---

## Picking a mode — decision matrix

```
Are you online and watching the market?
├── No → Mode 1 (verification only). Sell manually when you check.
└── Yes
    ├── Do you have a hard minimum price?
    │   ├── Yes → Mode 2 with --auto-sell-price-mist <floor>.
    │   │       Set the floor, walk away, check fills daily.
    │   └── No  → Wait for Mode 3 or run an external keeper bot.
    └── Are you running multiple ASICs across multiple wallets?
        ├── Yes → External keeper bot (Pattern C). One process
        │        repricing orders across all your wallets.
        └── No  → Mode 2 today + manual retarget via /marketplace.
```

---

## Operational checklist

Before flipping any auto-* flag in production, confirm:

1. **Gas budget.** Auto-sell PTBs are larger than plain share submits
   because they merge + split + place_sell. `--gas-budget 50000000`
   (~0.05 SUI per batch) is the tested default.
2. **MinerRoundRegistry is wired.** Without `--miner-round-registry
   <id>`, the sidecar runs in legacy mode and your MWR-per-round
   invariant isn't enforced — claims later will abort.
3. **HashShareRegistry is wired.** Without `--hashshare-registry <id>`
   the slot-watcher can't hot-swap the mint config, so auto-sell will
   never fire (no `Coin<HS_NNN>` to sell).
4. **Slot is bound to the round.** First share of every new round
   advances the FIFO. If no share has landed against the current round
   yet, call `hash_share_registry::bind_slot_to_round(<round>)` from any
   account once — it's idempotent.

---

## Where this fits in the codebase

| Component | What it does |
|---|---|
| [`miner-sidecar/src/main.rs`](../miner-sidecar/src/main.rs) | CLI parsing — the `--auto-sell-*` flags. |
| [`miner-sidecar/src/stratum_proxy.rs`](../miner-sidecar/src/stratum_proxy.rs) | After each batch's `submit_batch` confirms, calls `sender.auto_sell_minted()`. |
| [`sui-client/src/lib.rs`](../sui-client/src/lib.rs) | `AutoSellConfig`, `auto_sell_minted()`. Builds the merge-split-place_sell_order PTB. |
| [`contracts/sources/hash_share_market.move`](../contracts/sources/hash_share_market.move) | All `place_*` / `fill_*` / `update_*_price` / `cancel_*` / `top_up_*` primitives. |
| [`web/components/market/OrderBookSidebar.tsx`](../web/components/market/OrderBookSidebar.tsx) | "Your open orders" list with cancel. Reprice UI lives here when added. |
| [`web/components/market/DeepBookSwapPanel.tsx`](../web/components/market/DeepBookSwapPanel.tsx) | DeepBookV3 limit-order panel for the non-SUI quotes. BalanceManager onboarding + place/cancel via the SDK. |

If you wire any of the roadmap items above, please update this doc and
flip the ⚪ to ✓.
