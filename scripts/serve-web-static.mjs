import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve('web/out');
const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? '0.0.0.0';
const suiRpcUrl = process.env.SUI_RPC_URL ?? 'https://fullnode.devnet.sui.io:443';
const packageId = process.env.SUI_PACKAGE
  ?? process.env.PACKAGE_ID
  ?? '0xe7f4a12f7be6bcb538963fca9a5ef3d34e0c79008d8a41fd7ae9bfdf12c67be4';
const poolObjectId = process.env.POOL_OBJECT
  ?? process.env.POOL_OBJECT_ID
  ?? '0xc16be431e437b96566b76c4b96084639ac5e581a8d4909ed43bc6d52dded2285';

const types = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function resolvePath(urlPath) {
  const pathname = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  const clean = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const direct = resolve(join(root, clean));
  if (!direct.startsWith(root)) return null;

  if (existsSync(direct)) return direct;
  if (!extname(direct) && existsSync(`${direct}.html`)) return `${direct}.html`;
  if (pathname === '/' && existsSync(join(root, 'index.html'))) return join(root, 'index.html');
  return null;
}

async function rpc(method, params) {
  const res = await fetch(suiRpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message ?? JSON.stringify(json.error)}`);
  return json.result;
}

function bytes(value) {
  if (Array.isArray(value)) return value.flatMap((item) => (Array.isArray(item) ? bytes(item) : Number(item)));
  if (typeof value === 'string') {
    const isHex = [...value].every((c) => /[0-9a-fA-F]/.test(c));
    if (isHex && value.length % 2 === 0) {
      const out = [];
      for (let i = 0; i < value.length; i += 2) out.push(parseInt(value.slice(i, i + 2), 16));
      return out;
    }
    try {
      return Array.from(Buffer.from(value, 'base64'));
    } catch {
      return [];
    }
  }
  return [];
}

function hex(value) {
  return bytes(value).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function ascii(value) {
  const data = bytes(value);
  const chars = [];
  const offset = data[0] === 0x03 && data.length > 4 ? 4 : 0;
  for (let i = offset; i < data.length && chars.length < 48; i += 1) {
    const b = data[i];
    if (b >= 0x20 && b <= 0x7e) chars.push(String.fromCharCode(b));
    else if (chars.length >= 6) break;
  }
  return chars.join('').trim();
}

async function templatesPayload() {
  let pool = { poolId: poolObjectId, operator: '', totalShares: '0', difficulty: '0' };
  try {
    const poolRes = await rpc('sui_getObject', [poolObjectId, { showContent: true }]);
    const fields = poolRes?.data?.content?.fields ?? {};
    pool = {
      poolId: poolObjectId,
      operator: String(fields.admin ?? ''),
      totalShares: String(fields.total_shares ?? '0'),
      difficulty: String(fields.global_min_difficulty ?? '0'),
    };
  } catch {
    // Keep rendering templates even if the pool stats object is temporarily unavailable.
  }

  const eventRes = await rpc('suix_queryEvents', [
    { MoveEventType: `${packageId}::pool::TemplateCreated` },
    null,
    50,
    true,
  ]);
  const events = eventRes?.data ?? [];
  const eventMap = new Map();
  const ids = [];
  for (const event of events) {
    const id = String(event?.parsedJson?.template_id ?? '');
    if (!id) continue;
    ids.push(id);
    eventMap.set(id, {
      timestampMs: String(event.timestampMs ?? event.parsedJson?.timestamp_ms ?? '0'),
      txDigest: String(event.id?.txDigest ?? ''),
    });
  }

  const objects = ids.length ? await rpc('sui_multiGetObjects', [ids, { showContent: true }]) : [];
  const jobs = objects
    .map((obj, index) => {
      const fields = obj?.data?.content?.fields;
      if (!fields) return null;
      const id = String(obj.data.objectId ?? ids[index] ?? '');
      const event = eventMap.get(id) ?? {};
      return {
        jobId: String(fields.height ?? index),
        templateId: id,
        poolId: poolObjectId,
        operator: String(fields.owner ?? ''),
        prevHash: hex(fields.prev_block_hash),
        coinbase1: hex(fields.coinbase1),
        coinbaseAscii: ascii(fields.coinbase1),
        merkleBranches: Array.isArray(fields.merkle_branches) ? fields.merkle_branches.map(hex) : [],
        version: String(fields.version ?? '0'),
        nBits: String(fields.nbits ?? '0'),
        nTime: String(fields.ntime ?? '0'),
        createdEpoch: String(fields.created_at_ms ?? '0'),
        timestampMs: String(event.timestampMs ?? fields.created_at_ms ?? '0'),
        txDigest: String(event.txDigest ?? ''),
      };
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.createdEpoch) - Number(a.createdEpoch));

  return { jobs, pool };
}

async function sharesPayload() {
  const eventRes = await rpc('suix_queryEvents', [
    { MoveEventType: `${packageId}::pool::BatchSharesValidated` },
    null,
    50,
    true,
  ]);
  const shares = [];
  for (const event of eventRes?.data ?? []) {
    const parsed = event.parsedJson ?? {};
    const miners = Array.isArray(parsed.miners) ? parsed.miners : [];
    const hashes = Array.isArray(parsed.share_hashes) ? parsed.share_hashes : [];
    const difficulties = Array.isArray(parsed.difficulties) ? parsed.difficulties : [];
    const count = Math.max(Number(parsed.valid_count ?? 0), miners.length, hashes.length, difficulties.length);
    for (let i = 0; i < count; i += 1) {
      const shareHash = hex(hashes[i] ?? []);
      shares.push({
        poolId: poolObjectId,
        jobId: String(parsed.template_id ?? ''),
        templateId: String(parsed.template_id ?? ''),
        worker: String(miners[i] ?? ''),
        nonce: shareHash.slice(0, 16),
        shareHash,
        difficulty: String(difficulties[i] ?? parsed.total_difficulty ?? '0'),
        timestampMs: String(event.timestampMs ?? parsed.timestamp_ms ?? '0'),
        txDigest: String(event.id?.txDigest ?? ''),
      });
    }
  }
  return { shares };
}

async function sendJson(res, producer) {
  try {
    const payload = await producer();
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(payload));
  } catch (error) {
    res.writeHead(502, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify({ error: error.message ?? String(error) }));
  }
}

createServer(async (req, res) => {
  const pathname = (req.url ?? '/').split('?')[0];
  if (pathname === '/api/templates') return sendJson(res, templatesPayload);
  if (pathname === '/api/shares') return sendJson(res, sharesPayload);

  const file = resolvePath(req.url ?? '/');
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'content-type': types[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}).listen(port, host, () => {
  console.log(`Serving ${root} at http://${host}:${port}`);
});
