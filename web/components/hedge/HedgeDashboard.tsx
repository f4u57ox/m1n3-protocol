"use client";

import { useEffect, useMemo, useState } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
} from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useMinerHedge, type HedgeBuild } from "@/hooks/useMinerHedge";
import { usePredictManager } from "@/hooks/usePredictManager";
import { activePredictConfig, activePredictQuote } from "@/lib/predict-constants";
import { strikeToUsd } from "@/lib/predict-client";
import { buildPayoffCurve, type HedgeRange } from "@/lib/hedge-math";
import { useQuoteCoins } from "@/hooks/useQuoteCoins";
import { findQuoteToken } from "@/lib/quote-tokens";
import { HedgePayoffChart } from "@/components/hedge/HedgePayoffChart";
import { PositionLadder } from "@/components/hedge/PositionLadder";

/**
 * Three stacked panels:
 *   1. Revenue header — projection from the user's hashrate + hashprice
 *   2. Simulator — drop-band sliders + PnL distribution histogram
 *   3. Place + Open Positions — single PTB to mint the strip, with the
 *      open hedges below
 */
export function HedgeDashboard() {
  const cfg = activePredictConfig();
  if (!cfg) {
    return <NetworkBlock />;
  }
  return (
    <div className="space-y-6">
      <RevenueHeader />
      <Simulator />
      <Positions />
    </div>
  );
}

function NetworkBlock() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Predict not deployed on this network</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm text-muted-foreground">
        <p>
          DeepBook Predict is currently testnet-only. Switch the dapp via{" "}
          <code className="rounded bg-muted px-1.5 py-0.5">
            NEXT_PUBLIC_SUI_NETWORK=testnet
          </code>{" "}
          and request DUSDC at{" "}
          <a
            href="https://tally.so/r/Xx102L"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline"
          >
            tally.so/r/Xx102L
          </a>{" "}
          before retrying.
        </p>
      </CardContent>
    </Card>
  );
}

