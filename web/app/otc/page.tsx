"use client";

import dynamic from "next/dynamic";

// The OTC flow pulls in @contra/bulletproofs-wasm which can't be bundled
// into a static-export server chunk. We render entirely on the client.
const OtcShell = dynamic(() => import("./OtcShell").then((m) => m.OtcShell), {
  ssr: false,
  loading: () => (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold">OTC</h1>
        <p className="text-muted-foreground">Loading SDK…</p>
      </div>
    </div>
  ),
});

export default function OtcPage() {
  return <OtcShell />;
}
