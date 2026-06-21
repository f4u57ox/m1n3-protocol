"use client";

import { useCallback } from "react";
import {
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { useQuery } from "@tanstack/react-query";
import { activeOtcEscrowConfig } from "@/lib/confidential-constants";

/**
 * On-chain shape of the `Escrow<DeliverableT, PayT>` Move struct.
 * Mirrors `m1n3_confidential_otc::Escrow`.
 */
export type EscrowState = {
  escrowId: string;
  deliverableAmount: bigint;
  payAmount: bigint;
  seller: string;
  buyer: string;
  deliverableType: string;
  payType: string;
  memo: string;
};

function parseTypeArg(typeStr: string, index: 0 | 1): string {
  const open = typeStr.indexOf("<");
  const close = typeStr.lastIndexOf(">");
  if (open < 0 || close < 0) return "";
  const inner = typeStr.slice(open + 1, close);
  // Splits on top-level commas only (struct types don't nest commas at
  // this depth on chain so a simple split is fine).
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "<") depth++;
    else if (c === ">") depth--;
    else if (c === "," && depth === 0) {
      parts.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(inner.slice(start).trim());
  return parts[index] ?? "";
}

/**
 * Live view of an `Escrow` object. Returns null while loading or if the
 * object isn't found (cancelled / settled / wrong id).
 */
export function useEscrow(escrowId: string | null) {
  const suiClient = useSuiClient();

  return useQuery<EscrowState | null>({
    queryKey: ["otc-escrow", escrowId],
    enabled: !!escrowId,
    refetchInterval: 8_000,
    staleTime: 4_000,
    queryFn: async () => {
      if (!escrowId) return null;
      const res = await suiClient.getObject({
        id: escrowId,
        options: { showContent: true, showType: true },
      });
      const content = res.data?.content;
      const fullType = res.data?.type;
      if (!content || content.dataType !== "moveObject" || !fullType) {
        return null;
      }
      const fields = content.fields as Record<string, unknown>;
      // Deliverable is a Coin<T> — the value lives in fields.deliverable.fields.balance
      const deliverableField = fields.deliverable as
        | { fields?: { balance?: string } }
        | undefined;
      const deliverableAmount = BigInt(
        deliverableField?.fields?.balance ?? "0",
      );
      // Memo is BCS-decoded to a number array; convert back to UTF-8.
      let memoStr = "";
      const memo = fields.memo;
      if (Array.isArray(memo)) {
        memoStr = new TextDecoder().decode(new Uint8Array(memo.map(Number)));
      } else if (typeof memo === "string") {
        memoStr = memo;
      }
      return {
        escrowId,
        deliverableAmount,
        payAmount: BigInt((fields.pay_amount as string) ?? "0"),
        seller: (fields.seller as string) ?? "",
        buyer: (fields.buyer as string) ?? "",
        deliverableType: parseTypeArg(fullType, 0),
        payType: parseTypeArg(fullType, 1),
        memo: memoStr,
      };
    },
  });
}

/**
 * Seller-side `lock_escrow` PTB builder + signer.
 *
 * Returns a thunk that picks the seller's first `Coin<DeliverableT>`,
 * splits off `deliverableAmount`, and locks it. The shared `Escrow`
 * object id is returned from the tx so the caller can build the share
 * link.
 */
export function useLockEscrow() {
  const suiClient = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const cfg = activeOtcEscrowConfig();

  return useCallback(
    async (args: {
      sellerAddress: string;
      deliverableType: string;
      payType: string;
      deliverableAmount: bigint;
      payAmount: bigint;
      buyer: string;
      memo: string;
    }) => {
      if (!cfg) throw new Error("OTC escrow not available on this network");
      const { data: coins } = await suiClient.getCoins({
        owner: args.sellerAddress,
        coinType: args.deliverableType,
      });
      const total = coins.reduce((a, c) => a + BigInt(c.balance), 0n);
      if (total < args.deliverableAmount) {
        throw new Error(
          `Not enough ${args.deliverableType} (have ${total}, need ${args.deliverableAmount})`,
        );
      }

      const tx = new Transaction();
      // Merge all coins onto the first one (in case the seller has dust)
      // so split is straightforward.
      const [primary, ...rest] = coins;
      if (rest.length > 0) {
        tx.mergeCoins(
          tx.object(primary.coinObjectId),
          rest.map((c) => tx.object(c.coinObjectId)),
        );
      }
      const [deliverable] = tx.splitCoins(tx.object(primary.coinObjectId), [
        args.deliverableAmount,
      ]);
      const memoBytes = Array.from(new TextEncoder().encode(args.memo));
      tx.moveCall({
        target: `${cfg.packageId}::m1n3_confidential_otc::lock_escrow`,
        typeArguments: [args.deliverableType, args.payType],
        arguments: [
          deliverable,
          tx.pure.address(args.buyer),
          tx.pure.u64(args.payAmount),
          tx.pure.vector("u8", memoBytes),
        ],
      });

      const r = await signAndExecute({
        transaction: tx as unknown as Parameters<typeof signAndExecute>[0]["transaction"],
      });
      const full = await suiClient.waitForTransaction({
        digest: r.digest,
        options: { showEffects: true, showObjectChanges: true },
      });
      // Find the created Escrow shared object.
      const escrowObj = full.objectChanges?.find(
        (c) =>
          c.type === "created" &&
          "objectType" in c &&
          typeof c.objectType === "string" &&
          c.objectType.includes("m1n3_confidential_otc::Escrow"),
      );
      if (!escrowObj || escrowObj.type !== "created") {
        throw new Error("Escrow object not found in tx effects");
      }
      return { escrowId: escrowObj.objectId, digest: r.digest };
    },
    [suiClient, signAndExecute, cfg],
  );
}

/**
 * Buyer-side `settle` PTB builder + signer.
 *
 * Builds a single atomic transaction:
 *   1. find / merge the buyer's `Coin<PayT>` and split exact `payAmount`
 *   2. `m1n3_confidential_otc::settle` → returns deliverable `Coin<HS>`
 *   3. transfer deliverable to the buyer (so they hold it after the
 *      tx) — they can wrap it confidentially in a follow-up PTB
 */
export function useSettleEscrow() {
  const suiClient = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const cfg = activeOtcEscrowConfig();

  return useCallback(
    async (args: { escrow: EscrowState; buyerAddress: string }) => {
      if (!cfg) throw new Error("OTC escrow not available on this network");
      const { data: coins } = await suiClient.getCoins({
        owner: args.buyerAddress,
        coinType: args.escrow.payType,
      });
      const total = coins.reduce((a, c) => a + BigInt(c.balance), 0n);
      if (total < args.escrow.payAmount) {
        throw new Error(
          `Not enough ${args.escrow.payType} (have ${total}, need ${args.escrow.payAmount})`,
        );
      }
      const tx = new Transaction();
      const [primary, ...rest] = coins;
      if (rest.length > 0) {
        tx.mergeCoins(
          tx.object(primary.coinObjectId),
          rest.map((c) => tx.object(c.coinObjectId)),
        );
      }
      const [payment] = tx.splitCoins(tx.object(primary.coinObjectId), [
        args.escrow.payAmount,
      ]);
      const deliverable = tx.moveCall({
        target: `${cfg.packageId}::m1n3_confidential_otc::settle`,
        typeArguments: [args.escrow.deliverableType, args.escrow.payType],
        arguments: [tx.object(args.escrow.escrowId), payment],
      });
      tx.transferObjects([deliverable], args.buyerAddress);
      const r = await signAndExecute({
        transaction: tx as unknown as Parameters<typeof signAndExecute>[0]["transaction"],
      });
      await suiClient.waitForTransaction({ digest: r.digest });
      return { digest: r.digest };
    },
    [suiClient, signAndExecute, cfg],
  );
}

/** Seller-side `cancel` — recovers the deliverable. */
export function useCancelEscrow() {
  const suiClient = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const cfg = activeOtcEscrowConfig();

  return useCallback(
    async (args: { escrow: EscrowState; sellerAddress: string }) => {
      if (!cfg) throw new Error("OTC escrow not available on this network");
      const tx = new Transaction();
      const deliverable = tx.moveCall({
        target: `${cfg.packageId}::m1n3_confidential_otc::cancel`,
        typeArguments: [args.escrow.deliverableType, args.escrow.payType],
        arguments: [tx.object(args.escrow.escrowId)],
      });
      tx.transferObjects([deliverable], args.sellerAddress);
      const r = await signAndExecute({
        transaction: tx as unknown as Parameters<typeof signAndExecute>[0]["transaction"],
      });
      await suiClient.waitForTransaction({ digest: r.digest });
      return { digest: r.digest };
    },
    [suiClient, signAndExecute, cfg],
  );
}

/** DUSDC faucet — mints `FAUCET_AMOUNT` (1000 DUSDC) to the caller. */
export function useDusdcFaucet() {
  const suiClient = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const cfg = activeOtcEscrowConfig();

  return useCallback(async () => {
    if (!cfg) throw new Error("DUSDC not available on this network");
    const tx = new Transaction();
    tx.moveCall({
      target: `${cfg.packageId}::dusdc::faucet`,
      arguments: [tx.object(cfg.dusdcCapId)],
    });
    const r = await signAndExecute({
      transaction: tx as unknown as Parameters<typeof signAndExecute>[0]["transaction"],
    });
    await suiClient.waitForTransaction({ digest: r.digest });
    return { digest: r.digest };
  }, [suiClient, signAndExecute, cfg]);
}
