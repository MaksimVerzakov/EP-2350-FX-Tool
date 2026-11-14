#!/usr/bin/env node
/**
 * Builds the self-contained Cloudflare Worker (`dist/_worker.js`) and static
 * routing manifest (`dist/_routes.json`) so the EP-2350 website and `/mcp`
 * Streamable HTTP MCP server live on the exact same domain.
 *
 * Static assets (`/`, `/assets/*`, `#preset=...`) are excluded from Worker
 * invocation via `_routes.json` so they remain 100% unlimited on Cloudflare's Free Tier.
 */

import fs from 'node:fs';
import path from 'node:path';
import { MCP_WORKER_ENTRY, bundleMcp } from './bundle-mcp.mjs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

export async function buildCloudflareWorker(outDir = DIST_DIR) {
  fs.mkdirSync(outDir, { recursive: true });
  const outWorkerFile = path.join(outDir, '_worker.js');

  await bundleMcp({
    rootDir: ROOT_DIR,
    entry: MCP_WORKER_ENTRY,
    outFile: outWorkerFile,
    platform: 'neutral'
  });

  // Write Cloudflare Pages _routes.json so ONLY /mcp invokes the Worker
  // and all static website assets are served with unlimited free requests
  const routesConfig = {
    version: 1,
    include: ['/mcp', '/mcp/*'],
    exclude: []
  };
  fs.writeFileSync(
    path.join(outDir, '_routes.json'),
    JSON.stringify(routesConfig, null, 2) + '\n',
    'utf8'
  );
  fs.writeFileSync(path.join(outDir, '.assetsignore'), '_worker.js\n_routes.json\n', 'utf8');

  return {
    workerPath: outWorkerFile,
    routesPath: path.join(outDir, '_routes.json')
  };
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMainModule) {
  await buildCloudflareWorker();
  console.log('✓ Built Cloudflare Worker bundle: dist/_worker.js + dist/_routes.json');
}
