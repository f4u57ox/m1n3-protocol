"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { OtcDraft } from "@/components/otc/OtcDraft";
import { OtcCounterSign } from "@/components/otc/OtcCounterSign";
import { OtcSettlement } from "@/components/otc/OtcSettlement";
import { decodeOtcLink } from "@/lib/otc-ticket";
import { activeOtcEscrowConfig } from "@/lib/confidential-constants";
import type { EscrowState } from "@/hooks/useOtcEscrow";

function OtcShellContent() {
  const search = useSearchParams();
  const linkParam = search.get("link");
  const cfg = activeOtcEscrowConfig();

  const decoded = linkParam ? decodeOtcLink(linkParam) : null;

  const [settled, setSettled] = useState<{
    escrow: EscrowState;
    digest: string;
  } | null>(null);

  return (
    <>
      <title>m1n3 — OTC</title>
      <div className="space-y-6 max-w-3xl">
        <div>
          <h1 className="text-2xl font-bold">OTC</h1>
          <p className="text-muted-foreground">
            Atomic peer-to-peer settlement for HashShares. Seller locks{" "}
            <code>Coin&lt;HS_NNN&gt;</code> in an on-chain escrow bound to a
            buyer + DUSDC price; buyer signs one PTB to settle both legs
            atomically. The deliverable is then wrap-able into a
            confidential{" "}
            <a
              className="underline"
              href="https://github.com/MystenLabs/confidential-transfers"
              target="_blank"
              rel="noreferrer"
            >
              confidential-transfers
            </a>{" "}
            <code>TokenAccount</code> for ongoing privacy.{" "}
            <strong>Devnet only.</strong>
          </p>
        </div>

        {!cfg && (
          <div className="rounded-lg border border-border bg-card p-6">
            <p className="text-sm text-muted-foreground">
              OTC is devnet-only. Switch the dapp to devnet to use it.
            </p>
          </div>
        )}

        {cfg && settled && (
          <OtcSettlement escrow={settled.escrow} digest={settled.digest} />
        )}

        {cfg && !settled && decoded && (
          <OtcCounterSign
            escrowId={decoded.escrowId}
            onSettled={(escrow, digest) => setSettled({ escrow, digest })}
          />
        )}

        {cfg && !settled && !decoded && <OtcDraft />}
      </div>
    </>
  );
}

export function OtcShell() {
  return (
    <Suspense>
      <OtcShellContent />
    </Suspense>
  );
}
