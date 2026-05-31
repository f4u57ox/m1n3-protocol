"use client";

import React, { useEffect, useRef, useCallback, useMemo, useState } from "react";
import { useAnimationFrame } from "@/hooks/useAnimationFrame";
import BlockCard, { type BlockCardData } from "./BlockCard";
import BeamCanvas from "./BeamCanvas";
import { generateHexFragments, hexDimensions, type HexFragment } from "./hex-bytes";

interface CardBeamAnimationProps {
  blocks: BlockCardData[];
  rows?: number;
}

// Single-row (original) constants
const SINGLE_CARD_SIZE = 280;
const SINGLE_CARD_GAP = 24;
const SINGLE_ASSEMBLY_FAR = 300;
const SINGLE_ASSEMBLY_NEAR = 50;

// Multi-row constants
const MULTI_CARD_SIZE = 160;
const MULTI_CARD_GAP = 16;
const ROW_GAP = 12;
const MULTI_ASSEMBLY_FAR = 200;
const MULTI_ASSEMBLY_NEAR = 35;

const AUTO_SPEED = 80; // px/s
const MIN_CARDS = 20;
const FRICTION = 0.95;
const MIN_VELOCITY = 30;
const SCANNER_WIDTH = 8;

const ROW_CONFIGS = [
  { speedMultiplier: 1.0, startOffsetFraction: 0.0 },
  { speedMultiplier: 0.85, startOffsetFraction: 0.33 },
  { speedMultiplier: 1.15, startOffsetFraction: 0.66 },
];

interface StreamState {
  position: number;
  velocity: number;
  direction: number;
  speedMultiplier: number;
  cardLineWidth: number;
}

// ── Fragment layout constants (matching original CSS) ──
const FRAG_CHAR_WIDTH = 5.4;
const FRAG_LINE_HEIGHT = 13;
const FRAG_PADDING = 8;

interface HexScatterCanvasProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  streamsRef: React.RefObject<StreamState[]>;
  rowPaddedBlocks: BlockCardData[][];
  cardSize: number;
  cardGap: number;
  assemblyFar: number;
  assemblyNear: number;
  rowGap: number;
  containerHeight: number;
}

