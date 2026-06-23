"use client";

/**
 * Floating pitch-deck launcher.
 *
 * Renders a minimized "Pitch deck" pill anchored to the bottom-right of
 * the viewport. The pill is part of the page chrome — visible immediately
 * on first paint, but tiny (one row, glass-card styling that matches the
 * site's surface treatment) so it never competes with the actual content.
 *
 * Click expands into a full-viewport modal with the PDF embedded via a
 * native `<iframe>`. Closes on:
 *   - the close button (top-right of the modal)
 *   - backdrop click (anywhere outside the iframe's chrome)
 *   - the Escape key
 * Modal lifecycle also locks the body scroll while open and restores it on
 * close so the page doesn't jump when the user re-enters.
 *
 * The PDF iframe is **not** mounted until the user opens the modal — the
 * 3 MB asset never downloads on initial paint, and lazy-mounting on click
 * keeps the homepage's perf budget intact.
 */

import { useCallback, useEffect, useState } from "react";
import { BookOpen, X } from "lucide-react";

interface DeckButtonProps {
  /** Public path to the PDF inside `web/public/`. */
  src?: string;
  /** Label shown on the minimized pill. */
  label?: string;
}

export function DeckButton({
  src = "/m1n3-deck.pdf",
  label = "Pitch deck",
}: DeckButtonProps) {
  const [open, setOpen] = useState(false);

  const close = useCallback(() => setOpen(false), []);

  // Body scroll lock + Escape handler while the modal is open.
  // Restoring overflow on cleanup so a remount doesn't strand the lock.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  return (
    <>
      {/* ── Minimized pill (always present) ────────────────────────────
          Anchored bottom-right, above normal content, below the modal.
          Uses the same glass-card treatment (border, blur, soft shadow)
          and uppercase mono label as other CTAs on the site. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={`Open ${label}`}
        className="fixed bottom-4 right-4 z-40 inline-flex items-center gap-2 rounded-full border border-border bg-card/80 px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.25em] text-foreground shadow-lg backdrop-blur transition-all hover:scale-[1.03] hover:bg-card hover:border-foreground/40 sm:bottom-6 sm:right-6 sm:px-5 sm:py-3 sm:text-[11px]"
      >
        <BookOpen className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
        <span>{label}</span>
      </button>

      {/* ── Modal (only mounted while open — defers PDF download) ──────
          Backdrop catches clicks and closes; inner panel stops
          propagation so clicks inside the iframe don't dismiss. */}
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={label}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3 backdrop-blur-sm sm:p-6"
          onClick={close}
        >
          <div
            className="relative h-full max-h-[92vh] w-full max-w-6xl overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header strip with close + open-in-new-tab fallback. */}
            <div className="absolute right-3 top-3 z-10 flex items-center gap-2 sm:right-4 sm:top-4">
              <a
                href={src}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-full border border-border bg-background/80 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-foreground/80 backdrop-blur hover:bg-background hover:text-foreground sm:text-[11px]"
              >
                Open ↗
              </a>
              <button
                type="button"
                onClick={close}
                aria-label="Close pitch deck"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background/80 text-foreground/80 backdrop-blur hover:bg-background hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Native PDF viewer via `<iframe>` — works in every modern
                browser without pulling pdfjs (~1 MB) into the bundle.
                `#toolbar=1` hints to surface the browser's PDF toolbar. */}
            <iframe
              src={`${src}#toolbar=1&navpanes=0&view=FitH`}
              title={label}
              className="h-full w-full"
              loading="lazy"
            />
          </div>
        </div>
      )}
    </>
  );
}
