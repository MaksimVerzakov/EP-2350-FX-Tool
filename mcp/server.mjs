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
import { MCP_CORE_ENTRY, bundleMcp } from '../scripts/bundle-mcp.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

let engineModulesPromise = null;

/**
 * Bundle the TypeScript MCP core (and everything it imports) with rolldown into a temp ESM
 * file and import it. Runs once per process; there is no file list to maintain.
 */
export function loadEp2350EngineModules() {
  if (!engineModulesPromise) {
    engineModulesPromise = (async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep2350-mcp-'));
      process.on('exit', () => {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
      });
      const { outFile } = await bundleMcp({
        rootDir: ROOT_DIR,
        entry: MCP_CORE_ENTRY,
        outFile: path.join(tmpDir, 'mcp-core.mjs'),
        platform: 'node'
      });
      return import(pathToFileURL(outFile).href);
    })();
    // Allow a retry after a failed build (e.g. a syntax error fixed while the dev server runs).
    engineModulesPromise.catch(() => {
      engineModulesPromise = null;
    });
  }
  return engineModulesPromise;
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
