/**
 * Sui data queries for the m1n3 pool — backed by the Sui GraphQL indexer.
 *
 * GraphQL endpoint has CORS wildcard and is the recommended Sui web-app API.
 * JSON-RPC is deprecated (July 2026); this file avoids it entirely.
 */

import { gql, b64hex, b64hexArray, parseU64 } from './sui-graphql';
import { reverseHex } from './bitcoin-utils';
import { PACKAGE_ID, ORIGINAL_PACKAGE_ID, POOL_OBJECT_ID } from './constants';
import type { TemplateData, PoolData, MinerStatsData } from './types';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// How many of the most-recently-registered templates are tagged "Active"
/// in the UI. The on-chain protocol accepts shares against any template
/// whose `round_id == pool.current_round` (enforced by `pool::submit_share`
/// and `miner::EStaleTemplate`), but at testnet difficulty that's dozens
/// per round. Miners' ASICs only ever work on the latest 1-3 jobs because
/// stratum's `mining.notify` pushes refreshed jobs every ~30 seconds with
/// `clean_jobs=true`. So "Active" here means *currently being mined*, not
/// *technically valid for share submission*.
const ACTIVE_TEMPLATE_WINDOW = 3;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseTemplateJson(
  json: Record<string, any>,
  id: string,
): TemplateData {
  return {
    id,
    height: parseU64(json.height),
    prevBlockHash: b64hex(json.prev_block_hash),
    coinbase1: b64hex(json.coinbase1),
    coinbase2: b64hex(json.coinbase2),
    merkleBranches: b64hexArray(json.merkle_branches).map(reverseHex),
    version: parseU64(json.version),
    nbits: parseU64(json.nbits),
    ntime: parseU64(json.ntime),
    isActive: false, // set in fetchActiveTemplates after sorting
    owner: typeof json.owner === 'string' ? json.owner : '',
    createdAtMs: parseU64(json.created_at_ms),
    shareCount: 0,
  };
}

// ---------------------------------------------------------------------------
// Pool queries
// ---------------------------------------------------------------------------

export async function fetchPoolStats(): Promise<PoolData | null> {
  try {
    if (!POOL_OBJECT_ID) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: { object: { asMoveObject: { contents: { json: Record<string, any> } } } | null } =
      await gql(
        `query Pool($id: SuiAddress!) {
          object(address: $id) { asMoveObject { contents { json } } }
        }`,
        { id: POOL_OBJECT_ID },
      );
    const json = data?.object?.asMoveObject?.contents?.json;
    if (!json) return null;
    return {
      totalShares: parseU64(json.total_shares),
      totalBlocks: parseU64(json.total_blocks),
      currentRound: parseU64(json.current_round),
      globalMinDifficulty: parseU64(json.global_min_difficulty),
      chainHeight: 0,
    };
  } catch (err) {
    console.error('[sui-queries] fetchPoolStats failed:', err);
    return null;
  }
}

export async function fetchPoolHashrate(): Promise<{ instantaneous: number; average: number }> {
  return { instantaneous: 0, average: 0 };
}

/**
 * Aggregate ShareSubmitted events by template_id. Paginates through the
 * indexer (Sui GraphQL `events` with `first` + `after`) and returns a map
 * from `template_id` to count.
 *
 * `EVENT_PAGE_SIZE` caps each request; we walk up to `MAX_PAGES` pages so a
 * very long history doesn't pin the dashboard. For deep-history dashboards,
 * point a dedicated indexer view at this aggregation.
 */
const EVENT_PAGE_SIZE = 50;
const MAX_PAGES = 20;

interface PerTemplateShareInfo {
  /** Number of `ShareSubmitted` events observed for this template. */
  count: number;
  /** Tx digest of the *most recent* `ShareSubmitted` (by event timestamp). */
  lastDigest?: string;
  lastTimestampMs?: number;
}

