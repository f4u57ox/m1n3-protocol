// m1n3 Dashboard TypeScript Interfaces

export interface TemplateData {
  id: string;
  height: number;
  prevBlockHash: string;
  coinbase1: string;
  coinbase2: string;
  merkleBranches: string[];
  version: number;
  nbits: number;
  ntime: number;
  isActive: boolean;
  owner: string;
  createdAtMs: number;
  shareCount: number;
  stakedAmount?: number;
  /** Sui tx digest that registered this Template (frozen object) on chain. */
  registrationDigest?: string;
  /** Sui tx digest of the most recent `ShareSubmitted` event referencing
   *  this template. Null when no share has landed against it yet. */
  lastShareDigest?: string;
}

export interface PoolData {
  totalShares: number;
  totalBlocks: number;
  currentRound: number;
  globalMinDifficulty: number;
  chainHeight: number;
  poolHashrate?: number;
  poolHashrateAvg?: number;
}

export interface StakingData {
  totalStaked: number;
  totalPositions: number;
  templateStakes: Record<string, TemplateStakeData>;
}

export interface TemplateStakeData {
  totalStaked: number;
  stakerCount: number;
}

export interface StakerPosition {
  amount: number;
  lastStakeTimeMs: number;
  unstakeRequestedMs: number;
}

export interface TemplateEvent {
  type:
    | 'template_created'
    | 'share_submitted'
    | 'share_validated'
    | 'batch_shares_validated'
    | 'block_found'
    | 'staked'
    | 'unstaked'
    | 'difficulty_reset';
  data: Record<string, unknown>;
  timestamp: number;
}

/** Parsed DifficultyReset event from on-chain. */
export interface DifficultyResetEvent {
  miner: string;
  oldDifficulty: number;
  newDifficulty: number;
  timeSinceLastShareMs: number;
  timestamp: number;
}

/** A share event (either ShareSubmitted or ShareValidated). */
export interface ShareEvent {
  miner: string;
  templateId: string;
  shareHash: string;
  difficultyAchieved: number;
  targetDifficulty: number;
  isBlock: boolean;
  timestampMs: number;
  txDigest: string;
  roundId?: number;
  /** 'full' for ShareSubmitted (NFT created), 'lightweight' for ShareValidated */
  mode: 'full' | 'lightweight';
}

export interface ConnectionStatus {
  rpc: boolean;
  websocket: boolean;
  lastUpdate: number;
}

// ---------------------------------------------------------------------------
// Block Registry & Bit-Level Fragmentation types (Phase 2)
// ---------------------------------------------------------------------------

/** A Bitcoin block registered on Sui via BlockHeaderRegistered event. */
export interface RegisteredBlock {
  height: number;
  blockHash: string;       // 32 bytes hex, big-endian display order
  parentHash: string;      // 32 bytes hex, internal byte order (from header bytes 4-35)
  timestamp: number;       // unix seconds (u32)
  chainWork: string;       // u256 as decimal string
  registeredAtMs: number;  // on-chain event timestamp
  txDigest: string;        // Sui transaction digest
}

/** On-chain commitment phase data from CommitmentOpened/ParticipantCommitted events. */
export interface RoundCommitment {
  blockHeight: number;
  participants: string[];   // Sui addresses that committed
  deadlineMs: number;       // commitment phase deadline
  finalized: boolean;
}

/** Bit assignment for a single participant after round finalization. */
export interface BitAssignment {
  participantAddress: string;
  bitOffset: number;
  bitCount: number;
}

/** A fragment submission from a FragmentSubmitted event (bit-level). */
export interface FragmentSubmission {
  blockHeight: number;
  fragmentIndex: number;
  submitter: string;       // Sui address
  bitOffset: number;
  bitCount: number;
  timestampMs: number;
}

/** Segment of the 80-byte block header (for byte map decomposition). */
export interface HeaderSegment {
  startByte: number;
  length: number;
  label: string;
  hex: string;
  source?: 'template' | 'miner';
  description: string;
}

/** Color assignment for a fragment submitter. */
export interface SubmitterColorAssignment {
  address: string;
  color: string;
  fragmentIndices: number[];
}

/** Layout of a single fragment within the 80-byte block header. */
export interface FragmentLayout {
  index: number;
  offset: number;   // byte offset into 80-byte header
  size: number;      // size in bytes
}

/** State of a single active block registration round (for live visualizer). */
export interface ActiveRound {
  blockHeight: number;
  phase: 'commitment' | 'finalization' | 'submission' | 'verified' | 'expired';
  participants: string[];
  commitDeadlineMs: number;
  numParticipants: number;
  bitsPerParticipant: number;
  assignments: BitAssignment[];
  submittedFragments: FragmentSubmission[];
  totalExpected: number;
  submissionDeadlineMs: number;
  rewardPerParticipant: number;
  openedAtMs: number;
}

