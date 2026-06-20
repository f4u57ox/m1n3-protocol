'use client';

import { useQuery } from '@tanstack/react-query';
import { suiClient } from '@/lib/sui-client';
import {
  activeDeepBookConfig,
  type QuoteToken,
} from '@/lib/quote-tokens';
import { useDeepBookClient } from '@/lib/deepbook-client';

/**
 * Look up a `Pool<BASE, QUOTE>` via DeepBookV3's registry.
 *
 * The registry stores pool IDs under a dynamic field keyed by the *typed*
 * `pool::PoolKey { base_type, quote_type }`. We can't construct that BCS
 * directly from the browser cheaply, so instead we ask the indexer for
 * `Pool` objects of the right generic and pick the one whose dynamic
 * fields trace back to our base/quote types.
 *
 * Strategy:
 *   1. Query `suix_queryEvents` for `PoolCreated` with the matching
 *      `base_type` + `quote_type` strings — that event is emitted by
 *      `create_permissionless_pool` and carries the pool ID.
 *   2. Cache for ~5 min (pools are sticky).
 *
 * Returns `null` when the pool doesn't exist yet, so the UI can show
 * a "create pool" CTA.
 */
export function useDeepBookPool(
  baseType: string | undefined,
  quote: QuoteToken | undefined,
) {
  const enabled = !!(baseType && quote);
  const cfg = activeDeepBookConfig();
  const db = useDeepBookClient();

  return useQuery<{ poolId: string | null }>({
    queryKey: ['deepbook-pool', baseType ?? '', quote?.type ?? ''],
    enabled,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      if (!cfg || !baseType || !quote) return { poolId: null };

      // Fast path: SDK reads the on-chain registry directly via dynamic
      // fields. Only available when a wallet is connected (the SDK
      // requires an address at construction).
      if (db) {
        try {
          const id = await db.getPoolIdByAssets(baseType, quote.type);
          if (id) return { poolId: id };
        } catch {
          // Pool not registered yet — fall through to event scan as a
          // belt-and-braces second opinion.
        }
      }

      // Slow path: walk back through PoolCreated events.
      const eventType = `${cfg.packageId}::pool::PoolCreated`;
      // Walk back through PoolCreated events looking for a base/quote match.
      let cursor: { txDigest: string; eventSeq: string } | null = null;
      for (let page = 0; page < 5; page++) {
        const res = await suiClient.queryEvents({
          query: { MoveEventType: eventType },
          cursor: cursor as any,
          limit: 50,
          order: 'descending',
        });
        for (const ev of res.data) {
          const parsed = ev.parsedJson as
            | { base_type?: string; quote_type?: string; pool_id?: string }
            | undefined;
          if (!parsed?.base_type || !parsed.quote_type || !parsed.pool_id) {
            continue;
          }
          // event type strings come without the leading `0x`
          const eb = normaliseAddr(parsed.base_type);
          const eq = normaliseAddr(parsed.quote_type);
          const wantB = normaliseAddr(baseType);
          const wantQ = normaliseAddr(quote.type);
          if (eb === wantB && eq === wantQ) {
            return { poolId: parsed.pool_id };
          }
        }
        if (!res.hasNextPage || !res.nextCursor) break;
        cursor = res.nextCursor as any;
      }
      return { poolId: null };
    },
  });
}

function normaliseAddr(t: string): string {
  // Strip `0x` and any leading zeros from the package portion of a Move
  // type, then re-lowercase. Useful so 0x002::sui::SUI matches
  // 0x2::sui::SUI etc.
  const i = t.indexOf('::');
  if (i < 0) return t.toLowerCase();
  const addr = t.slice(0, i).replace(/^0x0*/i, '');
  return (`0x${addr}` + t.slice(i)).toLowerCase();
}
