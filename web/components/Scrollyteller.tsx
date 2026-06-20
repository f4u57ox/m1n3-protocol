"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { STEPS, type Step } from "@/data/steps";
import { StepDiagram } from "./StepDiagram";

/**
 * Scrollytelling shell.
 *
 * Layout (md+): two columns. Right column is `sticky` and holds the diagram
 * for the currently-active step. Left column scrolls — each step occupies
 * ~100vh and uses IntersectionObserver to flag itself active when it has
 * the most visible coverage on screen.
 *
 * Mobile (<md): single column. Diagram lives inline above each step so the
 * narrative still flows top-to-bottom.
 */
export function Scrollyteller({
  steps,
  headerKicker = "The whole pipeline",
  headerTitle = "Template to claim, in twelve steps.",
  headerLede = "Scroll through. Each step locks the diagram on the right and unpacks who can call it, which Move function fires, and why the trust assumption shrunk one more notch.",
  closingKicker = "Trust assumption",
  closingTitle = "Two operator actions. Everything else is on-chain proof.",
  closingBody,
  showTileGrid = true,
}: {
  steps?: Step[];
  headerKicker?: string;
  headerTitle?: string;
  headerLede?: string;
  closingKicker?: string;
  closingTitle?: string;
  closingBody?: React.ReactNode;
  showTileGrid?: boolean;
} = {}) {
  const data = steps ?? STEPS;
  const [activeIdx, setActiveIdx] = useState(0);
  const refs = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    const obs = new IntersectionObserver(
      (entries) => {
        // Pick the entry with the highest intersection ratio
        let best = -1;
        let bestRatio = 0;
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const idx = Number((e.target as HTMLElement).dataset.idx);
          if (e.intersectionRatio > bestRatio) {
            bestRatio = e.intersectionRatio;
            best = idx;
          }
        }
        if (best >= 0) setActiveIdx(best);
      },
      {
        threshold: [0.3, 0.45, 0.6, 0.75],
        rootMargin: "-15% 0px -35% 0px",
      },
    );
    refs.current.forEach((el) => el && obs.observe(el));
    return () => obs.disconnect();
  }, []);

  const active = data[activeIdx];

  return (
    <div className="relative">
      {/* Page intro */}
      <div className="mx-auto max-w-3xl px-4 pt-10 pb-8 sm:pt-20 sm:pb-14 md:pt-32 md:pb-24 text-center">
        <p className="font-mono text-[10px] sm:text-[11px] uppercase tracking-[0.3em] sm:tracking-[0.4em] text-muted-foreground">
          {headerKicker}
        </p>
        <h1 className="mt-4 text-balance text-3xl font-semibold tracking-tight sm:text-5xl md:text-6xl">
          {headerTitle}
        </h1>
        <p className="mt-4 sm:mt-6 text-balance text-sm text-muted-foreground sm:text-base md:text-lg">
          {headerLede}
        </p>
      </div>

      {/* Progress rail */}
      <ProgressRail count={data.length} activeIdx={activeIdx} />

      <div className="mx-auto grid max-w-7xl gap-6 px-4 pb-12 sm:gap-10 sm:pb-20 md:grid-cols-[1.05fr_1.2fr] md:gap-16 md:pb-32">
        {/* Left — step content stack */}
        <div>
          {data.map((s, i) => (
            <StepBlock
              key={s.id}
              step={s}
              idx={i}
              active={i === activeIdx}
              registerRef={(el) => (refs.current[i] = el)}
            />
          ))}
        </div>

        {/* Right — sticky diagram (md+) */}
        <div className="hidden md:block">
          <div className="sticky top-24 h-[calc(100vh-7rem)]">
            <div className="relative h-full w-full rounded-2xl border border-border bg-card/40 p-6 backdrop-blur">
              <StepDiagram id={active.id} />
            </div>
          </div>
        </div>
      </div>

      <ClosingCard
        kicker={closingKicker}
        title={closingTitle}
        body={closingBody}
        showTileGrid={showTileGrid}
      />
    </div>
  );
}

