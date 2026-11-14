import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import type { ServerResponse } from 'node:http';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import pkg from './package.json' with { type: 'json' };

function parseSemver(ver: string): [number, number, number] | null {
  const m = ver.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function bumpSemverFromCommit(base: [number, number, number], commitMsg: string): string {
  if (/(BREAKING CHANGE|^[a-zA-Z]+(\([^)]+\))?!:)/m.test(commitMsg)) {
    return `${base[0] + 1}.0.0`;
  }
  if (/(^feat(\([^)]+\))?:|from [^/\s]+\/feat[-/])/m.test(commitMsg)) {
    return `${base[0]}.${base[1] + 1}.0`;
  }
  return `${base[0]}.${base[1]}.${base[2] + 1}`;
}

function resolveAppVersion(): string {
  if (process.env.APP_VERSION) {
    return process.env.APP_VERSION.replace(/^v/, '');
  }
  try {
    const headSha = execSync('git rev-parse HEAD', {
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .toString()
      .trim();

    let bestVer: [number, number, number] | null = null;
    let bestSha = '';

    // 1. Try local tags first
    try {
      const localTag = execSync('git tag -l "v[0-9]*.[0-9]*.[0-9]*" --sort=-v:refname', {
        stdio: ['ignore', 'pipe', 'ignore']
      })
        .toString()
        .trim()
        .split('\n')[0]
        ?.trim();
      if (localTag) {
        bestVer = parseSemver(localTag);
        bestSha = execSync(`git rev-list -n 1 "${localTag}"`, {
          stdio: ['ignore', 'pipe', 'ignore']
        })
          .toString()
          .trim();
      }
    } catch {
      // Ignore local tag errors
    }

    // 2. Fallback to origin tags for shallow clones (e.g. Cloudflare Workers Builds)
    if (!bestVer) {
      const remoteLines = execSync('git ls-remote --tags origin "refs/tags/v[0-9]*"', {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000
      })
        .toString()
        .trim()
        .split('\n');

      const tagCommits = new Map<string, string>();
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
        // Check if HEAD is ahead of bestSha (e.g., Cloudflare building before deploy.yml pushes the new tag)
        try {
          const lastMsg = execSync('git log -1 --pretty=%B', {
            stdio: ['ignore', 'pipe', 'ignore']
          })
            .toString()
            .trim();
          const isMainMerge = /Merge pull request #\d+/.test(lastMsg);
          if (isMainMerge) {
            return bumpSemverFromCommit(bestVer, lastMsg);
          }
        } catch {
          // Ignore commit inspection error
        }
      }
      return bestVer.join('.');
    }
  } catch {
    // No git info available; fall back to package.json
  }
  return pkg.version;
}

/**
 * Vite dev-server middleware that bridges the EP-2350 MCP Server (`push_to_live_ui`)
 * with any open browser tab via Server-Sent Events (`/__mcp_sync`).
 */
function ep2350McpLiveSyncPlugin(): Plugin {
  const sseClients = new Set<ServerResponse>();
  let latestPayload: unknown = null;

  return {
    name: 'ep2350-mcp-live-sync',
    configureServer(server) {
      server.middlewares.use('/__mcp_sync', (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
          res.statusCode = 204;
          res.end();
          return;
        }

        if (req.method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          });
          res.write('retry: 2000\n\n');
          if (latestPayload) {
            res.write(`data: ${JSON.stringify(latestPayload)}\n\n`);
          }
          sseClients.add(res);
          req.on('close', () => {
            sseClients.delete(res);
          });
          return;
        }

        if (req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => {
            body += chunk.toString();
          });
          req.on('end', () => {
            try {
              const parsed = JSON.parse(body || '{}');
              latestPayload = { ...parsed, timestamp: Date.now() };
              const serialized = `data: ${JSON.stringify(latestPayload)}\n\n`;
              for (const client of sseClients) {
                client.write(serialized);
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  ok: true,
                  connectedClients: sseClients.size
                })
              );
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  ok: false,
                  error: err instanceof Error ? err.message : 'Invalid JSON body'
                })
              );
            }
          });
          return;
        }

        res.statusCode = 405;
        res.end();
      });

      // Streamable HTTP MCP endpoint (/mcp) on the same local origin as the web UI
      server.middlewares.use('/mcp', (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        req.on('end', () => {
          void (async () => {
            try {
              const host = req.headers.host || 'localhost:3000';
              const fullUrl = `http://${host}/mcp`;
              const headers = new Headers();
              for (const [k, v] of Object.entries(req.headers)) {
                if (typeof v === 'string') headers.set(k, v);
                else if (Array.isArray(v)) headers.set(k, v.join(', '));
              }
              const method = req.method || 'GET';
              const bodyBuf = Buffer.concat(chunks);
              const webReq = new Request(fullUrl, {
                method,
                headers,
                body:
                  method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'
                    ? bodyBuf
                    : undefined
              });
              const mcpServerPath = './mcp/server.mjs';
              const { handleMcpHttpFetch } = await import(/* @vite-ignore */ mcpServerPath);
              const webRes: Response = await handleMcpHttpFetch(webReq, {
                uiUrl: `http://${host}`
              });
              res.statusCode = webRes.status;
              webRes.headers.forEach((val, key) => {
                res.setHeader(key, val);
              });
              const arrayBuf = await webRes.arrayBuffer();
              res.end(Buffer.from(arrayBuf));
            } catch (err) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: null,
                  error: {
                    code: -32603,
                    message: err instanceof Error ? err.message : String(err)
                  }
                })
              );
            }
          })();
        });
      });
    }
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), ep2350McpLiveSyncPlugin()],
  define: {
    __APP_VERSION__: JSON.stringify(resolveAppVersion())
  },
  server: {
    port: 3000,
    open: true,
    watch: {
      ignored: ['**/.worktrees/**']
    }
  }
});
