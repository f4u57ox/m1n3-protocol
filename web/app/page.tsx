import { Hero } from "@/components/Hero";
import { IntroSection } from "@/components/IntroSection";
import { DemoVideo } from "@/components/DemoVideo";
import { HomeCTA } from "@/components/HomeCTA";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "m1n3" };

export default function HomePage() {
  return (
    <main className="relative">
      <Hero />
      <IntroSection />
      {/* Demo video sits between the explainer and the call-to-action.
          Lazy-loads YouTube only on click — no perf hit on first paint. */}
      <DemoVideo videoId="vyFU3AD3row" />
      <HomeCTA />
    </main>
  );
}