// ---------------------------------------------------------------------------
// Miners
// ---------------------------------------------------------------------------

export interface MinerStatsData {
  address: string;
  totalShares: number;
  blocksFound: number;
  registeredAtMs: number;
  currentRoundWork: number;
  currentRoundShares: number;
  /** Estimated hashrate in H/s, derived from recent share event difficulties */
  estimatedHashrate: number;
  /** Last share timestamp from events (not on-chain, since v4 removed this field) */
  lastShareTimeMs: number;
  /** Template ID the miner is currently mining on (from most recent share) */
  currentTemplateId?: string;
  /** Owner/creator of the template being mined */
  templateOwner?: string;
  /** Whether this miner is true solo (owns the template they mine) */
  isSoloMiner: boolean;
  /** Mining mode description */
  miningMode: 'solo' | 'pooled' | 'unknown';
}

// ---------------------------------------------------------------------------
// Rewards
// ---------------------------------------------------------------------------

export interface RewardRegistryData {
  totalBatches: number;
  totalSatsPaid: number;
  completedRounds: number;
}

export interface RewardBatchData {
  id: string;
  roundId: number;
  totalSats: number;
  minerCount: number;
  status: number;          // 0=PENDING, 1=SIGNING, 2=SIGNED, 3=BROADCAST, 4=CONFIRMED
  btcTxHash: string | null;
  createdAtMs: number;
  signingRequestedAtMs: number | null;
  signedAtMs: number | null;
  broadcastAtMs: number | null;
  confirmedAtMs: number | null;
}

export const REWARD_STATUS_LABELS: Record<number, string> = {
  0: 'Pending',
  1: 'Signing',
  2: 'Signed',
  3: 'Broadcast',
  4: 'Confirmed',
};

// ---------------------------------------------------------------------------
// Token (M1N3)
// ---------------------------------------------------------------------------

export interface M1N3TreasuryData {
  totalMinted: number;        // base units (8 decimals)
  treasuryId: string;
}

export interface TokenDistributionEntry {
  blockHeight: number;
  rewardAmount: number;
  participantCount: number;
  timestampMs: number;
}

// ---------------------------------------------------------------------------
// Marketplace
// ---------------------------------------------------------------------------

export interface ListingData {
  id: string;
  seller: string;
  price: number;
  blockHeight: number;
  templateId: string;
  isBlock: boolean;
  difficultyAchieved: number;
  workWeight: number;
  listedAtMs: number;
  isActive: boolean;
}

export interface MarketplaceStats {
  totalListings: number;
  totalSales: number;
  totalVolume: number;
  totalFeesCollected: number;
}

/** Extended marketplace stats including derived profitability metrics. */
export interface ExtendedMarketplaceStats extends MarketplaceStats {
  totalCanceled: number;
  fillRate: number;               // % of listings that sold (0-100)
  averageTimeToFillMs: number;    // average ms from listing to purchase
  averageDiscountPct: number;     // volume-weighted average discount
  uniqueSellers: number;
  uniqueBuyers: number;
  totalFeesDistributed: number;
}

/** A completed trade from ListingPurchased event. */
export interface TradeRecord {
  listingId: string;
  seller: string;
  buyer: string;
  price: number;                  // in MIST
  blockHeight: number;
  difficultyAchieved: number;
  templateId: string;
  isBlock: boolean;
  purchasedAtMs: number;
  listedAtMs: number;             // from cross-referencing ListingCreated
  timeToFillMs: number;           // purchasedAtMs - listedAtMs
  txDigest: string;
  feePaid: number;                // 2% of price
}

/** A listing cancellation from ListingCanceled event. */
export interface CancelRecord {
  listingId: string;
  seller: string;
  canceledAtMs: number;
  txDigest: string;
}

// ---------------------------------------------------------------------------
// Gas Cost Tracking
// ---------------------------------------------------------------------------

/** Gas cost data for a single transaction type. */
export interface GasCostEntry {
  txType: 'share_submit' | 'share_lightweight' | 'share_batch' | 'template_register' | 'template_update' | 'list_share' | 'buy_share';
  gasUsed: number;                // in MIST
  txDigest: string;
  timestampMs: number;
}

/** Aggregated gas cost statistics. */
export interface GasCostSummary {
  totalGasSpent: number;          // total MIST spent on gas
  avgGasPerShare: number;         // standard submit
  avgGasPerShareLightweight: number; // lightweight submit
  avgGasPerBatch: number;         // batch submit
  avgGasPerTemplateTx: number;    // register + update average
  shareSubmitCount: number;
  lightweightSubmitCount: number;
  batchSubmitCount: number;
}

