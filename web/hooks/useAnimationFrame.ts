import { useEffect, useRef } from "react";

type FrameCallback = (now: number, dt: number) => void;

const callbacks = new Set<FrameCallback>();
let rafId = 0;
let running = false;
let lastTime = 0;

function tick(now: number) {
  const dt = lastTime ? (now - lastTime) / 1000 : 0;
  lastTime = now;

  for (const cb of callbacks) {
    cb(now, dt);
  }

  if (callbacks.size > 0) {
    rafId = requestAnimationFrame(tick);
  } else {
    running = false;
  }
}

function startLoop() {
  if (!running) {
    running = true;
    lastTime = 0;
    rafId = requestAnimationFrame(tick);
  }
}

function stopLoop() {
  if (running && callbacks.size === 0) {
    cancelAnimationFrame(rafId);
    running = false;
  }
}

/**
 * Shared requestAnimationFrame coordinator.
 * All registered callbacks run within a single RAF loop.
 */
export function useAnimationFrame(callback: FrameCallback) {
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    const wrapper: FrameCallback = (now, dt) => cbRef.current(now, dt);
    callbacks.add(wrapper);
    startLoop();

    return () => {
      callbacks.delete(wrapper);
      stopLoop();
    };
  }, []);
}
