"use client";

import { useRef, useEffect, useCallback, useState } from "react";
import { useAnimationFrame } from "@/hooks/useAnimationFrame";
import Image from "next/image";
import { CardBeamAnimation } from "@/components/CardBeamAnimation";
import { HERO_BLOCKS } from "@/data/hero-blocks";
import { useHashprice } from "@/hooks/useHashprice";

const GLYPHS = "0123456789abcdef";
const BITCOIN_GLYPH = "\u20BF";

/* ── Tunable Parameters ── */
function getHeroParticleCount(): number {
  const cores = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 4) : 4;
  const dpr = typeof window !== "undefined" ? (window.devicePixelRatio ?? 1) : 1;
  if (cores <= 4 || (dpr >= 2 && cores <= 6)) return 40;
  if (cores <= 8) return 60;
  return 80;
}
const PARTICLE_COUNT = typeof window !== "undefined" ? getHeroParticleCount() : 80;
const BTC_LIFETIME = 100; // frames (~1.7s at 60fps)
const MIN_SPEED = 0.5;
const MAX_SPEED = 2.5;
const CHAR_CYCLE_INTERVAL = 3; // frames between char changes
const VELOCITY_JITTER = 0.05;
const SPEED_CAP = 3.0;
const HEX_OPACITY_MIN = 0.06;
const HEX_OPACITY_MAX = 0.14;
const BTC_OPACITY = 0.25;
const BTC_CHANCE = 0.0003;
const SIZE_BUCKETS = [14, 16, 18, 20, 22, 24] as const;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  char: string;
  isBtc: boolean;
  btcLife: number; // frames remaining as ₿ (0 = not ₿)
  opacity: number;
  size: number;
  frameTick: number;
}

function randomFloat(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

function randomDirection(): { vx: number; vy: number } {
  const angle = Math.random() * Math.PI * 2;
  const speed = randomFloat(MIN_SPEED, MAX_SPEED);
  return { vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed };
}

function createParticle(w: number, h: number): Particle {
  const { vx, vy } = randomDirection();
  return {
    x: Math.random() * w,
    y: Math.random() * h,
    vx,
    vy,
    char: GLYPHS[Math.floor(Math.random() * 16)],
    isBtc: false,
    btcLife: 0,
    opacity: randomFloat(HEX_OPACITY_MIN, HEX_OPACITY_MAX),
    size: SIZE_BUCKETS[Math.floor(Math.random() * SIZE_BUCKETS.length)],
    frameTick: Math.floor(Math.random() * CHAR_CYCLE_INTERVAL),
  };
}

function HeroHashCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<{
    ctx: CanvasRenderingContext2D;
    w: number;
    h: number;
    fgColor: string;
    particles: Particle[];
    fontStrings: Record<number, string>;
  } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;

    let w = 0;
    let h = 0;
    let fgColor = "";

    function readFgColor() {
      const style = getComputedStyle(document.documentElement);
      const raw = style.getPropertyValue("--foreground").trim();
      if (raw) {
        fgColor = `hsl(${raw})`;
      } else {
        fgColor = "hsl(0 0% 98%)";
      }
      if (stateRef.current) stateRef.current.fgColor = fgColor;
    }

    function resize() {
      const rect = canvas!.parentElement!.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas!.width = w * dpr;
      canvas!.height = h * dpr;
      canvas!.style.width = w + "px";
      canvas!.style.height = h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (stateRef.current) {
        stateRef.current.w = w;
        stateRef.current.h = h;
      }
    }

    readFgColor();
    resize();

    const observer = new MutationObserver(() => readFgColor());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement!);

    const particles: Particle[] = [];
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      particles.push(createParticle(w, h));
    }

    const fontStrings: Record<number, string> = {};
    for (const sz of SIZE_BUCKETS) {
      fontStrings[sz] = `${sz}px "JetBrains Mono", monospace`;
    }

    stateRef.current = { ctx, w, h, fgColor, particles, fontStrings };

    return () => {
      observer.disconnect();
      ro.disconnect();
      stateRef.current = null;
    };
  }, []);

  const renderFrame = useCallback(() => {
    const s = stateRef.current;
    if (!s) return;
    const { ctx, particles, fontStrings } = s;
    const w = s.w;
    const h = s.h;
    const fgColor = s.fgColor;

    ctx.clearRect(0, 0, w, h);
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];

      if (!p.isBtc) {
        p.vx += randomFloat(-VELOCITY_JITTER, VELOCITY_JITTER);
        p.vy += randomFloat(-VELOCITY_JITTER, VELOCITY_JITTER);
      }

      const maxSpd = p.isBtc ? 0.3 : SPEED_CAP;
      const minSpd = p.isBtc ? 0.1 : MIN_SPEED;
      const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      if (speed > maxSpd) {
        const scale = maxSpd / speed;
        p.vx *= scale;
        p.vy *= scale;
      } else if (speed < minSpd) {
        const scale = minSpd / speed;
        p.vx *= scale;
        p.vy *= scale;
      }

      p.x += p.vx;
      p.y += p.vy;

      if (p.x < 0) p.x += w;
      else if (p.x > w) p.x -= w;
      if (p.y < 0) p.y += h;
      else if (p.y > h) p.y -= h;

      p.frameTick++;
      if (p.frameTick >= CHAR_CYCLE_INTERVAL) {
        p.frameTick = 0;
        if (p.isBtc) {
          p.btcLife--;
          if (p.btcLife <= 0) {
            p.isBtc = false;
            p.char = GLYPHS[Math.floor(Math.random() * 16)];
            p.opacity = randomFloat(HEX_OPACITY_MIN, HEX_OPACITY_MAX);
          }
        } else if (Math.random() < BTC_CHANCE) {
          p.isBtc = true;
          p.btcLife = BTC_LIFETIME;
          p.char = BITCOIN_GLYPH;
          p.opacity = BTC_OPACITY;
        } else {
          p.char = GLYPHS[Math.floor(Math.random() * 16)];
        }
      }
    }

    for (const sz of SIZE_BUCKETS) {
      ctx.font = fontStrings[sz];
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        if (p.size !== sz) continue;
        ctx.globalAlpha = p.opacity;
        ctx.fillStyle = p.isBtc ? "#f7931a" : fgColor;
        ctx.fillText(p.char, p.x, p.y);
      }
    }

    ctx.globalAlpha = 1;
  }, []);

  useAnimationFrame(renderFrame);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0"
    />
  );
}

