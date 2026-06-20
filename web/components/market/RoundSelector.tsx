"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { HashShareSlotBinding } from "@/hooks/useHashShareRedemptions";
import { ChevronDown, History } from "lucide-react";

/**
 * Pill button showing the active HashShare slot (e.g. "HS003 · round 42").
 * Clicking expands a dropdown of every other bound slot, sorted by round
 * descending. Past rounds carry their bound HashShare label.
 *
 * Defaults to the latest-round binding the first time the page mounts —
 * the caller redirects to the latest via `?coin=`, this component just
 * surfaces what's currently selected and lets the user switch.
 */
export function RoundSelector({
  bindings,
  activeCoin,
}: {
  bindings: HashShareSlotBinding[];
  activeCoin: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const byCoin = useMemo(() => {
    // Keep only the most-recent binding per coin type, sorted by round desc.
    const map = new Map<string, HashShareSlotBinding>();
    for (const b of bindings) {
      const cur = map.get(b.fullType);
      if (!cur || cur.roundId < b.roundId) map.set(b.fullType, b);
    }
    return Array.from(map.values()).sort((a, b) =>
      Number(b.roundId - a.roundId),
    );
  }, [bindings]);

  const active = byCoin.find((b) => b.fullType === activeCoin);
  const others = byCoin.filter((b) => b.fullType !== activeCoin);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <div className="relative inline-flex items-center gap-2" ref={wrapRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="group inline-flex items-center gap-1.5 sm:gap-2 rounded-full border border-border bg-card/60 px-3 sm:px-4 py-1.5 sm:py-2 font-mono text-xs sm:text-sm transition-colors hover:border-foreground/40 hover:bg-card"
      >
        <span className="grid h-4 w-4 sm:h-5 sm:w-5 place-items-center rounded-full bg-purple-500/10 text-[9px] sm:text-[10px] font-semibold text-purple-400">
          HS
        </span>
        <span className="text-foreground">
          {active?.label ?? "—"}
        </span>
        <span className="hidden sm:inline text-muted-foreground">
          · round {active?.roundId.toString() ?? "?"}
        </span>
        <span className="sm:hidden text-muted-foreground">
          r{active?.roundId.toString() ?? "?"}
        </span>
        <span className="ml-1 rounded-full bg-emerald-500/15 px-1.5 sm:px-2 py-0.5 text-[9px] sm:text-[10px] uppercase tracking-[0.15em] sm:tracking-[0.2em] text-emerald-400">
          live
        </span>
        <ChevronDown
          className={`ml-0.5 sm:ml-1 h-3 sm:h-3.5 w-3 sm:w-3.5 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-40 mt-2 w-72 overflow-hidden rounded-2xl border border-border bg-popover/95 shadow-2xl backdrop-blur">
          <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
            <History className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="font-mono text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
              Past rounds
            </span>
          </div>
          {others.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">
              No past rounds yet.
            </div>
          ) : (
            <ul className="max-h-72 overflow-y-auto py-1">
              {others.map((b) => (
                <li key={b.fullType}>
                  <button
                    onClick={() => {
                      router.push(
                        `/marketplace?coin=${encodeURIComponent(b.fullType)}`,
                      );
                      setOpen(false);
                    }}
                    className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors hover:bg-accent"
                  >
                    <div className="flex items-center gap-2">
                      <span className="grid h-5 w-5 place-items-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
                        HS
                      </span>
                      <span className="font-mono text-sm text-foreground">
                        {b.label}
                      </span>
                    </div>
                    <span className="font-mono text-xs text-muted-foreground">
                      round {b.roundId.toString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
