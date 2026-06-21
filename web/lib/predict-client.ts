/**
 * Predict server REST client (testnet).
 *
 * The Predict indexer at `predict-server.testnet.mystenlabs.com` is the
 * canonical low-latency render backend per the protocol README; on-chain
 * reads should only be used for confirmation-critical state, never for
 * routine list/query. This client wraps the endpoints we need for the
 * /hedge flow.
 *
 * Strikes and spot are integers scaled by 1e9 — so `spot = 63775942864337`
 * means **$63,775.94**. Use the `STRIKE_SCALAR` constant when converting
 * back and forth for display.
 */

import { activePredictConfig } from './predict-constants';

export const STRIKE_SCALAR = 1_000_000_000; // 1e9 — Predict's u64 strike scaling

// ── Types ────────────────────────────────────────────────────────────────────

export interface PredictOracleSummary {
  predict_id: string;
  oracle_id: string;
  oracle_cap_id: string;
  underlying_asset: string;
  expiry: number; // Unix ms
  min_strike: number; // raw u64, scaled by STRIKE_SCALAR
  tick_size: number; // raw u64, scaled by STRIKE_SCALAR
  status: 'active' | 'settled' | 'compacted' | string;
  activated_at: number;
  settlement_price: number | null;
  settled_at: number | null;
  created_checkpoint: number;
}

export interface PredictPriceEvent {
  oracle_id: string;
  spot: number; // raw u64, scaled by STRIKE_SCALAR
  forward: number; // raw u64, scaled by STRIKE_SCALAR
  onchain_timestamp: number;
  checkpoint_timestamp_ms: number;
}

export interface PredictSviEvent {
  oracle_id: string;
  /// Raw SVI total-variance parameterization params (all integers, see
  /// the predict source `oracle.move` for the scaling).
  a: number;
  b: number;
  rho: number;
  rho_negative: boolean;
  m: number;
  m_negative: boolean;
  sigma: number;
  onchain_timestamp: number;
}

export interface PredictOracleState {
  oracle: PredictOracleSummary;
  latest_price: PredictPriceEvent | null;
  latest_svi: PredictSviEvent | null;
  ask_bounds: unknown | null;
}

export interface PredictManagerSummary {
  manager_id: string;
  owner: string;
  predict_id?: string;
  /// Quote-asset balances held inside this manager, keyed by coin type tag.
  quote_balances?: Record<string, string>;
}

export interface PredictPositionsSummary {
  manager_id: string;
  positions: Array<{
    oracle_id: string;
    strike: number;
    is_up: boolean;
    quantity: string;
  }>;
  ranges: Array<{
    oracle_id: string;
    lower_strike: number;
    higher_strike: number;
    quantity: string;
  }>;
}

// ── Client ──────────────────────────────────────────────────────────────────

class PredictServerError extends Error {
  constructor(public status: number, public path: string, public body: string) {
    super(`predict-server ${status} on ${path}: ${body.slice(0, 200)}`);
  }
}

async function fetchPredict<T>(path: string): Promise<T> {
  const cfg = activePredictConfig();
  if (!cfg) {
    throw new Error(
      'DeepBook Predict is not deployed on this network; switch the dapp to testnet.',
    );
  }
  const url = `${cfg.serverBaseUrl}${path}`;
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) {
    const body = await r.text();
    throw new PredictServerError(r.status, path, body);
  }
  return (await r.json()) as T;
}

// ── Endpoint wrappers (only the ones the /hedge flow uses) ──────────────────

export async function getServerStatus(): Promise<{
  status: string;
  latest_onchain_checkpoint: number;
  current_time_ms: number;
}> {
  return fetchPredict('/status');
}

/**
 * List every oracle the active Predict instance carries. Sorted ascending by
 * expiry. Use `filterActiveBtcOracles` to narrow to the BTC sub-hour markets.
 */
export async function listPredictOracles(): Promise<PredictOracleSummary[]> {
  const cfg = activePredictConfig();
  if (!cfg) throw new Error('Predict not configured for this network');
  return fetchPredict<PredictOracleSummary[]>(
    `/predicts/${cfg.predictObjectId}/oracles`,
  );
}

