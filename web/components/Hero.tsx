"use client";

import { useRef, useEffect, useCallback } from "react";
import { useAnimationFrame } from "@/hooks/useAnimationFrame";
import Link from "next/link";
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
  const { difficultyPrice, loading, error } = useHashprice();

  return (
    <div className="mt-6 flex items-center justify-center gap-1.5 font-mono">
      <span className="text-sm opacity-50 text-muted-foreground">{"{"}</span>
      <span className="text-sm text-muted-foreground">difficultyPrice</span>
      <span className="text-sm opacity-50">:</span>
      {loading ? (
        <span className="inline-block h-5 w-16 animate-pulse rounded bg-muted" />
      ) : error ? (
        <span className="text-lg font-medium tabular-nums text-destructive/70">--err</span>
      ) : (
        <>
          <span className="text-lg font-medium text-foreground tabular-nums">
            ${difficultyPrice?.toFixed(0)}
          </span>
          <span className="text-xs opacity-40">/TD</span>
        </>
      )}
      <span className="text-sm opacity-50 text-muted-foreground">{"}"}</span>
    </div>
  );
}

export function Hero() {
  return (
    <section className="fixed inset-0 top-21 z-40 flex items-center justify-center overflow-hidden bg-background">
      <HeroHashCanvas />

      <div className="relative z-10 flex h-full w-full flex-col">
        {/* Card beam — fills upper portion */}
        <div className="flex flex-1 items-center">
          <div className="w-full">
            <CardBeamAnimation blocks={heroBlockCards} />
          </div>
        </div>

        {/* Text + CTA — anchored to bottom */}
        <div className="mx-auto max-w-5xl px-4 pb-16 text-center">
          <div className="flex justify-center">
            <Image
              src="/m1n3w.png"
              alt="m1n3"
              width={320}
              height={106}
              className="hidden dark:block"
              priority
            />
            <Image
              src="/m1n3b.png"
              alt="m1n3"
              width={320}
              height={106}
              className="block dark:hidden"
              priority
            />
          </div>
          <HashpriceDisplay />
        </div>
      </div>
    </section>
  );
}
