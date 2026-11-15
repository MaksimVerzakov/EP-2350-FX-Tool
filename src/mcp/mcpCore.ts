import { EFFECTS_REGISTRY } from '../constants/effectsRegistry';
import { OFFICIAL_TE_PACKS } from '../constants/defaultPresets';
import {
  DEFAULT_PUBLIC_APP_URL,
  buildPackShareUrl,
  buildPresetShareUrl,
  encodePackToHash,
  encodePresetToHash
} from '../utils/presetUrl';
import { MCP_TOOL_NAMES, buildToolList } from './toolSchemas';
import { checkPreset, hasStructuralErrors } from '../skill/presetCheck';
import {
  buildEffectsReference,
  detectPresetScale,
  exportPackConfig,
  normalizeSinglePreset,
  readPreset,
  validatePresetInput
} from '../skill/presetTools';

export { buildEffectsReference, normalizeSinglePreset, readPreset };

export interface McpRuntimeOptions {
  /** Base URL of the web UI for generating #preset= shareable deep-links */
  uiUrl?: string;
  /** Hosted edge (Cloudflare Worker): never makes outbound requests on behalf of callers. */
  edgeMode?: boolean;
  /** Write a local file (stdio transport only; used by export_pack_config `outputPath`). */
  writeLocalFile?: (pathStr: string, data: Uint8Array | string) => string;
  /**
   * Browser origins allowed to call the Streamable HTTP endpoint. Requests without an
   * `Origin` header (non-browser MCP clients) are always accepted. Defaults to loopback
   * origins only (`localhost`, `127.0.0.1`, `[::1]`), which blocks cross-site requests and
   * DNS-rebinding attacks against a local dev server. Use `'*'` for a public, file-less
   * deployment such as the Cloudflare Worker.
   */
  allowedOrigins?: '*' | string[];
  /** Maximum accepted HTTP request body size in bytes (default 8 MiB). */
  maxRequestBytes?: number;
}

export const DEFAULT_MAX_REQUEST_BYTES = 8 * 1024 * 1024;

/** MCP protocol revisions this server implements, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
/** Assumed by Streamable HTTP when a client sends no `MCP-Protocol-Version` header. */
const DEFAULT_HTTP_PROTOCOL_VERSION = '2025-03-26';
const MAX_BATCH_SIZE = 8;

/** App version injected at build/load time (`__APP_VERSION__`), shared with the web UI. */
export const MCP_SERVER_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0-dev';

export const MCP_SERVER_INFO = {
  name: 'ep2350-fx-mcp-server',
  title: 'EP-2350 FX Tool',
  version: MCP_SERVER_VERSION
};

const MCP_SERVER_INSTRUCTIONS =
  'Builds effect presets for the Teenage Engineering EP-2350 fx mic. 1) Call get_effects_reference for the preset format, every effect and parameter, modulation and the hardware rules. 2) Write the preset. 3) Call validate_preset and fix every error it reports (each issue names the exact field, what is wrong and how to fix it); its summary describes in plain words what the preset will do. 4) Deliver with export_pack_config (hardware config.json), and give the user the shareUrl or call push_to_live_ui so they can listen to it in the web app.'

/** Picks the protocol version to answer `initialize` with (spec version negotiation). */
export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
}

/** JSON-RPC error codes used by this server. */
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL_ERROR = -32603;
const RPC_RESOURCE_NOT_FOUND = -32002;

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** True when the URL's hostname is a loopback address (localhost, 127.0.0.1, [::1]). */
export function isLoopbackUrl(rawUrl: string): boolean {
  try {
    const { hostname } = new URL(rawUrl);
    return (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === '[::1]' ||
      hostname === '::1' ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname)
    );
  } catch {
    return false;
  }
}

function isOriginAllowed(origin: string, allowedOrigins: McpRuntimeOptions['allowedOrigins']) {
  if (allowedOrigins === '*') return true;
  if (Array.isArray(allowedOrigins) && allowedOrigins.includes(origin)) return true;
  return isLoopbackUrl(origin);
}