// ---------------------------------------------------------------------------
// Staker APY & Token Economics
// ---------------------------------------------------------------------------

/** Staker yield metrics. */
export interface StakerYieldMetrics {
  /** Annual percentage yield: (annual_fees / total_staked) * 100 */
  apyPct: number;
  /** SUI earned per M1N3 token per day (in MIST) */
  dailyYieldPerToken: number;
  /** SUI earned per M1N3 token per month (in MIST) */
  monthlyYieldPerToken: number;
  /** SUI earned per M1N3 token per year (in MIST) */
  annualYieldPerToken: number;
  /** % of M1N3 supply that is staked */
  stakingUtilizationPct: number;
  /** Total fees distributed to stakers */
  totalFeesDistributed: number;
  /** Total M1N3 staked */
  totalStaked: number;
  /** Projected APY at 10x volume */
  projectedApy10x: number;
  /** Projected APY at 100x volume */
  projectedApy100x: number;
}

// ---------------------------------------------------------------------------
// Buyer / Arbitrageur Economics
// ---------------------------------------------------------------------------

/** Buyer yield and ROI metrics. */
export interface BuyerYieldMetrics {
  /** Annualized yield from discount arbitrage */
  annualizedYieldPct: number;
  /** Average discount at which shares trade */
  avgDiscountPct: number;
  /** Maturation time in hours (~16.7h for 100 blocks) */
  maturationHours: number;
  /** Historical ROI for buyers who held to maturation */
  historicalRoiPct: number;
  /** Number of completed trades in the sample */
  sampleSize: number;
}

// ---------------------------------------------------------------------------
// Pool Performance & Risk
// ---------------------------------------------------------------------------

/** Pool performance metrics. */
export interface PoolPerformanceMetrics {
  /** Luck factor: actual_blocks / expected_blocks (1.0 = exactly expected) */
  luckFactor: number;
  /** Average round duration in seconds */
  avgRoundDurationSec: number;
  /** Standard deviation of round duration */
  roundDurationStdDev: number;
  /** Expected round duration based on pool hashrate and network difficulty */
  expectedRoundDurationSec: number;
  /** Effective hashrate / reported hashrate ratio */
  efficiencyRatio: number;
  /** Number of rounds in the sample */
  roundsSampled: number;
}

// ---------------------------------------------------------------------------
// Platform Profitability
// ---------------------------------------------------------------------------

/** Platform-level profitability metrics. */
export interface PlatformProfitability {
  /** Net margin = total_fees - total_gas_costs (in MIST) */
  netMarginMist: number;
  /** Net margin percentage */
  netMarginPct: number;
  /** Total fees collected (in MIST) */
  totalFeesMist: number;
  /** Total gas costs (in MIST) */
  totalGasCostsMist: number;
  /** Average fee revenue per share traded (in MIST) */
  avgFeePerTrade: number;
  /** Average gas cost per share submitted (in MIST) */
  avgGasPerShare: number;
  /** Break-even daily volume in SUI */
  breakEvenDailyVolumeSol: number;
  /** Estimated daily infrastructure cost in SUI */
  dailyInfraCostSol: number;
}

/** Revenue projection at a given adoption level. */
export interface RevenueProjection {
  label: string;
  adoptionPct: number;            // % of global hashrate
  dailyHashratePh: number;
  dailySharesEstimate: number;
  dailyVolumeUsd: number;
  dailyFeesUsd: number;
  monthlyFeesUsd: number;
  annualFeesUsd: number;
  stakerApyPct: number;
}

/** TAM (Total Addressable Market) analysis. */
export interface TAMAnalysis {
  /** Daily BTC block rewards in BTC (~900 BTC/day post-halving) */
  dailyBlockRewardsBtc: number;
  /** Daily transaction fees in BTC */
  dailyTxFeesBtc: number;
  /** Total daily mining revenue in USD */
  dailyMiningRevenueUsd: number;
  /** m1n3 addressable portion (block rewards only, not fees) */
  addressableRevenueUsd: number;
  /** Current m1n3 capture rate */
  currentCaptureRatePct: number;
}

/** Miner cost-of-capital analysis. */
export interface CostOfCapitalAnalysis {
  /** Miner's annual cost of capital (APR) */
  costOfCapitalApr: number;
  /** Implied cost of waiting 100 blocks at this APR */
  impliedWaitingCostPct: number;
  /** Maximum rational discount a well-capitalized miner should accept */
  breakEvenDiscountPct: number;
  /** For a stressed miner (higher cost of capital), breakeven discount */
  stressedBreakEvenPct: number;
}