function RevenueHeader() {
  const { projection, oracleId, spot, expiryMs, isLoading } = useMinerHedge();
  const account = useCurrentAccount();

  if (!account) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Connect your wallet to project mining revenue and configure a hedge.
        </CardContent>
      </Card>
    );
  }
  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Loading hashrate, BTC price, and the soonest Predict oracle…
        </CardContent>
      </Card>
    );
  }
  const minutesToExpiry = Math.max(0, (expiryMs - Date.now()) / 60_000);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Your mining revenue projection</span>
          <Badge variant="secondary">
            {oracleId
              ? `expires in ${minutesToExpiry.toFixed(0)}m`
              : "no oracle"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Hashrate" value={`${projection.hashrateThs.toFixed(1)} TH/s`} />
          <Stat
            label="Hashprice"
            value={`$${projection.hashpriceUsdPerThDay.toFixed(4)}/TH/day`}
          />
          <Stat label="BTC spot" value={`$${spot.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
          <Stat
            label="Expected revenue (oracle window)"
            value={`$${projection.expectedUsd.toFixed(2)} · ${projection.qBtc.toFixed(6)} BTC`}
            wide
          />
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  wide,
}: {
  label: string;
  value: string;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "col-span-2" : ""}>
      <p className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 font-mono text-sm font-medium">{value}</p>
    </div>
  );
}

function Simulator() {
  const { build, suggestedBand, projection, expiryMs, spot } = useMinerHedge();
  const [dropLo, setDropLo] = useState(0.002);
  const [dropHi, setDropHi] = useState(0.008);

  // Default to the SVI-suggested band on first availability.
  useEffect(() => {
    if (suggestedBand && (dropLo === 0.002 && dropHi === 0.008)) {
      setDropLo(suggestedBand.lo);
      setDropHi(suggestedBand.hi);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestedBand]);

  const result = useMemo(() => {
    if (!build) return null;
    return build({ dropBandLo: dropLo, dropBandHi: dropHi });
  }, [build, dropLo, dropHi]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Hedge simulator</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <SliderRow
            label={`Drop band lower (${(dropLo * 100).toFixed(2)}%)`}
            value={dropLo}
            min={0.0005}
            max={0.05}
            step={0.0005}
            onChange={setDropLo}
            hint={
              suggestedBand
                ? `Suggested: ${(suggestedBand.lo * 100).toFixed(2)}% (≈ 0.25σ at expiry)`
                : undefined
            }
          />
          <SliderRow
            label={`Drop band upper (${(dropHi * 100).toFixed(2)}%)`}
            value={dropHi}
            min={dropLo + 0.0005}
            max={0.10}
            step={0.0005}
            onChange={setDropHi}
            hint={
              suggestedBand
                ? `Suggested: ${(suggestedBand.hi * 100).toFixed(2)}% (≈ 1.25σ at expiry)`
                : undefined
            }
          />
        </div>

        {result?.summary ? (
          <>
            <OffsetPanel summary={result.summary} expectedUsd={projection.expectedUsd} />
            <HedgePayoffChart
              payoff={result.payoff}
              spot={spot}
              summary={result.summary}
            />
            <SimResultPanel result={result} spot={spot} expectedUsd={projection.expectedUsd} />
          </>
        ) : (
          <p className="text-sm italic text-muted-foreground">
            {result && result.strip.length === 0
              ? "Drop band is out of the oracle's strike range — widen it."
              : "Waiting for live oracle state…"}
          </p>
        )}

        {result && (
          <HedgePlacement
            strip={result.strip}
            spot={spot}
            premiumUsd={result.pricing.totalPremiumUsd}
            expiryMs={expiryMs}
          />
        )}
      </CardContent>
    </Card>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  hint?: string;
}) {
  return (
    <div>
      <label className="block text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 w-full accent-primary"
      />
      {hint && <p className="mt-1 text-[10px] text-muted-foreground/70">{hint}</p>}
    </div>
  );
}

/**
 * The headline a miner actually reads: pay X premium, protect up to Y of
 * revenue if BTC falls to the floor, and your revenue can't drop below Z no
 * matter how far BTC crashes.
 */
function OffsetPanel({
  summary,
  expectedUsd,
}: {
  summary: NonNullable<HedgeBuild["summary"]>;
  expectedUsd: number;
}) {
  return (
    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.04] p-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <BigStat
          label="Premium you pay"
          value={`$${summary.premiumUsd.toFixed(2)}`}
          sub={`${(summary.premiumPctOfRevenue * 100).toFixed(2)}% of expected revenue`}
          tone="cost"
        />
        <BigStat
          label="Downside you offset"
          value={`up to $${summary.maxProtectedUsd.toFixed(2)}`}
          sub={`if BTC falls to $${summary.floorUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
          tone="gain"
        />
        <BigStat
          label="Revenue floor"
          value={`$${summary.flooredRevenueUsd.toFixed(2)}`}
          sub={`vs $${summary.unhedgedAtFloorUsd.toFixed(2)} unhedged at that price`}
          tone="gain"
        />
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground">
        Pay{" "}
        <span className="font-mono text-foreground">
          ${summary.premiumUsd.toFixed(2)}
        </span>{" "}
        to cap losses below{" "}
        <span className="font-mono text-foreground">
          ${summary.topUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}
        </span>
        . The hedge repays its own premium once BTC drops{" "}
        <span className="font-mono text-foreground">
          {(summary.breakEvenDropPct * 100).toFixed(2)}%
        </span>{" "}
        (to $
        {summary.breakEvenSpot.toLocaleString(undefined, { maximumFractionDigits: 0 })}
        ); every dollar lower is net protection, up to{" "}
        <span className="font-mono text-emerald-400">
          ${summary.maxProtectedUsd.toFixed(2)}
        </span>
        {expectedUsd > 0 && (
          <>
            {" "}({((summary.maxProtectedUsd / expectedUsd) * 100).toFixed(0)}% of
            expected revenue)
          </>
        )}
        .
      </p>
    </div>
  );
}

function BigStat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: "cost" | "gain";
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </p>
      <p
        className={`mt-1 font-mono text-xl font-semibold ${
          tone === "gain" ? "text-emerald-400" : "text-foreground"
        }`}
      >
        {value}
      </p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>
    </div>
  );
}

