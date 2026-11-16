#!/usr/bin/env node
/**
 * Builds the Cloudflare Worker (dist/_worker.js, see src/mcp/worker.ts): it serves dist/ as static
 * assets and answers the MCP endpoint at /mcp on the same domain. wrangler.jsonc points at it.
 * `.assetsignore` keeps the Worker bundle itself out of the public static assets.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleTs } from './bundle-ts.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(__filename), '..');

export const WORKER_ENTRY = 'src/mcp/worker.ts';

export async function buildWorker(outDir = path.join(ROOT_DIR, 'dist')) {
  const workerPath = path.join(outDir, '_worker.js');
  await bundleTs({ rootDir: ROOT_DIR, entry: WORKER_ENTRY, outFile: workerPath, platform: 'neutral' });
  fs.writeFileSync(path.join(outDir, '.assetsignore'), '_worker.js\n', 'utf8');
  return { workerPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const { workerPath } = await buildWorker();
  console.log(`✓ Built Cloudflare Worker: ${path.relative(ROOT_DIR, workerPath)}`);
}