async function fetchShareInfoByTemplate(): Promise<Map<string, PerTemplateShareInfo>> {
  const out = new Map<string, PerTemplateShareInfo>();
  const packageId = ORIGINAL_PACKAGE_ID;
  if (!packageId) return out;
  const eventType = `${packageId}::pool::ShareSubmitted`;
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    let data: {
      events: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          contents: { json: Record<string, any> } | null;
          transaction: { digest: string } | null;
          timestamp: string | null;
        }[];
      };
    };
    try {
      data = await gql(
        `query ShareEventsForCount($type: String!, $cursor: String, $first: Int!) {
          events(filter: { type: $type }, first: $first, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              contents { json }
              transaction { digest }
              timestamp
            }
          }
        }`,
        { type: eventType, cursor, first: EVENT_PAGE_SIZE },
      );
    } catch (err) {
      console.error('[sui-queries] fetchShareInfoByTemplate page failed:', err);
      break;
    }
    const evs = data?.events;
    if (!evs) break;
    for (const node of evs.nodes) {
      const tid = node.contents?.json?.template_id;
      if (typeof tid !== 'string' || tid.length === 0) continue;
      const digest = node.transaction?.digest;
      const ts = node.timestamp ? Date.parse(node.timestamp) : NaN;
      const cur = out.get(tid) ?? { count: 0 };
      cur.count += 1;
      if (digest && (cur.lastTimestampMs === undefined || (Number.isFinite(ts) && ts > cur.lastTimestampMs))) {
        cur.lastDigest = digest;
        cur.lastTimestampMs = Number.isFinite(ts) ? ts : cur.lastTimestampMs;
      }
      out.set(tid, cur);
    }
    if (!evs.pageInfo.hasNextPage) break;
    cursor = evs.pageInfo.endCursor;
  }
  return out;
}

/**
 * Paginate `TemplateRegistered` events and return a map from `template_id`
 * to the tx digest that registered it. One digest per template (registration
 * is a one-shot frozen-object emit).
 */
async function fetchTemplateRegistrationDigests(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const packageId = ORIGINAL_PACKAGE_ID;
  if (!packageId) return out;
  const eventType = `${packageId}::pool::TemplateRegistered`;
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    let data: {
      events: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          contents: { json: Record<string, any> } | null;
          transaction: { digest: string } | null;
        }[];
      };
    };
    try {
      data = await gql(
        `query TemplateRegEvents($type: String!, $cursor: String, $first: Int!) {
          events(filter: { type: $type }, first: $first, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              contents { json }
              transaction { digest }
            }
          }
        }`,
        { type: eventType, cursor, first: EVENT_PAGE_SIZE },
      );
    } catch (err) {
      console.error('[sui-queries] fetchTemplateRegistrationDigests page failed:', err);
      break;
    }
    const evs = data?.events;
    if (!evs) break;
    for (const node of evs.nodes) {
      const tid = node.contents?.json?.template_id;
      const digest = node.transaction?.digest;
      if (typeof tid === 'string' && digest && !out.has(tid)) {
        out.set(tid, digest);
      }
    }
    if (!evs.pageInfo.hasNextPage) break;
    cursor = evs.pageInfo.endCursor;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Template queries
// ---------------------------------------------------------------------------

interface GqlObjectNode {
  address: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  asMoveObject: { contents: { json: Record<string, any> } } | null;
}
interface GqlObjectsPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: GqlObjectNode[];
}

