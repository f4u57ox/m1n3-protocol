import type { Metadata } from "next";
import TemplateDetailContent from "./TemplateDetailContent";

export const metadata: Metadata = { title: "m1n3 — t3mpl4t3s" };

export async function generateStaticParams() {
  // Return at least one entry so Next.js static export recognizes the route.
  // The .htaccess SPA fallback handles all other template IDs at runtime.
  return [{ templateId: "_" }];
}

export default function TemplateDetailPage() {
  return <TemplateDetailContent />;
}