export const MCP_RESOURCES = [
  {
    uri: 'ep2350://schema/effects-registry',
    name: 'EP-2350 Effects Registry & Hardware Constraints',
    description:
      'Complete specification of all 11 EP-2350 effects, parameter bounds, units, single-instance constraints, parallel BUS 1/2 routing, and modulation depth scaling rules.',
    mimeType: 'application/json'
  },
  {
    uri: 'ep2350://presets/official-packs',
    name: 'Official Teenage Engineering EP-2350 Preset Packs',
    description:
      'All 3 official TE preset packs (BROKEN RADIO, DUB, MYSTERIOUS = 12 hardware presets) for few-shot sound design reference. Values are in hardware config.json scale (0.0..1.0): pass a pack to validate_preset as configJson, or multiply percent values by 100 for a `preset`.',
    mimeType: 'application/json'
  }
];

export const MCP_PROMPTS = [
  {
    name: 'design-fx-from-description',
    description:
      'Design an EP-2350 vocal effect preset from a natural language description, validate it and deliver it.',
    arguments: [
      {
        name: 'description',
        description: 'Desired vocal effect sound and expressive Handle/Shake behavior',
        required: true
      }
    ]
  }
];

/** Full tool list as advertised on the stdio transport (local file access available). */
export const MCP_TOOLS = buildToolList({ localFiles: true, edgeMode: false });

export async function handleMcpCoreRequest(
  request: Record<string, any>,
  options: McpRuntimeOptions = {}
): Promise<Record<string, any> | null> {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return rpcError(null, RPC_INVALID_REQUEST, 'Invalid Request');
  }

  const { id, method, params } = request;

  // Responses sent by the client (e.g. to server requests) need no reply.
  if (method === undefined && ('result' in request || 'error' in request)) {
    return null;
  }

  if (request.jsonrpc !== '2.0' || typeof method !== 'string') {
    return rpcError(
      typeof id === 'string' || typeof id === 'number' ? id : null,
      RPC_INVALID_REQUEST,
      'Invalid Request: expected a JSON-RPC 2.0 message with a string "method"'
    );
  }

  // Notifications (no id) get no response.
  if (id === undefined) {
    return null;
  }

  // MCP requires request ids to be a string or integer (never null).
  if (typeof id !== 'string' && typeof id !== 'number') {
    return rpcError(null, RPC_INVALID_REQUEST, 'Invalid Request: id must be a string or number');
  }

  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
          capabilities: {
            resources: { listChanged: false },
            tools: { listChanged: false },
            prompts: { listChanged: false }
          },
          serverInfo: MCP_SERVER_INFO,
          instructions: MCP_SERVER_INSTRUCTIONS
        }
      };
    }

    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }

    if (method === 'resources/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: { resources: MCP_RESOURCES }
      };
    }

    if (method === 'resources/read') {
      const uri = params?.uri;
      if (uri === 'ep2350://schema/effects-registry') {
        const schemaDoc = buildEffectsReference();
        return {
          jsonrpc: '2.0',
          id,
          result: {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(schemaDoc, null, 2)
              }
            ]
          }
        };
      }

      if (uri === 'ep2350://presets/official-packs') {
        const packsDoc = OFFICIAL_TE_PACKS.map((p) => ({
          id: p.id,
          name: p.name,
          subtitle: p.subtitle,
          config: JSON.parse(p.rawJson)
        }));
        return {
          jsonrpc: '2.0',
          id,
          result: {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(packsDoc, null, 2)
              }
            ]
          }
        };
      }

      return rpcError(id, RPC_RESOURCE_NOT_FOUND, `Resource not found: ${uri}`);
    }

    if (method === 'prompts/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: { prompts: MCP_PROMPTS }
      };
    }

    if (method === 'prompts/get') {
      const promptName = params?.name;
      const args = params?.arguments || {};
      const promptDef = MCP_PROMPTS.find((p) => p.name === promptName);
      if (!promptDef) {
        return rpcError(id, RPC_INVALID_PARAMS, `Unknown prompt: ${promptName}`);
      }
      const missingArgs = promptDef.arguments
        .filter((a) => a.required && !(typeof args[a.name] === 'string' && args[a.name].trim()))
        .map((a) => a.name);
      if (missingArgs.length > 0) {
        return rpcError(
          id,
          RPC_INVALID_PARAMS,
          `Missing required prompt argument(s): ${missingArgs.join(', ')}`
        );
      }
      if (promptName === 'design-fx-from-description') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            description: 'Design and verify an EP-2350 effect chain from a text prompt',
            messages: [
              {
                role: 'user',
                content: {
                  type: 'text',
                  text: `Design an EP-2350 vocal effect preset for: "${args.description || ''}". Call get_effects_reference first, then write the preset (effect chain plus handle/shake/lfo modulation) yourself. Call validate_preset and fix every error and warning it reports; read its summary and check it matches the description. Finally deliver it with export_pack_config and give the user the shareUrl so they can listen to it.`
                }
              }
            ]
          }
        };
      }
      return rpcError(id, RPC_INVALID_PARAMS, `Unknown prompt: ${promptName}`);
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: buildToolList({
            localFiles: Boolean(options.writeLocalFile),
            edgeMode: Boolean(options.edgeMode)
          })
        }
      };
    }

    if (method === 'tools/call') {
      const toolName = String(params?.name || '');
      if (!MCP_TOOL_NAMES.includes(toolName)) {
        return rpcError(id, RPC_INVALID_PARAMS, `Unknown tool: ${toolName}`);
      }
      const rawArgs = params?.arguments ?? {};
      if (typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
        return rpcError(id, RPC_INVALID_PARAMS, 'Tool arguments must be an object');
      }
      // Failures inside a tool (bad WAV data, invalid preset, ...) are reported as tool results
      // with isError so the model can see them and self-correct, not as protocol errors.
      let toolOutput: Record<string, any>;
      try {
        toolOutput = await executeMcpToolCall(toolName, rawArgs, options);
      } catch (err) {
        toolOutput = {
          error: `${toolName} failed: ${err instanceof Error ? err.message : String(err)}`
        };
      }
      const isError = Boolean(toolOutput?.error);
      // Plain JSON round-trip drops undefined fields so structuredContent matches the text block.
      const structured = JSON.parse(JSON.stringify(toolOutput));
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(structured, null, 2)
            }
          ],
          // structuredContent must match the tool's outputSchema, so it is only sent on success.
          ...(isError ? {} : { structuredContent: structured }),
          isError
        }
      };
    }

    return rpcError(id, RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
  } catch (err) {
    return rpcError(id, RPC_INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
  }
}

