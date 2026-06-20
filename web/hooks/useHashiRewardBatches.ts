import { useQuery } from '@tanstack/react-query';
import { suiClient } from '@/lib/sui-client';
import { ORIGINAL_PACKAGE_ID } from '@/lib/constants';

export interface HashiRewardBatch {
  batchId: string;
  roundId: bigint;
  totalSats: bigint;
  claimDeadlineMs: bigint;
  status: number; // 0 PENDING, 1 FUNDED, 2 COMPLETED, 3 EXPIRED
}

interface CreatedEventFields {
  batch_id: string;
  round_id: string;
  total_sats: string;
}

interface FundedEventFields {
  batch_id: string;
  round_id: string;
  total_sats: string;
  claim_deadline_ms: string;
}

export function useHashiRewardBatches() {
  return useQuery<HashiRewardBatch[]>({
    queryKey: ['hashiRewardBatches', ORIGINAL_PACKAGE_ID],
    enabled: !!ORIGINAL_PACKAGE_ID,
    refetchInterval: 30_000,
    staleTime: 15_000,
    queryFn: async () => {
      const fundedEvents = await suiClient.queryEvents({
        query: { MoveEventType: `${ORIGINAL_PACKAGE_ID}::hashi_rewards::HashiBatchFunded` },
        order: 'descending',
        limit: 50,
      });
      const created = await suiClient.queryEvents({
        query: { MoveEventType: `${ORIGINAL_PACKAGE_ID}::hashi_rewards::HashiBatchCreated` },
        order: 'descending',
        limit: 100,
      });
      const createdMap = new Map<string, CreatedEventFields>();
      for (const e of created.data) {
        const f = e.parsedJson as CreatedEventFields;
        if (f?.batch_id) createdMap.set(f.batch_id, f);
      }
      const out: HashiRewardBatch[] = [];
      for (const e of fundedEvents.data) {
        const f = e.parsedJson as FundedEventFields;
        if (!f?.batch_id) continue;
        out.push({
          batchId: f.batch_id,
          roundId: BigInt(f.round_id ?? '0'),
          totalSats: BigInt(f.total_sats ?? '0'),
          claimDeadlineMs: BigInt(f.claim_deadline_ms ?? '0'),
          status: 1,
        });
      }
      // include pending (created but not funded) for visibility
      for (const [batchId, f] of createdMap.entries()) {
        if (out.find((b) => b.batchId === batchId)) continue;
        out.push({
          batchId,
          roundId: BigInt(f.round_id ?? '0'),
          totalSats: BigInt(f.total_sats ?? '0'),
          claimDeadlineMs: 0n,
          status: 0,
        });
      }
      return out.sort((a, b) => Number(b.roundId - a.roundId));
    },
  });
}
