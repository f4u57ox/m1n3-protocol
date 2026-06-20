"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { truncateAddress, timeAgo, formatDifficulty } from "@/lib/utils";
import type { DifficultyResetEvent } from "@/lib/types";

interface DifficultyResetLogProps {
  resets: DifficultyResetEvent[];
}

export function DifficultyResetLog({ resets }: DifficultyResetLogProps) {
  if (resets.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
        No difficulty resets recorded yet
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Miner</TableHead>
          <TableHead className="text-right">Old Diff</TableHead>
          <TableHead className="text-right">New Diff</TableHead>
          <TableHead className="text-right">Idle Time</TableHead>
          <TableHead className="text-right">When</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {resets.map((r, i) => (
          <TableRow key={`${r.miner}-${r.timestamp}-${i}`}>
            <TableCell className="font-mono text-xs">
              {truncateAddress(r.miner)}
            </TableCell>
            <TableCell className="text-right">
              {formatDifficulty(r.oldDifficulty)}
            </TableCell>
            <TableCell className="text-right text-green-600 dark:text-green-400">
              {formatDifficulty(r.newDifficulty)}
            </TableCell>
            <TableCell className="text-right">
              {(r.timeSinceLastShareMs / 1000).toFixed(0)}s
            </TableCell>
            <TableCell className="text-right">
              {timeAgo(r.timestamp)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
