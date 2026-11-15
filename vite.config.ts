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
 * Serves `./skill/*` dynamically in `vite dev` / Playwright tests so SKILL.md
 * and the downloadable skill zip behave identically to the production build.
 */
function serveDevSkillPlugin(appVersion: string): Plugin {
  const skillCacheDir = path.resolve(process.cwd(), 'node_modules/.cache/ep2350-skill');
  return {
    name: 'ep2350-dev-skill',
    configureServer(server) {
      server.middlewares.use('/skill', async (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          next();
          return;
        }
        try {
          const reqPath = (req.url || '/').split('?')[0];
          const relPath = reqPath.replace(/^\/+/, '');
          if (!relPath || relPath.includes('..')) {
            next();
            return;
          }
          const host = req.headers.host || 'localhost:3000';
          const appUrl = `http://${host}`;
          await buildSkill({ outDir: skillCacheDir, appUrl, version: appVersion });
          const targetPath = path.resolve(skillCacheDir, relPath);
          if (!targetPath.startsWith(skillCacheDir + path.sep) || !fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
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

const appVersion = resolveAppVersion(process.cwd());

export default defineConfig({
  base: './',
  plugins: [react(), serveDevSkillPlugin(appVersion)],
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
