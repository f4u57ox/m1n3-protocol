#!/usr/bin/env node
// Create the DeepBookV3 HS_000 / USDC pool on Sui mainnet.
//
// Cost: 500 DEEP (pool creation fee) + ~0.05 SUI gas.
//
// Reads .env.mainnet for the m1n3 package id and HS_000 coin type. Loads
// the deploy wallet's keypair from ~/.sui/sui_config/sui.keystore. Builds
// the DeepBookV3 `create_permissionless_pool` PTB and submits.
//
// Why a Node script instead of `sui client ptb`: DeepBook does scalar
// conversion on tick/lot/min, the DEEP fee coin must be sourced from
// owned objects via `coinWithBalance`, and the SDK already encapsulates
// all of that. Re-implementing it in shell is bug-bait.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ENV_FILE = join(ROOT, '.env.mainnet');
const KEYSTORE = join(homedir(), '.sui', 'sui_config', 'sui.keystore');

// Resolve @mysten/* and @noble/* from the web/ workspace's node_modules.
// `createRequire` rooted at a package.json inside `web/` lets us use the
// SDK installs that already exist there instead of duplicating them.
const requireFromWeb = createRequire(join(ROOT, 'web', 'package.json'));

function loadDotenv(path) {
  const m = {};
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    m[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return m;
}

async function main() {
  const env = loadDotenv(ENV_FILE);
  const PKG = env.SUI_PACKAGE;
  const USDC_TYPE = env.USDC_TYPE;
  if (!PKG || !USDC_TYPE) {
    throw new Error('SUI_PACKAGE or USDC_TYPE missing from .env.mainnet');
  }
  const HS_000_TYPE = `${PKG}::hs_000::HS_000`;

  // Resolve through web/'s node_modules — the SDK packages use ESM
  // exports maps that only work when Node's CJS resolver enters them
  // from a context where they're listed as deps.
  //
  // In @mysten/sui@2.x the JSON-RPC client lives under the `./jsonRpc`
  // subpath (not `./client`). Match the export shape used by the dapp.
  const { SuiJsonRpcClient, getJsonRpcFullnodeUrl } = requireFromWeb('@mysten/sui/jsonRpc');
  const { Ed25519Keypair } = requireFromWeb('@mysten/sui/keypairs/ed25519');
  const { Transaction } = requireFromWeb('@mysten/sui/transactions');
  const dbk = requireFromWeb('@mysten/deepbook-v3');
  const { DeepBookClient, mainnetCoins } = dbk;

  // Load the keystore — array of base64-encoded private keys.
  const keystore = JSON.parse(readFileSync(KEYSTORE, 'utf8'));

  // Find the keypair whose address matches the active CLI address.
  // (We can't ask the CLI for it from inside Node; the user must have
  // already `sui client switch --address m1n3-mainnet`-ed before running.)
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('sui', ['client', 'active-address']);
  const activeAddr = r.stdout.toString().trim();
  if (!activeAddr.startsWith('0x')) {
    throw new Error('failed to read active address from `sui client active-address`');
  }

  let keypair = null;
  for (const raw of keystore) {
    // Sui keystore stores keys as base64 of `[flag][32-byte private key]`.
    const bytes = Buffer.from(raw, 'base64');
    const flag = bytes[0];
    if (flag !== 0x00) continue; // 0x00 = ed25519 signature scheme.
    const sk = bytes.slice(1);
    const kp = Ed25519Keypair.fromSecretKey(sk);
    if (kp.toSuiAddress() === activeAddr) {
      keypair = kp;
      break;
    }
  }
  if (!keypair) {
    throw new Error(`no ed25519 keypair in ${KEYSTORE} matches active address ${activeAddr}`);
  }

  const client = new SuiJsonRpcClient({
    network: 'mainnet',
    url: 'https://fullnode.mainnet.sui.io:443',
  });

  console.log(`==> Creating DeepBookV3 pool for HS_000 / USDC on mainnet`);
  console.log(`    base:  ${HS_000_TYPE}`);
  console.log(`    quote: ${USDC_TYPE}`);
  console.log(`    payer: ${activeAddr}`);

  // Inject HS_000 into the SDK's coin map. HashShares are integer-only
  // (decimals = 0, scalar = 1).
  const coins = {
    ...mainnetCoins,
    HS_000: {
      address: PKG,
      type: HS_000_TYPE,
      scalar: 1,
      feed: '',
      currencyId: '',
      priceInfoObjectId: '',
    },
  };

  // DeepBookV3 hard constraints (`pool::create_pool`):
  //   - tick_size > 0 AND power of 10
  //   - lot_size >= 1000 AND power of 10
  //   - min_size > 0 AND multiple of lot_size AND power of 10
  //
  // With HS_000 at 0 decimals, lot_size=1000 means the smallest tradable
  // HashShare quantity on DeepBook is 1000 HS. Smaller trades route
  // through the in-house `hash_share_market` (no min). The 0.01 USDC
  // tick keeps prices on a sensible grid for HS valuations in the
  // single-digit-USDC range.
  const tickSize = Number(process.env.TICK_SIZE ?? 0.01); // 0.01 USDC per HS
  const lotSize = Number(process.env.LOT_SIZE ?? 1000); // 1000 HS per lot
  const minSize = Number(process.env.MIN_SIZE ?? 1000); // 1000 HS minimum order

  const dbClient = new DeepBookClient({
    address: activeAddr,
    network: 'mainnet',
    client,
    coins,
  });

  const tx = new Transaction();
  tx.setSenderIfNotSet(activeAddr);
  dbClient.deepBook.createPermissionlessPool({
    baseCoinKey: 'HS_000',
    quoteCoinKey: 'USDC',
    tickSize,
    lotSize,
    minSize,
  })(tx);

  console.log('==> Submitting...');
  const res = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: { showEffects: true, showObjectChanges: true },
  });
  await client.waitForTransaction({ digest: res.digest });

  console.log(`==> Tx digest: ${res.digest}`);
  const poolObj = (res.objectChanges ?? []).find(
    (c) => c.type === 'created' && c.objectType.includes('::pool::Pool<'),
  );
  if (poolObj) {
    console.log(`==> Pool object: ${poolObj.objectId}`);
    console.log(`==> Splice into .env.mainnet manually as DEEPBOOK_POOL_HS000_USDC=...`);
  } else {
    console.log('warning: pool object not found in tx effects; check SuiScan.');
  }
}

main().catch((e) => {
  console.error('error:', e?.message ?? e);
  process.exit(1);
});
