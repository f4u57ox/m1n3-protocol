import { useQuery } from "@tanstack/react-query";
import { suiClient } from "@/lib/sui-client";
import {
  HASHPOWER_LANE_PACKAGE_ID,
  HASHPOWER_LANE_V2_PACKAGE_ID,
  ORIGINAL_PACKAGE_ID,
} from "@/lib/constants";

/**
 * Discriminator between the two on-chain hashpower order shapes:
 *
 *  • `v1` — `pool::HashpowerBuyOrder` (template-pinned). Carries an
 *    immutable `templateId`. Stops accepting shares the moment the
 *    buyer's bitcoind sees a new tip and publishes a fresh template.
 *    Surfaced for cancel-only management (zombie cleanup).
 *  • `v2` — `pool::BuyerHashpowerOrder` (buyer-bound). No template
 *    pinning. Shares against any template owned by `buyer` settle the
 *    order. `latestTemplateId` is a UI-only convenience computed off
 *    chain from the buyer's most-recent `TemplateRegistered` event.
 */
export type HashpowerOrderKind = "v1" | "v2";

export interface HashpowerOrder {
  kind: HashpowerOrderKind;
  objectId: string;
  buyer: string;
  /** V1 only: the immutable template id the order is pinned to. */
  templateId?: string;
  /** V2 only: most-recent template the buyer has registered (UI hint). */
  latestTemplateId?: string;
  /** V2 only: when the buyer last published a template, Unix ms. */
  latestTemplateAtMs?: bigint;
  /** Most recent share fills against this order, newest first. Up to 5. */
  recentFills: OrderFill[];
  /** µQuote per difficulty-1 unit of share work. */
  pricePerDifficulty: bigint;
  /** Remaining budget in the quote's base units (µUSDC on mainnet). */
  budget: bigint;
  /** Epoch cutoff or `null` for open-ended. */
  expiresEpoch: bigint | null;
  /** True when the buyer can re-price via the update entry. */
  isDynamic: boolean;
  /** Fully-qualified Move type of the quote coin. */
  quoteCoinType: string;
}

/** Snapshot of a single accepted share that drained a hashpower order. */
export interface OrderFill {
  /** Unix milliseconds when the share landed on chain. */
  timestampMs: bigint;
  /** Sui address of the miner that submitted the share. */
  miner: string;
  /** µQuote routed from the order's budget to the miner. */
  payout: bigint;
  /** Share's computed difficulty (`difficulty * price = payout`). */
  difficulty: bigint;
  /** True when the share also met Bitcoin network difficulty. */
  isBlock: boolean;
  /** Buyer-owned template the share was hashed against. */
  templateId: string;
}

/**
 * Discover every open hashpower order on chain — both V1 (`HashpowerBuyOrder`,
 * template-pinned, legacy) and V2 (`BuyerHashpowerOrder`, buyer-bound).
 *
 * For each V2 order we additionally walk the operator's
 * `TemplateRegistered` event stream (under `ORIGINAL_PACKAGE_ID`) to surface
 * the buyer's most-recent template as `latestTemplateId`. This is purely a
 * display hint — the order accepts shares against any of the buyer's
 * templates, not just the latest.
 */
export function useHashpowerOrders() {
  return useQuery<HashpowerOrder[]>({
    queryKey: [
      "hashpowerOrders",
      HASHPOWER_LANE_PACKAGE_ID,
      HASHPOWER_LANE_V2_PACKAGE_ID,
      ORIGINAL_PACKAGE_ID,
    ],
    enabled: !!HASHPOWER_LANE_PACKAGE_ID && !!HASHPOWER_LANE_V2_PACKAGE_ID,
    refetchInterval: 15_000,
    staleTime: 5_000,
    queryFn: async () => {
      const v1 = await collectV1Orders();
      const v2 = await collectV2Orders();
      const all = [...v2, ...v1];

      // Hydrate recent fills for every order (V1 + V2 events live in
      // separate origin packages, so we scan both streams once and
      // bucket by order_id).
      const allOrderIds = new Set(all.map((o) => o.objectId));
      const v2Fills = await collectFills(
        allOrderIds,
        HASHPOWER_LANE_V2_PACKAGE_ID,
        "BuyerHashpowerShareFilled",
      );
      const v1Fills = await collectFills(
        allOrderIds,
        HASHPOWER_LANE_PACKAGE_ID,
        "HashpowerShareFilled",
      );
      for (const o of all) {
        o.recentFills = v2Fills.get(o.objectId) ?? v1Fills.get(o.objectId) ?? [];
      }

      // Highest price first across both kinds — miners care about gross
      // µQuote / difficulty.
      all.sort((a, b) => Number(b.pricePerDifficulty - a.pricePerDifficulty));
      return all;
    },
  });
}

