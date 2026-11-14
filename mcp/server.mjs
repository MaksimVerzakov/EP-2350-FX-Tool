#!/usr/bin/env node
/**
 * EP-2350 FX Tool — Model Context Protocol (MCP) Server
 *
 * Exposes the EP-2350 DSP Engine, Acoustic Analyzer, Parameter Optimizer,
 * Hardware Validator, and Live Web UI Bridge over standard MCP stdio JSON-RPC 2.0
 * and Streamable HTTP (`/mcp`).
 *
 * Usage:
 *   npm run mcp
 *   node mcp/server.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { stripTypeScriptTypes } from 'node:module';
import { injectAppVersion, resolveAppVersion } from '../scripts/app-version.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

let cachedEngineModules = null;

/**
 * Compile and load the TypeScript DSP & MCP core modules on the fly using Node 22+
 * built-in `stripTypeScriptTypes`. Zero external bundler or build step required.
 */
export async function loadEp2350EngineModules() {
  if (cachedEngineModules) return cachedEngineModules;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep2350-mcp-'));
  process.on('exit', () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

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
    'src/mcp/mcpCore.ts'
  ];

  const appVersion = resolveAppVersion(ROOT_DIR);
  for (const relPath of filesToCompile) {
    const absIn = path.join(ROOT_DIR, relPath);
    let source = fs.readFileSync(absIn, 'utf8');

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

  const importMod = (relMjs) => import(pathToFileURL(path.join(tmpDir, relMjs)).href);

  const [
    effectsRegistryMod,
    defaultPresetsMod,
    parserMod,
    serializerMod,
    presetUrlMod,
    wavCodecMod,
    offlineRendererMod,
    analyzerMod,
    optimizerMod,
    mcpCoreMod
  ] = await Promise.all([
    importMod('src/constants/effectsRegistry.mjs'),
    importMod('src/constants/defaultPresets.mjs'),
    importMod('src/utils/parser.mjs'),
    importMod('src/utils/serializer.mjs'),
    importMod('src/utils/presetUrl.mjs'),
    importMod('src/utils/wavCodec.mjs'),
    importMod('src/dsp/offlineRenderer.mjs'),
    importMod('src/dsp/analyzer.mjs'),
    importMod('src/dsp/optimizer.mjs'),
    importMod('src/mcp/mcpCore.mjs')
  ]);

  cachedEngineModules = {
    ...effectsRegistryMod,
    ...defaultPresetsMod,
    ...parserMod,
    ...serializerMod,
    ...presetUrlMod,
    ...wavCodecMod,
    ...offlineRendererMod,
    ...analyzerMod,
    ...optimizerMod,
    ...mcpCoreMod
  };

  return cachedEngineModules;
}

function createNodeRuntimeOptions(overrides = {}) {
  return {
    uiUrl: overrides.uiUrl || process.env.EP2350_UI_URL || undefined,
    edgeMode: Boolean(overrides.edgeMode),
    resolveLocalPath: (p) => path.resolve(ROOT_DIR, p),
    readLocalFile: (p) => {
      const abs = path.resolve(ROOT_DIR, p);
      return fs.readFileSync(abs);
    },
    writeLocalFile: (p, data) => {
      const abs = path.resolve(ROOT_DIR, p);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, data);
      return abs;
    },
    ...overrides
  };
}

/**
 * Execute an MCP JSON-RPC 2.0 request and return the JSON-RPC response object
 * (or `null` for notifications).
 */
export async function handleMcpJsonRpcRequest(request, options = {}) {
  const engine = await loadEp2350EngineModules();
  return engine.handleMcpCoreRequest(request, createNodeRuntimeOptions(options));
}

/**
 * Execute an MCP Streamable HTTP Web `Request` and return a Web `Response`.
 */
export async function handleMcpHttpFetch(request, options = {}) {
  const engine = await loadEp2350EngineModules();
  return engine.handleMcpHttpFetch(request, createNodeRuntimeOptions(options));
}

// Start stdio JSON-RPC loop when invoked directly as a CLI script
const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMainModule) {
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false
  });

  let queue = Promise.resolve();

  const writeMessage = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    queue = queue.then(async () => {
      let req;
      try {
        req = JSON.parse(trimmed);
      } catch {
        writeMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      // JSON-RPC batching is not part of MCP stdio since 2025-06-18.
      if (Array.isArray(req)) {
        writeMessage({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Invalid Request: batching is not supported' }
        });
        return;
      }
      try {
        const res = await handleMcpJsonRpcRequest(req);
        if (res) writeMessage(res);
      } catch (err) {
        // stdout is reserved for protocol messages; diagnostics go to stderr.
        process.stderr.write(`[ep2350-mcp] ${err instanceof Error ? err.stack : String(err)}\n`);
        const id =
          req && (typeof req.id === 'string' || typeof req.id === 'number') ? req.id : null;
        if (id !== null) {
          writeMessage({
            jsonrpc: '2.0',
            id,
            error: { code: -32603, message: err instanceof Error ? err.message : String(err) }
          });
        }
      }
    });
  });
}
