import { MCP_PATH, handleMcpRequest } from './mcpServer';

/**
 * Cloudflare Worker: serves the built web app (dist/) as static assets and answers the
 * MCP endpoint at /mcp on the same domain. Share links point back at this domain unless
 * EP2350_UI_URL is set.
 */

export interface WorkerEnv {
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
  EP2350_UI_URL?: string;
}

export default {
  async fetch(request: Request, env: WorkerEnv = {}): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    if (pathname === MCP_PATH) {
      const appUrl = (env.EP2350_UI_URL || url.origin).replace(/\/+$/, '');
      // One JSON line per MCP message; Workers Logs indexes the fields (see observability in wrangler.jsonc).
      return handleMcpRequest(request, { appUrl, log: (entry) => console.log(JSON.stringify(entry)) });
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not Found', { status: 404 });
  }
};