async function executeMcpToolCall(
  toolName: string,
  args: Record<string, any>,
  options: McpRuntimeOptions
): Promise<Record<string, any>> {
  const shareBaseUrl = String(args.uiUrl || options.uiUrl || DEFAULT_PUBLIC_APP_URL).replace(
    /\/+$/,
    ''
  );
  const isEdge = Boolean(options.edgeMode);

  // Writing files is only wired up for the trusted stdio transport. Over HTTP the callback is
  // stripped, so reject a path argument explicitly instead of silently ignoring it.
  if (!options.writeLocalFile && typeof args.outputPath === 'string' && args.outputPath.trim() !== '') {
    return {
      error:
        'outputPath is not available on this transport (files can only be written by the stdio server, npm run mcp). Use the returned configJson or shareUrl instead.'
    };
  }

  switch (toolName) {
    case 'get_effects_reference': {
      if (args.effect !== undefined) {
        const wanted = String(args.effect).toUpperCase();
        if (!Object.prototype.hasOwnProperty.call(EFFECTS_REGISTRY, wanted)) {
          return { error: `Unknown effect "${args.effect}". Valid: ${Object.keys(EFFECTS_REGISTRY).join(', ')}.` };
        }
      }
      return buildEffectsReference(args.effect);
    }

    case 'validate_preset': {
      return validatePresetInput(args, shareBaseUrl);
    }

    case 'export_pack_config': {
      const exported = exportPackConfig(args, shareBaseUrl);
      if (exported.error) return exported;
      const { configJsonString, ...result } = exported;
      const writtenPath =
        args.outputPath && options.writeLocalFile
          ? options.writeLocalFile(args.outputPath, configJsonString)
          : undefined;
      return { ...result, writtenPath };
    }

    case 'push_to_live_ui': {
      const payload: Record<string, any> = {};
      let shareHash = '';
      let shareUrl = '';

      if (args.pack && typeof args.pack === 'object') {
        payload.pack = args.pack;
        shareHash = encodePackToHash(args.pack, args.slot);
        shareUrl = buildPackShareUrl(shareBaseUrl, args.pack, args.slot);
      } else if (args.preset && typeof args.preset === 'object') {
        const pushIssues = checkPreset(args.preset, detectPresetScale(args.preset));
        if (hasStructuralErrors(pushIssues)) {
          return {
            error: 'The preset cannot be read; fix the errors below (validate_preset gives the same details).',
            errors: pushIssues.filter((i) => i.type === 'error')
          };
        }
        const slot = typeof args.slot === 'number' ? args.slot : args.preset.pos ?? 0;
        payload.preset = readPreset({ ...args.preset, pos: slot }, slot).preset;
        payload.slot = slot;
        shareHash = encodePresetToHash(payload.preset, slot);
        shareUrl = buildPresetShareUrl(shareBaseUrl, payload.preset, slot);
      } else {
        return { error: 'Provide either `preset` or `pack` to push to the live UI.' };
      }

      // On remote Cloudflare edge, always deliver via stateless shareUrl deep-link. The edge
      // never makes outbound requests on behalf of callers (prevents SSRF via `uiUrl`).
      if (isEdge) {
        return {
          pushed: true,
          deliveryMode: 'shareUrl',
          shareHash,
          shareUrl,
          message:
            'Open shareUrl in your browser to audition and edit this preset in your isolated session.'
        };
      }

      const baseUrl = String(args.uiUrl || options.uiUrl || 'http://localhost:3000').replace(
        /\/$/,
        ''
      );
      const endpoint = `${baseUrl}/__mcp_sync`;

      // A caller-supplied uiUrl may only point at a local dev server.
      if (args.uiUrl && !isLoopbackUrl(baseUrl)) {
        return {
          pushed: false,
          deliveryMode: 'shareUrl',
          shareHash,
          shareUrl,
          error: `Live push is only allowed to a local dev server (localhost / 127.0.0.1); refusing ${endpoint}. Open shareUrl directly to load this preset in your browser.`
        };
      }

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!res.ok) {
          return {
            pushed: false,
            deliveryMode: 'shareUrl',
            endpoint,
            shareHash,
            shareUrl,
            message: `The web app at ${baseUrl} responded with status ${res.status}, so nothing was pushed live. Open shareUrl to load this preset in your browser.`
          };
        }
        const data = await res.json();
        return {
          pushed: true,
          deliveryMode: 'live',
          endpoint,
          shareHash,
          shareUrl,
          response: data
        };
      } catch (err) {
        // Not an error: the shareUrl is the normal delivery when no local dev server is running.
        return {
          pushed: false,
          deliveryMode: 'shareUrl',
          endpoint,
          shareHash,
          shareUrl,
          message: `No local dev server at ${baseUrl} (${err instanceof Error ? err.message : String(err)}), so nothing was pushed live. Open shareUrl to load this preset in your browser.`
        };
      }
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

export const MCP_CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id'
};

