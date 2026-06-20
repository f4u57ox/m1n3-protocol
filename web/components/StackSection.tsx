"use client";

import Image from "next/image";
import Link from "next/link";

type Pillar = {
  href: string;
  external?: boolean;
  brand: string;
  badge: string;
  title: string;
  tagline: string;
  body: string;
  accent: string;
  Logo: () => React.ReactElement;
};

const M1n3Logo = () => (
  <span className="relative inline-flex items-center">
    <Image
      src="/m1n3w.png"
      alt=""
      width={120}
      height={40}
      className="hidden h-10 w-auto dark:block"
    />
    <Image
      src="/m1n3b.png"
      alt=""
      width={120}
      height={40}
      className="block h-10 w-auto dark:hidden"
    />
  </span>
);

const HashiLogo = () => (
  <span className="inline-flex items-center gap-3">
    <Image
      src="/hashi.svg"
      alt=""
      width={36}
      height={36}
      className="h-9 w-9 [filter:invert(1)] dark:[filter:none]"
    />
    <span className="font-mono text-2xl font-semibold tracking-tight">Hashi</span>
  </span>
);

const DeepBookLogo = () => (
  // Official DeepBook horizontal lockup (868 × 137 — aspect ~6.34 : 1).
  // Light theme uses the all-black variant; dark uses all-white. Render at
  // h-8 (~32px) so its width sits near the m1n3 wordmark visually.
  <span className="inline-flex items-center">
    <Image
      src="/deepbook-white.svg"
      alt="DeepBook"
      width={868}
      height={137}
      className="hidden h-8 w-auto dark:block"
    />
    <Image
      src="/deepbook-black.svg"
      alt="DeepBook"
      width={868}
      height={137}
      className="block h-8 w-auto dark:hidden"
    />
  </span>
);

const pillars: Pillar[] = [
  {
    href: "/m1",
    brand: "m1n3",
    badge: "Mining pool",
    title: "Decentralized PoW pool",
    tagline: "Stratum v1 in, HBTC out.",
    body:
      "Every accepted share is recorded on Sui with the miner's own keypair. " +
      "Round close, payout funding, and reward claim are all permissionless — " +
      "no admin cap touches the reward path.",
    accent: "from-orange-500/15 to-transparent",
    Logo: M1n3Logo,
  },
  {
    href: "https://hashi.systems",
    external: true,
    brand: "Hashi",
    badge: "Trustless BTC bridge",
    title: "Bitcoin lands as HBTC",
    tagline: "Committee-verified deposits, settled on Sui.",
    body:
      "When a round's block is found, the bitcoin reward is bridged through " +
      "Hashi's MPC committee directly into a shared HashiVault<BTC>. " +
      "The reward batch can only be funded by a confirmed Hashi deposit " +
      "bound to that round.",
    accent: "from-blue-500/15 to-transparent",
    Logo: HashiLogo,
  },
  {
    href: "https://deepbook.tech",
    external: true,
    brand: "DeepBook",
    badge: "Sui-native CLOB",
    title: "HashShares trade on DeepBook",
    tagline: "Every share is a Coin<HS_NNN>.",
    body:
      "Per-round HashShare coins are tradeable the moment they are minted. " +
      "The keeper permissionlessly registers each round's HashShare type as " +
      "a DeepBookV3 pool, so price discovery starts the same block a round opens.",
    accent: "from-emerald-500/15 to-transparent",
    Logo: DeepBookLogo,
  },
];

export function StackSection() {
  return (
    <section className="relative z-40 bg-background">
      {/* Subtle gradient seam between the hero and the stack */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-24 h-24 bg-gradient-to-b from-transparent to-background"
      />

      <div className="mx-auto max-w-6xl px-4 py-32 sm:py-40">
        <div className="mx-auto max-w-2xl text-center">
          <p className="font-mono text-xs uppercase tracking-[0.4em] text-muted-foreground">
            The stack
          </p>
          <h2 className="mt-4 text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
            Mining, settled on Sui.
          </h2>
          <p className="mt-5 text-balance text-base text-muted-foreground sm:text-lg">
            m1n3 is a permissionless Bitcoin mining pool on{" "}
            <span className="font-mono text-foreground">Sui</span>, with rewards bridged through{" "}
            <span className="font-mono text-foreground">Hashi</span> and per-share liquidity on{" "}
            <span className="font-mono text-foreground">DeepBook</span>.
          </p>
        </div>

        <div className="mt-20 grid gap-6 md:grid-cols-3">
          {pillars.map((p) => (
            <PillarCard key={p.brand} pillar={p} />
          ))}
        </div>

        <FlowDiagram />
      </div>
    </section>
  );
}

function PillarCard({ pillar }: { pillar: Pillar }) {
  const inner = (
    <div className="group relative h-full overflow-hidden rounded-2xl border border-border/60 bg-card/40 p-7 backdrop-blur transition-colors hover:border-border">
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-0 bg-gradient-to-br opacity-60 transition-opacity group-hover:opacity-100 ${pillar.accent}`}
      />
      <div className="relative flex h-full flex-col">
        <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
          {pillar.badge}
        </p>
        <div className="mt-4 min-h-[44px]">
          <pillar.Logo />
        </div>
        <h3 className="mt-6 text-xl font-semibold tracking-tight">
          {pillar.title}
        </h3>
        <p className="mt-2 font-mono text-xs text-muted-foreground">
          {pillar.tagline}
        </p>
        <p className="mt-5 flex-1 text-sm leading-relaxed text-muted-foreground">
          {pillar.body}
        </p>
        <span className="mt-7 inline-flex items-center gap-1 font-mono text-xs uppercase tracking-[0.25em] text-foreground/80 group-hover:text-foreground">
          {pillar.external ? "Visit" : "Open"} →
        </span>
      </div>
    </div>
  );
  if (pillar.external) {
    return (
      <a href={pillar.href} target="_blank" rel="noreferrer" className="block h-full">
        {inner}
      </a>
    );
  }
  return (
    <Link href={pillar.href} className="block h-full">
      {inner}
    </Link>
  );
}

function FlowDiagram() {
  return (
    <div className="mt-24 rounded-2xl border border-border/60 bg-card/30 p-8 backdrop-blur sm:p-10">
      <p className="text-center font-mono text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
        End-to-end reward flow
      </p>
      <div className="mt-7 grid items-center gap-4 sm:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr]">
        <Step label="Miner submits share" sub="stratum v1 → sidecar" />
        <Arrow />
        <Step label="Block found" sub="BlockFoundClaim frozen on Sui" />
        <Arrow />
        <Step label="HBTC bridged" sub="via Hashi committee" />
        <Arrow />
        <Step label="Claim or trade" sub="reward + HashShare on DeepBook" />
      </div>
    </div>
  );
}

function Step({ label, sub }: { label: string; sub: string }) {
  return (
    <div className="text-center">
      <p className="text-sm font-medium tracking-tight">{label}</p>
      <p className="mt-1 font-mono text-[11px] text-muted-foreground">{sub}</p>
    </div>
  );
}

function Arrow() {
  return (
    <div className="flex items-center justify-center" aria-hidden>
      <svg
        width="28"
        height="14"
        viewBox="0 0 28 14"
        className="text-muted-foreground/60"
        fill="none"
      >
        <path
          d="M0 7 H22 M18 3 L22 7 L18 11"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