// ── V1: template-pinned (legacy) ───────────────────────────────────────────

async function collectV1Orders(): Promise<HashpowerOrder[]> {
  if (!HASHPOWER_LANE_PACKAGE_ID) return [];
  const events = await suiClient.queryEvents({
    query: {
      MoveEventType: `${HASHPOWER_LANE_PACKAGE_ID}::pool::HashpowerBuyOrderPlaced`,
    },
    order: "descending",
    limit: 200,
  });
  const ids = events.data
    .map((e) => (e.parsedJson as Record<string, string>).order_id)
    .filter(Boolean);
  if (ids.length === 0) return [];

  const objects = await batchedMultiGet(ids);
  const typePrefix = `${HASHPOWER_LANE_PACKAGE_ID}::pool::HashpowerBuyOrder<`;
  const orders: HashpowerOrder[] = [];
  for (const o of objects) {
    const d = o.data;
    if (!d?.content || d.content.dataType !== "moveObject") continue;
    if (!d.type?.startsWith(typePrefix)) continue;
    const f = d.content.fields as Record<string, unknown>;
    const quoteCoinType = d.type.slice(typePrefix.length, d.type.length - 1);
    orders.push({
      kind: "v1",
      objectId: d.objectId,
      buyer: String(f.buyer ?? ""),
      templateId: String(f.template_id ?? ""),
      pricePerDifficulty: BigInt(
        String((f.price_per_difficulty as string | undefined) ?? "0"),
      ),
      budget: BigInt(String((f.budget as string | undefined) ?? "0")),
      expiresEpoch: parseOptionEpoch(f.expires_epoch),
      isDynamic: Boolean(f.is_dynamic),
      quoteCoinType,
      recentFills: [], // populated by the queryFn after both collectors run
    });
  }
  return orders;
}

// ── V2: buyer-bound ────────────────────────────────────────────────────────

async function collectV2Orders(): Promise<HashpowerOrder[]> {
  if (!HASHPOWER_LANE_V2_PACKAGE_ID) return [];
  const events = await suiClient.queryEvents({
    query: {
      MoveEventType: `${HASHPOWER_LANE_V2_PACKAGE_ID}::pool::BuyerHashpowerOrderPlaced`,
    },
    order: "descending",
    limit: 200,
  });
  const ids = events.data
    .map((e) => (e.parsedJson as Record<string, string>).order_id)
    .filter(Boolean);
  if (ids.length === 0) return [];

  const objects = await batchedMultiGet(ids);
  const typePrefix = `${HASHPOWER_LANE_V2_PACKAGE_ID}::pool::BuyerHashpowerOrder<`;
  const raw: HashpowerOrder[] = [];
  for (const o of objects) {
    const d = o.data;
    if (!d?.content || d.content.dataType !== "moveObject") continue;
    if (!d.type?.startsWith(typePrefix)) continue;
    const f = d.content.fields as Record<string, unknown>;
    const quoteCoinType = d.type.slice(typePrefix.length, d.type.length - 1);
    raw.push({
      kind: "v2",
      objectId: d.objectId,
      buyer: String(f.buyer ?? ""),
      pricePerDifficulty: BigInt(
        String((f.price_per_difficulty as string | undefined) ?? "0"),
      ),
      budget: BigInt(String((f.budget as string | undefined) ?? "0")),
      expiresEpoch: parseOptionEpoch(f.expires_epoch),
      isDynamic: Boolean(f.is_dynamic),
      quoteCoinType,
      recentFills: [], // hydrated by the queryFn after both collectors run
    });
  }

  // Compute `latestTemplateId` + `latestTemplateAtMs` for each unique
  // buyer via the operator's `TemplateRegistered` event stream. Events
  // are addressed by the ORIGINAL publishing package id (v1) regardless
  // of which package version emitted them, so one filter covers all
  // upgrades. We walk newest-first and bail once every buyer is hit.
  if (raw.length === 0) return raw;
  const buyers = new Set(raw.map((o) => o.buyer));
  const latestByBuyer = new Map<string, { templateId: string; atMs: bigint }>();
  if (ORIGINAL_PACKAGE_ID) {
    let cursor: { eventSeq: string; txDigest: string } | null = null;
    let remaining = buyers.size;
    for (let page = 0; page < 10 && remaining > 0; page += 1) {
      const r = await suiClient.queryEvents({
        query: {
          MoveEventType: `${ORIGINAL_PACKAGE_ID}::pool::TemplateRegistered`,
        },
        order: "descending",
        limit: 100,
        cursor,
      });
      for (const ev of r.data) {
        const j = ev.parsedJson as Record<string, string>;
        if (j.owner && buyers.has(j.owner) && !latestByBuyer.has(j.owner)) {
          latestByBuyer.set(j.owner, {
            templateId: String(j.template_id),
            // Prefer the event's `timestamp_ms` field if present, fall
            // back to the SuiEvent envelope's `timestampMs`.
            atMs: BigInt(
              String(j.timestamp_ms ?? (ev as unknown as { timestampMs?: string }).timestampMs ?? "0"),
            ),
          });
          remaining -= 1;
          if (remaining === 0) break;
        }
      }
      if (!r.hasNextPage || !r.nextCursor) break;
      cursor = r.nextCursor;
    }
  }
  for (const o of raw) {
    const hit = latestByBuyer.get(o.buyer);
    if (hit) {
      o.latestTemplateId = hit.templateId;
      o.latestTemplateAtMs = hit.atMs;
    }
  }
  return raw;
}

