import { handleMcpHttpFetch } from './mcpCore';

export interface CloudflareWorkerEnv {
  ASSETS?: {
    fetch: (request: Request) => Promise<Response>;
  };
  EP2350_UI_URL?: string;
}

export default {
  async fetch(request: Request, env: CloudflareWorkerEnv = {}): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (pathname === '/mcp') {
      const originUiUrl = env.EP2350_UI_URL || `${url.protocol}//${url.host}`;
      return handleMcpHttpFetch(request, {
        uiUrl: originUiUrl,
        edgeMode: true
      });
    }

    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  }
};
