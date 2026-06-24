import { Hero } from "@/components/Hero";
import { IntroSection } from "@/components/IntroSection";
import { DemoVideo } from "@/components/DemoVideo";
import { HomeCTA } from "@/components/HomeCTA";
import { DeckButton } from "@/components/DeckButton";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "m1n3" };

export default function HomePage() {
  return (
    <main className="relative">
      <Hero />
      <IntroSection />
      {/* Demo video sits between the explainer and the call-to-action.
          Lazy-loads YouTube only on click — no perf hit on first paint. */}
      <DemoVideo videoId="Woe61hCIej0" />
      <HomeCTA />
      {/* Minimized pitch-deck launcher anchored to the bottom-right.
          Visible from the moment the page paints; the 3 MB PDF stays
          on the CDN until the visitor clicks the pill open. */}
      <DeckButton />
    </main>
  );
}
