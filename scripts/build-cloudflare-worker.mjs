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
import os from 'node:os';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { injectAppVersion, resolveAppVersion } from './app-version.mjs';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

export async function buildCloudflareWorker(outDir = DIST_DIR) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep2350-cf-worker-'));

  try {
    const filesToCompile = [
      'src/types/config.ts',
      'src/constants/effectsRegistry.ts',
      'src/constants/defaultPresets.ts',
      'src/utils/parser.ts',
      'src/utils/serializer.ts',
      'src/utils/presetUrl.ts',
      'src/utils/wavCodec.ts',
      'src/dsp/math.ts',
      'src/dsp/offlineRenderer.ts',
      'src/dsp/analyzer.ts',
      'src/dsp/optimizer.ts',
      'src/mcp/toolSchemas.ts',
      'src/mcp/mcpCore.ts',
      'src/mcp/cloudflareWorker.ts'
    ];

    const appVersion = resolveAppVersion(ROOT_DIR);
    for (const relPath of filesToCompile) {
      const absIn = path.join(ROOT_DIR, relPath);
      let source = fs.readFileSync(absIn, 'utf8');

      // Inline ?raw JSON pack imports
      source = source.replace(
        /import\s+([a-zA-Z0-9_]+)\s+from\s+['"]([^'"]+)\?raw['"]/g,
        (_, varName, importPath) => {
          const fullJsonPath = path.resolve(path.dirname(absIn), importPath);
          const jsonContent = fs.readFileSync(fullJsonPath, 'utf8');
          return `const ${varName} = ${JSON.stringify(jsonContent)};`;
        }
      );

      source = injectAppVersion(source, appVersion);

      const stripped = stripTypeScriptTypes(source);
      const rewritten = stripped.replace(
        /from\s+['"](\.[^'"]+)['"]/g,
        (_, spec) => `from '${spec}.mjs'`
      );

      const absOut = path.join(tmpDir, relPath.replace(/\.ts$/, '.mjs'));
      fs.mkdirSync(path.dirname(absOut), { recursive: true });
      fs.writeFileSync(absOut, rewritten, 'utf8');
    }

    fs.mkdirSync(outDir, { recursive: true });
    const entryFile = path.join(tmpDir, 'src/mcp/cloudflareWorker.mjs');
    const outWorkerFile = path.join(outDir, '_worker.js');

    const bundle = await rolldown({
      input: entryFile
    });

    await bundle.write({
      file: outWorkerFile,
      format: 'esm'
    });
    await bundle.close();

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
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMainModule) {
  await buildCloudflareWorker();
  console.log('✓ Built Cloudflare Worker bundle: dist/_worker.js + dist/_routes.json');
}
