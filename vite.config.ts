import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import type { ServerResponse } from 'node:http';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import pkg from './package.json' with { type: 'json' };

function resolveAppVersion(): string {
  if (process.env.APP_VERSION) {
    return process.env.APP_VERSION.replace(/^v/, '');
  }
  try {
    const latestTag = execSync('git describe --tags --abbrev=0 --match "v[0-9]*"', {
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .toString()
      .trim();
    if (latestTag) return latestTag.replace(/^v/, '');
  } catch {
    // No git tags yet; fall back to package.json
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
