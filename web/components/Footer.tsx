import { PoweredBy } from "./PoweredBy";

/**
 * Site-wide footer. Rendered once in the root layout after the main
 * content. Stays out of the way on tall pages and pins to the bottom
 * on short ones via `mt-auto` on the parent flex column.
 */
export function Footer() {
  return (
    <footer className="mt-auto border-t border-border/60 bg-background/40 backdrop-blur">
      <div className="mx-auto max-w-7xl px-4">
        <PoweredBy />
        <div className="flex flex-col items-center gap-1 pb-4 text-center font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground sm:flex-row sm:justify-between sm:gap-0">
          <span>© 2026 m1n3 · Apache-2.0</span>
          <span>Built for Sui Overflow 2026</span>
        </div>
      </div>
    </footer>
  );
}