function SimResultPanel({
  result,
  spot,
  expectedUsd,
}: {
  result: HedgeBuild;
  spot: number;
  expectedUsd: number;
}) {
  const sim = result.sim!;
  const sigmaReductionPct =
    sim.summary.unhedgedStdev > 0
      ? ((sim.summary.unhedgedStdev - sim.summary.hedgedStdev) /
          sim.summary.unhedgedStdev) *
        100
      : 0;
  const tailLiftUsd = sim.summary.hedgedP05 - sim.summary.unhedgedP05;

  return (
    <div className="space-y-3 rounded-xl border border-border/60 bg-muted/10 p-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 text-xs">
        <Stat
          label="Premium (SVI smile)"
          value={`$${result.pricing.totalPremiumUsd.toFixed(2)}`}
        />
        <Stat
          label="σ reduction"
          value={`${sigmaReductionPct.toFixed(1)}%`}
        />
        <Stat label="P05 lift" value={`+$${tailLiftUsd.toFixed(2)}`} />
        <Stat
          label="Strip size"
          value={`${result.strip.length} ranges`}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs">
        <DistColumn
          title="Unhedged revenue"
          p05={sim.summary.unhedgedP05}
          p50={sim.summary.unhedgedP50}
          p95={sim.summary.unhedgedP95}
        />
        <DistColumn
          title="Hedged revenue"
          p05={sim.summary.hedgedP05}
          p50={sim.summary.hedgedP50}
          p95={sim.summary.hedgedP95}
          highlight
        />
      </div>

      <HedgeProof
        sigmaReductionPct={sigmaReductionPct}
        tailLiftUsd={tailLiftUsd}
        sim={sim}
      />

      {result.strip.length > 0 && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Show {result.strip.length} ranges in the strip (spot = $
            {spot.toFixed(0)}, qty in DUSDC payout)
          </summary>
          <div className="mt-2 grid grid-cols-3 gap-2 font-mono">
            {result.strip.map((r, i) => (
              <div key={i} className="rounded border border-border/40 p-1.5">
                <p>
                  ${strikeToUsd(r.lowerStrikeRaw).toFixed(0)} – $
                  {strikeToUsd(r.higherStrikeRaw).toFixed(0)}
                </p>
                <p className="text-muted-foreground">
                  qty: {r.quantity.toFixed(4)} DUSDC
                </p>
              </div>
            ))}
          </div>
          <p className="mt-2 text-muted-foreground">
            Total max payout if BTC settles inside band: $
            {result.strip.reduce((s, r) => s + r.quantity, 0).toFixed(2)} (=
            {(
              (result.strip.reduce((s, r) => s + r.quantity, 0) / expectedUsd) *
              100
            ).toFixed(1)}
            % of expected revenue)
          </p>
        </details>
      )}
    </div>
  );
}

