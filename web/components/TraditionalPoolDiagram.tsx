"use client";

import {
  Database,
  Hash,
  Wallet,
  ShieldCheck,
  UserCog,
  Cpu,
  ArrowRight,
  X,
} from "lucide-react";

/**
 * Visual side-by-side: every operator-controlled piece of a traditional
 * pool, and the on-chain mechanism that replaces it on m1n3. The two
 * substitutions worth highlighting are:
 *
 *   1. Custody — pool wallet → Hashi MPC vault (BTC is bridged into a
 *      shared on-chain object, never sits in a single party's wallet).
 *   2. Accountability — pool database → Sui's hash::sha2_256 verifying
 *      every share on-chain, with a public receipt anyone can audit.
 *
 * Replaces the prior text-only walkthrough.
 */
type Slot = {
  icon: typeof Database;
  title: string;
  body: string;
};

type Comparison = {
  label: string;
  traditional: Slot;
  m1n3: Slot;
  tag: string;
};

const COMPARISONS: Comparison[] = [
  {
    label: "Share validation",
    traditional: {
      icon: Database,
      title: "The pool's database",
      body: "Off-chain spreadsheet only the operator can read or modify. You ask their dashboard if a share counted.",
    },
    m1n3: {
      icon: Hash,
      title: "Sui · hash::sha2_256",
      body: "The chain itself runs SHA-256 on the block header and writes a public ShareReceipt. The math is the audit.",
    },
    tag: "Decentralized accountability",
  },
  {
    label: "BTC custody",
    traditional: {
      icon: Wallet,
      title: "The pool's wallet",
      body: "A single key (or operator-controlled multisig) holds every miner's earnings until payout.",
    },
    m1n3: {
      icon: ShieldCheck,
      title: "Hashi MPC vault",
      body: "An independent committee bridges BTC into a shared on-chain vault. No single party — including m1n3 — can drain it.",
    },
    tag: "Decentralized custody",
  },
  {
    label: "Payout decision",
    traditional: {
      icon: UserCog,
      title: "The pool admin",
      body: "Operator picks the split, the fees, the timing. You take what you're given.",
    },
    m1n3: {
      icon: Cpu,
      title: "On-chain claim",
      body: "Each miner pulls their slice with a public proof. Proportional to work. No human decides.",
    },
    tag: "Decentralized payout",
  },
];

export function TraditionalPoolDiagram() {
  return (
    <section className="relative">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:py-16 md:py-20">
        <div className="text-center">
          <p className="font-mono text-[10px] sm:text-[11px] uppercase tracking-[0.3em] sm:tracking-[0.4em] text-muted-foreground">
            How it works today
          </p>
          <h2 className="mt-4 text-balance text-3xl font-semibold tracking-tight sm:text-4xl md:text-5xl">
            Three operator-controlled pieces.
            <br className="hidden sm:inline" />{" "}
            <span className="text-muted-foreground">m1n3 eliminates all three.</span>
          </h2>
          <p className="mx-auto mt-4 sm:mt-5 max-w-2xl text-balance text-sm sm:text-base md:text-lg text-muted-foreground">
            Today&apos;s mining pools rely on a database, a wallet, and an
            admin&apos;s decision. Each one is replaced with code that anyone
            can verify on-chain.
          </p>
        </div>

        <div className="mt-10 sm:mt-14 space-y-4 sm:space-y-5">
          {COMPARISONS.map((c) => (
            <ComparisonRow key={c.label} c={c} />
          ))}
        </div>

        <div className="mt-10 sm:mt-14 grid gap-3 sm:grid-cols-2">
          <Highlight
            kicker="Decentralized accountability"
            body="Sui's hash::sha2_256 runs the same SHA-256 Bitcoin uses, on-chain. Every share has a public receipt the moment it's accepted — no operator database is in the loop."
            accent="text-emerald-400"
          />
          <Highlight
            kicker="Decentralized custody"
            body="The Hashi MPC bridge brings BTC over from Bitcoin signet into a shared HashiVault on Sui. No single key can move the funds. The operator can't 'go quiet.'"
            accent="text-sky-400"
          />
        </div>
      </div>
    </section>
  );
}

function ComparisonRow({ c }: { c: Comparison }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card/40 backdrop-blur">
      <div className="border-b border-border/60 px-5 py-3 sm:px-6 sm:py-4">
        <p className="font-mono text-[10px] sm:text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
          {c.label}
        </p>
      </div>

      {/* Traditional / arrow / m1n3 */}
      <div className="grid gap-0 md:grid-cols-[1fr_auto_1fr]">
        <SlotCard slot={c.traditional} kind="traditional" />
        <div className="flex items-center justify-center border-y border-border/60 bg-muted/10 px-4 py-3 md:border-y-0 md:border-x md:border-border/60 md:px-5 md:py-0">
          <div className="flex items-center gap-2 sm:flex-col sm:gap-2">
            <span className="grid h-7 w-7 sm:h-8 sm:w-8 place-items-center rounded-full bg-rose-500/15">
              <X className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-rose-400" />
            </span>
            <ArrowRight className="h-4 w-4 sm:h-5 sm:w-5 text-muted-foreground md:rotate-0 md:h-5 md:w-5" />
            <span className="grid h-7 w-7 sm:h-8 sm:w-8 place-items-center rounded-full bg-emerald-500/15">
              <ShieldCheck className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-emerald-400" />
            </span>
          </div>
        </div>
        <SlotCard slot={c.m1n3} kind="m1n3" />
      </div>

      <div className="border-t border-border/60 bg-foreground/5 px-5 py-3 text-center sm:px-6 sm:py-4">
        <p className="font-mono text-[10px] sm:text-[11px] uppercase tracking-[0.25em] sm:tracking-[0.3em] text-foreground/80">
          → {c.tag}
        </p>
      </div>
    </div>
  );
}

function SlotCard({ slot, kind }: { slot: Slot; kind: "traditional" | "m1n3" }) {
  const styles =
    kind === "traditional"
      ? "text-foreground/70"
      : "text-foreground";
  const iconBg =
    kind === "traditional"
      ? "bg-rose-500/10 ring-rose-500/20 text-rose-300"
      : "bg-emerald-500/10 ring-emerald-500/30 text-emerald-300";
  const tag =
    kind === "traditional" ? "Today" : "On m1n3";
  const tagColor =
    kind === "traditional"
      ? "text-rose-400/80"
      : "text-emerald-400/90";

  return (
    <div className={`p-5 sm:p-6 ${styles}`}>
      <div className="flex items-center gap-3">
        <span className={`grid h-9 w-9 place-items-center rounded-lg ring-1 ${iconBg}`}>
          <slot.icon className="h-4 w-4" />
        </span>
        <div>
          <p className={`font-mono text-[10px] uppercase tracking-[0.25em] ${tagColor}`}>
            {tag}
          </p>
          <p className="text-base font-semibold tracking-tight">
            {slot.title}
          </p>
        </div>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground sm:text-[15px]">
        {slot.body}
      </p>
    </div>
  );
}

function Highlight({
  kicker,
  body,
  accent,
}: {
  kicker: string;
  body: string;
  accent: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-foreground/5 px-5 py-5 sm:px-6 sm:py-6">
      <p
        className={`font-mono text-[10px] sm:text-[11px] uppercase tracking-[0.3em] ${accent}`}
      >
        {kicker}
      </p>
      <p className="mt-3 text-sm sm:text-[15px] leading-relaxed text-foreground/90">
        {body}
      </p>
    </div>
  );
}
