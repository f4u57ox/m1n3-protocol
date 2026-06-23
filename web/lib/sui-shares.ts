/**
 * Recent share events via Sui GraphQL.
 *
 * Three share-event types feed the Recent Shares table, one per submission lane:
 *
 *   pool::ShareSubmitted              { miner, template_id, round_id, share_hash,
 *                                       difficulty, is_block, timestamp_ms }
 *       Emitted by `submit_share` — pool lane, credits MinerRoundStats.
 *
 *   pool::HashpowerShareFilled        { order_id, miner, template_id, derived_template_id,
 *                                       difficulty, payout, is_block, timestamp_ms }
 *       V1 buyer-pay lane (`submit_share_for_pay` / `submit_share_for_pay_derived`).
 *       Miner is paid in QuoteT atomically; no pool-round accumulation.
 *
 *   pool::BuyerHashpowerShareFilled   { order_id, miner, template_id, derived_template_id,
 *                                       difficulty, payout, is_block, timestamp_ms }
 *       V2 buyer-bound lane (`submit_share_for_buyer_pay`). Same payout semantics
 *       as V1; the order binds to the buyer's address rather than a single template.
 *
 * All three are merged here and exposed via a single `ShareEvent[]`.
 */

import { gql, parseU64 } from './sui-graphql';
import {
  ORIGINAL_PACKAGE_ID,
  PACKAGE_ID,
  HASHPOWER_LANE_PACKAGE_ID,
  HASHPOWER_LANE_V2_PACKAGE_ID,
} from './constants';
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
  mode: ShareEvent['mode'],
): ShareEvent {
  const json = node.contents?.json ?? {};
  const shareHashHex = shareHashToHex(json.share_hash);
  // The new ShareSubmitted event renames `difficulty_achieved` → `difficulty`
  // and drops `target_difficulty`. Read both names for back-compat.
  const difficulty = parseU64(json.difficulty ?? json.difficulty_achieved ?? 0);

  // Buyer-pay events carry `payout`, `order_id` and an Option<ID>
  // `derived_template_id`. The Option encodes as `{ vec: [<ID>] }` or
  // `{ vec: [] }` in GraphQL JSON depending on the SDK; tolerate both
  // by accepting either shape.
  const payout = parseU64(json.payout ?? 0);
  const orderId = (json.order_id as string) ?? undefined;
  let derivedTemplateId: string | undefined;
  const dt = json.derived_template_id;
  if (typeof dt === 'string') {
    derivedTemplateId = dt;
  } else if (dt && typeof dt === 'object' && Array.isArray(dt.vec) && dt.vec.length > 0) {
    derivedTemplateId = String(dt.vec[0]);
  }

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
    ...(payout > 0 ? { payoutMicro: payout } : {}),
    ...(orderId ? { orderId } : {}),
    ...(derivedTemplateId ? { derivedTemplateId } : {}),
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

    // Pool-lane (`ShareSubmitted`) packages: the original + the upgraded
    // published-at if they diverge (an upgrade keeps event types bound to the
    // original id). On a fresh publish like v5, both are the same value.
    const poolPackageIds = Array.from(new Set([
      ORIGINAL_PACKAGE_ID,
      ...(PACKAGE_ID && PACKAGE_ID !== ORIGINAL_PACKAGE_ID ? [PACKAGE_ID] : []),
    ]));
    // V1 buyer-pay lane (`HashpowerShareFilled`): origin id of the V1 struct.
    // Falls back to the pool packages if not configured.
    const v1LanePackageIds = Array.from(new Set(
      HASHPOWER_LANE_PACKAGE_ID ? [HASHPOWER_LANE_PACKAGE_ID] : poolPackageIds,
    ));
    // V2 buyer-bound lane (`BuyerHashpowerShareFilled`): origin id of the V2 struct.
    const v2LanePackageIds = Array.from(new Set(
      HASHPOWER_LANE_V2_PACKAGE_ID ? [HASHPOWER_LANE_V2_PACKAGE_ID] : poolPackageIds,
    ));

    const queryEvent = (pkgId: string, name: string) =>
      gql<{ events: { nodes: GqlShareNode[] } }>(
        EVENT_QUERY,
        { type: `${pkgId}::pool::${name}`, limit },
      ).then((d) => d?.events?.nodes ?? []).catch(() => [] as GqlShareNode[]);

    // Run all three lane queries (× all origin packages) in parallel.
    const [poolResults, v1Results, v2Results] = await Promise.all([
      Promise.all(poolPackageIds.map((p) => queryEvent(p, 'ShareSubmitted'))),
      Promise.all(v1LanePackageIds.map((p) => queryEvent(p, 'HashpowerShareFilled'))),
      Promise.all(v2LanePackageIds.map((p) => queryEvent(p, 'BuyerHashpowerShareFilled'))),
    ]);

    // Merge into one stream, dedupe by tx digest, sort newest-first.
    const seen = new Set<string>();
    const merged: (GqlShareNode & { _ts: number; _mode: ShareEvent['mode'] })[] = [];

    const collect = (results: GqlShareNode[][], mode: ShareEvent['mode']) => {
      for (const nodes of results) {
        for (const n of nodes) {
          const key = n.transaction?.digest ?? n.timestamp;
          if (!key || seen.has(key)) continue;
          seen.add(key);
          merged.push({ ...n, _ts: Date.parse(n.timestamp) || 0, _mode: mode });
        }
      }
    };
    collect(poolResults, 'full');
    collect(v1Results, 'buyer-v1');
    collect(v2Results, 'buyer-v2');

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
