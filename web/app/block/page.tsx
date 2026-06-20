"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useRegisteredBlocks } from "@/hooks/useBlockShares";
import { lookupBlockHash } from "@/lib/block-hashes-client";
import { timeAgo } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { InfoTooltip } from "@/components/ui/info-tooltip";

export default function BlockListingPage() {
  // Fetch registered blocks from on-chain events
  const {
    blocks: registeredBlocks,
    loading: regLoading,
    error: regError,
  } = useRegisteredBlocks();

  // Determine next height to register
  const maxRegisteredHeight =
    registeredBlocks.length > 0
      ? Math.max(...registeredBlocks.map((b) => b.height))
      : -1;
  const nextHeight = maxRegisteredHeight + 1;

  // Fetch the hash for the next-to-register block from local data
  const { data: nextHashData } = useQuery({
    queryKey: ["block-hash-lookup", nextHeight],
    queryFn: () => lookupBlockHash(nextHeight),
    staleTime: Infinity,
  });

  const nextHash = nextHashData?.hashes?.[0]?.hash ?? null;

  // Sort registered blocks ascending (genesis first)
  const sortedBlocks = [...registeredBlocks].sort(
    (a, b) => a.height - b.height,
  );

  return (
    <>
    <title>m1n3 — Blocks</title>
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Block Registry</h1>
          <p className="text-muted-foreground">
            {registeredBlocks.length} Bitcoin block header{registeredBlocks.length !== 1 ? "s" : ""} registered on Sui — node runners earn M1N3 tokens by registering blocks
          </p>
        </div>
        <Link
          href="/block/live"
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary-foreground opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-primary-foreground" />
          </span>
          Live
        </Link>
      </div>

      {regLoading && (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-20 bg-muted rounded animate-pulse" />
          ))}
        </div>
      )}

      {regError && (
        <div className="rounded-lg border bg-destructive/10 p-4 text-center text-destructive text-sm">
          {regError}
        </div>
      )}

      {!regLoading && (
        <div className="space-y-2">
          {/* Registered blocks */}
          {sortedBlocks.map((block) => (
            <Link key={block.height} href={`/block/${block.height}`}>
              <Card className="hover:border-primary/50 transition-colors cursor-pointer">
                <CardContent className="py-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <span className="text-sm font-bold tabular-nums w-20">
                        #{block.height.toLocaleString()}
                      </span>
                      <Badge variant="default">
                        Registered
                        <InfoTooltip text="This block header has been verified and recorded on Sui" />
                      </Badge>
                    </div>
                    <span className="text-xs font-mono text-muted-foreground truncate flex-1">
                      {block.blockHash}
                    </span>
                  </div>
                  <div className="flex gap-6 mt-2 text-xs text-muted-foreground pl-[5.75rem]">
                    <span>Registered {timeAgo(block.registeredAtMs)}</span>
                    <span>
                      Chain work: {block.chainWork}
                      <InfoTooltip text="Cumulative proof-of-work from genesis — measures total chain security" />
                    </span>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}

          {/* Next block to register */}
          <Link href={`/block/${nextHeight}`}>
            <Card className="hover:border-primary/50 transition-colors cursor-pointer border-dashed">
              <CardContent className="py-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="text-sm font-bold tabular-nums w-20">
                      #{nextHeight.toLocaleString()}
                    </span>
                    <Badge variant="outline">
                      Next
                      <InfoTooltip text="The next block a node runner can register to earn M1N3 tokens" />
                    </Badge>
                  </div>
                  <span className="text-xs font-mono text-muted-foreground truncate flex-1">
                    {nextHash ?? "Loading..."}
                  </span>
                </div>
                <div className="flex gap-6 mt-2 text-xs text-muted-foreground pl-[5.75rem]">
                  <span>Registered: ???</span>
                  <span>Chain work: ???</span>
                </div>
              </CardContent>
            </Card>
          </Link>
        </div>
      )}
    </div>
    </>
  );
}
