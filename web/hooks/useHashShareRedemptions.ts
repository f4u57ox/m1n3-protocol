import { useQuery } from "@tanstack/react-query";
import { suiClient } from "@/lib/sui-client";
import { PACKAGE_ID, ORIGINAL_PACKAGE_ID } from "@/lib/constants";

export interface HashShareSlotBinding {
  roundId: bigint;
  capId: string;
  label: string;
  fullType: string;
}

export interface HashShareRedemptionPool {
  redemptionId: string;
  roundId: bigint;
  totalSats: bigint;
  supplyAtOpen: bigint;
  capId: string;
  fullType: string;
  deadlineMs: bigint;
}

function labelBytesToString(label: unknown): string {
  if (typeof label === "string") return label;
  if (Array.isArray(label)) {
    const bytes = new Uint8Array(label as number[]);
    return new TextDecoder().decode(bytes);
  }
  return "";
}

function labelToFullType(label: string): string {
  // "HS000" or "HS_000" → "<pkg>::hs_000::HS_000". Both forms are
  // produced in the wild — testnet/devnet rounds were registered as
  // "HS000", but mainnet's register-slots script set labels to "HS_000"
  // matching the file/module naming convention. Accept either.
  const m = label.match(/^HS_?(\d+)$/);
  if (!m) return "";
  return `${PACKAGE_ID}::hs_${m[1]}::HS_${m[1]}`;
}

/**
 * Discover (round_id, HashShare type) pairs via `SlotBoundToRound` events.
 * Used by the rewards UI to render which round a HashShare balance belongs
 * to and to surface a "Trade on m1n3 / DeepBook" link for that slot.
 */
export function useHashShareBindings() {
  return useQuery<HashShareSlotBinding[]>({
    queryKey: ["hashShareBindings", ORIGINAL_PACKAGE_ID],
    enabled: !!ORIGINAL_PACKAGE_ID,
    refetchInterval: 60_000,
    staleTime: 30_000,
    queryFn: async () => {
      if (!ORIGINAL_PACKAGE_ID) return [];
      const events = await suiClient.queryEvents({
        query: {
          MoveEventType: `${ORIGINAL_PACKAGE_ID}::hash_share_registry::SlotBoundToRound`,
        },
        order: "descending",
        limit: 100,
      });
      const out: HashShareSlotBinding[] = [];
      for (const e of events.data) {
        const f = e.parsedJson as Record<string, unknown>;
        if (!f?.round_id) continue;
        const label = labelBytesToString(f.label);
        out.push({
          roundId: BigInt(String(f.round_id)),
          capId: String(f.cap_id ?? ""),
          label,
          fullType: labelToFullType(label),
        });
      }
      return out;
    },
  });
}

/**
 * Active per-round redemption pools — the venue where holders burn
 * `Coin<HS_NNN>` for proportional BTC. We get one entry per round that has
 * had `hash_share::open_redemption` called against it.
 */
export function useHashShareRedemptions() {
  return useQuery<HashShareRedemptionPool[]>({
    queryKey: ["hashShareRedemptions", ORIGINAL_PACKAGE_ID],
    enabled: !!ORIGINAL_PACKAGE_ID,
    refetchInterval: 60_000,
    staleTime: 30_000,
    queryFn: async () => {
      if (!ORIGINAL_PACKAGE_ID) return [];
      const events = await suiClient.queryEvents({
        query: {
          MoveEventType: `${ORIGINAL_PACKAGE_ID}::hash_share::RedemptionOpened`,
        },
        order: "descending",
        limit: 100,
      });
      const out: HashShareRedemptionPool[] = [];
      for (const e of events.data) {
        const f = e.parsedJson as Record<string, unknown>;
        if (!f?.round_id || !f?.cap_id) continue;
        const tx = await suiClient.getTransactionBlock({
          digest: e.id.txDigest,
          options: { showObjectChanges: true },
        });
        let redemptionId = "";
        for (const c of tx.objectChanges ?? []) {
          if (c.type === "created" && c.objectType.includes("::hash_share::Redemption<")) {
            redemptionId = c.objectId;
            break;
          }
        }
        if (!redemptionId) continue;
        const labelStr = labelBytesToString((f as Record<string, unknown>).label ?? "");
        out.push({
          redemptionId,
          roundId: BigInt(String(f.round_id)),
          totalSats: BigInt(String(f.total_sats ?? "0")),
          supplyAtOpen: BigInt(String(f.supply_at_open ?? "0")),
          capId: String(f.cap_id),
          fullType: labelToFullType(labelStr),
          deadlineMs: BigInt(String(f.deadline_ms ?? "0")),
        });
      }
      return out;
    },
  });
}
