/**
 * Client-side block-hash lookup backed by chunked static JSON files.
 *
 * Files live at /data/block-hashes/meta.json and /data/block-hashes/chunk-N.json.
 * Each chunk is fetched at most once per session (cached in-memory).
 */

interface BlockHashMeta {
  total: number;
  chunkSize: number;
  chunks: number;
}

interface HashEntry {
  height: number;
  hash: string;
}

interface HashesPage {
  hashes: HashEntry[];
  total: number;
  offset: number;
  limit: number;
}

let metaCache: BlockHashMeta | null = null;
const chunkCache = new Map<number, string[]>();

async function getMeta(): Promise<BlockHashMeta> {
  if (metaCache) return metaCache;
  const resp = await fetch('/data/block-hashes/meta.json');
  if (!resp.ok) throw new Error('Failed to load block-hashes meta');
  metaCache = (await resp.json()) as BlockHashMeta;
  return metaCache;
}

async function getChunk(index: number): Promise<string[]> {
  const cached = chunkCache.get(index);
  if (cached) return cached;
  const resp = await fetch(`/data/block-hashes/chunk-${index}.json`);
  if (!resp.ok) throw new Error(`Failed to load block-hashes chunk ${index}`);
  const data = (await resp.json()) as string[];
  chunkCache.set(index, data);
  return data;
}

/**
 * Look up the hash for a single block height.
 * Returns { hashes: [{ height, hash }], total } matching the old API shape,
 * or { hashes: [], total } if the height is out of range.
 */
export async function lookupBlockHash(
  height: number,
): Promise<HashesPage> {
  const meta = await getMeta();
  if (height < 0 || height >= meta.total) {
    return { hashes: [], total: meta.total, offset: height, limit: 1 };
  }
  const chunkIndex = Math.floor(height / meta.chunkSize);
  const chunk = await getChunk(chunkIndex);
  const indexInChunk = height % meta.chunkSize;
  return {
    hashes: [{ height, hash: chunk[indexInChunk] }],
    total: meta.total,
    offset: height,
    limit: 1,
  };
}

/**
 * Paginated listing of block hashes (mirrors the old API route).
 * order='desc' returns newest-first, 'asc' returns oldest-first.
 */
export async function fetchBlockHashesPage(
  offset: number,
  limit: number,
  order: 'asc' | 'desc' = 'desc',
): Promise<HashesPage> {
  const meta = await getMeta();
  const entries: HashEntry[] = [];

  if (order === 'desc') {
    // Newest first: start from (total - 1 - offset)
    const start = meta.total - 1 - offset;
    for (let i = start; i >= 0 && entries.length < limit; i--) {
      const chunkIndex = Math.floor(i / meta.chunkSize);
      const chunk = await getChunk(chunkIndex);
      entries.push({ height: i, hash: chunk[i % meta.chunkSize] });
    }
  } else {
    for (let i = offset; i < meta.total && entries.length < limit; i++) {
      const chunkIndex = Math.floor(i / meta.chunkSize);
      const chunk = await getChunk(chunkIndex);
      entries.push({ height: i, hash: chunk[i % meta.chunkSize] });
    }
  }

  return { hashes: entries, total: meta.total, offset, limit };
}
