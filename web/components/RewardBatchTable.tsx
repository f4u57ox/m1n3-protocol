"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { truncateAddress, timeAgo } from "@/lib/utils";
import { REWARD_STATUS_LABELS } from "@/lib/types";
import type { RewardBatchData } from "@/lib/types";

const STATUS_COLORS: Record<number, string> = {
  0: "bg-yellow-500/15 text-yellow-600 border-yellow-500/30",
  1: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  2: "bg-purple-500/15 text-purple-600 border-purple-500/30",
  3: "bg-orange-500/15 text-orange-600 border-orange-500/30",
  4: "bg-green-500/15 text-green-600 border-green-500/30",
};

interface RewardBatchTableProps {
  batches: RewardBatchData[];
}

export function RewardBatchTable({ batches }: RewardBatchTableProps) {
  if (batches.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground">
        No reward batches yet
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Round ID</TableHead>
          <TableHead className="text-right">Miner Count</TableHead>
          <TableHead className="text-right">Total Sats</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>BTC Tx Hash</TableHead>
          <TableHead className="text-right">Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {batches.map((batch) => (
          <TableRow key={batch.id}>
            <TableCell className="font-mono">
              #{batch.roundId}
            </TableCell>
            <TableCell className="text-right">
              {batch.minerCount.toLocaleString()}
            </TableCell>
            <TableCell className="text-right">
              {batch.totalSats.toLocaleString()}
            </TableCell>
            <TableCell>
              <Badge className={STATUS_COLORS[batch.status] ?? ""}>
                {REWARD_STATUS_LABELS[batch.status] ?? "Unknown"}
              </Badge>
            </TableCell>
            <TableCell className="font-mono text-xs">
              {batch.btcTxHash ? (
                <a
                  href={`https://mempool.space/tx/${batch.btcTxHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  {truncateAddress(batch.btcTxHash, 8)}
                </a>
              ) : "—"}
            </TableCell>
            <TableCell className="text-right">
              {batch.createdAtMs > 0 ? timeAgo(batch.createdAtMs) : "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
