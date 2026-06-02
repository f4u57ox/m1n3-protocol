// Client-side Sui RPC fetching — used directly by hooks for static export.
// All values come from NEXT_PUBLIC_* env vars baked in at build time.

const SUI_RPC_URL  = process.env.NEXT_PUBLIC_SUI_RPC_URL  ?? 'https://fullnode.devnet.sui.io:443';
const POOL_OBJECT_ID = process.env.NEXT_PUBLIC_POOL_OBJECT_ID ?? '';
const PACKAGE_ID     = process.env.NEXT_PUBLIC_PACKAGE_ID     ?? '';

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(SUI_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message ?? JSON.stringify(json.error)}`);
  return json.result;
}

function parseBytes(v: unknown): number[] {
  if (Array.isArray(v)) return (v as unknown[]).map(Number);
  if (typeof v === 'string') {
    if (/^[0-9a-fA-F]+$/.test(v) && v.length % 2 === 0) {
      const arr: number[] = [];
      for (let i = 0; i < v.length; i += 2) arr.push(parseInt(v.slice(i, i + 2), 16));
      return arr;
    }
    try {
      const bin = atob(v);
      return Array.from(bin, c => c.charCodeAt(0));
    } catch { /* ignore */ }
  }
  return [];
}

function parseNestedBytes(v: unknown): number[][] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[]).map(parseBytes);
}

function bytesToHex(bytes: number[]): string {
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
}

function extractCoinbaseAscii(bytes: number[]): string {
  let offset = 0;
  if (bytes[0] === 0x03 && bytes.length > 4) offset = 4;
  const chars: string[] = [];
  for (let i = offset; i < bytes.length && chars.length < 48; i++) {
    const b = bytes[i];
    if (b >= 0x20 && b <= 0x7e) chars.push(String.fromCharCode(b));
    else if (chars.length >= 6) break;
  }
  return chars.join('').trim();
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface JobTemplate {
  jobId:          string;
  poolId:         string;
  operator:       string;
  prevHash:       string;
  coinbase1:      string;
  coinbaseAscii:  string;
  merkleBranches: string[];
  version:        string;
  nBits:          string;
  nTime:          string;
  createdEpoch:   string;
  timestampMs:    string;
  txDigest:       string;
}

export interface PoolStats {
  poolId:      string;
  operator:    string;
  totalShares: string;
  difficulty:  string;
}

export interface TemplatesResponse {
  jobs: JobTemplate[];
  pool: PoolStats;
}

export interface ShareEvent {
  poolId:      string;
  jobId:       string;
  worker:      string;
  nonce:       string;
  difficulty:  string;
  timestampMs: string;
  txDigest:    string;
}

export interface SharesResponse {
  shares: ShareEvent[];
}

// ── Fetchers ──────────────────────────────────────────────────────────────────

export async function fetchTemplates(): Promise<TemplatesResponse> {
  if (!POOL_OBJECT_ID) throw new Error('NEXT_PUBLIC_POOL_OBJECT_ID is not configured');

  const poolRes = await rpc('sui_getObject', [
    POOL_OBJECT_ID,
    { showContent: true, showOwner: true },
  ]) as Record<string, unknown>;

  const poolData    = (poolRes as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
  const poolContent = poolData?.content as Record<string, unknown> | undefined;
  const poolFields  = poolContent?.fields as Record<string, unknown> | undefined;
  if (!poolFields) throw new Error('Cannot read Pool object fields');

  const jobsNode      = poolFields.jobs as Record<string, unknown> | undefined;
  const jobsFields    = jobsNode?.fields as Record<string, unknown> | undefined;
  const jobsIdNode    = jobsFields?.id as Record<string, unknown> | undefined;
  const resolvedTableId: string = (jobsIdNode?.id as string) ?? '';

  const operator:    string = (poolFields.operator as string) ?? '';
  const totalShares: string = poolFields.total_shares?.toString() ?? '0';
  const difficulty:  string = poolFields.difficulty?.toString() ?? '512';

  const poolStats: PoolStats = { poolId: POOL_OBJECT_ID, operator, totalShares, difficulty };

  if (!resolvedTableId) return { jobs: [], pool: poolStats };

  const dynRes  = await rpc('suix_getDynamicFields', [resolvedTableId, null, 50]) as Record<string, unknown>;
  const entries = (dynRes?.data as unknown[]) ?? [];
  if (entries.length === 0) return { jobs: [], pool: poolStats };

  const fieldIds = (entries as Record<string, unknown>[]).map(e => e.objectId as string);
  const multiRes = await rpc('sui_multiGetObjects', [fieldIds, { showContent: true }]) as unknown[];

  const eventMap: Record<string, { timestampMs: string; txDigest: string }> = {};
  if (PACKAGE_ID) {
    try {
      const evRes = await rpc('suix_queryEvents', [
        { MoveEventType: `${PACKAGE_ID}::pool::JobPosted` },
        null, 50, false,
      ]) as Record<string, unknown>;
      for (const ev of ((evRes?.data as unknown[]) ?? [])) {
        const e      = ev as Record<string, unknown>;
        const parsed = e.parsedJson as Record<string, unknown> | undefined;
        const id     = parsed?.job_id?.toString();
        if (id) {
          const evId = e.id as Record<string, unknown> | undefined;
          eventMap[id] = {
            timestampMs: e.timestampMs?.toString() ?? '0',
            txDigest:    (evId?.txDigest as string) ?? '',
          };
        }
      }
    } catch { /* events are optional */ }
  }

  const jobs: JobTemplate[] = (multiRes as Record<string, unknown>[])
    .map(obj => {
      const objData   = obj?.data as Record<string, unknown> | undefined;
      const content   = objData?.content as Record<string, unknown> | undefined;
      const topFields = content?.fields as Record<string, unknown> | undefined;
      const value     = topFields?.value as Record<string, unknown> | undefined;
      const fields    = (value?.fields as Record<string, unknown>) ?? (value as Record<string, unknown>);
      if (!fields) return null;

      const jobId        = fields.job_id?.toString() ?? '0';
      const prevHashBytes = parseBytes(fields.prev_hash);
      const cb1Bytes      = parseBytes(fields.coinbase1);
      const branches      = parseNestedBytes(fields.merkle_branches);
      const ev            = eventMap[jobId] ?? { timestampMs: '0', txDigest: '' };

      return {
        jobId,
        poolId: POOL_OBJECT_ID,
        operator,
        prevHash:       bytesToHex(prevHashBytes),
        coinbase1:      bytesToHex(cb1Bytes),
        coinbaseAscii:  extractCoinbaseAscii(cb1Bytes),
        merkleBranches: branches.map(bytesToHex),
        version:        fields.version?.toString() ?? '0',
        nBits:          fields.n_bits?.toString() ?? '0',
        nTime:          fields.n_time?.toString() ?? '0',
        createdEpoch:   fields.created_epoch?.toString() ?? '0',
        timestampMs:    ev.timestampMs,
        txDigest:       ev.txDigest,
      } satisfies JobTemplate;
    })
    .filter((j): j is JobTemplate => j !== null)
    .sort((a, b) => parseInt(b.jobId) - parseInt(a.jobId));

  return { jobs, pool: poolStats };
}

export async function fetchShares(): Promise<SharesResponse> {
  if (!PACKAGE_ID) throw new Error('NEXT_PUBLIC_PACKAGE_ID is not configured');

  const evRes = await rpc('suix_queryEvents', [
    { MoveEventType: `${PACKAGE_ID}::pool::ShareAccepted` },
    null, 50, true,
  ]) as Record<string, unknown>;

  const shares: ShareEvent[] = ((evRes?.data as unknown[]) ?? []).map(ev => {
    const e      = ev as Record<string, unknown>;
    const parsed = e.parsedJson as Record<string, unknown> | undefined;
    const evId   = e.id as Record<string, unknown> | undefined;
    return {
      poolId:      String(parsed?.pool_id   ?? ''),
      jobId:       String(parsed?.job_id     ?? '0'),
      worker:      String(parsed?.worker     ?? ''),
      nonce:       String(parsed?.nonce      ?? '0'),
      difficulty:  String(parsed?.difficulty ?? '0'),
      timestampMs: String(e.timestampMs      ?? '0'),
      txDigest:    String(evId?.txDigest     ?? ''),
    };
  });

  return { shares };
}
