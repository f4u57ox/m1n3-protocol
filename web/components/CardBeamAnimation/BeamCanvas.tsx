import React, { useEffect, useRef, useCallback } from "react";
import { useAnimationFrame } from "@/hooks/useAnimationFrame";

interface BeamCanvasProps {
  scanningActiveRef: { current: boolean };
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  alpha: number;
  originalAlpha: number;
  decay: number;
  life: number;
  time: number;
  twinkleSpeed: number;
  twinkleAmount: number;
  inFormation: boolean;
}

function randomFloat(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

const BEAM_WIDTH = 3;
const BASE_FADE_ZONE = 60;
const BASE_INTENSITY = 0.8;
const SCAN_INTENSITY = 1.8;
const SCAN_FADE_ZONE = 35;
const TRANSITION_SPEED = 0.05;

// Adaptive particle counts based on device capability
type DeviceTier = "low" | "mid" | "high";
function getDeviceTier(): DeviceTier {
  const cores = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 4) : 4;
  const dpr = typeof window !== "undefined" ? (window.devicePixelRatio ?? 1) : 1;
  // High DPR + few cores = mobile device, likely low/mid
  if (cores <= 4 || (dpr >= 2 && cores <= 6)) return "low";
  if (cores <= 8) return "mid";
  return "high";
}

const PARTICLE_TIERS: Record<DeviceTier, { base: number; scan: number }> = {
  low:  { base: 120, scan: 300 },
  mid:  { base: 200, scan: 450 },
  high: { base: 250, scan: 600 },
};

const SLOW_FRAME_THRESHOLD = 20; // ms
const SLOW_FRAME_COUNT_THRESHOLD = 10;

const BTC_TRIGGER_MIN = 720;
const BTC_TRIGGER_MAX = 1080;
const BTC_CONVERGE_FRAMES = 60;
const BTC_HOLD_FRAMES = 60;
const BTC_DISPERSE_FRAMES = 45;
const BTC_SYMBOL_SIZE = 80;
const BTC_PARTICLE_COUNT = 60;
const BTC_DRIFT_SPEED = 0.5;
const BTC_GLOW_BOOST = 1.8;

interface FormationState {
  phase: "idle" | "converging" | "holding" | "dispersing";
  timer: number;
  nextTrigger: number;
  assignedParticles: number[];
  targetPositions: { x: number; y: number }[];
  originPositions: { x: number; y: number }[];
  centerX: number;
  centerY: number;
}

interface BeamState {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  particles: Particle[];
  formation: FormationState;
  btcShapePoints: { x: number; y: number }[];
  spriteCanvas: HTMLCanvasElement;
  currentIntensity: number;
  currentMaxParticles: number;
  currentFadeZone: number;
  currentGlowIntensity: number;
  // Cached gradients
  cachedScanG3: CanvasGradient | null;
  cachedVertGrad: CanvasGradient | null;
  cachedCoreGrad: CanvasGradient | null;
  cachedG1: CanvasGradient | null;
  cachedG2: CanvasGradient | null;
  lastCachedW: number;
  lastCachedH: number;
  lastCachedFadeZone: number;
  lastCachedGlowIntensity: number;
  // Adaptive performance
  baseMaxParticles: number;
  scanMaxParticles: number;
  slowFrameCount: number;
  lastFrameTime: number;
}

