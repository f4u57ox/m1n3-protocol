import type { Metadata } from "next";
import BlockDetailContent from "./BlockDetailContent";

export const metadata: Metadata = { title: "m1n3 — n0d3s" };

export async function generateStaticParams() {
  // Return at least one entry so Next.js static export recognizes the route.
  // The .htaccess SPA fallback handles all other heights at runtime.
  return [{ height: "0" }];
}

export default function BlockDetailPage() {
  return <BlockDetailContent />;
}
