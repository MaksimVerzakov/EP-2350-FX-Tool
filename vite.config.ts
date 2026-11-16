import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { resolveAppVersion } from './scripts/app-version.mjs';
import { buildSkill } from './scripts/build-skill.mjs';

const MIME_BY_EXT: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8',
  '.zip': 'application/zip',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

/**
 * Serves the skill in `vite dev` / Playwright tests exactly as the production build publishes it:
 * `./skill/*` (SKILL.md, zip), `./skill.md` (short link) and `./.well-known/agent-skills/*`
 * (discovery index for `npx skills add`).
 */
function serveDevSkillPlugin(appVersion: string): Plugin {
  const siteCacheDir = path.resolve(process.cwd(), 'node_modules/.cache/ep2350-skill-site');
  const isSkillPath = (p: string) => p === 'skill.md' || p.startsWith('skill/') || p.startsWith('.well-known/agent-skills/');
  return {
    name: 'ep2350-dev-skill',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          next();
          return;
        }
        try {
          const reqPath = (req.url || '/').split('?')[0];
          const relPath = decodeURIComponent(reqPath).replace(/^\/+/, '');
          if (!isSkillPath(relPath) || relPath.includes('..')) {
            next();
            return;
          }
          const host = req.headers.host || 'localhost:3000';
          const appUrl = `http://${host}`;
          await buildSkill({ outDir: path.join(siteCacheDir, 'skill'), siteDir: siteCacheDir, appUrl, version: appVersion });
          const targetPath = path.resolve(siteCacheDir, relPath);
          if (!targetPath.startsWith(siteCacheDir + path.sep) || !fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
            next();
            return;
          }
          const ext = path.extname(targetPath).toLowerCase();
          res.setHeader('Content-Type', MIME_BY_EXT[ext] || 'application/octet-stream');
          if (req.method === 'HEAD') {
            res.end();
            return;
          }
          res.end(fs.readFileSync(targetPath));
        } catch (err) {
          next(err);
        }
      });
    }
  };
}

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
  plugins: [react(), serveDevSkillPlugin(appVersion), serveDevMcpPlugin()],
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
