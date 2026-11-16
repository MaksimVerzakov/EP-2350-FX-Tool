import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { resolveAppVersion } from './scripts/app-version.mjs';

/**
 * Answers the MCP endpoint (/mcp) in `vite dev` the same way the Cloudflare Worker does in
 * production. The server module is loaded through Vite so its `?raw` imports resolve.
 */
function serveDevMcpPlugin(): Plugin {
  return {
    name: 'ep2350-dev-mcp',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const reqPath = (req.url || '/').split('?')[0].replace(/\/+$/, '');
        if (reqPath !== '/mcp') {
          next();
          return;
        }
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const origin = `http://${req.headers.host || 'localhost:3000'}`;
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
          const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
          const request = new Request(`${origin}${req.url}`, {
            method: req.method,
            headers,
            body: hasBody ? Buffer.concat(chunks) : undefined
          });
          const { handleMcpRequest } = await server.ssrLoadModule('/src/mcp/mcpServer.ts');
          const response: Response = await handleMcpRequest(request, { appUrl: origin });
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (err) {
          next(err);
        }
      });
    }
  };
}

const appVersion = resolveAppVersion(process.cwd());

export default defineConfig({
  base: './',
  plugins: [react(), serveDevMcpPlugin()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion)
  },
  server: {
    port: 3000,
    open: true,
    watch: {
      // Ignore only this checkout's nested worktrees. A '**/.worktrees/**' glob would also match
      // every file when the dev server itself runs inside a worktree, which disables HMR there.
      ignored: [path.resolve(process.cwd(), '.worktrees') + '/**']
    }
  }
});