function HexScatterCanvas({
  containerRef,
  streamsRef,
  rowPaddedBlocks,
  cardSize,
  cardGap,
  assemblyFar,
  assemblyNear,
  rowGap,
  containerHeight,
}: HexScatterCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<{
    ctx: CanvasRenderingContext2D;
    w: number;
    h: number;
    fgColor: string;
    dpr: number;
  } | null>(null);

  // Precompute fragment data — deduplicated by blockHash
  const fragmentsByHash = useMemo(() => {
    const map = new Map<string, HexFragment[]>();
    const { cols, rows } = hexDimensions(cardSize, cardSize);
    const scatterRadius = Math.round(cardSize * 0.75);
    for (const row of rowPaddedBlocks) {
      for (const block of row) {
        if (map.has(block.blockHash)) continue;
        map.set(
          block.blockHash,
          generateHexFragments(block.blockHash, cols, rows, scatterRadius, block.headerHex),
        );
      }
    }
    return map;
  }, [rowPaddedBlocks, cardSize]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;

    let fgColor = "";

    function readFgColor() {
      const style = getComputedStyle(document.documentElement);
      const raw = style.getPropertyValue("--foreground").trim();
      fgColor = raw ? `hsl(${raw})` : "hsl(0 0% 98%)";
      if (stateRef.current) stateRef.current.fgColor = fgColor;
    }

    function resize() {
      const rect = canvas!.parentElement!.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
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

    stateRef.current = { ctx, w: 0, h: 0, fgColor, dpr };
    resize(); // sets w, h on state

    const observer = new MutationObserver(() => readFgColor());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement!);

    return () => {
      observer.disconnect();
      ro.disconnect();
      stateRef.current = null;
    };
  }, []);

  const renderFrame = useCallback(() => {
    const s = stateRef.current;
    if (!s || !containerRef.current) return;
    const { ctx, w, h, fgColor } = s;
    const streams = streamsRef.current;
    if (!streams || streams.length === 0) return;

    ctx.clearRect(0, 0, w, h);

    const scannerLocalX = w / 2;
    const rowCount = rowPaddedBlocks.length;
    const totalRowsH = cardSize * rowCount + rowGap * (rowCount - 1);
    const topOffset = (h - totalRowsH) / 2;

    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textBaseline = "top";
    ctx.textAlign = "left";

    for (let r = 0; r < streams.length; r++) {
      const stream = streams[r];
      if (!stream) continue;
      const row = rowPaddedBlocks[r];
      if (!row) continue;

      const rowTop = topOffset + r * (cardSize + rowGap);

      for (let j = 0; j < row.length; j++) {
        const cardLeft = stream.position + j * (cardSize + cardGap);
        const cardRight = cardLeft + cardSize;

        // Skip off-screen cards (with scatter radius buffer)
        if (cardRight < -assemblyFar - cardSize || cardLeft > w + assemblyFar + cardSize) continue;

        // Compute scatter (same math as updateCardClipping)
        const cardCenterX = cardLeft + cardSize / 2;
        const distToBeam = scannerLocalX - cardCenterX;
        let scatter: number;
        if (distToBeam <= 0) {
          scatter = 0;
        } else if (distToBeam >= assemblyFar) {
          scatter = 1;
        } else if (distToBeam <= assemblyNear) {
          scatter = 0;
        } else {
          const t = (distToBeam - assemblyNear) / (assemblyFar - assemblyNear);
          scatter = t * t;
        }

        // Skip fully assembled cards (fragments invisible when assembled)
        if (scatter < 0.001) continue;

        const block = row[j];
        const fragments = fragmentsByHash.get(block.blockHash);
        if (!fragments) continue;

        for (let fi = 0; fi < fragments.length; fi++) {
          const f = fragments[fi];

          // Fade multiplier: smoothly ramp alpha to 0 as scatter enters near-beam zone
          const BEAM_FADE = 0.15;
          const fadeMul = scatter < BEAM_FADE ? scatter / BEAM_FADE : 1.0;
          const alpha = (f.baseOpacity + (1 - scatter) * (0.10 - f.baseOpacity)) * fadeMul;
          if (alpha < 0.005) continue;

          // Base position within card
          const baseX = cardLeft + FRAG_PADDING + f.col * FRAG_CHAR_WIDTH * 3;
          const baseY = rowTop + FRAG_PADDING + f.row * FRAG_LINE_HEIGHT;

          // Apply scatter offset
          const x = baseX + scatter * f.dx;
          const y = baseY + scatter * f.dy;

          // Skip if fully off-screen
          if (x < -20 || x > w + 20 || y < -20 || y > h + 20) continue;

          ctx.globalAlpha = alpha;
          ctx.fillStyle = fgColor;

          // Apply rotation if significant
          const rot = scatter * f.rot;
          if (Math.abs(rot) > 0.5) {
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate((rot * Math.PI) / 180);
            ctx.fillText(f.char, 0, 0);
            ctx.restore();
          } else {
            ctx.fillText(f.char, x, y);
          }
        }
      }
    }

    ctx.globalAlpha = 1;
  }, [containerRef, streamsRef, rowPaddedBlocks, cardSize, cardGap, assemblyFar, assemblyNear, rowGap, fragmentsByHash]);

  useAnimationFrame(renderFrame);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 11 }}
    />
  );
}

