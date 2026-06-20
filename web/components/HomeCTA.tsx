"use client";

import Link from "next/link";

const TILES = [
  {
    href: "/info/",
    kicker: "Story",
    label: "How it works",
    sub: "12 on-chain steps · in plain words",
    accent: "from-foreground/10 to-transparent",
  },
  {
    href: "/marketplace/",
    kicker: "Trade",
    label: "Marketplace",
    sub: "swap · limit · multi-fill",
    accent: "from-emerald-500/15 to-transparent",
  },
  {
    href: "/m1/",
    kicker: "Watch",
    label: "Pool",
    sub: "live rounds · miners · shares",
    accent: "from-orange-500/15 to-transparent",
  },
  {
    href: "/rewards/",
    kicker: "Claim",
    label: "Rewards",
    sub: "your slice of the round batch",
    accent: "from-amber-500/15 to-transparent",
  },
];

export function HomeCTA() {
  return (
    <section className="relative bg-background pb-16 sm:pb-24 md:pb-32">
      <div className="mx-auto max-w-6xl px-4">
        <div className="mx-auto max-w-2xl text-center">
          <p className="font-mono text-[10px] sm:text-[11px] uppercase tracking-[0.3em] sm:tracking-[0.4em] text-muted-foreground">
            Want the full story?
          </p>
          <h2 className="mt-4 text-balance text-3xl font-semibold tracking-tight sm:text-4xl md:text-5xl">
            Twelve on-chain steps replace the operator.
          </h2>
          <p className="mt-4 text-balance text-sm sm:text-base text-muted-foreground">
            See exactly how a share goes from your ASIC to a Bitcoin payout —
            in plain language. Then jump straight into the dapp.
          </p>
          <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/info/"
              className="inline-flex items-center justify-center rounded-full bg-foreground px-7 py-3 font-mono text-xs uppercase tracking-[0.25em] text-background transition-transform hover:scale-[1.02]"
            >
              Walk through it →
            </Link>
            <Link
              href="/docs/"
              className="inline-flex items-center justify-center rounded-full border border-border px-7 py-3 font-mono text-xs uppercase tracking-[0.25em] text-foreground transition-colors hover:bg-accent"
            >
              Read the docs
            </Link>
          </div>
        </div>

        <div className="mt-12 sm:mt-16 grid gap-3 sm:gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {TILES.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              className="group relative overflow-hidden rounded-2xl border border-border bg-card/40 p-4 sm:p-5 text-left backdrop-blur transition-colors hover:border-foreground/40 hover:bg-card"
            >
              <div
                aria-hidden
                className={`pointer-events-none absolute inset-0 bg-gradient-to-br opacity-60 transition-opacity group-hover:opacity-100 ${t.accent}`}
              />
              <div className="relative">
                <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground transition-colors group-hover:text-foreground">
                  {t.kicker} →
                </p>
                <p className="mt-3 text-lg font-semibold tracking-tight">
                  {t.label}
                </p>
                <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                  {t.sub}
                </p>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
