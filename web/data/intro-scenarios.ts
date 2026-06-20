import { computeTheoreticalValue } from "@/lib/hashprice-utils";

// Share difficulty chosen so baseline PPS ~ $1.00 for readable chart values.
// Percentage changes are identical regardless of share difficulty.
export const SHARE_DIFF = 355_555_556;

export type Sentiment = "bullish" | "bearish" | "recovery";

export interface ScenarioState {
  networkDifficulty: number;
  btcPrice: number;
  blockSubsidy: number;
}

export interface ScenarioKeyframe extends ScenarioState {
  t: number; // 0-1 normalized time within scenario
}

export interface IntroScenario {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  sentiment: Sentiment;
  icon: string;
  keyframes: ScenarioKeyframe[];
  metrics: { diffChange: string; btcChange: string; ppsChange: string };
  durationMs: number;
}

export interface ChartDataPoint {
  time: number; // ms from animation start
  pps: number;
  networkDifficulty: number;
  btcPrice: number;
  scenarioIndex: number;
}

// ---- Easing ----

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// ---- Interpolation ----

export function interpolateScenario(
  scenario: IntroScenario,
  progress: number,
): ScenarioState {
  const t = easeInOutCubic(Math.max(0, Math.min(1, progress)));
  const kfs = scenario.keyframes;

  let lo = kfs[0];
  let hi = kfs[kfs.length - 1];
  for (let i = 0; i < kfs.length - 1; i++) {
    if (t >= kfs[i].t && t <= kfs[i + 1].t) {
      lo = kfs[i];
      hi = kfs[i + 1];
      break;
    }
  }

  const segT = hi.t === lo.t ? 1 : (t - lo.t) / (hi.t - lo.t);

  return {
    networkDifficulty:
      lo.networkDifficulty +
      (hi.networkDifficulty - lo.networkDifficulty) * segT,
    btcPrice: lo.btcPrice + (hi.btcPrice - lo.btcPrice) * segT,
    blockSubsidy: lo.blockSubsidy + (hi.blockSubsidy - lo.blockSubsidy) * segT,
  };
}

export function computeScenarioPpsValue(state: ScenarioState): number {
  return computeTheoreticalValue(
    SHARE_DIFF,
    state.networkDifficulty,
    state.blockSubsidy * state.btcPrice,
  );
}

// ---- Boundary helpers ----

export function getScenarioBoundaries(scenarios: IntroScenario[]): number[] {
  const b = [0];
  let acc = 0;
  for (const s of scenarios) {
    acc += s.durationMs;
    b.push(acc);
  }
  return b;
}

export function getTotalDuration(scenarios: IntroScenario[]): number {
  return scenarios.reduce((s, sc) => s + sc.durationMs, 0);
}

// ---- Keyframe builder ----

function kf(start: ScenarioState, end: ScenarioState): ScenarioKeyframe[] {
  return [
    { t: 0, ...start },
    { t: 1, ...end },
  ];
}

// ---- Chained scenario states ----
// Each scenario's start = previous scenario's end

const S0: ScenarioState = {
  networkDifficulty: 100e12,
  btcPrice: 90_000,
  blockSubsidy: 3.125,
};
const S1: ScenarioState = {
  networkDifficulty: 75e12,
  btcPrice: 90_000,
  blockSubsidy: 3.125,
};
const S2: ScenarioState = {
  networkDifficulty: 67.5e12,
  btcPrice: 90_000,
  blockSubsidy: 3.125,
};
const S3: ScenarioState = {
  networkDifficulty: 67.5e12,
  btcPrice: 130_000,
  blockSubsidy: 3.125,
};
const S4: ScenarioState = {
  networkDifficulty: 57.375e12,
  btcPrice: 169_000,
  blockSubsidy: 3.125,
};
const S5: ScenarioState = {
  networkDifficulty: 68.85e12,
  btcPrice: 169_000,
  blockSubsidy: 3.125,
};
const S6: ScenarioState = {
  networkDifficulty: 68.85e12,
  btcPrice: 55_770,
  blockSubsidy: 3.125,
};
const S7: ScenarioState = {
  networkDifficulty: 68.85e12,
  btcPrice: 55_770,
  blockSubsidy: 1.5625,
};
const S8: ScenarioState = {
  networkDifficulty: 50.26e12,
  btcPrice: 91_460,
  blockSubsidy: 1.5625,
};

export const BASELINE_PPS = computeScenarioPpsValue(S0);
export const BASELINE_DIFF = S0.networkDifficulty;
export const BASELINE_BTC = S0.btcPrice;

