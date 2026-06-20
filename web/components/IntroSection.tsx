"use client";

import { Shield, Clock, Coins } from "lucide-react";

/**
 * Sits between the Hero and the 12-step scrollytelling pipeline.
 * Frames the contrast the user is about to walk through, in three beats:
 * trust, latency, liquidity. Adapted from /info's intro tab.
 */
const BEATS = [
  {
    icon: Shield,
    title: "Trust the operator. Or don't.",
    old: "Traditional pools run the wallet, hold the keys, validate shares off-chain, and decide whether you got paid.",
    new: "On m1n3 the operator has two cap-gated jobs: register block templates and set difficulty. Every other step is permissionless on-chain.",
    accent: "from-rose-500/10 to-transparent",
  },
  {
    icon: Clock,
    title: "Wait ~16 hours for your share.",
    old: "When a block is found, the coinbase locks for 100 confirmations before the pool can distribute. You hold an IOU.",
    new: "The HashShare for your work is a Coin in your wallet the same Sui transaction the share was accepted. No coinbase maturation.",
    accent: "from-amber-500/10 to-transparent",
  },
  {
    icon: Coins,
    title: "Lose the upside between blocks.",
    old: "Hashrate volatility eats earnings between payouts. Mining is binary — you find a block or you don't.",
    new: "Every accepted share lists on a DeepBookV3 CLOB the moment it's minted. Take the price now, or hold for the round batch.",
    accent: "from-emerald-500/10 to-transparent",
  },
];

export function IntroSection() {
  return (
    <section className="relative z-40 bg-background">
      {/* fade-in from the hero */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-24 h-24 bg-gradient-to-b from-transparent to-background"
      />

      <div className="mx-auto max-w-6xl px-4 py-16 sm:py-24 md:py-32">
        <div className="mx-auto max-w-2xl text-center">
          <p className="font-mono text-[10px] sm:text-[11px] uppercase tracking-[0.35em] sm:tracking-[0.4em] text-muted-foreground">
            Why this exists
          </p>
          <h2 className="mt-4 text-balance text-3xl font-semibold tracking-tight sm:text-4xl md:text-5xl">
            Mining hasn&apos;t changed in 15 years.
          </h2>
          <p className="mt-4 sm:mt-5 text-balance text-sm text-muted-foreground sm:text-base md:text-lg">
            m1n3 is a Bitcoin mining pool with the operator removed from the
            reward path. Shares settle on Sui, rewards bridge through Hashi as
            HBTC, and per-share liquidity lives on DeepBook.
          </p>
        </div>

        <div className="mt-10 sm:mt-14 md:mt-16 grid gap-4 sm:gap-5 md:grid-cols-3">
          {BEATS.map((b) => (
            <div
              key={b.title}
              className="group relative overflow-hidden rounded-2xl border border-border bg-card/40 p-5 sm:p-6 md:p-7 backdrop-blur"
            >
              <div
                aria-hidden
                className={`pointer-events-none absolute inset-0 bg-gradient-to-br opacity-60 ${b.accent}`}
              />
              <div className="relative">
                <span className="grid h-9 w-9 place-items-center rounded-lg bg-foreground/5 ring-1 ring-border">
                  <b.icon className="h-4 w-4" />
                </span>
                <h3 className="mt-5 text-lg font-semibold tracking-tight">
                  {b.title}
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                  <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-rose-400/80">
                    Old way
                  </span>
                  <br />
                  {b.old}
                </p>
                <p className="mt-4 text-sm leading-relaxed text-foreground/95">
                  <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-emerald-400/80">
                    m1n3
                  </span>
                  <br />
                  {b.new}
                </p>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-12 sm:mt-16 flex flex-col items-center gap-3 px-2 text-center">
          <p className="font-mono text-[10px] sm:text-[11px] uppercase tracking-[0.25em] sm:tracking-[0.3em] text-muted-foreground">
            Twelve on-chain steps · scroll to walk through them
          </p>
          <span aria-hidden className="block h-6 sm:h-8 w-px bg-foreground/40" />
        </div>
      </div>
    </section>
  );
}
