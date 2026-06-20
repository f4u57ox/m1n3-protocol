"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Client-side redirect for old routes (static export prevents server redirects). */
export function ClientRedirect({ to }: { to: string }) {
  const router = useRouter();
  useEffect(() => {
    router.replace(to);
  }, [router, to]);
  return null;
}
