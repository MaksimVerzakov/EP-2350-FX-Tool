/**
 * Resolves the app version shared by the web UI and the MCP server:
 * `APP_VERSION` env (set by CI) → latest `vX.Y.Z` git tag → package.json version.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

function parseSemver(ver) {
  const m = ver.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemver(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function bumpSemverFromCommit(base, commitMsg) {
  if (/(BREAKING CHANGE|^[a-zA-Z]+(\([^)]+\))?!:)/m.test(commitMsg)) {
    return `${base[0] + 1}.0.0`;
  }
  if (/(^feat(\([^)]+\))?:|from [^/\s]+\/feat[-/])/m.test(commitMsg)) {
    return `${base[0]}.${base[1] + 1}.0`;
  }
  return `${base[0]}.${base[1]}.${base[2] + 1}`;
}

export function resolveAppVersion(rootDir = process.cwd()) {
  if (process.env.APP_VERSION) {
    return process.env.APP_VERSION.replace(/^v/, '');
  }
  try {
    const headSha = execSync('git rev-parse HEAD', {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .toString()
      .trim();

    let bestVer = null;
    let bestSha = '';

    // 1. Try local tags first
    try {
      const localTag = execSync('git tag -l "v[0-9]*.[0-9]*.[0-9]*" --sort=-v:refname', {
        cwd: rootDir,
        stdio: ['ignore', 'pipe', 'ignore']
      })
        .toString()
        .trim()
        .split('\n')[0]
        ?.trim();
      if (localTag) {
        bestVer = parseSemver(localTag);
        bestSha = execSync(`git rev-list -n 1 "${localTag}"`, {
          cwd: rootDir,
          stdio: ['ignore', 'pipe', 'ignore']
        })
          .toString()
          .trim();
      }
    } catch {
      // Ignore local tag errors
    }

    // 2. Fallback to origin tags for shallow clones (e.g. CI checkouts without tags)
    if (!bestVer) {
      const remoteLines = execSync('git ls-remote --tags origin "refs/tags/v[0-9]*"', {
        cwd: rootDir,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000
      })
        .toString()
        .trim()
        .split('\n');

      const tagCommits = new Map();
      for (const line of remoteLines) {
        const [sha, ref] = line.trim().split(/\s+/);
        if (!sha || !ref) continue;
        const cleanRef = ref.replace(/^refs\/tags\//, '');
        const isPeeled = cleanRef.endsWith('^{}');
        const tagName = isPeeled ? cleanRef.slice(0, -3) : cleanRef;
        if (!tagCommits.has(tagName) || isPeeled) {
          tagCommits.set(tagName, sha);
        }
      }

      for (const [tagName, sha] of tagCommits.entries()) {
        const parsed = parseSemver(tagName);
        if (parsed && (!bestVer || compareSemver(parsed, bestVer) > 0)) {
          bestVer = parsed;
          bestSha = sha;
        }
      }
    }

    if (bestVer) {
      if (bestSha && headSha && bestSha !== headSha) {
        try {
          const lastMsg = execSync('git log -1 --pretty=%B', {
            cwd: rootDir,
            stdio: ['ignore', 'pipe', 'ignore']
          })
            .toString()
            .trim();
          if (/Merge pull request #\d+/.test(lastMsg)) {
            return bumpSemverFromCommit(bestVer, lastMsg);
          }
        } catch {
          // Ignore commit inspection error
        }
      }
      return bestVer.join('.');
    }
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
