/**
 * Bundles TypeScript sources into one ESM file with rolldown (it follows imports and strips
 * types itself, so there is no hand-maintained list of files to compile). Used by
 * scripts/build-skill.mjs for the skill's SKILL.md renderer and validator CLI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { rolldown } from 'rolldown';
import { injectAppVersion, resolveAppVersion } from './app-version.mjs';

const RAW_SUFFIX = '?raw';

/**
 * Handles the two Vite-only features the shared sources use:
 *   - `import x from './file.json?raw'` → the file's text as a default-exported string
 *   - the `__APP_VERSION__` build-time token → the resolved app version string
 *   - any extra `define` tokens (e.g. `__EP2350_APP_URL__`) → their JSON-encoded values
 */
function ep2350SourcePlugin(version, define = {}) {
  return {
    name: 'ep2350-sources',
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
      if (!/\.[cm]?tsx?$/.test(id)) return null;
      let out = code.includes('__APP_VERSION__') ? injectAppVersion(code, version) : code;
      for (const [token, value] of Object.entries(define)) {
        out = out.replaceAll(token, JSON.stringify(value));
      }
      return out === code ? null : { code: out, map: null };
    }
  };
}

/**
 * Bundles `entry` (relative to `rootDir`) into a single ESM file at `outFile`.
 * Returns the output path and the version that was injected.
 */
export async function bundleTs({
  rootDir,
  entry,
  outFile,
  platform = 'node',
  version = resolveAppVersion(rootDir),
  define = {}
}) {
  const bundle = await rolldown({
    input: path.resolve(rootDir, entry),
    platform,
    plugins: [ep2350SourcePlugin(version, define)],
    // Fail loudly instead of emitting a bundle with unresolved imports.
    onwarn(warning, defaultHandler) {
      if (warning.code === 'UNRESOLVED_IMPORT') {
        throw new Error(`[bundle-ts] ${warning.message}`);
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
