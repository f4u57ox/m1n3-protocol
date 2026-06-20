"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { QUOTE_TOKENS, type QuoteToken } from "@/lib/quote-tokens";

/**
 * Pill dropdown for picking the quote token in the SwapCard.
 *
 * Only SUI routes through the existing `hash_share_market` PTBs today; the
 * other tokens are DeepBookV3 routes the keeper already maintains pools
 * for, but the UI for placing those orders is staged for a follow-up.
 */
export function QuoteSelector({
  value,
  onChange,
}: {
  value: QuoteToken;
  onChange: (q: QuoteToken) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

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
    <div className="relative" ref={wrapRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex shrink-0 items-center gap-1.5 sm:gap-2 rounded-full bg-foreground/5 px-2.5 sm:px-3 py-1.5 sm:py-2 ring-1 ring-border transition-colors hover:bg-foreground/10"
      >
        <Chip symbol={value.symbol} />
        <span className="font-mono text-xs sm:text-sm font-semibold">
          {value.symbol}
        </span>
        <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-2 w-64 overflow-hidden rounded-2xl border border-border bg-popover/95 shadow-2xl backdrop-blur">
          <div className="border-b border-border/60 px-4 py-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
              Quote currency
            </p>
          </div>
          <ul className="max-h-80 overflow-y-auto py-1">
            {QUOTE_TOKENS.map((t) => {
              const active = t.symbol === value.symbol;
              return (
                <li key={t.symbol}>
                  <button
                    onClick={() => {
                      onChange(t);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors ${
                      active ? "bg-accent" : "hover:bg-accent"
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <Chip symbol={t.symbol} />
                      <div className="flex flex-col">
                        <span className="font-mono text-sm font-semibold">
                          {t.symbol}
                        </span>
                        {t.note && (
                          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                            {t.note}
                          </span>
                        )}
                      </div>
                    </div>
                    {active && (
                      <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[9px] uppercase tracking-[0.2em] text-emerald-400">
                        active
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="border-t border-border/60 bg-muted/20 px-4 py-2.5">
            <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
              SUI · m1n3 market   ·   others · DeepBookV3
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function Chip({ symbol }: { symbol: string }) {
  return (
    <span className="grid h-5 w-5 sm:h-6 sm:w-6 place-items-center rounded-full bg-purple-500/15 text-[9px] sm:text-[10px] font-bold text-purple-400">
      {symbol.slice(0, 2)}
    </span>
  );
}
