"use client";

import { ClientRedirect } from "@/components/ClientRedirect";

export default function SetupRedirect() {
  return <ClientRedirect to="/info?tab=setup" />;
}