/**
 * Scan the chosen *ShareFilled event stream and bucket events by
 * `order_id`, keeping at most 5 most-recent per order. Caller supplies
 * the origin package id (V1 = `HASHPOWER_LANE_PACKAGE_ID`,
 * V2 = `HASHPOWER_LANE_V2_PACKAGE_ID`).
 */
async function collectFills(
  orderIds: Set<string>,
  originPackageId: string,
  eventName: "BuyerHashpowerShareFilled" | "HashpowerShareFilled",
): Promise<Map<string, OrderFill[]>> {
  const out = new Map<string, OrderFill[]>();
  if (orderIds.size === 0 || !originPackageId) return out;
  let cursor: { eventSeq: string; txDigest: string } | null = null;
  for (let page = 0; page < 5; page += 1) {
    const r = await suiClient.queryEvents({
      query: {
        MoveEventType: `${originPackageId}::pool::${eventName}`,
      },
      order: "descending",
      limit: 100,
      cursor,
    });
    for (const ev of r.data) {
      const j = ev.parsedJson as Record<string, unknown>;
      const orderId = String(j.order_id ?? "");
      if (!orderIds.has(orderId)) continue;
      const list = out.get(orderId) ?? [];
      if (list.length >= 5) continue;
      list.push({
        timestampMs: BigInt(String(j.timestamp_ms ?? "0")),
        miner: String(j.miner ?? ""),
        payout: BigInt(String(j.payout ?? "0")),
        difficulty: BigInt(String(j.difficulty ?? "0")),
        isBlock: Boolean(j.is_block),
        templateId: String(j.template_id ?? ""),
      });
      out.set(orderId, list);
    }
    if (!r.hasNextPage || !r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return out;
}

// ── Shared helpers ─────────────────────────────────────────────────────────

async function batchedMultiGet(
  ids: string[],
): Promise<Awaited<ReturnType<typeof suiClient.multiGetObjects>>> {
  const out: Awaited<ReturnType<typeof suiClient.multiGetObjects>> = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = await suiClient.multiGetObjects({
      ids: ids.slice(i, i + 50),
      options: { showContent: true, showType: true, showOwner: true },
    });
    out.push(...batch);
  }
  return out;
}

function parseOptionEpoch(v: unknown): bigint | null {
  if (!v) return null;
  if (typeof v === "object" && v !== null) {
    const inner = (v as { vec?: unknown[] }).vec;
    if (Array.isArray(inner) && inner.length > 0) {
      return BigInt(String(inner[0]));
    }
  }
  return null;
}
