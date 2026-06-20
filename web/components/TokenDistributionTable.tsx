"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatM1N3 } from "@/lib/utils";
import { timeAgo } from "@/lib/utils";
import type { TokenDistributionEntry } from "@/lib/types";

interface TokenDistributionTableProps {
  distributions: TokenDistributionEntry[];
}

export function TokenDistributionTable({
  distributions,
}: TokenDistributionTableProps) {
  if (distributions.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground">
        No m1n3 tokens minted yet &mdash; waiting for block verifications
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Block Height</TableHead>
          <TableHead className="text-right">Reward (M1N3)</TableHead>
          <TableHead className="text-right">Participants</TableHead>
          <TableHead className="text-right">Per Participant</TableHead>
          <TableHead className="text-right">Time</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {distributions.map((entry, idx) => {
          const perParticipant =
            entry.participantCount > 0
              ? entry.rewardAmount / entry.participantCount
              : 0;

          return (
            <TableRow key={`${entry.blockHeight}-${idx}`}>
              <TableCell className="font-mono">
                {entry.blockHeight.toLocaleString()}
              </TableCell>
              <TableCell className="text-right">
                {formatM1N3(entry.rewardAmount)}
              </TableCell>
              <TableCell className="text-right">
                {entry.participantCount.toLocaleString()}
              </TableCell>
              <TableCell className="text-right">
                {formatM1N3(perParticipant)}
              </TableCell>
              <TableCell className="text-right">
                {entry.timestampMs > 0 ? timeAgo(entry.timestampMs) : "—"}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