export function filterActiveBtcOracles(
  oracles: PredictOracleSummary[],
): PredictOracleSummary[] {
  const now = Date.now();
  return oracles
    .filter(
      (o) =>
        o.status === 'active' &&
        o.underlying_asset === 'BTC' &&
        o.expiry > now,
    )
    .sort((a, b) => a.expiry - b.expiry);
}

export async function getOracleState(oracleId: string): Promise<PredictOracleState> {
  return fetchPredict<PredictOracleState>(`/oracles/${oracleId}/state`);
}

export async function getOracleSviLatest(
  oracleId: string,
): Promise<PredictSviEvent | null> {
  try {
    return await fetchPredict<PredictSviEvent>(`/oracles/${oracleId}/svi/latest`);
  } catch (e) {
    if (e instanceof PredictServerError && e.status === 404) return null;
    throw e;
  }
}

export async function getOraclePriceLatest(
  oracleId: string,
): Promise<PredictPriceEvent | null> {
  try {
    return await fetchPredict<PredictPriceEvent>(
      `/oracles/${oracleId}/prices/latest`,
    );
  } catch (e) {
    if (e instanceof PredictServerError && e.status === 404) return null;
    throw e;
  }
}

/**
 * Look up the user's manager by owner address. Predict's server supports
 * `?owner=` on the managers endpoint per the README hint; falls back to
 * scanning if not. Returns `null` when the user has no manager yet.
 */
export async function findManagerForOwner(
  owner: string,
): Promise<PredictManagerSummary | null> {
  try {
    const list = await fetchPredict<PredictManagerSummary[]>(
      `/managers?owner=${owner}`,
    );
    return list[0] ?? null;
  } catch (e) {
    if (e instanceof PredictServerError && e.status === 404) return null;
    throw e;
  }
}

export async function getManagerPositionsSummary(
  managerId: string,
): Promise<PredictPositionsSummary> {
  return fetchPredict<PredictPositionsSummary>(
    `/managers/${managerId}/positions/summary`,
  );
}

// ── Unit conversion helpers ─────────────────────────────────────────────────

/** Raw scaled u64 → display USD (e.g. spot 63775942864337 → 63775.94). */
export function strikeToUsd(raw: number | string): number {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return n / STRIKE_SCALAR;
}

/** Display USD → raw scaled u64 suitable for `RangeKey`. */
export function usdToStrike(usd: number): number {
  return Math.round(usd * STRIKE_SCALAR);
}

/**
 * Reconstruct the SVI total-variance value `w(k)` at log-moneyness `k`,
 * given the raw integer SVI params returned by the indexer. Per the
 * protocol's `oracle.move` source the SVI params are scaled by
 * `FLOAT_SCALING = 1e9` (same scaling as strikes/spot/forward).
 */
export function sviTotalVariance(
  k: number,
  s: Pick<PredictSviEvent, 'a' | 'b' | 'rho' | 'rho_negative' | 'm' | 'm_negative' | 'sigma'>,
): number {
  const SCALE = 1_000_000_000; // 1e9 — FLOAT_SCALING per packages/predict/sources/oracle.move
  const a = s.a / SCALE;
  const b = s.b / SCALE;
  const rho = (s.rho_negative ? -s.rho : s.rho) / SCALE;
  const m = (s.m_negative ? -s.m : s.m) / SCALE;
  const sigma = s.sigma / SCALE;
  const km = k - m;
  return a + b * (rho * km + Math.sqrt(km * km + sigma * sigma));
}

/**
 * Implied vol (annualized, lognormal Black-Scholes) at moneyness `k`,
 * given time-to-expiry `tauYears`. Computed from total variance.
 */
export function sviImpliedVol(
  k: number,
  s: Pick<PredictSviEvent, 'a' | 'b' | 'rho' | 'rho_negative' | 'm' | 'm_negative' | 'sigma'>,
  tauYears: number,
): number {
  if (tauYears <= 0) return 0;
  const w = sviTotalVariance(k, s);
  return Math.sqrt(Math.max(w, 0) / tauYears);
}