function buildCorsHeaders(
  origin: string | null,
  allowedOrigins: McpRuntimeOptions['allowedOrigins']
): Record<string, string> {
  if (allowedOrigins === '*') {
    return { ...MCP_CORS_HEADERS, 'Access-Control-Allow-Origin': '*' };
  }
  const headers: Record<string, string> = { ...MCP_CORS_HEADERS, Vary: 'Origin' };
  if (origin && isOriginAllowed(origin, allowedOrigins)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function jsonRpcErrorResponse(
  status: number,
  code: number,
  message: string,
  headers: Record<string, string>
): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } }), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' }
  });
}

/**
 * Web-standard Fetch handler for MCP Streamable HTTP (`POST /mcp`, `GET /mcp`, `OPTIONS /mcp`).
 * Runs natively in Cloudflare Workers, Cloudflare Pages Functions, and Node 20+.
 *
 * Security: local filesystem callbacks are never exposed over HTTP, browser `Origin`s are
 * validated (loopback-only by default), POST bodies must be `application/json` (so cross-site
 * "simple" requests cannot trigger tool calls), and request bodies are size-capped.
 */
export async function handleMcpHttpFetch(
  request: Request,
  options: McpRuntimeOptions = {}
): Promise<Response> {
  const url = new URL(request.url);
  // Never expose local file access over HTTP, whatever the caller passed in.
  const { writeLocalFile: _writeLocalFile, ...httpSafeOptions } = options;
  const effectiveOptions: McpRuntimeOptions = {
    ...httpSafeOptions,
    uiUrl: options.uiUrl || `${url.protocol}//${url.host}`
  };

  const origin = request.headers.get('origin');
  const corsHeaders = buildCorsHeaders(origin, options.allowedOrigins);

  if (origin && !isOriginAllowed(origin, options.allowedOrigins)) {
    return jsonRpcErrorResponse(403, -32600, `Forbidden origin: ${origin}`, corsHeaders);
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }

  // This server is stateless (no Mcp-Session-Id), so there is no session to terminate.
  if (request.method === 'DELETE') {
    return jsonRpcErrorResponse(
      405,
      RPC_INVALID_REQUEST,
      'Method Not Allowed: this server is stateless and has no sessions to terminate',
      { ...corsHeaders, Allow: 'GET, POST, OPTIONS' }
    );
  }

  if (request.method === 'GET') {
    // The server never sends unsolicited messages, so it offers no SSE stream (spec: 405).
    const accept = request.headers.get('accept') || '';
    if (accept.includes('text/event-stream') && !accept.includes('text/html')) {
      return jsonRpcErrorResponse(
        405,
        RPC_INVALID_REQUEST,
        'Method Not Allowed: this server does not offer a server-to-client SSE stream',
        { ...corsHeaders, Allow: 'GET, POST, OPTIONS' }
      );
    }

    return new Response(
      JSON.stringify(
        {
          ...MCP_SERVER_INFO,
          status: 'ok',
          protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
          transport: 'Streamable HTTP (JSON-RPC 2.0)',
          endpoint: `${effectiveOptions.uiUrl}/mcp`,
          uiUrl: effectiveOptions.uiUrl,
          tools: MCP_TOOLS.map((t) => t.name),
          resources: MCP_RESOURCES.map((r) => r.uri)
        },
        null,
        2
      ),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      }
    );
  }

  if (request.method === 'POST') {
    // Spec: an unsupported MCP-Protocol-Version header must be rejected with 400.
    const protocolHeader = request.headers.get('mcp-protocol-version');
    if (protocolHeader && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolHeader)) {
      return jsonRpcErrorResponse(
        400,
        RPC_INVALID_REQUEST,
        `Unsupported MCP-Protocol-Version: ${protocolHeader} (supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')})`,
        corsHeaders
      );
    }

    const contentType = (request.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('application/json')) {
      return jsonRpcErrorResponse(
        415,
        -32600,
        'Unsupported Media Type: POST /mcp requires Content-Type: application/json',
        corsHeaders
      );
    }

    const maxBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    const declaredLength = Number(request.headers.get('content-length') || 0);
    if (declaredLength > maxBytes) {
      return jsonRpcErrorResponse(
        413,
        -32600,
        `Request body too large (limit ${maxBytes} bytes)`,
        corsHeaders
      );
    }

    let bodyJson: unknown;
    try {
      const rawText = await request.text();
      if (new TextEncoder().encode(rawText).byteLength > maxBytes) {
        return jsonRpcErrorResponse(
          413,
          -32600,
          `Request body too large (limit ${maxBytes} bytes)`,
          corsHeaders
        );
      }
      bodyJson = JSON.parse(rawText);
    } catch {
      return jsonRpcErrorResponse(400, -32700, 'Parse error', corsHeaders);
    }

    // JSON-RPC batching was removed from MCP in 2025-06-18; only 2025-03-26 allowed it.
    if (Array.isArray(bodyJson)) {
      const negotiated = protocolHeader || DEFAULT_HTTP_PROTOCOL_VERSION;
      if (negotiated !== '2025-03-26' || bodyJson.length === 0 || bodyJson.length > MAX_BATCH_SIZE) {
        return jsonRpcErrorResponse(
          400,
          RPC_INVALID_REQUEST,
          bodyJson.length === 0 || bodyJson.length > MAX_BATCH_SIZE
            ? `Invalid batch: expected 1-${MAX_BATCH_SIZE} messages`
            : `JSON-RPC batching is not supported in MCP protocol version ${negotiated}`,
          corsHeaders
        );
      }
      const responses = [];
      for (const item of bodyJson) {
        const res = await handleMcpCoreRequest(item as Record<string, any>, effectiveOptions);
        if (res !== null) responses.push(res);
      }

      if (responses.length === 0) {
        return new Response(null, {
          status: 202,
          headers: corsHeaders
        });
      }

      return new Response(JSON.stringify(responses), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }

    const rpcResponse = await handleMcpCoreRequest(
      bodyJson as Record<string, any>,
      effectiveOptions
    );
    if (rpcResponse === null) {
      return new Response(null, {
        status: 202,
        headers: corsHeaders
      });
    }

    return new Response(JSON.stringify(rpcResponse), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }

  return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
    status: 405,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
}
