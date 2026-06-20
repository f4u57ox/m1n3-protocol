import { useQuery } from "@tanstack/react-query";
import { suiClient } from "@/lib/sui-client";
import { ORIGINAL_PACKAGE_ID } from "@/lib/constants";

/**
 * Look up RoundHistory frozen object IDs per round. RoundHistory is
 * `transfer::freeze_object`'d in `pool::finalize_round`, so it doesn't
 * appear in owned-objects queries. We discover them via the `RoundClosed`
 * event → transaction object_changes.
 */
export function useRoundHistories() {
  return useQuery<Map<bigint, string>>({
    queryKey: ["roundHistories", ORIGINAL_PACKAGE_ID],
    enabled: !!ORIGINAL_PACKAGE_ID,
    refetchInterval: 60_000,
    staleTime: 30_000,
    queryFn: async () => {
      const out = new Map<bigint, string>();
      if (!ORIGINAL_PACKAGE_ID) return out;
      const events = await suiClient.queryEvents({
        query: { MoveEventType: `${ORIGINAL_PACKAGE_ID}::pool::RoundClosed` },
        order: "descending",
        limit: 100,
      });
      // Each event corresponds to one finalize_round tx; pull its
      // objectChanges to find the RoundHistory.
      for (const e of events.data) {
        const fields = e.parsedJson as { round_id?: string };
        if (!fields?.round_id) continue;
        const roundId = BigInt(fields.round_id);
        if (out.has(roundId)) continue; // first (most-recent) wins
        const tx = await suiClient.getTransactionBlock({
          digest: e.id.txDigest,
          options: { showObjectChanges: true },
        });
        for (const c of tx.objectChanges ?? []) {
          if (c.type === "created" && c.objectType.includes("::pool::RoundHistory")) {
            out.set(roundId, c.objectId);
            break;
          }
        }
      }
      return out;
    },
  });
}