/** FPPS pool comparison entry. */
export interface FPPSComparison {
  poolName: string;
  feeRate: number;                // % fee charged (e.g. 2.0, 2.5, 4.0)
  payoutMethod: string;           // FPPS, PPS+, PPLNS
  payoutDelay: string;            // "24h", "100 blocks", etc.
  effectivePayoutRate: number;    // 1 - feeRate/100
  m1n3EquivalentDiscount: number; // discount at which m1n3 matches this pool
}

// ---------------------------------------------------------------------------
// Share Market (Order Book)
// ---------------------------------------------------------------------------

/** A buy order (bid) from BuyOrderPlaced event + object state. */
export interface BuyOrderData {
  id: string;
  buyer: string;
  templateProvider: string;
  difficultyRequested: number;
  difficultyFilled: number;
  pricePerDifficulty: number;
  totalEscrowed: number;
  isActive: boolean;
  createdAtMs: number;
}

/** A sell order (ask) from SellOrderPlaced event + object state. */
export interface SellOrderData {
  id: string;
  seller: string;
  templateProvider: string;
  templateId: string;
  difficulty: number;
  pricePerDifficulty: number;
  isActive: boolean;
  createdAtMs: number;
}

/** A completed trade from TradeExecuted event. */
export interface OrderBookTrade {
  buyOrderId: string;
  sellOrderId: string;
  buyer: string;
  seller: string;
  templateProvider: string;
  difficultyTraded: number;
  pricePerDifficulty: number;
  totalUsdc: number;
  feeAmount: number;
  timestampMs: number;
  txDigest: string;
}

/** Share market aggregate stats from registry object. */
export interface ShareMarketStats {
  totalBuyOrders: number;
  totalSellOrders: number;
  totalTrades: number;
  totalVolume: number;
  totalFeesCollected: number;
}

/** A single price level in the aggregated order book. */
export interface OrderBookLevel {
  pricePerDifficulty: number;
  totalDifficulty: number;
  orderCount: number;
  cumulativeDifficulty: number;
}

// ---------------------------------------------------------------------------
// Hashprice Visualization & Market Simulation
// ---------------------------------------------------------------------------

/** A listing enriched with theoretical value and discount information. */
export interface PricedShare {
  id: string;
  seller: string;
  difficultyAchieved: number;
  workWeight: number;
  blockHeight: number;
  templateId: string;
  isBlock: boolean;
  /** Theoretical value in USD based on hashprice and difficulty. */
  theoreticalValueUsd: number;
  /** Actual market listing price in USD. */
  marketPriceUsd: number;
  /** Discount from theoretical value (0–100). */
  discountPct: number;
  /** Blocks remaining until coinbase maturation (~100 blocks). */
  blocksUntilMature: number;
}

/** A single price level in the order book. */
export interface OrderBookEntry {
  price: number;
  hashratePh: number;
  cumulativePh: number;
  side: 'bid' | 'ask';
}

/** Full order book snapshot. */
export interface OrderBookData {
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
  spread: number;
  midpoint: number;
  lastTradePrice: number;
}

/** A simulated trade execution. */
export interface SimulatedTrade {
  price: number;
  hashratePh: number;
  side: 'buy' | 'sell';
  discountPct: number;
  timestampMs: number;
}

/** Parameters controlling the market simulation engine. */
export interface MarketSimulationParams {
  networkDifficulty: number;
  blockRewardUsd: number;
  averageDiscount: number;
  spreadBps: number;
  tradeFrequencyPerMin: number;
}

/** A point on the BTC vs Mining Shares comparison chart. */
export interface ComparisonPoint {
  timestampMs: number;
  elapsedSec: number;
  btcValue: number;
  miningShareValue: number;
}

/** A point on the discount-vs-maturation curve. */
export interface DiscountCurvePoint {
  blocksUntilMature: number;
  discountPct: number;
  theoreticalValue: number;
  marketPrice: number;
}

// ---------------------------------------------------------------------------
// Market History & Network Data
// ---------------------------------------------------------------------------

export interface MarketHistoryPoint {
  timestamp: number;        // unix ms
  btcPrice: number;         // USD
  networkHashrate: number;  // H/s
  hashprice: number;        // $/PH/day (derived)
}

export type MarketHistoryRange = '7d' | '30d' | '90d' | '1y';

export interface DifficultyAdjustment {
  timestamp: number;        // unix seconds
  difficulty: number;
  difficultyChange: number; // percentage
  height: number;
}
