/**
 * Single build path for the EP-2350 MCP server code.
 *
 * Rolldown bundles the TypeScript sources straight from an entry point (it follows imports and
 * strips types itself), so there is no hand-maintained list of files to compile. Used by:
 *   - mcp/server.mjs                     → stdio server + Vite dev `/mcp` (bundled at startup)
 *   - scripts/build-cloudflare-worker.mjs → dist/_worker.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { rolldown } from 'rolldown';
import { injectAppVersion, resolveAppVersion } from './app-version.mjs';

/** MCP core (JSON-RPC + Streamable HTTP handlers) for Node. */
export const MCP_CORE_ENTRY = 'src/mcp/mcpCore.ts';
/** Cloudflare Worker entry (`/mcp` + static assets). */
export const MCP_WORKER_ENTRY = 'src/mcp/cloudflareWorker.ts';

const RAW_SUFFIX = '?raw';

/**
 * Handles the two Vite-only features the shared sources use:
 *   - `import x from './file.json?raw'` → the file's text as a default-exported string
 *   - the `__APP_VERSION__` build-time token → the resolved app version string
 */
function ep2350SourcePlugin(version) {
  return {
    name: 'ep2350-mcp-sources',
    resolveId(source, importer) {
      if (!source.endsWith(RAW_SUFFIX) || !importer) return null;
      const file = path.resolve(path.dirname(importer), source.slice(0, -RAW_SUFFIX.length));
      return `${file}${RAW_SUFFIX}`;
    },
    load(id) {
      if (!id.endsWith(RAW_SUFFIX)) return null;
      const text = fs.readFileSync(id.slice(0, -RAW_SUFFIX.length), 'utf8');
      return { code: `export default ${JSON.stringify(text)};`, moduleType: 'js' };
    },
    transform(code, id) {
      if (!/\.[cm]?tsx?$/.test(id) || !code.includes('__APP_VERSION__')) return null;
      return { code: injectAppVersion(code, version), map: null };
    }
  };
}

/**
 * Bundles `entry` (relative to `rootDir`) into a single ESM file at `outFile`.
 * Returns the output path and the version that was injected.
 */
export async function bundleMcp({
  rootDir,
  entry,
  outFile,
  platform = 'node',
  version = resolveAppVersion(rootDir)
}) {
  const bundle = await rolldown({
    input: path.resolve(rootDir, entry),
    platform,
    plugins: [ep2350SourcePlugin(version)],
    // Fail loudly instead of emitting a bundle with unresolved imports.
    onwarn(warning, defaultHandler) {
      if (warning.code === 'UNRESOLVED_IMPORT') {
        throw new Error(`[bundle-mcp] ${warning.message}`);
      }
      defaultHandler(warning);
    }
  });
  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    await bundle.write({ file: outFile, format: 'esm' });
  } finally {
    await bundle.close();
  }
  return { outFile, version };
}
