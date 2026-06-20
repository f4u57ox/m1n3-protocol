"use client";

import { Hammer, Server, Lock, Hourglass, AlertTriangle } from "lucide-react";

/**
 * Plain-language walkthrough of how a current Bitcoin mining pool works,
 * with the pain points called out as we go. Lives on /info as the
 * before-picture, so the reader has a clean reference when the
 * twelve-step scrollytelling below shows the after.
 *
 * Replaces the older Alice/Bob comparison.
 */
const FLOW = [
  {
    icon: Hammer,
    label: "You",
    body: "You plug in your mining hardware at home or in a hosted facility. It points at a pool's stratum server.",
  },
  {
    icon: Server,
    label: "Pool operator",
    body: "Your ASIC submits work to the pool's server. The pool tallies your share count in their own database — off-chain, internal, opaque.",
    pain: "You can't see their database. You can't audit it. You trust they're counting you fairly.",
  },
  {
    icon: Lock,
    label: "The block",
    body: "When the pool wins a block, the bitcoin reward goes to a wallet the pool controls. Not you, not a multisig, not a smart contract — the pool.",
    pain: "The custody risk is real. Pools have rugged. Pools have been hacked. Pools have just gone quiet.",
  },
  {
    icon: Hourglass,
    label: "The wait",
    body: "Bitcoin requires the coinbase transaction to mature for 100 blocks before it can be spent. That's about 16 hours of doing nothing.",
    pain: "You can't sell. You can't hedge. You can't borrow against future earnings. Just wait.",
  },
  {
    icon: AlertTriangle,
    label: "The payout",
    body: "Eventually the pool sends you a slice. Minus fees. Minus whatever they took for orphans. Minus whatever they decided.",
    pain: "The pool decides what fair is. You take what you're given or move to a different opaque pool.",
  },
];

export function TraditionalPoolExample() {
  return (
    <section className="relative">
      <div className="mx-auto max-w-4xl px-4 py-12 sm:py-16 md:py-20">
        <div className="text-center">
          <p className="font-mono text-[10px] sm:text-[11px] uppercase tracking-[0.3em] sm:tracking-[0.4em] text-muted-foreground">
            How it works today
          </p>
          <h2 className="mt-4 text-balance text-3xl font-semibold tracking-tight sm:text-4xl md:text-5xl">
            A day in a traditional mining pool.
          </h2>
          <p className="mx-auto mt-4 sm:mt-5 max-w-2xl text-balance text-sm sm:text-base md:text-lg text-muted-foreground">
            Before talking about what changes, here&apos;s the picture you live
            with on F2Pool, Foundry, Antpool, Slushpool, and every other
            traditional Bitcoin pool today.
          </p>
        </div>

        <ol className="mt-10 sm:mt-14 space-y-4 sm:space-y-5">
          {FLOW.map((step, i) => (
            <li
              key={step.label}
              className="grid gap-4 rounded-2xl border border-border bg-card/40 p-5 backdrop-blur sm:grid-cols-[auto_1fr] sm:gap-6 sm:p-6"
            >
              <div className="flex shrink-0 items-center gap-3 sm:flex-col sm:items-start">
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-foreground/5 ring-1 ring-border">
                  <step.icon className="h-5 w-5" />
                </span>
                <div className="flex flex-col">
                  <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
                    Step {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="text-sm font-semibold tracking-tight">
                    {step.label}
                  </span>
                </div>
              </div>
              <div>
                <p className="text-sm leading-relaxed text-foreground/90 sm:text-[15px]">
                  {step.body}
                </p>
                {step.pain && (
                  <p className="mt-3 inline-flex items-start gap-2 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300/95 sm:text-sm">
                    <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-rose-400/80">
                      Pain
                    </span>
                    <span>{step.pain}</span>
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>

        <div className="mt-12 sm:mt-16 rounded-2xl border border-border bg-foreground/5 px-5 py-6 sm:px-7 sm:py-7 text-center">
          <p className="font-mono text-[10px] sm:text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
            The shift
          </p>
          <p className="mt-3 text-balance text-base sm:text-lg leading-relaxed">
            m1n3 keeps your hardware. Drops the pool&apos;s database. Bridges
            the bitcoin to a public vault on Sui. Pays out by math, not by
            promise.
          </p>
          <p className="mt-3 text-balance text-sm text-muted-foreground">
            Here&apos;s how, step by step.
          </p>
        </div>
      </div>
    </section>
  );
}