export const INTRO_SCENARIOS: IntroScenario[] = [
  {
    id: "hashrate-exodus",
    title: "Hashrate Exodus",
    subtitle: "25% of miners forced offline",
    description:
      "A wave of miners are forced to shut down operations — whether by regulation, energy costs, or infrastructure failure. Network difficulty drops 25% as hashrate goes offline. Each remaining share captures a larger slice of block rewards.",
    sentiment: "bullish",
    icon: "\u{1F6AB}",
    keyframes: kf(S0, S1),
    metrics: { diffChange: "-25%", btcChange: "0%", ppsChange: "+33%" },
    durationMs: 9_000,
  },
  {
    id: "grid-disruption",
    title: "Grid Disruption",
    subtitle: "Power failures take more miners offline",
    description:
      "Widespread power outages knock additional mining operations offline. Miners who need to unwind their positions can sell shares instantly on the marketplace rather than wait. Difficulty drops another 10%, boosting remaining share values.",
    sentiment: "bullish",
    icon: "\u{1F328}\u{FE0F}",
    keyframes: kf(S1, S2),
    metrics: { diffChange: "-10%", btcChange: "0%", ppsChange: "+11%" },
    durationMs: 8_000,
  },
  {
    id: "btc-rally",
    title: "BTC Rally",
    subtitle: "Bitcoin price surges 44%",
    description:
      "Strong market demand drives a 44% Bitcoin price increase. Since block rewards are denominated in BTC, the rally directly translates to 44% higher share values.",
    sentiment: "bullish",
    icon: "\u{1F680}",
    keyframes: kf(S2, S3),
    metrics: { diffChange: "0%", btcChange: "+44%", ppsChange: "+44%" },
    durationMs: 8_000,
  },
  {
    id: "compounding-bull",
    title: "Compounding Bull",
    subtitle: "Difficulty drops while BTC rallies",
    description:
      "The ideal scenario: difficulty falls 15% as inefficient miners shut down and exit, while BTC climbs 30%. Both factors compound, pushing PPS up 53%.",
    sentiment: "bullish",
    icon: "\u26A1",
    keyframes: kf(S3, S4),
    metrics: { diffChange: "-15%", btcChange: "+30%", ppsChange: "+53%" },
    durationMs: 9_000,
  },
  {
    id: "hashrate-surge",
    title: "Hashrate Surge",
    subtitle: "New capacity floods the network",
    description:
      "A surge of new mining capacity comes online, increasing network hashrate by 20%. More competition means each share's slice of block rewards shrinks.",
    sentiment: "bearish",
    icon: "\u{1F527}",
    keyframes: kf(S4, S5),
    metrics: { diffChange: "+20%", btcChange: "0%", ppsChange: "-17%" },
    durationMs: 8_000,
  },
  {
    id: "btc-correction",
    title: "BTC Correction",
    subtitle: "Bitcoin price drops 67%",
    description:
      "A sharp market downturn sends Bitcoin tumbling 67%. PPS mirrors the decline since block rewards are denominated in BTC. Miners who need to exit can still sell shares instantly rather than hold depreciating positions.",
    sentiment: "bearish",
    icon: "\u{1F4C9}",
    keyframes: kf(S5, S6),
    metrics: { diffChange: "0%", btcChange: "-67%", ppsChange: "-67%" },
    durationMs: 9_000,
  },
  {
    id: "halving",
    title: "Halving Event",
    subtitle: "Block rewards cut in half",
    description:
      "The Bitcoin halving cuts block rewards in half. PPS drops 50% overnight \u2014 the most predictable bearish event. Miners facing unprofitability can sell their shares on the marketplace rather than mine at a loss.",
    sentiment: "bearish",
    icon: "\u2702\u{FE0F}",
    keyframes: kf(S6, S7),
    metrics: { diffChange: "0%", btcChange: "0%", ppsChange: "-50%" },
    durationMs: 9_000,
  },
  {
    id: "equilibrium",
    title: "Market Equilibrium",
    subtitle: "Self-correcting dynamics restore value",
    description:
      "Bitcoin mining\u2019s game theory plays out: unprofitable miners exit (-27% difficulty), reduced supply drives BTC up 64%. PPS recovers 124%, returning to baseline.",
    sentiment: "recovery",
    icon: "\u2696\u{FE0F}",
    keyframes: kf(S7, S8),
    metrics: { diffChange: "-27%", btcChange: "+64%", ppsChange: "+124%" },
    durationMs: 10_000,
  },
];

// Precompute scenario start PPS values
export const SCENARIO_START_PPS = INTRO_SCENARIOS.map((sc) => {
  const state = interpolateScenario(sc, 0);
  return computeScenarioPpsValue(state);
});

// Recompute chart data up to a given time (for jump-to-scenario)
export function computeChartDataUpTo(upToMs: number): ChartDataPoint[] {
  const data: ChartDataPoint[] = [];
  const boundaries = getScenarioBoundaries(INTRO_SCENARIOS);
  const step = 333;

  for (let t = 0; t <= upToMs; t += step) {
    let scIdx = 0;
    for (let i = boundaries.length - 2; i >= 0; i--) {
      if (t >= boundaries[i]) {
        scIdx = Math.min(i, INTRO_SCENARIOS.length - 1);
        break;
      }
    }
    const localProgress = Math.min(
      1,
      (t - boundaries[scIdx]) / INTRO_SCENARIOS[scIdx].durationMs,
    );
    const state = interpolateScenario(INTRO_SCENARIOS[scIdx], localProgress);
    data.push({
      time: t,
      pps: computeScenarioPpsValue(state),
      networkDifficulty: state.networkDifficulty,
      btcPrice: state.btcPrice,
      scenarioIndex: scIdx,
    });
  }

  return data;
}
