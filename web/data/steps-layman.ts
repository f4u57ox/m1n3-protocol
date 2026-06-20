/**
 * Layman-language version of the 12 pipeline steps used on /info.
 *
 * Same Step shape as `data/steps.ts` — same ids (so the diagrams in
 * StepDiagram still pair correctly), same indices, but the prose is
 * written for someone who has never heard of an MPC committee or seen
 * a Move function. Technical detail lives in /docs/protocol/.
 */
import type { Step } from "./steps";

export const LAYMAN_STEPS: Step[] = [
  {
    id: "template",
    index: "01",
    chapter: "Mining",
    title: "The pool publishes a Bitcoin job",
    lede: "Before anyone can mine, the pool needs to say what to mine on.",
    paragraphs: [
      "A miner doesn't pick what to mine — the pool does. It pulls the next \"job\" (a candidate Bitcoin block) from a Bitcoin node and publishes it on Sui.",
      "Once published, that job is locked. Nobody — not even the pool operator — can change it after the fact. Miners can grab it and start hashing against the same target everyone else is hashing against.",
    ],
    who: "The pool operator",
    move: "It's the only step where the operator still has special powers.",
  },
  {
    id: "submit",
    index: "02",
    chapter: "Mining",
    title: "Your miner submits a share",
    lede: "Your ASIC found a hash close to the target. Now it gets recorded on Sui.",
    paragraphs: [
      "Standard mining hardware (a cgminer, BitAxe, Avalon Nano — whatever you have) talks to a tiny program called a sidecar. The sidecar speaks the normal Stratum protocol so your miner doesn't need to know about Sui.",
      "Every time the pool accepts a share, the sidecar bundles it into a transaction and signs it with your own Sui wallet. That signature is the proof that this share is yours — not the pool's word, your signature.",
    ],
    who: "You (the miner) — automated by a small sidecar",
    move: "No operator involvement.",
  },
  {
    id: "validate",
    index: "03",
    chapter: "Mining",
    title: "Sui checks the math",
    lede: "On-chain verification — no operator can fudge whether your share counts.",
    paragraphs: [
      "The Sui blockchain itself takes the share, rebuilds the Bitcoin block header, runs SHA-256 twice (the same hash Bitcoin uses), and checks whether the result is below the share target.",
      "If yes, your share is recorded with the difficulty you just demonstrated. If by some chance the hash also clears the *block* target, the chain also writes down \"hey, this address found a real Bitcoin block.\" That note becomes the key to claiming the reward later.",
    ],
    who: "The Sui chain itself",
    move: "Nobody can override the math.",
  },
  {
    id: "block-found",
    index: "04",
    chapter: "Settlement",
    title: "A block is found",
    lede: "A proof-of-finding gets locked in. This is the key to everything that follows.",
    paragraphs: [
      "When a share clears Bitcoin's real network target, Sui creates a permanent, frozen record: \"This round, this height, this address found the block.\"",
      "That record is the only key the next steps will accept. The pool operator can't fake it, can't redirect attribution, can't pay yesterday's miners for today's block. Whoever signed the lucky share is on record forever.",
    ],
    who: "The Sui chain itself",
    move: "Cryptographically tied to the miner who found it.",
  },
  {
    id: "accumulator",
    index: "05",
    chapter: "Settlement",
    title: "The round opens for tally",
    lede: "Anyone can press the button. The chain checks the receipt.",
    paragraphs: [
      "With a block now found, the round needs to be tallied — who did how much work? Anyone can kick this off (a bot, another miner, you). The chain demands they present the proof-of-finding from step 4. If it's real, the round opens.",
      "Each miner then submits their own tally — \"here's how much work I did this round\" — backed by the share receipts the chain wrote in step 2.",
    ],
    who: "Anyone — usually an automated keeper",
    move: "No operator needed.",
  },
  {
    id: "finalize",
    index: "06",
    chapter: "Settlement",
    title: "The round closes",
    lede: "After a short window, the totals are locked.",
    paragraphs: [
      "Once a few minutes have passed and miners have had time to submit their tallies, anyone can finalize the round. The chain writes down a permanent record of total work done.",
      "From here, the share weights for this round are immutable. No off-chain spreadsheet exists. No operator can re-allocate.",
    ],
    who: "Anyone",
    move: "Time-gated, then permissionless.",
  },
  {
    id: "hashi-deposit",
    index: "07",
    chapter: "Bridge",
    title: "BTC gets bridged to Sui",
    lede: "The actual bitcoin reward needs to come over from Bitcoin's chain.",
    paragraphs: [
      "Bitcoin is on Bitcoin. Sui is on Sui. To pay miners on Sui, the BTC has to cross over. m1n3 uses Hashi, a trustless bridge run by a committee of independent validators.",
      "The operator sends the coinbase to a special Bitcoin address that Hashi controls. They register that transaction on Sui along with the proof-of-finding from step 4. The chain only accepts the registration if everything lines up.",
    ],
    who: "The operator off-chain + automation on-chain",
    move: "Operator picks the UTXO, chain verifies it matches the block.",
  },
  {
    id: "hashi-confirm",
    index: "08",
    chapter: "Bridge",
    title: "Hashi's committee approves",
    lede: "Once Bitcoin has confirmed it, HBTC appears on Sui.",
    paragraphs: [
      "Hashi's committee watches the Bitcoin chain. After enough confirmations they all sign off — and HBTC (a Sui token representing the BTC) appears in a shared vault on Sui.",
      "The vault is shared on-chain. No single party — including m1n3 — can drain it on their own. Funds only leave when the next step's conditions are met.",
    ],
    who: "Hashi's independent committee",
    move: "External to m1n3 — but transparent.",
  },
  {
    id: "fund-batch",
    index: "09",
    chapter: "Payout",
    title: "The reward batch funds",
    lede: "The exact amount from Bitcoin transfers into a payout batch for this round.",
    paragraphs: [
      "Anyone can call the funding step. The chain requires three things to line up: the round's tally (from step 6), the bridged deposit (from step 8), and a match between them. Only then is the batch funded.",
      "Crucially, it takes exactly what came in from Bitcoin — not a penny more, not a penny less. Multi-round accounting stays clean.",
    ],
    who: "Anyone — usually an automated keeper",
    move: "Permissionless and exact.",
  },
  {
    id: "hashshare-mint",
    index: "10",
    chapter: "Liquidity",
    title: "Each share becomes a tradeable coin",
    lede: "The moment your share is accepted, you get a Coin in your wallet.",
    paragraphs: [
      "In the same transaction as step 2, your share also mints a HashShare coin — a token representing your contribution to this specific round. It lands directly in your wallet, no claim needed.",
      "A tiny protocol fee (1%) is taken automatically. The rest is yours. You can hold it, sell it, swap it, lend against it — it's a normal Sui token.",
    ],
    who: "You (the miner) — automated by the sidecar",
    move: "Same transaction as the share submission.",
  },
  {
    id: "deepbook",
    index: "11",
    chapter: "Liquidity",
    title: "Markets open instantly",
    lede: "Your shares are listed on a real order-book the moment they exist.",
    paragraphs: [
      "When the round opens, m1n3 also registers a market on DeepBook — Sui's native order-book exchange. Now anyone can buy or sell your round's HashShares against SUI.",
      "Sell now and lock in your earnings before the round even closes. Or hold and wait for the bigger reward payout. The choice is yours — every round.",
    ],
    who: "Anyone",
    move: "Sui-native order-book, real trading.",
  },
  {
    id: "claim",
    index: "12",
    chapter: "Payout",
    title: "Each miner claims their share",
    lede: "Your work record turns into BTC. Proportional to what you contributed.",
    paragraphs: [
      "When the batch is funded (step 9), each miner uses their work record from step 5 to claim their slice. The split is proportional: you did 5% of the work, you get 5% of the reward.",
      "Claims can happen in parallel — your claim doesn't block anyone else's, and no one's claim blocks yours. Anything unclaimed after the window recycles back to the vault, never to the operator.",
    ],
    who: "Each miner — directly from their wallet",
    move: "Permissionless and parallelizable.",
  },
];