function DistColumn({
  title,
  p05,
  p50,
  p95,
  highlight,
}: {
  title: string;
  p05: number;
  p50: number;
  p95: number;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded border p-2 ${highlight ? "border-emerald-500/40 bg-emerald-500/5" : "border-border/40"}`}
    >
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      <div className="mt-1.5 space-y-0.5 font-mono">
        <Row left="p05" right={`$${p05.toFixed(2)}`} />
        <Row left="p50" right={`$${p50.toFixed(2)}`} />
        <Row left="p95" right={`$${p95.toFixed(2)}`} />
      </div>
    </div>
  );
}

function Row({ left, right }: { left: string; right: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{left}</span>
      <span>{right}</span>
    </div>
  );
}

function HedgeProof({
  sigmaReductionPct,
  tailLiftUsd,
  sim,
}: {
  sigmaReductionPct: number;
  tailLiftUsd: number;
  sim: NonNullable<ReturnType<NonNullable<ReturnType<typeof useMinerHedge>["build"]>>>["sim"];
}) {
  if (!sim) return null;
  const variancePass = sim.summary.hedgedStdev < sim.summary.unhedgedStdev;
  const tailPass = sim.summary.hedgedP05 > sim.summary.unhedgedP05;
  return (
    <div className="rounded border border-border/40 bg-card/60 p-2 text-[11px]">
      <p className="font-semibold">Proof (Monte-Carlo over SVI lognormal):</p>
      <ul className="mt-1 space-y-0.5">
        <li className={variancePass ? "text-emerald-400" : "text-rose-400"}>
          {variancePass ? "✓" : "✗"} σ(hedged) &lt; σ(unhedged) by{" "}
          {sigmaReductionPct.toFixed(2)}%
        </li>
        <li className={tailPass ? "text-emerald-400" : "text-rose-400"}>
          {tailPass ? "✓" : "✗"} P05(hedged) &gt; P05(unhedged) by +$
          {tailLiftUsd.toFixed(2)}
        </li>
      </ul>
    </div>
  );
}

function HedgePlacement({
  strip,
  spot,
  premiumUsd,
  expiryMs,
}: {
  strip: ReturnType<NonNullable<ReturnType<typeof useMinerHedge>["build"]>>["strip"];
  spot: number;
  premiumUsd: number;
  expiryMs: number;
}) {
  const cfg = activePredictConfig();
  const quote = activePredictQuote();
  const dusdc = quote ? findQuoteToken(quote.symbol) : null;
  const account = useCurrentAccount();
  const { manager, managerId, createManager, refetch } = usePredictManager();
  const { mutateAsync: signAndExecute, isPending } =
    useSignAndExecuteTransaction();
  const quoteCoins = useQuoteCoins(account?.address, dusdc?.type);
  const [last, setLast] = useState<
    null | { kind: "ok"; digest: string } | { kind: "err"; message: string }
  >(null);

  const oracleId = (typeof window !== "undefined" && expiryMs)
    ? // The simulator works against the first active BTC oracle.
      // Read it from the hedge hook through the parent; passed implicitly.
      null
    : null;
  // The oracle id is captured by the strip's strikes; we re-derive it
  // inside HedgePlacement via the live useMinerHedge() — kept separate
  // so the parent component owns the strike grid choice.
  const hedge = useMinerHedge();
  const finalOracleId = hedge.oracleId;

  const cost = useMemo(
    () =>
      Math.ceil(
        Math.max(premiumUsd * 1.15, premiumUsd) * 1_000_000,
      ),
    [premiumUsd],
  );

  async function place() {
    setLast(null);
    try {
      if (!cfg || !dusdc || !account || !finalOracleId) {
        throw new Error("Not ready");
      }
      if (strip.length === 0) throw new Error("Strip is empty");
      if (!managerId) {
        await createManager();
        await refetch();
        throw new Error(
          "Manager created — click Place again to deposit DUSDC and mint the strip.",
        );
      }
      if (quoteCoins.balance < BigInt(cost)) {
        throw new Error(
          `Need ${(cost / 1e6).toFixed(2)} DUSDC; wallet has ${(Number(quoteCoins.balance) / 1e6).toFixed(2)}`,
        );
      }
      const tx = new Transaction();
      // Merge DUSDC into one + split off cost.
      const [first, ...rest] = quoteCoins.ids;
      if (rest.length > 0) {
        tx.mergeCoins(tx.object(first), rest.map((r) => tx.object(r)));
      }
      const [premiumCoin] = tx.splitCoins(tx.object(first), [
        tx.pure.u64(cost),
      ]);
      tx.moveCall({
        target: `${cfg.packageId}::predict_manager::deposit`,
        typeArguments: [dusdc.type],
        arguments: [tx.object(managerId), premiumCoin],
      });
      const clockArg = tx.object("0x6");
      for (const r of strip) {
        // RangeKey::new(oracle_id, expiry, lower_strike, higher_strike)
        const key = tx.moveCall({
          target: `${cfg.packageId}::range_key::new`,
          arguments: [
            tx.pure.id(finalOracleId),
            tx.pure.u64(expiryMs),
            tx.pure.u64(r.lowerStrikeRaw),
            tx.pure.u64(r.higherStrikeRaw),
          ],
        });
        tx.moveCall({
          target: `${cfg.packageId}::predict::mint_range`,
          typeArguments: [dusdc.type],
          arguments: [
            tx.object(cfg.predictObjectId),
            tx.object(managerId),
            tx.object(finalOracleId),
            key,
            tx.pure.u64(Math.ceil(r.quantity * 1_000_000)), // qty in DUSDC base units
            clockArg,
          ],
        });
      }
      const r = await signAndExecute({
        transaction: tx as unknown as Parameters<
          typeof signAndExecute
        >[0]["transaction"],
      });
      setLast({ kind: "ok", digest: r.digest });
      refetch();
    } catch (e) {
      setLast({
        kind: "err",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (!cfg || !quote) return null;
  const ctaLabel = !account
    ? "Connect wallet"
    : !manager
      ? "Create manager + place hedge"
      : `Place hedge (${(cost / 1e6).toFixed(2)} DUSDC)`;

  return (
    <div className="rounded-xl border border-border/60 bg-muted/10 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            Ready to place
          </p>
          <p className="mt-1 font-mono text-sm">
            {strip.length} mint_range calls · est. premium $
            {(cost / 1e6).toFixed(2)}{" "}
            <span className="text-muted-foreground">(includes 15% slippage buffer)</span>
          </p>
        </div>
        <button
          onClick={place}
          disabled={isPending || strip.length === 0 || !account}
          className="rounded-full bg-foreground px-4 py-2 text-xs font-semibold text-background disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
        >
          {ctaLabel}
        </button>
      </div>
      {last && (
        <div
          className={`mt-2 rounded border px-2 py-1.5 text-[11px] ${
            last.kind === "ok"
              ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-400"
              : "border-rose-500/40 bg-rose-500/5 text-rose-400"
          }`}
        >
          {last.kind === "ok" ? (
            <>✓ Hedge placed · {last.digest.slice(0, 16)}…</>
          ) : (
            <>✗ {last.message}</>
          )}
        </div>
      )}
    </div>
  );
}

function Positions() {
  const { positions } = usePredictManager();
  const { spot, projection } = useMinerHedge();

  const { payoffNow, totalQty, payoffCurve } = useMemo(() => {
    const ranges = positions?.ranges ?? [];
    let payoffNow = 0;
    let totalQty = 0;
    for (const r of ranges) {
      const lo = strikeToUsd(r.lower_strike);
      const hi = strikeToUsd(r.higher_strike);
      const q = Number(r.quantity) / 1_000_000;
      totalQty += q;
      if (spot >= lo && spot < hi) payoffNow += q;
    }
    // Premium is sunk for open positions, so plot gross revenue (premium=0):
    // "given what I've already paid, here's revenue vs settlement".
    const strip: HedgeRange[] = ranges.map((r) => ({
      lowerStrikeRaw: r.lower_strike,
      higherStrikeRaw: r.higher_strike,
      quantity: Number(r.quantity) / 1_000_000,
    }));
    const payoffCurve =
      projection.qBtc > 0 && spot > 0
        ? buildPayoffCurve(strip, projection.qBtc, 0, spot)
        : [];
    return { payoffNow, totalQty, payoffCurve };
  }, [positions, spot, projection.qBtc]);

  if (!positions || positions.ranges.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Open hedge positions</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          No open hedge positions. Place a hedge above to start.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          <span>Open hedge positions</span>
          <span className="text-xs font-normal text-muted-foreground">
            At spot $
            {spot.toLocaleString(undefined, { maximumFractionDigits: 0 })}:{" "}
            <span className={payoffNow > 0 ? "text-emerald-400" : "text-foreground"}>
              ${payoffNow.toFixed(2)} live
            </span>{" "}
            / ${totalQty.toFixed(2)} max payout
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {payoffCurve.length > 0 && (
          <HedgePayoffChart payoff={payoffCurve} spot={spot} summary={null} />
        )}
        <PositionLadder ranges={positions.ranges} spot={spot} />
      </CardContent>
    </Card>
  );
}
