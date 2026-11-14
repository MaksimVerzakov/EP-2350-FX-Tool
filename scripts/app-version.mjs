/**
 * Resolves the app version shared by the web UI, the MCP server (stdio + Vite /mcp) and the
 * Cloudflare Worker bundle: `APP_VERSION` env (set by CI) → latest `vX.Y.Z` git tag →
 * package.json version.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

export function resolveAppVersion(rootDir = process.cwd()) {
  if (process.env.APP_VERSION) {
    return process.env.APP_VERSION.replace(/^v/, '');
  }
  try {
    const latestTag = execSync('git describe --tags --abbrev=0 --match "v[0-9]*"', {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .toString()
      .trim();
    if (latestTag) return latestTag.replace(/^v/, '');
  } catch {
    // No git tags (or no git); fall back to package.json
  }
  try {
    return JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0-dev';
  }
}

/** Replaces the `__APP_VERSION__` build-time token in source text with a string literal. */
export function injectAppVersion(source, version) {
  return source.replace(/\b__APP_VERSION__\b/g, JSON.stringify(version));
}
