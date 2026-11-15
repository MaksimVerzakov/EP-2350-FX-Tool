import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { resolveAppVersion } from './scripts/app-version.mjs';

export default defineConfig({
  base: './',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(resolveAppVersion(process.cwd()))
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
