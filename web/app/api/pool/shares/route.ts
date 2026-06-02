import { NextResponse } from 'next/server';

const SUI_RPC_URL = process.env.SUI_RPC_URL ?? 'https://fullnode.devnet.sui.io:443';
const PACKAGE_ID  = process.env.PACKAGE_ID;

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(SUI_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    cache: 'no-store',
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message ?? JSON.stringify(json.error)}`);
  return json.result;
}

export interface ShareEvent {
  poolId:     string;
  jobId:      string;
  worker:     string;
  nonce:      string;
  difficulty: string;
  timestampMs: string;
  txDigest:   string;
}

export interface SharesResponse {
  shares: ShareEvent[];
}

export async function GET() {
  if (!PACKAGE_ID) {
    return NextResponse.json({ error: 'PACKAGE_ID is not configured' }, { status: 503 });
  }

  try {
    const evRes = await rpc('suix_queryEvents', [
      { MoveEventType: `${PACKAGE_ID}::pool::ShareAccepted` },
      null,
      50,
      true, // descending — newest first
    ]) as Record<string, unknown>;

    const shares: ShareEvent[] = ((evRes?.data as unknown[]) ?? []).map(ev => {
      const e      = ev as Record<string, unknown>;
      const parsed = e.parsedJson as Record<string, unknown> | undefined;
      const evId   = e.id as Record<string, unknown> | undefined;

      return {
        poolId:      String(parsed?.pool_id   ?? ''),
        jobId:       String(parsed?.job_id     ?? '0'),
        worker:      String(parsed?.worker     ?? ''),
        nonce:       String(parsed?.nonce      ?? '0'),
        difficulty:  String(parsed?.difficulty ?? '0'),
        timestampMs: String(e.timestampMs      ?? '0'),
        txDigest:    String(evId?.txDigest     ?? ''),
      };
    });

    return NextResponse.json({ shares } satisfies SharesResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
