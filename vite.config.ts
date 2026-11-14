import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import type { ServerResponse } from 'node:http';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveAppVersion } from './scripts/app-version.mjs';


const MAX_SYNC_BODY_BYTES = 1024 * 1024;
const MAX_MCP_BODY_BYTES = 8 * 1024 * 1024;

function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === '[::1]' ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname)
    );
  } catch {
    return false;
  }
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
        // Same-origin only: the browser tab subscribes from this origin and the MCP server
        // pushes server-side, so no CORS headers are needed. Reject foreign browser origins.
        const origin = req.headers.origin;
        if (origin && !isLoopbackOrigin(origin)) {
          res.statusCode = 403;
          res.end();
          return;
        }

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
          // Require JSON so cross-site "simple" (text/plain) POSTs cannot push presets.
          if (!String(req.headers['content-type'] || '').includes('application/json')) {
            res.statusCode = 415;
            res.end();
            return;
          }
          let body = '';
          let tooLarge = false;
          req.on('data', (chunk) => {
            if (tooLarge) return;
            body += chunk.toString();
            if (body.length > MAX_SYNC_BODY_BYTES) tooLarge = true;
          });
          req.on('end', () => {
            if (tooLarge) {
              res.writeHead(413, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'Payload too large' }));
              return;
            }
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
        let receivedBytes = 0;
        req.on('data', (chunk) => {
          receivedBytes += chunk.length;
          if (receivedBytes > MAX_MCP_BODY_BYTES) return;
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        req.on('end', () => {
          if (receivedBytes > MAX_MCP_BODY_BYTES) {
            res.statusCode = 413;
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32600, message: 'Request body too large' }
              })
            );
            return;
          }
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
              // Resolve against the project root: the bundled config runs from
              // node_modules/.vite-temp, so a relative './mcp/server.mjs' would not resolve.
              const mcpServerUrl = pathToFileURL(
                path.resolve(server.config.root, 'mcp/server.mjs')
              ).href;
              const { handleMcpHttpFetch } = await import(/* @vite-ignore */ mcpServerUrl);
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
    __APP_VERSION__: JSON.stringify(resolveAppVersion(process.cwd()))
  },
  server: {
    port: 3000,
    open: true,
    watch: {
      ignored: ['**/.worktrees/**']
    }
  }
});