export default function CardBeamAnimation({
  blocks,
  rows = 3,
}: CardBeamAnimationProps) {
  const isMultiRow = rows > 1;
  const rowCount = isMultiRow ? rows : 1;
  const cardSize = isMultiRow ? MULTI_CARD_SIZE : SINGLE_CARD_SIZE;
  const cardGap = isMultiRow ? MULTI_CARD_GAP : SINGLE_CARD_GAP;
  const rowGap = isMultiRow ? ROW_GAP : 0;
  const assemblyFar = isMultiRow ? MULTI_ASSEMBLY_FAR : SINGLE_ASSEMBLY_FAR;
  const assemblyNear = isMultiRow ? MULTI_ASSEMBLY_NEAR : SINGLE_ASSEMBLY_NEAR;

  const containerRef = useRef<HTMLDivElement>(null);
  const cardLineRefs = useRef<(HTMLDivElement | null)[]>([]);
  const scanningActiveRef = useRef(false);

  // Animation state
  const streamsRef = useRef<StreamState[]>([]);
  const isAnimatingRef = useRef(true);
  const isDraggingRef = useRef(false);
  const lastMouseXRef = useRef(0);
  const mouseVelocityRef = useRef(0);

  // Virtualization: visible card index ranges per row [start, end] (inclusive)
  const CARD_BUFFER = 2;
  const [visibleRanges, setVisibleRanges] = useState<[number, number][]>([]);
  const visibleRangesRef = useRef<[number, number][]>([]);

  // Distribute blocks round-robin across rows, pad each to MIN_CARDS
  const rowPaddedBlocks = useMemo(() => {
    if (blocks.length === 0) return [];

    const rowArrays: BlockCardData[][] = Array.from(
      { length: rowCount },
      () => [],
    );

    // Round-robin distribution
    for (let i = 0; i < blocks.length; i++) {
      rowArrays[i % rowCount].push(blocks[i]);
    }

    // Pad each row to MIN_CARDS
    return rowArrays.map((rowBlocks) => {
      if (rowBlocks.length === 0) {
        // If a row got no blocks, fill from all blocks
        rowBlocks = [...blocks];
      }
      const padded: BlockCardData[] = [];
      while (padded.length < MIN_CARDS) {
        for (const b of rowBlocks) {
          padded.push(b);
          if (padded.length >= MIN_CARDS) break;
        }
      }
      return padded;
    });
  }, [blocks, rowCount]);

  const containerHeight = isMultiRow
    ? cardSize * rowCount + rowGap * (rowCount - 1) + 40
    : cardSize + 40;

  // ── Clipping + scatter + visibility logic (math-based, no DOM queries) ──
  const updateCardClipping = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const cw = container.offsetWidth;
    const scannerLocalX = cw / 2;
    const scannerLeft = scannerLocalX - SCANNER_WIDTH / 2;
    const scannerRight = scannerLocalX + SCANNER_WIDTH / 2;
    let anyScanningActive = false;

    const newRanges: [number, number][] = [];

    for (let r = 0; r < streamsRef.current.length; r++) {
      const stream = streamsRef.current[r];
      const cardLine = cardLineRefs.current[r];
      if (!cardLine) {
        newRanges.push([-1, -1]);
        continue;
      }

      const children = cardLine.children;
      const numCards = children.length;

      // Compute visible range for this row
      let firstVisible = -1;
      let lastVisible = -1;

      for (let j = 0; j < numCards; j++) {
        const cardLeft = stream.position + j * (cardSize + cardGap);
        const cardRight = cardLeft + cardSize;

        // Track visibility (card in viewport + assemblyFar buffer)
        if (cardRight >= -assemblyFar && cardLeft <= cw + assemblyFar) {
          if (firstVisible === -1) firstVisible = j;
          lastVisible = j;
        }

        // Skip off-screen cards for DOM manipulation
        if (cardRight < -assemblyFar || cardLeft > cw + assemblyFar) continue;

        const cardCenterX = cardLeft + cardSize / 2;
        const wrapper = children[j] as HTMLElement;

        // ── Scatter: distance from card center to beam center ──
        const distToBeam = scannerLocalX - cardCenterX;
        let scatter: number;
        if (distToBeam <= 0) {
          scatter = 0;
        } else if (distToBeam >= assemblyFar) {
          scatter = 1;
        } else if (distToBeam <= assemblyNear) {
          scatter = 0;
        } else {
          const t =
            (distToBeam - assemblyNear) / (assemblyFar - assemblyNear);
          scatter = t * t;
        }
        // Set bg opacity directly
        const bgEl = wrapper.firstElementChild as HTMLElement | null;
        if (bgEl) bgEl.style.opacity = String(1 - scatter);

        // Normal face clip-path (bg=first child, normal=last child)
        const normalCard = wrapper.lastElementChild as HTMLElement | null;
        if (!normalCard || normalCard === bgEl) continue;

        if (cardLeft < scannerRight && cardRight > scannerLeft) {
          anyScanningActive = true;
          const painted = Math.min(cardRight - scannerLeft, cardSize);
          const clipRight = (painted / cardSize) * 100;
          normalCard.style.clipPath = `inset(0 0 0 ${100 - clipRight}%)`;
        } else if (cardLeft >= scannerRight) {
          normalCard.style.clipPath = "inset(0 0 0 0%)";
        } else {
          normalCard.style.clipPath = "inset(0 0 0 100%)";
        }
      }

      // Add buffer
      const bufferedStart = firstVisible === -1 ? -1 : Math.max(0, firstVisible - CARD_BUFFER);
      const bufferedEnd = lastVisible === -1 ? -1 : Math.min(numCards - 1, lastVisible + CARD_BUFFER);
      newRanges.push([bufferedStart, bufferedEnd]);
    }

    // Only trigger re-render when ranges actually change
    const prev = visibleRangesRef.current;
    let changed = prev.length !== newRanges.length;
    if (!changed) {
      for (let i = 0; i < newRanges.length; i++) {
        if (!prev[i] || prev[i][0] !== newRanges[i][0] || prev[i][1] !== newRanges[i][1]) {
          changed = true;
          break;
        }
      }
    }
    if (changed) {
      visibleRangesRef.current = newRanges;
      setVisibleRanges(newRanges);
    }

    scanningActiveRef.current = anyScanningActive;
  }, [assemblyFar, assemblyNear, cardSize, cardGap, CARD_BUFFER]);

  // ── Initialize stream states ──
  useEffect(() => {
    if (rowPaddedBlocks.length === 0) return;

    const container = containerRef.current;
    if (!container) return;

    streamsRef.current = rowPaddedBlocks.map((rowBlocks, i) => {
      const lineWidth = (cardSize + cardGap) * rowBlocks.length;
      const config = isMultiRow
        ? ROW_CONFIGS[i % ROW_CONFIGS.length]
        : { speedMultiplier: 1, startOffsetFraction: 0 };
      return {
        position: -lineWidth,
        velocity: AUTO_SPEED,
        direction: 1,
        speedMultiplier: config.speedMultiplier,
        cardLineWidth: lineWidth,
      };
    });

  }, [rowPaddedBlocks, cardSize, cardGap, isMultiRow]);

  // ── Animation loop via shared RAF ──
  const animateCards = useCallback((_now: number, dt: number) => {
    const container = containerRef.current;
    if (!container || streamsRef.current.length === 0) return;

    const cw = container.offsetWidth;

    for (let i = 0; i < streamsRef.current.length; i++) {
      const stream = streamsRef.current[i];
      const cardLine = cardLineRefs.current[i];
      if (!cardLine) continue;

      if (isAnimatingRef.current && !isDraggingRef.current) {
        const targetSpeed = AUTO_SPEED * stream.speedMultiplier;
        if (stream.velocity > targetSpeed) {
          stream.velocity *= FRICTION;
          if (stream.velocity < targetSpeed) {
            stream.velocity = targetSpeed;
            stream.direction = 1;
          }
        }

        stream.position +=
          stream.velocity * stream.direction * dt;
      }

      if (stream.position < -stream.cardLineWidth) {
        stream.position = cw;
      } else if (stream.position > cw) {
        stream.position = -stream.cardLineWidth;
      }

      cardLine.style.transform = `translateX(${stream.position}px)`;
    }

    updateCardClipping();
  }, [updateCardClipping]);

  useAnimationFrame(animateCards);

  // ── Drag / touch / wheel handlers ──
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    function startDrag(clientX: number) {
      isDraggingRef.current = true;
      isAnimatingRef.current = false;
      lastMouseXRef.current = clientX;
      mouseVelocityRef.current = 0;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "grabbing";
    }

    function onDrag(clientX: number) {
      if (!isDraggingRef.current) return;
      const dx = clientX - lastMouseXRef.current;
      // Apply to all streams
      for (const stream of streamsRef.current) {
        stream.position += dx;
      }
      mouseVelocityRef.current = dx * 60;
      lastMouseXRef.current = clientX;
    }

    function endDrag() {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;

      for (const stream of streamsRef.current) {
        if (Math.abs(mouseVelocityRef.current) > MIN_VELOCITY) {
          stream.velocity =
            Math.abs(mouseVelocityRef.current) * stream.speedMultiplier;
          stream.direction = mouseVelocityRef.current > 0 ? 1 : -1;
        } else {
          stream.velocity = AUTO_SPEED * stream.speedMultiplier;
        }
      }

      isAnimatingRef.current = true;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    }

    function onMouseDown(e: MouseEvent) {
      e.preventDefault();
      startDrag(e.clientX);
    }
    function onMouseMove(e: MouseEvent) {
      if (!isDraggingRef.current) return;
      e.preventDefault();
      onDrag(e.clientX);
    }
    function onMouseUp() {
      endDrag();
    }
    function onTouchStart(e: TouchEvent) {
      startDrag(e.touches[0].clientX);
    }
    function onTouchMove(e: TouchEvent) {
      if (!isDraggingRef.current) return;
      onDrag(e.touches[0].clientX);
    }
    function onTouchEnd() {
      endDrag();
    }
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 20 : -20;
      for (const stream of streamsRef.current) {
        stream.position += delta;
      }
    }
    function onSelectStart(e: Event) {
      e.preventDefault();
    }

    container.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    container.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: true });
    document.addEventListener("touchend", onTouchEnd);
    container.addEventListener("wheel", onWheel, { passive: false });
    container.addEventListener("selectstart", onSelectStart);
    container.addEventListener("dragstart", onSelectStart);

    return () => {
      container.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      container.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("selectstart", onSelectStart);
      container.removeEventListener("dragstart", onSelectStart);
    };
  }, []);

  if (rowPaddedBlocks.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className="relative w-full overflow-hidden"
      style={{
        height: containerHeight,
        maskImage:
          "linear-gradient(to right, transparent, black 8%, black 92%, transparent)",
        WebkitMaskImage:
          "linear-gradient(to right, transparent, black 8%, black 92%, transparent)",
      }}
    >
      {/* Canvas beam + particles overlay */}
      <BeamCanvas scanningActiveRef={scanningActiveRef} />

      {/* Canvas hex scatter — replaces ~5940 span elements */}
      <HexScatterCanvas
        containerRef={containerRef}
        streamsRef={streamsRef}
        rowPaddedBlocks={rowPaddedBlocks}
        cardSize={cardSize}
        cardGap={cardGap}
        assemblyFar={assemblyFar}
        assemblyNear={assemblyNear}
        rowGap={rowGap}
        containerHeight={containerHeight}
      />

      {/* Card streams — stacked vertically, centered */}
      <div
        className="absolute inset-0 flex flex-col justify-center"
        style={{ zIndex: 10, gap: rowGap }}
      >
        {rowPaddedBlocks.map((rowBlocks, rowIndex) => (
          <div key={rowIndex} style={{ height: cardSize }}>
            <div
              ref={(el) => {
                cardLineRefs.current[rowIndex] = el;
              }}
              className="card-beam-stream"
              style={{ gap: cardGap }}
            >
              {rowBlocks.map((block, i) => {
                const range = visibleRanges[rowIndex];
                const isVisible = range ? i >= range[0] && i <= range[1] : false;
                return (
                  <div
                    key={`${block.height}-${rowIndex}-${i}`}
                    className="relative flex-shrink-0"
                    style={{
                      width: cardSize,
                      height: cardSize,
                      contain: "layout style",
                    }}
                    data-card-wrapper
                  >
                    {isVisible && (
                      <BlockCard
                        {...block}
                        cardSize={cardSize}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
