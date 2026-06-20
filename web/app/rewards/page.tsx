"use client";

import { useMemo, useState } from "react";
import { useCurrentAccount, useSignAndExecuteTransaction } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useMinerWorkRecords } from "@/hooks/useMinerWorkRecords";
import { useHashiRewardBatches, type HashiRewardBatch } from "@/hooks/useHashiRewardBatches";
import { useRoundHistories } from "@/hooks/useRoundHistories";
import { useHashShareBalances } from "@/hooks/useHashShareBalances";
import {
  useHashShareBindings,
  useHashShareRedemptions,
} from "@/hooks/useHashShareRedemptions";
import {
  HASHI_REWARD_REGISTRY_ID,
  PACKAGE_ID,
  POOL_OBJECT_ID,
} from "@/lib/constants";

const HBTC_COIN_TYPE =
  process.env.NEXT_PUBLIC_HBTC_COIN_TYPE ?? "0x2::sui::SUI";
const SUI_CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";

function formatSats(sats: bigint): string {
  if (sats === 0n) return "0";
  const btc = Number(sats) / 1e8;
  return `${btc.toFixed(8)} BTC`;
}

function statusLabel(status: number): string {
  return ["PENDING", "FUNDED", "COMPLETED", "EXPIRED"][status] ?? `STATUS_${status}`;
}

// Optional DeepBook explorer base URL. If set, the rewards page surfaces a
// "Trade on DeepBook" link per slot. Falls back to "—" when absent.
const DEEPBOOK_POOL_BASE =
  process.env.NEXT_PUBLIC_DEEPBOOK_POOL_EXPLORER_BASE ?? "";

