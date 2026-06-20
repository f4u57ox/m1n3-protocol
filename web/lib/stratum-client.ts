// Types and fetch helpers for the local stratum server metrics endpoint.

const STRATUM_METRICS = "http://localhost:9091/metrics";

export interface StratumMiner {
  worker: string;
  hashrate_ths: number;
  difficulty: number;
  shares_submitted: number;
  last_share_secs_ago: number;
}

export interface StratumTemplate {
  job_id: string;
  height: number;
  branches: number;
  version: number;
  nbits: string;
  ntime: number;
  age_secs: number;
}

export interface StratumShare {
  worker: string;
  job_id: string;
  hash: string;
  difficulty: number;
  accepted: boolean;
  is_block: boolean;
  secs_ago: number;
}

export interface StratumMetrics {
  miners_connected: number;
  global_difficulty: number;
  shares_accepted_total: number;
  shares_rejected_total: number;
  estimated_pool_hashrate_ths: number;
  last_template_secs_ago: number;
  uptime_secs: number;
  miners: StratumMiner[];
  current_template: StratumTemplate | null;
  recent_shares: StratumShare[];
}

export async function fetchStratumMetrics(): Promise<StratumMetrics | null> {
  try {
    const res = await fetch(STRATUM_METRICS, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as StratumMetrics;
  } catch {
    return null;
  }
}
