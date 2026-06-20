import { useQuery } from '@tanstack/react-query';
import { suiClient } from '@/lib/sui-client';
import { PACKAGE_ID } from '@/lib/constants';

export interface MinerWorkRecord {
  objectId: string;
  roundId: bigint;
  miner: string;
  netWork: bigint;
}

export function useMinerWorkRecords(owner: string | undefined) {
  return useQuery<MinerWorkRecord[]>({
    queryKey: ['minerWorkRecords', owner, PACKAGE_ID],
    enabled: !!owner && !!PACKAGE_ID,
    refetchInterval: 30_000,
    staleTime: 15_000,
    queryFn: async () => {
      if (!owner) return [];
      const res = await suiClient.getOwnedObjects({
        owner,
        filter: { StructType: `${PACKAGE_ID}::pool::MinerWorkRecord` },
        options: { showContent: true },
      });
      const out: MinerWorkRecord[] = [];
      for (const entry of res.data) {
        const obj = entry.data;
        if (!obj?.content || obj.content.dataType !== 'moveObject') continue;
        const fields = obj.content.fields as Record<string, string>;
        out.push({
          objectId: obj.objectId,
          roundId: BigInt(fields.round_id ?? '0'),
          miner: String(fields.miner ?? ''),
          netWork: BigInt(fields.net_work ?? '0'),
        });
      }
      return out;
    },
  });
}
