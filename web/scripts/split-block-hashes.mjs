#!/usr/bin/env node

/**
 * Splits the monolithic block-hashes.json into smaller chunks
 * served as static assets under public/data/block-hashes/.
 *
 * Each chunk contains CHUNK_SIZE hashes (array of strings).
 * A meta.json file records { total, chunkSize, chunks }.
 *
 * Block height maps directly to array index:
 *   chunk = Math.floor(height / CHUNK_SIZE)
 *   index within chunk = height % CHUNK_SIZE
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CHUNK_SIZE = 10_000;
const INPUT_CANDIDATES = [
  resolve(__dirname, '..', 'data', 'block-hashes.json'),
  resolve(__dirname, '..', '..', 'data', 'block-hashes.json'),
];
const INPUT = INPUT_CANDIDATES.find((p) => existsSync(p));
const OUTPUT_DIR = resolve(__dirname, '..', 'public', 'data', 'block-hashes');

rmSync(OUTPUT_DIR, { recursive: true, force: true });
mkdirSync(OUTPUT_DIR, { recursive: true });

if (!INPUT) {
  console.warn(
    'split-block-hashes: block-hashes.json not found in web/data or repo-root data; emitting empty meta.json so the build can continue.',
  );
  writeFileSync(
    resolve(OUTPUT_DIR, 'meta.json'),
    JSON.stringify({ total: 0, chunkSize: CHUNK_SIZE, chunks: 0 }),
  );
  process.exit(0);
}

console.log(`Reading ${INPUT}...`);
const allHashes = JSON.parse(readFileSync(INPUT, 'utf-8'));
const total = allHashes.length;
console.log(`Total hashes: ${total}`);

const numChunks = Math.ceil(total / CHUNK_SIZE);

for (let i = 0; i < numChunks; i++) {
  const start = i * CHUNK_SIZE;
  const end = Math.min(start + CHUNK_SIZE, total);
  const chunk = allHashes.slice(start, end);
  writeFileSync(
    resolve(OUTPUT_DIR, `chunk-${i}.json`),
    JSON.stringify(chunk),
  );
}

// Write meta.json
const meta = { total, chunkSize: CHUNK_SIZE, chunks: numChunks };
writeFileSync(resolve(OUTPUT_DIR, 'meta.json'), JSON.stringify(meta));

console.log(`Wrote ${numChunks} chunks + meta.json to ${OUTPUT_DIR}`);
