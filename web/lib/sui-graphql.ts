/**
 * Lightweight GraphQL client for the Sui indexer.
 *
 * The Sui GraphQL endpoint sends Access-Control-Allow-Origin: * so it can be
 * called directly from the browser — no proxy needed.
 * JSON-RPC is scheduled for deprecation in July 2026; GraphQL is the
 * recommended replacement for web apps.
 */

import { SUI_NETWORK } from './constants';

const GRAPHQL_URLS: Record<string, string> = {
  mainnet: 'https://graphql.mainnet.sui.io/graphql',
  testnet: 'https://graphql.testnet.sui.io/graphql',
  devnet: 'https://graphql.devnet.sui.io/graphql',
};

export const GRAPHQL_URL = GRAPHQL_URLS[SUI_NETWORK] ?? GRAPHQL_URLS['testnet'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function gql<T = any>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const resp = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) throw new Error(`GraphQL HTTP ${resp.status}`);
  const json = await resp.json();
  if (json.errors?.length) {
    throw new Error(json.errors[0]?.message ?? 'GraphQL error');
  }
  return json.data as T;
}

/** Decode a base64 string (vector<u8> in GraphQL JSON) to a lowercase hex string. */
export function b64hex(val: unknown): string {
  if (typeof val !== 'string') return '';
  try {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(val, 'base64').toString('hex');
    }
    const bin = atob(val);
    return Array.from(bin).map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  } catch {
    return '';
  }
}

/** Decode an array of base64 strings (vector<vector<u8>>) to hex strings. */
export function b64hexArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.map(b64hex).filter((s) => s.length > 0);
}

/** Parse a GraphQL u64 (returned as string) or u32/u8 (returned as number). */
export function parseU64(val: unknown): number {
  if (typeof val === 'string') return parseInt(val, 10) || 0;
  if (typeof val === 'number') return val;
  return 0;
}
