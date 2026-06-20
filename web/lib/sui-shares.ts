/**
 * Recent share events via Sui GraphQL.
 *
 * The current contract emits a single share event type:
 *   pool::ShareSubmitted { miner, template_id, round_id, share_hash,
 *                         difficulty, is_block, timestamp_ms }
 *
 * Legacy ShareValidated/full vs lightweight is dropped — `submit_share`
 * always emits one ShareSubmitted, with no NFT minted on the hot path.
 */

import { gql, parseU64 } from './sui-graphql';
import { ORIGINAL_PACKAGE_ID, PACKAGE_ID } from './constants';
import type { ShareEvent } from './types';

interface GqlShareNode {
  timestamp: string;
  transaction: { digest: string } | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contents: { json: Record<string, any> } | null;
}
interface GqlSharePage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: GqlShareNode[];
}

// Decode a vector<u8> from GraphQL JSON (base64 string) to a reversed hex string.
function shareHashToHex(val: unknown): string {
  if (typeof val !== 'string' || val.length === 0) return '';
  try {
    let bytes: Uint8Array;
    if (typeof Buffer !== 'undefined') {
      bytes = Buffer.from(val, 'base64');
    } else {
      const bin = atob(val);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    }
    return Array.from(bytes).reverse().map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return '';
  }
}

function nodeToShareEvent(
  node: GqlShareNode,
  mode: 'full' | 'lightweight',
): ShareEvent {
  const json = node.contents?.json ?? {};
  const shareHashHex = shareHashToHex(json.share_hash);
  // The new ShareSubmitted event renames `difficulty_achieved` → `difficulty`
  // and drops `target_difficulty`. Read both names for back-compat.
  const difficulty = parseU64(json.difficulty ?? json.difficulty_achieved ?? 0);
  return {
    miner: (json.miner as string) ?? '',
    templateId: (json.template_id as string) ?? '',
    roundId: parseU64(json.round_id ?? 0),
    shareHash: shareHashHex,
    difficultyAchieved: difficulty,
    targetDifficulty: parseU64(json.target_difficulty ?? 0),
    isBlock: json.is_block === true,
    timestampMs: parseU64(json.timestamp_ms),
    txDigest: node.transaction?.digest ?? '',
    mode,
  };
}

const EVENT_QUERY = `query RecentShareEvents($type: String!, $limit: Int!) {
  events(filter: { type: $type }, last: $limit) {
    nodes { timestamp transaction { digest } contents { json } }
  }
}`;

export async function fetchRecentShares(limit = 20): Promise<ShareEvent[]> {
  try {
    if (!ORIGINAL_PACKAGE_ID) return [];

    const packageIds = [ORIGINAL_PACKAGE_ID];
    if (PACKAGE_ID && PACKAGE_ID !== ORIGINAL_PACKAGE_ID) {
      packageIds.push(PACKAGE_ID);
    }

    // Single event type now: pool::ShareSubmitted.
    const fullResults = await Promise.all(
      packageIds.map((pkgId) =>
        gql<{ events: { nodes: GqlShareNode[] } }>(
          EVENT_QUERY,
          { type: `${pkgId}::pool::ShareSubmitted`, limit },
        ).then((d) => d?.events?.nodes ?? []).catch(() => [] as GqlShareNode[])
      ),
    );
    const liteResults: GqlShareNode[][] = [];

    // Merge both event types, deduplicate by tx digest, sort newest-first
    const seen = new Set<string>();
    const merged: (GqlShareNode & { _ts: number; _mode: 'full' | 'lightweight' })[] = [];

    for (const nodes of fullResults) {
      for (const n of nodes) {
        const key = n.transaction?.digest ?? n.timestamp;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push({ ...n, _ts: Date.parse(n.timestamp) || 0, _mode: 'full' });
      }
    }
    for (const nodes of liteResults) {
      for (const n of nodes) {
        const key = n.transaction?.digest ?? n.timestamp;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push({ ...n, _ts: Date.parse(n.timestamp) || 0, _mode: 'lightweight' });
      }
    }

    merged.sort((a, b) => b._ts - a._ts);
    return merged.slice(0, limit).map((n) => nodeToShareEvent(n, n._mode));
  } catch (err) {
    console.error('[sui-shares] fetchRecentShares failed:', err);
    return [];
  }
}

export async function fetchSharesForTemplate(templateId: string, limit = 50): Promise<ShareEvent[]> {
  try {
    const packageId = ORIGINAL_PACKAGE_ID;
    if (!packageId) return [];

    const shares: ShareEvent[] = [];

    // Try both event types for template-specific shares
    for (const [eventSuffix, mode] of [['ShareSubmitted', 'full'], ['ShareValidated', 'lightweight']] as const) {
      const eventType = `${packageId}::pool::${eventSuffix}`;
      let cursor: string | null = null;

      while (shares.length < limit) {
        const data: { events: GqlSharePage } = await gql(
          `query SharesByTemplate($type: String!, $cursor: String) {
            events(filter: { type: $type }, first: 50, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes { timestamp transaction { digest } contents { json } }
            }
          }`,
          { type: eventType, cursor },
        );
        const page = data?.events;
        if (!page) break;

        for (const node of page.nodes) {
          if ((node.contents?.json?.template_id as string) !== templateId) continue;
          shares.push(nodeToShareEvent(node, mode));
          if (shares.length >= limit) break;
        }

        if (shares.length >= limit || !page.pageInfo.hasNextPage) break;
        cursor = page.pageInfo.endCursor;
      }
    }

    return shares.sort((a, b) => b.timestampMs - a.timestampMs).slice(0, limit);
  } catch (err) {
    console.error('[sui-shares] fetchSharesForTemplate failed:', err);
    return [];
  }
}