function StepBlock({
  step, idx, active, registerRef,
}: {
  step: Step; idx: number; active: boolean;
  registerRef: (el: HTMLElement | null) => void;
}) {
  return (
    <section
      ref={registerRef}
      data-idx={idx}
      data-active={active}
      className="step-card py-8 sm:py-12 md:min-h-[80vh] md:py-16"
    >
      <div className="flex items-center gap-3">
        <span className="font-mono text-xs text-muted-foreground">
          {step.index}
        </span>
        <span className="h-px flex-1 bg-border" />
        <span className="font-mono text-[10px] sm:text-[11px] uppercase tracking-[0.25em] sm:tracking-[0.35em] text-muted-foreground truncate">
          {step.chapter}
        </span>
      </div>

      <h2 className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl md:text-4xl">
        {step.title}
      </h2>
      <p className="mt-3 text-balance text-base sm:text-lg leading-relaxed text-foreground/90">
        {step.lede}
      </p>

      {/* Mobile diagram (inline above paragraphs) */}
      <div className="my-5 sm:my-7 md:hidden">
        <div className="relative aspect-square w-full rounded-2xl border border-border bg-card/40 p-1.5 sm:p-2.5">
          <StepDiagram id={step.id} />
        </div>
      </div>

      <div className="mt-5 sm:mt-6 space-y-4 sm:space-y-5 text-[14px] sm:text-[15px] leading-relaxed text-muted-foreground">
        {step.paragraphs.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>

      <dl className="mt-6 sm:mt-8 grid grid-cols-1 gap-3 rounded-xl border border-border/60 bg-muted/20 p-4 sm:p-5 sm:grid-cols-[auto_1fr] sm:gap-x-6">
        <dt className="font-mono text-[10px] sm:text-[11px] uppercase tracking-[0.25em] sm:tracking-[0.3em] text-muted-foreground">
          Who
        </dt>
        <dd className="text-sm">{step.who}</dd>
        <dt className="font-mono text-[10px] sm:text-[11px] uppercase tracking-[0.25em] sm:tracking-[0.3em] text-muted-foreground">
          Move call
        </dt>
        <dd className="font-mono text-[11px] sm:text-xs md:text-sm break-all">{step.move}</dd>
      </dl>
    </section>
  );
}

function ProgressRail({
  count, activeIdx,
}: {
  count: number; activeIdx: number;
}) {
  return (
    <div
      aria-hidden
      className="fixed left-3 top-1/2 z-40 hidden -translate-y-1/2 flex-col items-center gap-2 lg:flex"
    >
      {Array.from({ length: count }).map((_, i) => (
        <span
          key={i}
          className={`h-2 w-2 rounded-full transition-all duration-300 ${
            i === activeIdx
              ? "scale-150 bg-foreground"
              : i < activeIdx
                ? "bg-foreground/60"
                : "bg-border"
          }`}
        />
      ))}
    </div>
  );
}

function ClosingCard({
  kicker,
  title,
  body,
  showTileGrid,
}: {
  kicker: string;
  title: string;
  body?: React.ReactNode;
  showTileGrid: boolean;
}) {
  return (
    <div className="mx-auto max-w-3xl px-4 pb-16 sm:pb-24 md:pb-32 text-center">
      <p className="font-mono text-[10px] sm:text-[11px] uppercase tracking-[0.3em] sm:tracking-[0.4em] text-muted-foreground">
        {kicker}
      </p>
      <h3 className="mt-4 text-balance text-2xl font-semibold tracking-tight sm:text-3xl md:text-4xl">
        {title}
      </h3>
      {body ? (
        <div className="mt-4 sm:mt-5 text-balance text-sm sm:text-base text-muted-foreground">
          {body}
        </div>
      ) : (
        <p className="mt-4 sm:mt-5 text-balance text-sm sm:text-base text-muted-foreground">
          Operators still register templates and set difficulty. Every other
          step — round close, reward funding, claim, share liquidity — is
          permissionless. <span className="font-mono">PoolAdminCap</span> is no
          longer on the path between a share and its payout.
        </p>
      )}
      {showTileGrid && <DappTileGrid />}
    </div>
  );
}

const TILES: { href: string; label: string; sub: string; accent: string }[] = [
  {
    href: "/m1",
    label: "Pool",
    sub: "live state · rounds · miners",
    accent: "from-orange-500/15 to-transparent",
  },
  {
    href: "/marketplace",
    label: "Market",
    sub: "swap · limit · multi-fill",
    accent: "from-emerald-500/15 to-transparent",
  },
  {
    href: "/rewards",
    label: "Rewards",
    sub: "claim your slice of the round batch",
    accent: "from-amber-500/15 to-transparent",
  },
  {
    href: "/templates",
    label: "Templates",
    sub: "registered Bitcoin block templates",
    accent: "from-blue-500/15 to-transparent",
  },
];

function DappTileGrid() {
  return (
    <div className="mt-10 sm:mt-14 grid gap-3 sm:gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
              Open →
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
  );
}
