/**
 * The 11 pipeline steps. The DiagramKey is keyed back to a switch in
 * `<StepDiagram>` so we can keep step copy data-driven while letting each
 * diagram be its own SVG component.
 */
export type StepKey =
  | "template"
  | "submit"
  | "validate"
  | "block-found"
  | "accumulator"
  | "finalize"
  | "hashi-deposit"
  | "hashi-confirm"
  | "fund-batch"
  | "hashshare-mint"
  | "deepbook"
  | "claim";

export type Step = {
  id: StepKey;
  index: string; // 01..11 - we count one extra (validate)
  /** Free-form chapter label — different step decks may bucket differently. */
  chapter: string;
  title: string;
  lede: string;
  paragraphs: string[];
  who: string;
  move: string;
};

export const STEPS: Step[] = [
  {
    id: "template",
    index: "01",
    chapter: "Mining",
    title: "Operator registers a block template",
    lede: "Pool operators publish frozen, signed Bitcoin block templates on Sui.",
    paragraphs: [
      "A pool operator pulls a block template from a Bitcoin full node, signs it, and calls `pool::register_template` with the `PoolAdminCap`. The template is frozen — its contents (version, prevhash, merkle commitment, nbits, ntime, coinbase scaffolding) can never change.",
      "Frozen templates are cheap to read in parallel: the share-submission hot path takes the template as `&Template` (immutable), so N miners can submit against the same template with zero consensus contention.",
      "This is the *only* part of the reward path that still requires the operator. Everything downstream is permissionless.",
    ],
    who: "Operator (with PoolAdminCap)",
    move: "pool::register_template",
  },
  {
    id: "submit",
    index: "02",
    chapter: "Mining",
    title: "Miner submits a share",
    lede: "Stratum v1 in, Sui transaction out — signed by the miner's own keypair.",
    paragraphs: [
      "Mining software (cgminer, BitAxe, an Avalon Nano) talks to a thin sidecar over Stratum v1. The sidecar relays jobs from the m1n3 stratum server and intercepts every `mining.submit`. When the upstream stratum says \"accepted,\" the sidecar bundles the share into a PTB and signs it with the miner's Sui keypair.",
      "The PTB calls `pool::submit_share` per share against three *owned* objects (`MinerStats`, `MinerRoundStats`, `ShareDedup`). Owned objects don't go through consensus, so different miners' submissions are embarrassingly parallel.",
      "Crucially: the operator never touches this PTB. The share is attributed to whoever signed the transaction — by construction, not by trust.",
    ],
    who: "Miner",
    move: "pool::submit_share",
  },
  {
    id: "validate",
    index: "03",
    chapter: "Mining",
    title: "On-chain share validation",
    lede: "Sui Move verifies the share hash without trusting anyone off-chain.",
    paragraphs: [
      "Inside `submit_share` the Move code reconstructs the 80-byte Bitcoin block header from the template + the miner's extranonce + nonce, runs SHA-256 twice, and checks the resulting hash against the pool's share target. There is no `accepted: bool` argument — the chain decides.",
      "Each verified share mints a `ShareReceipt` (round_id, miner, difficulty). On the rare share that also clears the *block* target, the same call freezes a `BlockFoundClaim { round_id, height, block_finder: tx_context::sender(ctx) }`.",
      "The block_finder is bound to the runtime sender of the PTB. The operator can't forge a claim under someone else's address.",
    ],
    who: "Sui Move runtime",
    move: "pool::submit_share (BTC math)",
  },
  {
    id: "block-found",
    index: "04",
    chapter: "Settlement",
    title: "Block found — proof gets frozen",
    lede: "A BlockFoundClaim becomes the only key that opens the round.",
    paragraphs: [
      "When a share clears the full network target, the `BlockFoundClaim` object is permanent and immutable. It carries the round_id, the block height, and the address that found the block.",
      "This is the cryptographic capability that replaces the operator's old godmode. Every downstream action (open accumulator, record on Hashi side, fund batch) reads this claim — they all assert the round_id and block_finder come from it, not from a parameter the caller chose.",
      "The operator can't fake a block, can't redirect attribution, can't pay yesterday's miners for today's block.",
    ],
    who: "Sui Move runtime",
    move: "pool::BlockFoundClaim (frozen object)",
  },
  {
    id: "accumulator",
    index: "05",
    chapter: "Settlement",
    title: "Anyone opens the round accumulator",
    lede: "Permissionless. No admin cap. The claim is the key.",
    paragraphs: [
      "Any address can call `pool::open_round_accumulator_from_claim(pool, &BlockFoundClaim, clock)`. The function asserts `claim.round_id == pool.current_round` and creates a shared `RoundAccumulator` for that round.",
      "The legacy admin-gated `open_round_accumulator` was deleted as part of the trustless cleanup. It is not coming back.",
      "Once the accumulator is shared, each miner can drain their `MinerRoundStats` into it by calling `accumulate_miner_stats`. This emits a per-miner `MinerWorkRecord` that they keep until claim time.",
    ],
    who: "Anyone (typically the trustless keeper)",
    move: "pool::open_round_accumulator_from_claim",
  },
  {
    id: "finalize",
    index: "06",
    chapter: "Settlement",
    title: "Round closes into a frozen history",
    lede: "After the accumulation window, the round becomes immutable.",
    paragraphs: [
      "After `ACCUMULATION_WINDOW_MS` has elapsed since the accumulator opened, anyone can call `pool::finalize_round`. This freezes a `RoundHistory { round_id, total_net_work, ... }` that all downstream payout logic reads from.",
      "Finalization is a one-shot — the accumulator object is consumed. From this point the round's share weights are fixed and shared on-chain. No off-chain spreadsheet ever existed.",
    ],
    who: "Anyone",
    move: "pool::finalize_round",
  },
  {
    id: "hashi-deposit",
    index: "07",
    chapter: "Settlement",
    title: "BTC is bridged through Hashi",
    lede: "Operator broadcasts a Bitcoin signet TX to the vault's derived P2TR.",
    paragraphs: [
      "The bitcoin coinbase reward needs to land on Sui as HBTC. The operator (or anyone holding the coins) sends a Bitcoin transaction to the P2TR address that Hashi has bound to this specific `HashiVault<BTC>` — derived from Hashi's `mpc_public_key` plus the vault UID via BIP-341.",
      "On Sui, `hashi_pool::record_block_found` is then called with the `BlockFoundClaim`, the bitcoin txid/vout, and the amount. The function is permissionless: it reads `round_id` and `block_finder` from the claim itself, so the operator can only register the UTXO that actually matches the block. Hashi's committee independently rejects approvals if the UTXO doesn't match.",
      "A shared `BlockDepositRecord` is created in the UNREGISTERED state and registered with Hashi.",
    ],
    who: "Operator off-chain + permissionless on-chain",
    move: "hashi_pool::record_block_found",
  },
  {
    id: "hashi-confirm",
    index: "08",
    chapter: "Settlement",
    title: "Hashi committee confirms",
    lede: "MPC validators sign off after Bitcoin gives them N confirmations.",
    paragraphs: [
      "Hashi's MPC committee monitors the signet UTXO. Once it has the required number of Bitcoin confirmations, they approve and then confirm the `BlockDepositRecord` on Sui. HBTC is minted into the shared `HashiVault<BTC>` in the same flow.",
      "The vault is a *shared* object. There is no owned-vault constructor in the package — only `hashi_vault::create_shared`. Owned vaults can't be drained by permissionless callers (`&mut` on owned objects needs the owner's signature), so allowing them would have been a trust footgun.",
      "Result: HBTC is now sitting in the vault, with the record CONFIRMED and round_id stamped on it.",
    ],
    who: "Hashi MPC committee",
    move: "hashi_pool::confirm",
  },
  {
    id: "fund-batch",
    index: "09",
    chapter: "Liquidity & payout",
    title: "Round batch funded — permissionless",
    lede: "The deposit record is the proof. The vault drains the exact amount.",
    paragraphs: [
      "Any address calls `hashi_rewards::open_and_fund_round_batch(registry, vault, round_history, deposit_record, clock)`. The function asserts the record's round_id matches the round_history, that the record is CONFIRMED, and that it isn't already funded.",
      "It then drains exactly `record.amount_sats` from the vault — not all the HBTC, just the bound amount — and creates a shared `HashiRewardBatch<BTC>` in the FUNDED state. The record is one-shot-marked as funded.",
      "This is the cleanup that closed audit finding C-1: the older fund path drained the whole vault, which would corrupt multi-round accounting.",
    ],
    who: "Anyone (trustless keeper)",
    move: "hashi_rewards::open_and_fund_round_batch",
  },
  {
    id: "hashshare-mint",
    index: "10",
    chapter: "Liquidity & payout",
    title: "Per-share HashShares mint to the miner",
    lede: "Every accepted share is also a Coin<HS_NNN> in the miner's wallet.",
    paragraphs: [
      "In the *same* PTB as `submit_share`, the miner-sidecar chains `hash_share_registry::bind_slot_to_round` and `hash_share::mint_share_to<T>`. The registry pre-publishes K one-time-witness coin types (HS_000, HS_001, …); the FIFO assigns one per round.",
      "`mint_share_to<T>` checks the per-round binding, takes a 1% protocol fee in the same Coin, and transfers the remainder to the miner. The result lands in the miner's wallet the same Sui transaction the share was accepted.",
      "No waiting. No claim. The HashShare is liquid the moment the share is accepted.",
    ],
    who: "Miner sidecar (signed by miner)",
    move: "hash_share::mint_share_to",
  },
  {
    id: "deepbook",
    index: "11",
    chapter: "Liquidity & payout",
    title: "HashShares trade on DeepBook",
    lede: "Every round's HashShare type is a permissionless DeepBookV3 pool.",
    paragraphs: [
      "When the registry binds a slot to a round, the trustless keeper observes the `SlotBoundToRound` event and creates a DeepBookV3 `Pool<HS_NNN, QUOTE>` via `create_permissionless_pool`. Price discovery starts the same block the round opens.",
      "Miners can sell their `Coin<HS_NNN>` immediately. Speculators can buy them. The pool is a regular DeepBook CLOB — orderbook, partial fills, market orders. m1n3 doesn't run a matcher; DeepBook does.",
      "Alongside DeepBook, m1n3 ships its own simple two-sided market (`hash_share_market`) for explicit BuyOrder / SellOrder objects. Either path works.",
    ],
    who: "Anyone",
    move: "deepbook::pool::create_permissionless_pool",
  },
  {
    id: "claim",
    index: "12",
    chapter: "Liquidity & payout",
    title: "Miner claims their slice of the batch",
    lede: "MinerWorkRecord in → Coin<BTC> out. Proportional to net work.",
    paragraphs: [
      "Each miner calls `hashi_rewards::claim_reward(registry, batch, my_mwr, round_history, clock)`. The PTB consumes the `MinerWorkRecord` (one-shot — the MinerRoundRegistry guarantees one MRR per round per miner), reads the round's total net_work, and pays out `record.net_work / total_net_work × batch.balance`.",
      "Multiple miners' claims can interleave in a single consensus round — the post-cleanup `claim_reward` removed the per-batch `Table<address, bool>` write, so the only shared mutation per claim is the balance split. Embarrassingly parallel by design.",
      "Unclaimed funds recycle back to the vault after the claim window — never to the operator.",
    ],
    who: "Miner",
    move: "hashi_rewards::claim_reward",
  },
];
