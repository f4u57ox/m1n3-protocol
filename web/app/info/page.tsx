import Link from "next/link";
import { TraditionalPoolDiagram } from "@/components/TraditionalPoolDiagram";
import { CostChart } from "@/components/CostChart";
import { Scrollyteller } from "@/components/Scrollyteller";
import { LAYMAN_STEPS } from "@/data/steps-layman";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "m1n3 — How it works",
  description:
    "Bitcoin mining without the trust assumption. See how today's pools work, then walk the twelve on-chain steps that replace them.",
};

export default function InfoPage() {
  return (
    <main className="relative -mx-3 sm:-mx-4">
      <div className="mx-auto max-w-6xl px-4 pt-8 sm:pt-16 md:pt-24 text-center">
        <p className="font-mono text-[10px] sm:text-[11px] uppercase tracking-[0.3em] sm:tracking-[0.4em] text-muted-foreground">
          What is m1n3
        </p>
        <h1 className="mt-4 text-balance text-4xl font-semibold tracking-tight sm:text-5xl md:text-6xl">
          A Bitcoin mining pool without a&nbsp;middleman.
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-balance text-sm sm:text-base md:text-lg text-muted-foreground">
          You point your miner at a normal stratum address. Every accepted
          share lands on Sui as proof — signed by your own wallet, not the
          pool&apos;s. Rewards bridge over from Bitcoin and pay out by code,
          not by a company.
        </p>
      </div>

      <TraditionalPoolDiagram />

      <CostChart />

      <Scrollyteller
        steps={LAYMAN_STEPS}
        headerKicker="How m1n3 changes it"
        headerTitle="Template to claim, in twelve steps."
        headerLede="Same mining hardware. Same Bitcoin block. Everything between those two is replaced with on-chain proofs anyone can verify. Scroll through."
        closingKicker="What you should walk away with"
        closingTitle="No operator decides what you earned."
        closingBody={
          <>
            <p>
              On a traditional pool you trust the operator to count your
              shares, hold your bitcoin, mature the coinbase, and finally pay
              you a slice. On m1n3 every one of those steps is replaced with a
              public, on-chain action that anyone can audit — including you.
            </p>
            <p className="mt-3">
              Ready to plug a miner in or set up the pool itself? The setup
              walkthroughs live in the docs.
            </p>
            <p className="mt-5">
              <Link
                href="/docs/getting-started/"
                className="inline-flex items-center justify-center rounded-full bg-foreground px-6 py-3 font-mono text-xs uppercase tracking-[0.25em] text-background transition-transform hover:scale-[1.02]"
              >
                Setup guides in the docs →
              </Link>
            </p>
          </>
        }
        showTileGrid={false}
      />
    </main>
  );
}
