"use client";

import { useState, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { lookupBlockHash } from "@/lib/block-hashes-client";
import { useBlockDetail } from "@/hooks/useBlockShares";
import { BlockCubeViz } from "@/components/BlockCubeViz";
import { MinerLegend } from "@/components/MinerLegend";
import { BlockByteMap } from "@/components/BlockByteMap";
import { ShareDetailPanel } from "@/components/ShareDetailPanel";

export default function BlockDetailContent() {
  const params = useParams();
  const height = Number(params.height as string);

  const [selectedSubmitter, setSelectedSubmitter] = useState<string | null>(
    null,
  );
  const byteMapRef = useRef<HTMLDivElement>(null);

  // Fetch block hash for this height
  const { data: hashData, isLoading: hashLoading } = useQuery({
    queryKey: ["block-hash-lookup", height],
    queryFn: () => lookupBlockHash(height),
    enabled: !isNaN(height) && height >= 0,
    staleTime: Infinity,
  });

  const blockHash = hashData?.hashes?.[0]?.hash ?? "";
  const totalBlocks = hashData?.total ?? 0;

  // Fetch block detail (header + fragments)
  const {
    headerHex,
    segments,
    fragments,
    fragmentLayouts,
    submitterColors,
    loading: detailLoading,
    error: detailError,
  } = useBlockDetail(blockHash, height);

  // Block is "registered" if it has on-chain fragment submissions OR if its
  // hash was resolved (meaning a BlockHeaderRegistered event exists for this height)
  const isRegistered = fragments.length > 0 || !!blockHash;

  // Reveal the header hex once the block is known to be registered on Sui
  const visibleHeaderHex = isRegistered ? headerHex : null;
  const visibleSegments = isRegistered ? segments : [];

  const loading = hashLoading || detailLoading;
  const error =
    !blockHash && !hashLoading
      ? "Block hash not found for this height"
      : detailError;

  const handleScrollToByteMap = () => {
    byteMapRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  if (isNaN(height) || height < 0) {
    return (
      <div className="space-y-4">
        <Link
          href="/block"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Blocks
        </Link>
        <div className="rounded-lg border bg-destructive/10 p-8 text-center text-destructive">
          Invalid block height
        </div>
      </div>
    );
  }

  // Loading skeleton
  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-8 bg-muted rounded w-64 animate-pulse" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="h-64 bg-muted rounded animate-pulse" />
          <div className="lg:col-span-2 h-64 bg-muted rounded animate-pulse" />
        </div>
        <div className="h-80 bg-muted rounded animate-pulse" />
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="space-y-4">
        <Link
          href="/block"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Blocks
        </Link>
        <div className="rounded-lg border bg-destructive/10 p-8 text-center text-destructive">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link
            href="/block"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" /> Back
          </Link>
          <div>
            <h1 className="text-2xl font-bold">
              Block #{height.toLocaleString()}
            </h1>
            <p className="text-muted-foreground text-sm">
              {isRegistered
                ? `${fragments.length} fragment submissions from ${submitterColors.length} submitter${submitterColors.length !== 1 ? "s" : ""}`
                : "Not yet registered on Sui"}
            </p>
          </div>
        </div>

        {/* Prev / Next navigation */}
        <div className="flex items-center gap-1">
          {height > 0 ? (
            <Link
              href={`/block/${height - 1}`}
              className="inline-flex items-center justify-center rounded-md border bg-background px-3 py-1.5 text-sm hover:bg-accent"
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              {(height - 1).toLocaleString()}
            </Link>
          ) : (
            <span className="inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm text-muted-foreground opacity-50 cursor-not-allowed">
              <ChevronLeft className="h-4 w-4 mr-1" />0
            </span>
          )}
          {totalBlocks > 0 && height < totalBlocks - 1 ? (
            <Link
              href={`/block/${height + 1}`}
              className="inline-flex items-center justify-center rounded-md border bg-background px-3 py-1.5 text-sm hover:bg-accent"
            >
              {(height + 1).toLocaleString()}
              <ChevronRight className="h-4 w-4 ml-1" />
            </Link>
          ) : (
            <span className="inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm text-muted-foreground opacity-50 cursor-not-allowed">
              {(height + 1).toLocaleString()}
              <ChevronRight className="h-4 w-4 ml-1" />
            </span>
          )}
        </div>
      </div>

      {/* Cube + Submitter Legend */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="flex items-center justify-center">
          <BlockCubeViz
            height={height}
            blockHash={blockHash}
            submitterColors={submitterColors}
            fragmentCount={fragmentLayouts.length}
            onClickScroll={handleScrollToByteMap}
          />
        </div>
        <div className="lg:col-span-2">
          <MinerLegend
            submitterColors={submitterColors}
            fragments={fragments}
            selectedSubmitter={selectedSubmitter}
            onSubmitterSelect={setSelectedSubmitter}
          />
        </div>
      </div>

      {/* Byte Map */}
      <div ref={byteMapRef}>
        <BlockByteMap
          headerHex={visibleHeaderHex}
          segments={visibleSegments}
          fragmentLayouts={fragmentLayouts}
          submitterColors={submitterColors}
          fragments={fragments}
          selectedSubmitter={selectedSubmitter}
        />
      </div>

      {/* Header Detail Panel */}
      <ShareDetailPanel
        headerHex={visibleHeaderHex}
        segments={visibleSegments}
        height={height}
        blockHash={blockHash}
      />
    </div>
  );
}