export default function RewardsPage() {
  const account = useCurrentAccount();
  const records = useMinerWorkRecords(account?.address);
  const batches = useHashiRewardBatches();
  const histories = useRoundHistories();
  const hashshares = useHashShareBalances(account?.address);
  const bindings = useHashShareBindings();
  const redemptions = useHashShareRedemptions();
  const { mutateAsync: signAndExecute, isPending: claiming } =
    useSignAndExecuteTransaction();
  const [lastResult, setLastResult] = useState<
    | null
    | { kind: "ok"; digest: string; round: bigint }
    | { kind: "err"; message: string }
  >(null);

  const configured =
    !!POOL_OBJECT_ID && !!HASHI_REWARD_REGISTRY_ID && !!PACKAGE_ID;

  // round_id → FUNDED batch (most-recent wins)
  const fundedByRound = useMemo(() => {
    const m = new Map<bigint, HashiRewardBatch>();
    for (const b of batches.data ?? []) {
      if (b.status === 1 /* FUNDED */) m.set(b.roundId, b);
    }
    return m;
  }, [batches.data]);

  async function claim(recordObjectId: string, roundId: bigint) {
    setLastResult(null);
    const batch = fundedByRound.get(roundId);
    const history = histories.data?.get(roundId);
    if (!batch || !history) {
      setLastResult({ kind: "err", message: "Batch or RoundHistory not found" });
      return;
    }
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: `${PACKAGE_ID}::hashi_rewards::claim_reward`,
        typeArguments: [HBTC_COIN_TYPE],
        arguments: [
          tx.object(HASHI_REWARD_REGISTRY_ID),
          tx.object(batch.batchId),
          tx.object(recordObjectId),
          tx.object(history),
          tx.object(SUI_CLOCK),
        ],
      });
      // dapp-kit bundles its own @mysten/sui, producing a nominally-different
      // Transaction type. Runtime is identical; cast through unknown.
      const result = await signAndExecute({ transaction: tx as unknown as Parameters<typeof signAndExecute>[0]["transaction"] });
      setLastResult({ kind: "ok", digest: result.digest, round: roundId });
      records.refetch();
      batches.refetch();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setLastResult({ kind: "err", message: msg });
    }
  }

  return (
    <>
      <title>m1n3 — Rewards</title>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Rewards</h1>
          <p className="text-muted-foreground">
            One MinerWorkRecord per (round, miner) pair is created when the round
            accumulator is drained. Claim against a FUNDED HashiRewardBatch to
            redeem your proportional Coin&lt;{HBTC_COIN_TYPE.split("::").pop()}&gt; share.
          </p>
        </div>

        {!configured && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Configuration required</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Set <code>NEXT_PUBLIC_POOL_OBJECT_ID</code> and{" "}
              <code>NEXT_PUBLIC_HASHI_REWARD_REGISTRY_ID</code> in{" "}
              <code>web/.env.local</code> for live data.
            </CardContent>
          </Card>
        )}

        {lastResult && (
          <Card>
            <CardContent className="py-3 text-sm">
              {lastResult.kind === "ok" ? (
                <span className="text-emerald-500">
                  ✓ Claimed round {lastResult.round.toString()} — tx{" "}
                  <code>{lastResult.digest.slice(0, 16)}…</code>
                </span>
              ) : (
                <span className="text-rose-500">✗ {lastResult.message}</span>
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              Your MinerWorkRecords {account ? `(${account.address.slice(0, 8)}…)` : ""}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!account ? (
              <div className="text-sm text-muted-foreground">
                Connect a wallet to see your records.
              </div>
            ) : records.isLoading ? (
              <div className="text-sm text-muted-foreground">Loading…</div>
            ) : !records.data?.length ? (
              <div className="text-sm text-muted-foreground">
                No MinerWorkRecord objects owned by this address.
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="text-left py-1">round</th>
                    <th className="text-right py-1">net_work</th>
                    <th className="text-left py-1">object</th>
                    <th className="text-right py-1"></th>
                  </tr>
                </thead>
                <tbody>
                  {records.data.map((r) => {
                    const batch = fundedByRound.get(r.roundId);
                    const history = histories.data?.get(r.roundId);
                    const canClaim = !!batch && !!history && !!account;
                    return (
                      <tr key={r.objectId} className="font-mono">
                        <td className="py-1">{r.roundId.toString()}</td>
                        <td className="py-1 text-right">{r.netWork.toString()}</td>
                        <td className="py-1">{r.objectId.slice(0, 10)}…</td>
                        <td className="py-1 text-right">
                          {canClaim ? (
                            <Button
                              size="sm"
                              disabled={claiming}
                              onClick={() => claim(r.objectId, r.roundId)}
                            >
                              {claiming ? "Claiming…" : "Claim"}
                            </Button>
                          ) : batch ? (
                            <span className="text-muted-foreground text-xs">
                              waiting for history
                            </span>
                          ) : (
                            <span className="text-muted-foreground text-xs">
                              {batches.isLoading ? "…" : "no funded batch"}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              Your HashShares {account ? `(${account.address.slice(0, 8)}…)` : ""}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!account ? (
              <div className="text-sm text-muted-foreground">
                Connect a wallet to see your HashShare balances.
              </div>
            ) : hashshares.isLoading ? (
              <div className="text-sm text-muted-foreground">Loading…</div>
            ) : !hashshares.data?.length ? (
              <div className="text-sm text-muted-foreground">
                No HashShares yet. Mint them by routing shares through
                <code className="ml-1">hash_share::mint_share</code> at
                submission time (third destination alongside pool reward and
                <code className="ml-1">market::fill_buy_order</code>).
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="text-left py-1">slot</th>
                    <th className="text-left py-1">round</th>
                    <th className="text-right py-1">balance</th>
                    <th className="text-left py-1">venue</th>
                  </tr>
                </thead>
                <tbody>
                  {hashshares.data.map((b) => {
                    const binding = bindings.data?.find(
                      (x) => x.fullType === b.fullType,
                    );
                    const redemption = redemptions.data?.find(
                      (r) => r.fullType === b.fullType,
                    );
                    return (
                      <tr key={b.fullType} className="font-mono">
                        <td className="py-1">{b.typeName}</td>
                        <td className="py-1">
                          {binding ? binding.roundId.toString() : "—"}
                        </td>
                        <td className="py-1 text-right">
                          {b.balanceUnits.toString()}
                        </td>
                        <td className="py-1 space-x-2">
                          {redemption ? (
                            <span className="text-emerald-500">
                              redemption open
                            </span>
                          ) : (
                            <span className="text-muted-foreground">
                              pre-close
                            </span>
                          )}
                          <a
                            className="underline text-xs"
                            href={`/marketplace?coin=${encodeURIComponent(b.fullType)}`}
                          >
                            m1n3 market
                          </a>
                          {DEEPBOOK_POOL_BASE ? (
                            <a
                              className="underline text-xs"
                              href={`${DEEPBOOK_POOL_BASE}/${encodeURIComponent(b.fullType)}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              DeepBook
                            </a>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Recent HashiRewardBatches</CardTitle>
          </CardHeader>
          <CardContent>
            {batches.isLoading ? (
              <div className="text-sm text-muted-foreground">Loading…</div>
            ) : !batches.data?.length ? (
              <div className="text-sm text-muted-foreground">No batches.</div>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="text-left py-1">round</th>
                    <th className="text-right py-1">subsidy</th>
                    <th className="text-left py-1">status</th>
                    <th className="text-left py-1">batch</th>
                  </tr>
                </thead>
                <tbody>
                  {batches.data.map((b) => (
                    <tr key={b.batchId} className="font-mono">
                      <td className="py-1">{b.roundId.toString()}</td>
                      <td className="py-1 text-right">{formatSats(b.totalSats)}</td>
                      <td className="py-1">{statusLabel(b.status)}</td>
                      <td className="py-1">{b.batchId.slice(0, 10)}…</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
