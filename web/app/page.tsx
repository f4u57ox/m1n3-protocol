import { Hero } from "@/components/Hero";
import { IntroSection } from "@/components/IntroSection";
import { HomeCTA } from "@/components/HomeCTA";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "m1n3" };

export default function HomePage() {
  return (
    <main className="relative">
      <Hero />
      <IntroSection />
      <HomeCTA />
    </main>
  );
}
