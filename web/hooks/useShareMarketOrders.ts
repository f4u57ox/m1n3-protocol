import { useQuery } from "@tanstack/react-query";
import { suiClient } from "@/lib/sui-client";
import { PACKAGE_ID, ORIGINAL_PACKAGE_ID } from "@/lib/constants";

export interface ShareMarketOrder {
  side: "bid" | "ask";
  objectId: string;
  owner: string;
  pricePerUnitMist: bigint;
  /// Buy orders: remaining SUI budget in MIST.
  /// Sell orders: remaining inventory in HashShare units.
  remaining: bigint;
  /// For buy orders, the max units this order can still fill at its price.
  maxUnits: bigint;
  expiresEpoch: bigint | null;
}

const BUY_TYPE = (coin: string) =>
  `${PACKAGE_ID}::hash_share_market::BuyOrder<${coin}>`;
const SELL_TYPE = (coin: string) =>
  `${PACKAGE_ID}::hash_share_market::SellOrder<${coin}>`;

/**
 * Discover active BuyOrder<T> and SellOrder<T> shared objects for a given
 * HashShare coin type. We query the module's `*OrderPlaced` events for IDs,
 * then `multiGetObjects` to fetch their current state and filter by struct
 * type (the event itself doesn't carry the type parameter).
 *
 * Cancelled or filled-to-zero orders that have been deleted are skipped
 * because `getObject` returns null for them.
 */
export function useShareMarketOrders(coinType: string | undefined) {
  return useQuery<{ bids: ShareMarketOrder[]; asks: ShareMarketOrder[] }>({
    queryKey: ["shareMarketOrders", coinType, ORIGINAL_PACKAGE_ID],
    enabled: !!coinType && !!ORIGINAL_PACKAGE_ID && !!PACKAGE_ID,
    refetchInterval: 15_000,
    staleTime: 5_000,
    queryFn: async () => {
      if (!coinType || !ORIGINAL_PACKAGE_ID) return { bids: [], asks: [] };

      const [buyEvents, sellEvents] = await Promise.all([
        suiClient.queryEvents({
          query: { MoveEventType: `${ORIGINAL_PACKAGE_ID}::hash_share_market::BuyOrderPlaced` },
          order: "descending",
          limit: 100,
        }),
        suiClient.queryEvents({
          query: { MoveEventType: `${ORIGINAL_PACKAGE_ID}::hash_share_market::SellOrderPlaced` },
          order: "descending",
          limit: 100,
        }),
      ]);

      const buyIds = buyEvents.data
        .map((e) => (e.parsedJson as Record<string, string>).order_id)
        .filter(Boolean);
      const sellIds = sellEvents.data
        .map((e) => (e.parsedJson as Record<string, string>).order_id)
        .filter(Boolean);
      const allIds = Array.from(new Set([...buyIds, ...sellIds]));
      if (allIds.length === 0) return { bids: [], asks: [] };

      // multiGetObjects caps at 50; batch.
      const objects: Awaited<ReturnType<typeof suiClient.multiGetObjects>> = [];
      for (let i = 0; i < allIds.length; i += 50) {
        const batch = await suiClient.multiGetObjects({
          ids: allIds.slice(i, i + 50),
          options: { showContent: true, showType: true, showOwner: true },
        });
        objects.push(...batch);
      }

      const expectedBuy = BUY_TYPE(coinType);
      const expectedSell = SELL_TYPE(coinType);
      const bids: ShareMarketOrder[] = [];
      const asks: ShareMarketOrder[] = [];

      for (const o of objects) {
        const d = o.data;
        if (!d?.content || d.content.dataType !== "moveObject") continue;
        const f = d.content.fields as Record<string, unknown>;
        const ownerObj = d.owner as { Shared?: unknown; AddressOwner?: string } | string | undefined;
        const _shared =
          typeof ownerObj === "object" && ownerObj !== null && "Shared" in ownerObj;

        // BuyOrder.payment and SellOrder.inventory are both `Balance<T>`.
        // The RPC content serialises Balance as a flat decimal string (the
        // raw u64 value), not as `{ fields: { value } }` like a wrapped Coin
        // would — so `f.payment` / `f.inventory` are strings, not nested
        // objects. The pre-cleanup code read them as wrapped Coin and
        // therefore always got 0.
        if (d.type === expectedBuy) {
          const price = BigInt(String((f.price_per_unit_mist as string) ?? "0"));
          const budget = BigInt(String((f.payment as string | undefined) ?? "0"));
          const maxUnits = price > 0n ? budget / price : 0n;
          const exp = parseOptionEpoch(f.expires_epoch);
          bids.push({
            side: "bid",
            objectId: d.objectId,
            owner: String(f.buyer ?? ""),
            pricePerUnitMist: price,
            remaining: budget,
            maxUnits,
            expiresEpoch: exp,
          });
        } else if (d.type === expectedSell) {
          const price = BigInt(String((f.price_per_unit_mist as string) ?? "0"));
          const inventory = BigInt(String((f.inventory as string | undefined) ?? "0"));
          const exp = parseOptionEpoch(f.expires_epoch);
          asks.push({
            side: "ask",
            objectId: d.objectId,
            owner: String(f.seller ?? ""),
            pricePerUnitMist: price,
            remaining: inventory,
            maxUnits: inventory,
            expiresEpoch: exp,
          });
        }
      }

      bids.sort((a, b) => Number(b.pricePerUnitMist - a.pricePerUnitMist));
      asks.sort((a, b) => Number(a.pricePerUnitMist - b.pricePerUnitMist));
      return { bids, asks };
    },
  });
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
