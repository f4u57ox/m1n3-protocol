"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { timeAgo } from "@/lib/utils";
import type { MinerStatsData } from "@/lib/types";

function getMinerStatus(lastShareTimeMs: number): {
  label: string;
  className: string;
} {
  const elapsed = Date.now() - lastShareTimeMs;
  if (lastShareTimeMs === 0 || elapsed > 3_600_000) {
    return { label: "Inactive", className: "bg-red-500/15 text-red-500 border-red-500/30" };
  }
  if (elapsed > 300_000) {
    return { label: "Idle", className: "bg-yellow-500/15 text-yellow-500 border-yellow-500/30" };
  }
  return { label: "Active", className: "bg-green-500/15 text-green-500 border-green-500/30" };
}

interface MinerCardProps {
  miner: MinerStatsData;
}

export function MinerCard({ miner }: MinerCardProps) {
  const status = getMinerStatus(miner.lastShareTimeMs);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="font-mono text-sm">
            {miner.address}
          </CardTitle>
          <Badge className={status.className}>{status.label}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-muted-foreground">Total Shares</p>
            <p className="font-semibold">{miner.totalShares.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Blocks Found</p>
            <p className="font-semibold">{miner.blocksFound.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Hashrate</p>
            <p className="font-semibold">
              {miner.estimatedHashrate > 0
                ? `${(miner.estimatedHashrate / 1e9).toFixed(2)} GH/s`
                : "—"}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Last Share</p>
            <p className="font-semibold">
              {miner.lastShareTimeMs > 0
                ? timeAgo(miner.lastShareTimeMs)
                : "Never"}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Registered</p>
            <p className="font-semibold">
              {miner.registeredAtMs > 0
                ? new Date(miner.registeredAtMs).toLocaleDateString()
                : "—"}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Round Work</p>
            <p className="font-semibold">
              {miner.currentRoundWork.toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Round Shares</p>
            <p className="font-semibold">
              {miner.currentRoundShares.toLocaleString()}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
