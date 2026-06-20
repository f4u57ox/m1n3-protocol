import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { SUI_RPC_URL, SUI_NETWORK } from './constants';

function buildUrl(net: 'devnet' | 'testnet' | 'mainnet'): string {
  // Sui's public fullnodes return Access-Control-Allow-Origin: *, so the
  // browser can talk to them directly. Static export has no Node route to
  // proxy through, so we use the upstream URL on both server and client.
  if (SUI_RPC_URL) return SUI_RPC_URL;
  return getJsonRpcFullnodeUrl(net);
}

const NET = (SUI_NETWORK === 'mainnet'
  ? 'mainnet'
  : SUI_NETWORK === 'devnet'
    ? 'devnet'
    : 'testnet') as 'devnet' | 'testnet' | 'mainnet';

export const suiClient = new SuiJsonRpcClient({
  url: buildUrl(NET),
  network: NET,
});
