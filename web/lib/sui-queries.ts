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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseTemplateJson(
  json: Record<string, any>,
  id: string,
  poolCurrentRound?: number,
): TemplateData {
  // Templates are now frozen (immutable) on registration — no `is_active` field.
  // A template is "active" iff its snapshotted round_id matches the pool's
  // current round; once the round closes, the template is historical.
  const templateRound = parseU64(json.round_id ?? 0);
  const isActive =
    poolCurrentRound === undefined ? true : templateRound >= poolCurrentRound;
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
    isActive,
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

async function fetchShareCountsByTemplate(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const packageId = ORIGINAL_PACKAGE_ID;
  if (!packageId) return out;
  const eventType = `${packageId}::pool::ShareSubmitted`;
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    let data: {
      events: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        nodes: { contents: { json: Record<string, any> } | null }[];
      };
    };
    try {
      data = await gql(
        `query ShareEventsForCount($type: String!, $cursor: String, $first: Int!) {
          events(filter: { type: $type }, first: $first, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { contents { json } }
          }
        }`,
        { type: eventType, cursor, first: EVENT_PAGE_SIZE },
      );
    } catch (err) {
      console.error('[sui-queries] fetchShareCountsByTemplate page failed:', err);
      break;
    }
    const evs = data?.events;
    if (!evs) break;
    for (const node of evs.nodes) {
      const tid = node.contents?.json?.template_id;
      if (typeof tid === 'string' && tid.length > 0) {
        out.set(tid, (out.get(tid) ?? 0) + 1);
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

    // Aggregate per-template share counts from ShareSubmitted events.
    // For a small protocol-wide volume this is fine; for production volumes
    // we'd swap to a dedicated indexer view.
    const shareCounts = await fetchShareCountsByTemplate();

    // Read the pool's current round so we can mark older templates as inactive.
    const pool = await fetchPoolStats();
    const poolRound = pool?.currentRound;

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
        const t = parseTemplateJson(json, node.address, poolRound);
        t.shareCount = shareCounts.get(node.address) ?? 0;
        templates.push(t);
      }

      if (!page.pageInfo.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
    }

    return templates.sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      if (b.height !== a.height) return b.height - a.height;
      return b.createdAtMs - a.createdAtMs;
    });
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
