import { useQuery } from "@tanstack/react-query";
import { suiClient } from "@/lib/sui-client";
import { ORIGINAL_PACKAGE_ID } from "@/lib/constants";

/**
 * Cumulative volume of the in-house HashShare market, derived by summing
 * `gross_mist` across every `BuyOrderFilled` + `SellOrderFilled` event the
 * package has ever emitted.
 *
 * Naming note: the on-chain field is `gross_mist` for historical reasons
 * (the market launched SUI-quoted); on the mainnet USDC market every value
 * is denominated in µUSDC. We expose it via `quoteBaseUnits` so the UI
 * doesn't need to know that detail.
 *
 * Scope: this is a market-wide volume across ALL HashShare round coins
 * (HS_000…HS_007) and ALL quote tokens combined. The event payload doesn't
 * carry the order's type parameters, so per-round / per-quote attribution
 * would require a separate `multiGetObjects` pass per order id. Until
 * we need that, the single number is honest enough for a KPI surface.
 *
 * Pagination: the hook walks every event page up to a hard cap of 50
 * pages (5k events). On mainnet that's effectively unbounded for the
 * current launch volume; if the protocol crosses that threshold we'll
 * switch to a cursor-pinned incremental aggregator.
 */
export function useMarketVolume() {
  return useQuery<{
    quoteBaseUnits: bigint;
    fills: number;
    fees: bigint;
  }>({
    queryKey: ["marketVolume", ORIGINAL_PACKAGE_ID],
    enabled: !!ORIGINAL_PACKAGE_ID,
    refetchInterval: 30_000,
    staleTime: 15_000,
    queryFn: async () => {
      if (!ORIGINAL_PACKAGE_ID) {
        return { quoteBaseUnits: 0n, fills: 0, fees: 0n };
      }
      const types = [
        `${ORIGINAL_PACKAGE_ID}::hash_share_market::BuyOrderFilled`,
        `${ORIGINAL_PACKAGE_ID}::hash_share_market::SellOrderFilled`,
      ];
      let total = 0n;
      let totalFees = 0n;
      let fills = 0;
      for (const t of types) {
        let cursor: { eventSeq: string; txDigest: string } | null = null;
        for (let page = 0; page < 50; page += 1) {
          const r = await suiClient.queryEvents({
            query: { MoveEventType: t },
            order: "descending",
            limit: 100,
            cursor,
          });
          for (const ev of r.data) {
            const j = ev.parsedJson as Record<string, string>;
            const g = j.gross_mist ? BigInt(j.gross_mist) : 0n;
            const f = j.fee_mist ? BigInt(j.fee_mist) : 0n;
            if (g > 0n) {
              total += g;
              totalFees += f;
              fills += 1;
            }
          }
          if (!r.hasNextPage || !r.nextCursor) break;
          cursor = r.nextCursor;
        }
      }
      return { quoteBaseUnits: total, fills, fees: totalFees };
    },
  });
}