const heroBlockCards = HERO_BLOCKS;

function HashpriceDisplay() {
  const { satsPerMegaDelta, usdPerMegaDelta, networkDifficulty, loading, error } =
    useHashprice();

  return (
    <div
      className="mt-6 flex flex-col items-center gap-1 font-mono"
      title="Fair PPS value of one difficulty-1 share, scaled to one million Δ-1 shares. block_reward_sats / network_difficulty."
    >
      <div className="flex items-center justify-center gap-1.5">
        <span className="text-sm opacity-50 text-muted-foreground">{"{"}</span>
        <span className="text-sm text-muted-foreground">share_value</span>
        <span className="text-sm opacity-50">:</span>
        {loading ? (
          <span className="inline-block h-5 w-20 animate-pulse rounded bg-muted" />
        ) : error ? (
          <span className="text-lg font-medium tabular-nums text-destructive/70">
            --err
          </span>
        ) : (
          <>
            <span className="text-lg font-medium text-foreground tabular-nums">
              {satsPerMegaDelta != null ? satsPerMegaDelta.toFixed(2) : "—"}
            </span>
            <span className="text-xs opacity-40">sats/MΔ</span>
          </>
        )}
        <span className="text-sm opacity-50 text-muted-foreground">{"}"}</span>
      </div>
      {!loading && !error && usdPerMegaDelta != null && networkDifficulty != null && (
        <div className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground/60">
          ≈ ${usdPerMegaDelta.toFixed(4)} / MΔ · Δ {(networkDifficulty / 1e12).toFixed(1)}T
        </div>
      )}
    </div>
  );
}

/**
 * Scroll-driven fade-up. Reads window.scrollY and writes inline style on the
 * hero shell so the particle canvas + card beam translate up and fade as the
 * user scrolls into the stack section below.
 *
 * Uses a single rAF-throttled handler so we never write style more than once
 * per frame.
 */
function useHeroScroll() {
  const [v, setV] = useState({ y: 0, p: 0 });
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const h = window.innerHeight || 1;
        const y = window.scrollY;
        // p in 0..1 over the first viewport of scroll.
        const p = Math.max(0, Math.min(1, y / h));
        setV({ y, p });
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  return v;
}

export function Hero() {
  const { p } = useHeroScroll();
  // 0 → 1: opacity fades, content slides up, slight scale-down for parallax depth.
  const opacity = Math.max(0, 1 - p * 1.15);
  const translate = -p * 60; // px
  const scale = 1 - p * 0.04;

  return (
    <section
      className="sticky top-14 z-30 flex h-[calc(100vh-3.5rem)] items-center justify-center overflow-hidden bg-background"
      style={{
        opacity,
        transform: `translateY(${translate}px) scale(${scale})`,
        willChange: "opacity, transform",
        pointerEvents: p > 0.9 ? "none" : "auto",
      }}
    >
      <div className="hero-rise absolute inset-0">
        <HeroHashCanvas />
      </div>

      <div className="relative z-10 flex h-full w-full flex-col">
        {/* Card beam — fills upper portion */}
        <div className="hero-rise flex flex-1 items-center">
          <div className="w-full">
            <CardBeamAnimation blocks={heroBlockCards} />
          </div>
        </div>

        {/* Text + CTA — anchored to bottom; logo + hashprice fade in last */}
        <div className="mx-auto max-w-5xl px-4 pb-8 sm:pb-12 md:pb-16 text-center">
          <div className="hero-logo-in flex justify-center">
            <Image
              src="/m1n3w.png"
              alt="m1n3"
              width={320}
              height={106}
              className="hidden dark:block h-14 w-auto sm:h-20 md:h-[5.25rem]"
              priority
            />
            <Image
              src="/m1n3b.png"
              alt="m1n3"
              width={320}
              height={106}
              className="block dark:hidden h-14 w-auto sm:h-20 md:h-[5.25rem]"
              priority
            />
          </div>
          <div className="hero-late-fade">
            <HashpriceDisplay />
            <ScrollHint />
          </div>
        </div>
      </div>
    </section>
  );
}

function ScrollHint() {
  return (
    <div className="mt-6 sm:mt-8 md:mt-10 flex flex-col items-center gap-1.5 text-[10px] sm:text-xs uppercase tracking-[0.3em] text-muted-foreground/70">
      <span>scroll</span>
      <span aria-hidden className="block h-4 w-px animate-pulse bg-muted-foreground/60" />
    </div>
  );
}