export async function fetchActiveTemplates(): Promise<TemplateData[]> {
  try {
    const packageId = ORIGINAL_PACKAGE_ID;
    if (!packageId) return [];

    // Aggregate per-template share counts + most-recent share digest from
    // ShareSubmitted events, and pull each template's registration digest
    // from TemplateRegistered events. Run in parallel — both walk the same
    // indexer with disjoint event-type filters.
    const [shareInfo, regDigests] = await Promise.all([
      fetchShareInfoByTemplate(),
      fetchTemplateRegistrationDigests(),
    ]);

    const templateType = `${packageId}::pool::Template`;
    const templates: TemplateData[] = [];
    let cursor: string | null = null;

    while (true) {
      const data: { objects: GqlObjectsPage } = await gql(
        `query Templates($type: String!, $cursor: String) {
          objects(filter: { type: $type }, first: 50, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { address asMoveObject { contents { json } } }
          }
        }`,
        { type: templateType, cursor },
      );
      const page = data?.objects;
      if (!page) break;

      for (const node of page.nodes) {
        const json = node.asMoveObject?.contents?.json;
        if (!json) continue;
        const t = parseTemplateJson(json, node.address);
        const info = shareInfo.get(node.address);
        t.shareCount = info?.count ?? 0;
        t.lastShareDigest = info?.lastDigest;
        t.registrationDigest = regDigests.get(node.address);
        templates.push(t);
      }

      if (!page.pageInfo.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
    }

    // Sort by registration time (newest first), then mark the first
    // ACTIVE_TEMPLATE_WINDOW as "Active". Anything older becomes "Historic".
    // We use `createdAtMs` (registration time) rather than `round_id`
    // because at testnet difficulty rounds rarely advance — the natural
    // freshness signal is "when did the stratum register this".
    const sorted = templates.sort((a, b) => {
      if (b.createdAtMs !== a.createdAtMs) return b.createdAtMs - a.createdAtMs;
      return b.height - a.height;
    });
    for (let i = 0; i < sorted.length; i++) {
      sorted[i].isActive = i < ACTIVE_TEMPLATE_WINDOW;
    }
    return sorted;
  } catch (err) {
    console.error('[sui-queries] fetchActiveTemplates failed:', err);
    return [];
  }
}

export async function fetchTemplateById(id: string): Promise<TemplateData | null> {
  try {
    const data: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      object: { asMoveObject: { contents: { json: Record<string, any> } } | null } | null;
    } = await gql(
      `query Template($id: SuiAddress!) {
        object(address: $id) { asMoveObject { contents { json } } }
      }`,
      { id },
    );
    const json = data?.object?.asMoveObject?.contents?.json;
    if (!json) return null;
    return parseTemplateJson(json, id);
  } catch (err) {
    console.error('[sui-queries] fetchTemplateById failed:', err);
    return null;
  }
}

export async function fetchTemplatesByOwner(owner: string): Promise<TemplateData[]> {
  try {
    const packageId = ORIGINAL_PACKAGE_ID;
    if (!packageId || !owner) return [];

    const templateType = `${packageId}::pool::Template`;
    const templates: TemplateData[] = [];
    let cursor: string | null = null;

    while (true) {
      const data: { objects: GqlObjectsPage } = await gql(
        `query TemplatesByOwner($type: String!, $owner: SuiAddress!, $cursor: String) {
          objects(filter: { type: $type, owner: $owner }, first: 50, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { address asMoveObject { contents { json } } }
          }
        }`,
        { type: templateType, owner, cursor },
      );
      const page = data?.objects;
      if (!page) break;

      for (const node of page.nodes) {
        const json = node.asMoveObject?.contents?.json;
        if (!json) continue;
        templates.push(parseTemplateJson(json, node.address));
      }

      if (!page.pageInfo.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
    }

    return templates.sort((a, b) => b.createdAtMs - a.createdAtMs);
  } catch (err) {
    console.error('[sui-queries] fetchTemplatesByOwner failed:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Miner queries
// ---------------------------------------------------------------------------

export async function fetchMinerStats(address: string): Promise<MinerStatsData | null> {
  try {
    const packageId = PACKAGE_ID;
    if (!packageId || !address) return null;

    const structType = `${packageId}::miner::MinerStats`;
    const data: { objects: { nodes: GqlObjectNode[] } } = await gql(
      `query MinerStats($type: String!, $owner: SuiAddress!) {
        objects(filter: { type: $type, owner: $owner }, first: 1) {
          nodes { address asMoveObject { contents { json } } }
        }
      }`,
      { type: structType, owner: address },
    );

    const json = data?.objects?.nodes?.[0]?.asMoveObject?.contents?.json;
    if (!json) return null;

    return {
      address,
      totalShares: parseU64(json.total_shares),
      blocksFound: parseU64(json.blocks_found),
      registeredAtMs: parseU64(json.registered_at_ms),
      currentRoundWork: 0,
      currentRoundShares: 0,
      estimatedHashrate: 0,
      lastShareTimeMs: 0,
      isSoloMiner: false,
      miningMode: 'unknown',
    };
  } catch (err) {
    console.error('[sui-queries] fetchMinerStats failed:', err);
    return null;
  }
}

export { parseU64 };