export default function BeamCanvas({ scanningActiveRef }: BeamCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<BeamState | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    if (!canvas) return;

    const ctx = canvas.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;

    // Particle sprite cache
    const spriteCanvas = document.createElement("canvas");
    spriteCanvas.width = 16;
    spriteCanvas.height = 16;
    const spriteCtx = spriteCanvas.getContext("2d")!;
    const half = 8;
    const grad = spriteCtx.createRadialGradient(half, half, 0, half, half, half);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.3, "rgba(253,199,110,0.8)");
    grad.addColorStop(0.7, "rgba(247,147,26,0.4)");
    grad.addColorStop(1, "transparent");
    spriteCtx.fillStyle = grad;
    spriteCtx.beginPath();
    spriteCtx.arc(half, half, half, 0, Math.PI * 2);
    spriteCtx.fill();

    // ₿ shape precomputation
    const btcShapePoints: { x: number; y: number }[] = [];
    {
      const sz = 100;
      const offC = document.createElement("canvas");
      offC.width = sz;
      offC.height = sz;
      const offCtx = offC.getContext("2d")!;
      offCtx.fillStyle = "#fff";
      offCtx.font = `bold ${sz * 0.85}px sans-serif`;
      offCtx.textAlign = "center";
      offCtx.textBaseline = "middle";
      offCtx.fillText("\u20BF", sz / 2, sz / 2);
      const imgData = offCtx.getImageData(0, 0, sz, sz).data;
      const allPts: { x: number; y: number }[] = [];
      const stride = 3;
      for (let py = 0; py < sz; py += stride) {
        for (let px = 0; px < sz; px += stride) {
          if (imgData[(py * sz + px) * 4 + 3] > 128) {
            allPts.push({ x: (px / sz) - 0.5, y: (py / sz) - 0.5 });
          }
        }
      }
      if (allPts.length <= BTC_PARTICLE_COUNT) {
        btcShapePoints.push(...allPts);
      } else {
        const step = allPts.length / BTC_PARTICLE_COUNT;
        for (let i = 0; i < BTC_PARTICLE_COUNT; i++) {
          btcShapePoints.push(allPts[Math.floor(i * step)]);
        }
      }
    }

    const tier = getDeviceTier();

    const s: BeamState = {
      ctx,
      w: 0,
      h: 0,
      particles: [],
      formation: {
        phase: "idle",
        timer: 0,
        nextTrigger: Math.floor(randomFloat(BTC_TRIGGER_MIN, BTC_TRIGGER_MAX)),
        assignedParticles: [],
        targetPositions: [],
        originPositions: [],
        centerX: 0,
        centerY: 0,
      },
      btcShapePoints,
      spriteCanvas,
      currentIntensity: BASE_INTENSITY,
      currentMaxParticles: PARTICLE_TIERS[tier].base,
      currentFadeZone: BASE_FADE_ZONE,
      currentGlowIntensity: 1,
      cachedScanG3: null,
      cachedVertGrad: null,
      cachedCoreGrad: null,
      cachedG1: null,
      cachedG2: null,
      lastCachedW: 0,
      lastCachedH: 0,
      lastCachedFadeZone: -1,
      lastCachedGlowIntensity: -1,
      baseMaxParticles: PARTICLE_TIERS[tier].base,
      scanMaxParticles: PARTICLE_TIERS[tier].scan,
      slowFrameCount: 0,
      lastFrameTime: 0,
    };

    function rebuildGradients() {
      const lightBarX = s.w / 2;
      s.cachedScanG3 = ctx.createLinearGradient(
        lightBarX - BEAM_WIDTH * 8, 0,
        lightBarX + BEAM_WIDTH * 8, 0,
      );
      s.cachedScanG3.addColorStop(0, "rgba(247,147,26,0)");
      s.cachedScanG3.addColorStop(0.5, "rgba(247,147,26,0.2)");
      s.cachedScanG3.addColorStop(1, "rgba(247,147,26,0)");
      s.lastCachedW = s.w;
      s.lastCachedH = s.h;
    }

    function resize() {
      const rect = canvas.parentElement!.getBoundingClientRect();
      s.w = rect.width;
      s.h = rect.height;
      canvas.width = s.w * dpr;
      canvas.height = s.h * dpr;
      canvas.style.width = s.w + "px";
      canvas.style.height = s.h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      rebuildGradients();
    }

    resize();

    // Initialize particles
    function createParticle(): Particle {
      const lightBarX = s.w / 2;
      return {
        x: randomFloat(0, lightBarX - BEAM_WIDTH),
        y: randomFloat(0, s.h),
        vx: randomFloat(0.2, 1.0),
        vy: randomFloat(-0.15, 0.15),
        radius: randomFloat(0.4, 1),
        alpha: randomFloat(0.6, 1),
        originalAlpha: 0,
        decay: randomFloat(0.005, 0.025),
        life: 1.0,
        time: 0,
        twinkleSpeed: randomFloat(0.02, 0.08),
        twinkleAmount: randomFloat(0.1, 0.25),
        inFormation: false,
      };
    }

    for (let i = 0; i < s.baseMaxParticles; i++) {
      const p = createParticle();
      p.originalAlpha = p.alpha;
      s.particles.push(p);
    }

    // Attach createParticle to state for use in render callback
    (s as any)._createParticle = createParticle;
    (s as any)._rebuildGradients = rebuildGradients;

    stateRef.current = s;

    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement!);

    return () => {
      ro.disconnect();
      stateRef.current = null;
    };
  }, []);

  const renderFrame = useCallback(() => {
    const s = stateRef.current;
    if (!s) return;

    const { ctx, particles, formation, btcShapePoints, spriteCanvas } = s;
    const w = s.w;
    const h = s.h;
    const lightBarX = w / 2;
    const scanning = scanningActiveRef.current ?? false;
    const createParticle = (s as any)._createParticle as () => Particle;

    function resetParticle(p: Particle) {
      p.x = randomFloat(0, lightBarX - BEAM_WIDTH);
      p.y = randomFloat(0, h);
      p.vx = randomFloat(0.2, 1.0);
      p.vy = randomFloat(-0.15, 0.15);
      p.alpha = randomFloat(0.6, 1);
      p.originalAlpha = p.alpha;
      p.life = 1.0;
      p.time = 0;
    }

    // Frame-time adaptive throttling
    const now = performance.now();
    if (s.lastFrameTime > 0) {
      const dt = now - s.lastFrameTime;
      if (dt > SLOW_FRAME_THRESHOLD) {
        s.slowFrameCount++;
        if (s.slowFrameCount >= SLOW_FRAME_COUNT_THRESHOLD) {
          // Reduce particle limits by 10%
          s.baseMaxParticles = Math.max(60, Math.floor(s.baseMaxParticles * 0.9));
          s.scanMaxParticles = Math.max(120, Math.floor(s.scanMaxParticles * 0.9));
          s.slowFrameCount = 0;
        }
      } else {
        s.slowFrameCount = Math.max(0, s.slowFrameCount - 1);
      }
    }
    s.lastFrameTime = now;

    // Smooth transitions
    const targetIntensity = scanning ? SCAN_INTENSITY : BASE_INTENSITY;
    const targetMax = scanning ? s.scanMaxParticles : s.baseMaxParticles;
    const targetFade = scanning ? SCAN_FADE_ZONE : BASE_FADE_ZONE;

    s.currentIntensity += (targetIntensity - s.currentIntensity) * TRANSITION_SPEED;
    s.currentMaxParticles += (targetMax - s.currentMaxParticles) * TRANSITION_SPEED;
    s.currentFadeZone += (targetFade - s.currentFadeZone) * TRANSITION_SPEED;

    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, w, h);

    // ── drawLightBar ──
    {
      const fadeZone = s.currentFadeZone;
      const targetGlow = scanning ? 3.5 : 1;
      s.currentGlowIntensity += (targetGlow - s.currentGlowIntensity) * TRANSITION_SPEED;
      const gI = s.currentGlowIntensity;

      // Rebuild cached gradients when inputs change beyond threshold
      const needsRebuild =
        w !== s.lastCachedW ||
        h !== s.lastCachedH ||
        Math.abs(fadeZone - s.lastCachedFadeZone) > 0.01 ||
        Math.abs(gI - s.lastCachedGlowIntensity) > 0.01;

      if (needsRebuild) {
        (s as any)._rebuildGradients();

        // vertGrad — depends on h and fadeZone
        s.cachedVertGrad = ctx.createLinearGradient(0, 0, 0, h);
        s.cachedVertGrad.addColorStop(0, "rgba(255,255,255,0)");
        s.cachedVertGrad.addColorStop(Math.min(fadeZone / h, 0.49), "rgba(255,255,255,1)");
        s.cachedVertGrad.addColorStop(Math.max(1 - fadeZone / h, 0.51), "rgba(255,255,255,1)");
        s.cachedVertGrad.addColorStop(1, "rgba(255,255,255,0)");

        // coreGrad — depends on lightBarX and gI
        s.cachedCoreGrad = ctx.createLinearGradient(
          lightBarX - BEAM_WIDTH / 2, 0,
          lightBarX + BEAM_WIDTH / 2, 0,
        );
        s.cachedCoreGrad.addColorStop(0, "rgba(255,255,255,0)");
        s.cachedCoreGrad.addColorStop(0.3, `rgba(255,255,255,${Math.min(0.9 * gI, 1)})`);
        s.cachedCoreGrad.addColorStop(0.5, `rgba(255,255,255,${Math.min(1 * gI, 1)})`);
        s.cachedCoreGrad.addColorStop(0.7, `rgba(255,255,255,${Math.min(0.9 * gI, 1)})`);
        s.cachedCoreGrad.addColorStop(1, "rgba(255,255,255,0)");

        // g1 — depends on lightBarX and gI
        s.cachedG1 = ctx.createLinearGradient(
          lightBarX - BEAM_WIDTH * 2, 0,
          lightBarX + BEAM_WIDTH * 2, 0,
        );
        s.cachedG1.addColorStop(0, "rgba(247,147,26,0)");
        s.cachedG1.addColorStop(0.5, `rgba(253,199,110,${Math.min(0.8 * gI, 1)})`);
        s.cachedG1.addColorStop(1, "rgba(247,147,26,0)");

        // g2 — depends on lightBarX and gI
        s.cachedG2 = ctx.createLinearGradient(
          lightBarX - BEAM_WIDTH * 4, 0,
          lightBarX + BEAM_WIDTH * 4, 0,
        );
        s.cachedG2.addColorStop(0, "rgba(247,147,26,0)");
        s.cachedG2.addColorStop(0.5, `rgba(247,147,26,${Math.min(0.4 * gI, 1)})`);
        s.cachedG2.addColorStop(1, "rgba(247,147,26,0)");

        s.lastCachedFadeZone = fadeZone;
        s.lastCachedGlowIntensity = gI;
      }

      ctx.globalCompositeOperation = "lighter";

      // Core line
      ctx.globalAlpha = 1;
      ctx.fillStyle = s.cachedCoreGrad!;
      ctx.beginPath();
      ctx.roundRect(lightBarX - BEAM_WIDTH / 2, 0, BEAM_WIDTH, h, 15);
      ctx.fill();

      // Glow layer 1
      ctx.globalAlpha = scanning ? 1.0 : 0.8;
      ctx.fillStyle = s.cachedG1!;
      ctx.beginPath();
      ctx.roundRect(lightBarX - BEAM_WIDTH * 2, 0, BEAM_WIDTH * 4, h, 25);
      ctx.fill();

      // Glow layer 2
      ctx.globalAlpha = scanning ? 0.8 : 0.6;
      ctx.fillStyle = s.cachedG2!;
      ctx.beginPath();
      ctx.roundRect(lightBarX - BEAM_WIDTH * 4, 0, BEAM_WIDTH * 8, h, 35);
      ctx.fill();

      // Glow layer 3
      if (scanning && s.cachedScanG3) {
        ctx.globalAlpha = 0.6;
        ctx.fillStyle = s.cachedScanG3;
        ctx.beginPath();
        ctx.roundRect(lightBarX - BEAM_WIDTH * 8, 0, BEAM_WIDTH * 16, h, 45);
        ctx.fill();
      }

      // Vertical fade mask
      ctx.globalCompositeOperation = "destination-in";
      ctx.globalAlpha = 1;
      ctx.fillStyle = s.cachedVertGrad!;
      ctx.fillRect(0, 0, w, h);
    }

    // ── ₿ formation state machine ──
    if (formation.phase === "idle") {
      formation.timer++;
      if (formation.timer >= formation.nextTrigger && particles.length >= BTC_PARTICLE_COUNT) {
        const beamEdge = lightBarX - BEAM_WIDTH / 2;
        const scored = particles
          .map((p, idx) => ({ idx, dist: Math.abs(p.x - beamEdge) }))
          .sort((a, b) => a.dist - b.dist);
        formation.assignedParticles = scored.slice(0, BTC_PARTICLE_COUNT).map((ss) => ss.idx);
        for (const idx of formation.assignedParticles) {
          particles[idx].inFormation = true;
        }
        formation.centerX = lightBarX - BTC_SYMBOL_SIZE * 0.8;
        formation.centerY = h / 2;
        formation.originPositions = formation.assignedParticles.map((idx) => ({
          x: particles[idx].x,
          y: particles[idx].y,
        }));
        formation.targetPositions = formation.assignedParticles.map((_, j) => {
          const sp = btcShapePoints[j % btcShapePoints.length];
          return {
            x: formation.centerX + sp.x * BTC_SYMBOL_SIZE,
            y: formation.centerY + sp.y * BTC_SYMBOL_SIZE,
          };
        });
        formation.phase = "converging";
        formation.timer = 0;
      }
    } else if (formation.phase === "converging") {
      formation.timer++;
      const t = Math.min(formation.timer / BTC_CONVERGE_FRAMES, 1);
      const ease = t * t * (3 - 2 * t);
      for (let j = 0; j < formation.assignedParticles.length; j++) {
        const idx = formation.assignedParticles[j];
        if (idx >= particles.length) continue;
        const p = particles[idx];
        const orig = formation.originPositions[j];
        const tgt = formation.targetPositions[j];
        p.x = orig.x + (tgt.x - orig.x) * ease;
        p.y = orig.y + (tgt.y - orig.y) * ease;
        p.vx = 0;
        p.vy = 0;
        p.life = Math.max(p.life, 0.8);
        p.alpha = p.originalAlpha * BTC_GLOW_BOOST;
      }
      if (formation.timer >= BTC_CONVERGE_FRAMES) {
        formation.phase = "holding";
        formation.timer = 0;
      }
    } else if (formation.phase === "holding") {
      formation.timer++;
      formation.centerX += BTC_DRIFT_SPEED;
      for (let j = 0; j < formation.assignedParticles.length; j++) {
        const idx = formation.assignedParticles[j];
        if (idx >= particles.length) continue;
        const p = particles[idx];
        const sp = btcShapePoints[j % btcShapePoints.length];
        p.x = formation.centerX + sp.x * BTC_SYMBOL_SIZE;
        p.y = formation.centerY + sp.y * BTC_SYMBOL_SIZE;
        p.vx = 0;
        p.vy = 0;
        p.life = Math.max(p.life, 0.8);
        p.alpha = p.originalAlpha * BTC_GLOW_BOOST;
      }
      if (formation.timer >= BTC_HOLD_FRAMES) {
        formation.phase = "dispersing";
        formation.timer = 0;
        for (const idx of formation.assignedParticles) {
          if (idx >= particles.length) continue;
          const p = particles[idx];
          p.vx = randomFloat(0.5, 2.0);
          p.vy = randomFloat(-1.0, 1.0);
        }
      }
    } else if (formation.phase === "dispersing") {
      formation.timer++;
      const t = formation.timer / BTC_DISPERSE_FRAMES;
      for (const idx of formation.assignedParticles) {
        if (idx >= particles.length) continue;
        const p = particles[idx];
        p.alpha = p.originalAlpha * (BTC_GLOW_BOOST + (1 - BTC_GLOW_BOOST) * t);
      }
      if (formation.timer >= BTC_DISPERSE_FRAMES) {
        for (const idx of formation.assignedParticles) {
          if (idx < particles.length) particles[idx].inFormation = false;
        }
        formation.phase = "idle";
        formation.timer = 0;
        formation.nextTrigger = Math.floor(randomFloat(BTC_TRIGGER_MIN, BTC_TRIGGER_MAX));
        formation.assignedParticles = [];
      }
    }

    // Draw particles
    ctx.globalCompositeOperation = "lighter";
    const fadeZone = s.currentFadeZone;

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      const isInFormation = p.inFormation;

      if (!isInFormation) {
        p.x += p.vx;
        p.y += p.vy;
        p.time++;
        p.alpha =
          p.originalAlpha * p.life +
          Math.sin(p.time * p.twinkleSpeed) * p.twinkleAmount;
        p.life -= p.decay;

        if (p.x >= lightBarX - BEAM_WIDTH / 2 || p.life <= 0) {
          resetParticle(p);
        }
      }

      if (p.life <= 0) continue;
      let fadeAlpha = 1;
      if (p.y < fadeZone) fadeAlpha = p.y / fadeZone;
      else if (p.y > h - fadeZone) fadeAlpha = (h - p.y) / fadeZone;
      fadeAlpha = Math.max(0, Math.min(1, fadeAlpha));

      const drawAlpha = isInFormation
        ? Math.max(0, p.alpha) * Math.min(fadeAlpha, 1)
        : Math.max(0, p.alpha) * fadeAlpha;
      ctx.globalAlpha = drawAlpha;
      ctx.drawImage(
        spriteCanvas,
        p.x - p.radius,
        p.y - p.radius,
        p.radius * 2,
        p.radius * 2,
      );
    }

    // Spawn new particles
    const maxP = Math.floor(s.currentMaxParticles);
    if (Math.random() < s.currentIntensity && particles.length < maxP) {
      const np = createParticle();
      np.originalAlpha = np.alpha;
      particles.push(np);
    }

    const ratio = s.currentIntensity / BASE_INTENSITY;
    if (ratio > 1.1 && Math.random() < (ratio - 1.0) * 1.2 && particles.length < maxP) {
      const np = createParticle();
      np.originalAlpha = np.alpha;
      particles.push(np);
    }

    // Trim excess
    if (particles.length > maxP + 200 && formation.phase === "idle") {
      particles.splice(maxP, particles.length - maxP);
    }
  }, [scanningActiveRef]);

  useAnimationFrame(renderFrame);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 15 }}
    />
  );
}
