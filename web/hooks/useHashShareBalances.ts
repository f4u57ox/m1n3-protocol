import { useQuery } from "@tanstack/react-query";
import { suiClient } from "@/lib/sui-client";
import { PACKAGE_ID } from "@/lib/constants";

export interface HashShareBalance {
  /// e.g. "HS_000"
  typeName: string;
  /// e.g. "0xpkg::hs_000::HS_000"
  fullType: string;
  /// Slot index extracted from typeName ("HS_000" → 0)
  slotIdx: number;
  /// Total HashShare balance the address holds in this slot.
  balanceUnits: bigint;
  /// Object IDs of the individual Coin<T> objects (may be > 1 if the
  /// address has received multiple mints into separate coins).
  coinObjectIds: string[];
}

const HS_TYPE_RE = new RegExp(`^${PACKAGE_ID}::hs_(\\d+)::HS_(\\d+)$`);

/**
 * Enumerate the user's per-round `Coin<HS_NNN>` balances. Returns one entry
 * per slot type the address holds at least 1 unit of.
 *
 * Implementation: `getAllCoins` returns every coin owned by the address
 * regardless of type. We filter client-side for the HashShare type pattern
 * so we don't have to know up-front which slots have ever been bound.
 */
export function useHashShareBalances(owner: string | undefined) {
  return useQuery<HashShareBalance[]>({
    queryKey: ["hashShareBalances", owner, PACKAGE_ID],
    enabled: !!owner && !!PACKAGE_ID,
    refetchInterval: 30_000,
    staleTime: 15_000,
    queryFn: async () => {
      if (!owner) return [];
      const acc = new Map<string, HashShareBalance>();
      let cursor: string | null | undefined = undefined;
      // Pagination — getAllCoins caps at 50 per page.
      for (let page = 0; page < 20; page++) {
        const res: {
          data: Array<{ coinType: string; coinObjectId: string; balance: string }>;
          hasNextPage: boolean;
          nextCursor: string | null;
        } = (await suiClient.getAllCoins({
          owner,
          cursor: cursor ?? null,
          limit: 50,
        })) as unknown as {
          data: Array<{ coinType: string; coinObjectId: string; balance: string }>;
          hasNextPage: boolean;
          nextCursor: string | null;
        };
        for (const c of res.data) {
          const m = c.coinType.match(HS_TYPE_RE);
          if (!m) continue;
          const slotIdx = Number(m[1]);
          const typeName = `HS_${m[1]}`;
          let entry = acc.get(c.coinType);
          if (!entry) {
            entry = {
              typeName,
              fullType: c.coinType,
              slotIdx,
              balanceUnits: 0n,
              coinObjectIds: [],
            };
            acc.set(c.coinType, entry);
          }
          entry.balanceUnits += BigInt(c.balance);
          entry.coinObjectIds.push(c.coinObjectId);
        }
        if (!res.hasNextPage) break;
        cursor = res.nextCursor;
      }
      return Array.from(acc.values()).sort((a, b) => a.slotIdx - b.slotIdx);
    },
  });
}
