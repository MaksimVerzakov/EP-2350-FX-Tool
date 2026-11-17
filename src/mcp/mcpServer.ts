import brokenRadioRaw from '../../packs/ep-2350_preset_pack-broken_radio/config.json?raw';
import dubPackRaw from '../../packs/ep-2350_preset_pack-dub/config.json?raw';
import mysteriousPackRaw from '../../packs/ep-2350_preset_pack-mysterious/config.json?raw';
import { renderFormatGuide } from './formatGuide';
import { TOOLS_VERSION } from '../validation/presetTools';
import { formatResult, validateText } from '../validation/validateText';

/**
 * Remote MCP server for the EP-2350 sound designer (Streamable HTTP, stateless, JSON responses).
 *
 * It gives any MCP client (Claude, ChatGPT, Gemini CLI, Cursor, ...) three tools, with nothing to
 * install and no code execution needed on the client side:
 *   get_format_guide  the config.json format and every effect's parameters (src/mcp/formatGuide.ts)
 *   validate_pack     checks a pack and returns errors with fixes, a summary and the share link
 *   get_example_pack  the official Teenage Engineering packs as starting points
 *
 * Pure: takes a Request, returns a Response. The Cloudflare Worker (src/mcp/worker.ts) and the
 * Vite dev server both call handleMcpRequest.
 */

export const MCP_PATH = '/mcp';
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_REQUEST_BYTES = 1024 * 1024;

const EXAMPLE_PACKS: Record<string, string> = {
  broken_radio: brokenRadioRaw,
  dub: dubPackRaw,
  mysterious: mysteriousPackRaw
};

export const SERVER_INSTRUCTIONS = `Designs effect presets for the Teenage Engineering EP-2350 fx mic.

1. Call get_format_guide once to learn the config.json format and the effect parameters.
2. Write the pack (up to 4 presets) for what the user described.
3. Call validate_pack with it. Fix every error it reports and call it again until it is VALID.
4. Give the user the share link from validate_pack. It opens the pack in the EP-2350 FX Tool web app, where they can listen to it, tweak it and send it to the mic over USB-C.`;

export interface McpOptions {
  /** Web app URL that share links open in (no trailing slash). */
  appUrl: string;
  /** Called once per JSON-RPC message (and once per rejected request) with what came in and what went out. */
  log?: (entry: McpLogEntry) => void;
}

/** Longest config text kept in a log entry; longer configs are cut and flagged. */
export const MAX_LOGGED_CONFIG_CHARS = 8000;

/**
 * One log line per MCP message: which client called which tool with what, and what it got back.
 * No IP address is recorded.
 */
export interface McpLogEntry {
  event: 'mcp';
  method: string | null;
  tool?: string;
  /** clientInfo from initialize (e.g. { name: "openai-mcp" }), to tell clients apart. */
  client?: { name?: string; version?: string };
  protocolVersion?: string;
  userAgent?: string;
  ray?: string;
  status: number;
  /** false for a JSON-RPC error or a tool result with isError. */
  ok: boolean;
  rpcError?: { code: number; message: string };
  /** validate_pack: the verdict and each issue as "code path". */
  isValid?: boolean;
  errors?: string[];
  warnings?: string[];
  /** validate_pack: the submitted config as text, cut to MAX_LOGGED_CONFIG_CHARS. */
  config?: string;
  configChars?: number;
  configTruncated?: boolean;
  /** get_example_pack: the requested name. */
  example?: string;
  ms: number;
}

type JsonRpcId = string | number | null;
interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, any>;
}

class RpcError extends Error {
  constructor(
    public code: number,
    message: string
  ) {
    super(message);
  }
}

export const TOOLS = [
  {
    name: 'get_format_guide',
    title: 'EP-2350 format guide',
    description:
      'Returns the EP-2350 config.json format: pack and preset structure, every effect with its parameters, ranges and defaults, and how the squeeze handle, shake and LFO modulate them. Call this once before writing a pack.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  {
    name: 'validate_pack',
    title: 'Check a pack and get its link',
    description:
      'Checks an EP-2350 config.json pack ({ "name", "presets": [...] }) or a single preset ({ "name", "list": [...] }). Returns VALID or every error with the exact field and how to fix it, a plain-language summary of what each preset does, and, when valid, a share link that opens the pack in the EP-2350 FX Tool web app. Always call this before giving a pack to the user, and give them the share link.',
    inputSchema: {
      type: 'object',
      properties: {
        config: {
          description: 'The pack or preset, as a JSON object or as JSON text.',
          anyOf: [{ type: 'object' }, { type: 'string' }]
        }
      },
      required: ['config'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  {
    name: 'get_example_pack',
    title: 'Official example pack',
    description:
      'Returns one of the three official Teenage Engineering EP-2350 packs (4 presets each) as config.json, as a starting point for a style: broken_radio (lo-fi radio and walkie talkie), dub (echoes and springs), mysterious (dark and pitched).',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', enum: Object.keys(EXAMPLE_PACKS) } },
      required: ['name'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }
];

const text = (t: string) => ({ type: 'text', text: t });

function callTool(name: string, args: Record<string, any>, opts: McpOptions): Record<string, any> {
  switch (name) {
    case 'get_format_guide':
      return { content: [text(renderFormatGuide({ appUrl: opts.appUrl }))] };
    case 'validate_pack': {
      const config = args.config;
      if (config === undefined || config === null || (typeof config !== 'string' && typeof config !== 'object')) {
        return { content: [text('validate_pack needs "config": the pack or preset as a JSON object or JSON text.')], isError: true };
      }
      const result = validateText(typeof config === 'string' ? config : JSON.stringify(config), opts.appUrl);
      const structured = {
        isValid: !!result.isValid,
        errors: result.errors ?? [],
        warnings: result.warnings ?? [],
        summary: result.summary ?? [],
        ...(result.isValid ? { shareUrl: result.shareUrl } : {}),
        ...(result.isValid ? { config: result.normalizedConfigJson ?? result.normalizedPresetJson } : {})
      };
      return { content: [text(formatResult(result))], structuredContent: structured };
    }
    case 'get_example_pack': {
      const raw = EXAMPLE_PACKS[args.name];
      if (!raw) {
        return { content: [text(`Unknown example "${args.name}". Use one of: ${Object.keys(EXAMPLE_PACKS).join(', ')}.`)], isError: true };
      }
      return { content: [text(raw)] };
    }
    default:
      throw new RpcError(-32602, `Unknown tool: ${name}`);
  }
}

/** Handles one JSON-RPC message. Returns null for notifications (no response). */
export function handleRpc(msg: JsonRpcMessage, opts: McpOptions): Record<string, any> | null {
  const isNotification = msg.id === undefined;
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id ?? null, result });
  try {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      throw new RpcError(-32600, 'Invalid JSON-RPC 2.0 request');
    }
    if (isNotification) return null;
    const params = msg.params ?? {};
    switch (msg.method) {
      case 'initialize': {
        const requested = params.protocolVersion;
        return reply({
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'ep2350-sound-designer', title: 'EP-2350 Sound Designer', version: TOOLS_VERSION },
          instructions: SERVER_INSTRUCTIONS
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call':
        if (typeof params.name !== 'string') throw new RpcError(-32602, 'tools/call needs a tool "name"');
        return reply(callTool(params.name, params.arguments ?? {}, opts));
      default:
        throw new RpcError(-32601, `Method not found: ${msg.method}`);
    }
  } catch (err) {
    if (isNotification) return null;
    const code = err instanceof RpcError ? err.code : -32603;
    return { jsonrpc: '2.0', id: msg.id ?? null, error: { code, message: err instanceof Error ? err.message : String(err) } };
  }
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, Mcp-Protocol-Version'
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });

/** Streamable HTTP transport, stateless: POST carries JSON-RPC, answered with application/json. */
type RequestMeta = Pick<McpLogEntry, 'userAgent' | 'ray'>;

const issueList = (issues: unknown): string[] =>
  Array.isArray(issues) ? issues.map((i: any) => `${i?.code ?? 'issue'} ${i?.path ?? ''}`.trim()) : [];

/** Builds the log entry for one JSON-RPC message and its reply (null for notifications). */
export function describeExchange(
  msg: JsonRpcMessage,
  reply: Record<string, any> | null,
  meta: RequestMeta & { status: number; ms: number }
): McpLogEntry {
  const method = msg && typeof msg.method === 'string' ? msg.method : null;
  const params = (msg && msg.params) || {};
  const result = reply?.result;
  const entry: McpLogEntry = {
    event: 'mcp',
    method,
    ...meta,
    ok: !reply?.error && !result?.isError
  };
  if (reply?.error) entry.rpcError = { code: reply.error.code, message: String(reply.error.message) };
  if (method === 'initialize') {
    const info = params.clientInfo;
    if (info && typeof info === 'object') entry.client = { name: info.name, version: info.version };
    if (typeof params.protocolVersion === 'string') entry.protocolVersion = params.protocolVersion;
  }
  if (method === 'tools/call' && typeof params.name === 'string') {
    entry.tool = params.name;
    const args = params.arguments ?? {};
    if (params.name === 'validate_pack' && args.config !== undefined) {
      const text = typeof args.config === 'string' ? args.config : JSON.stringify(args.config);
      const chars = text?.length ?? 0;
      entry.configChars = chars;
      entry.config = text?.slice(0, MAX_LOGGED_CONFIG_CHARS);
      if (chars > MAX_LOGGED_CONFIG_CHARS) entry.configTruncated = true;
      const structured = result?.structuredContent;
      if (structured) {
        entry.isValid = !!structured.isValid;
        entry.errors = issueList(structured.errors);
        entry.warnings = issueList(structured.warnings);
      }
    }
    if (params.name === 'get_example_pack' && typeof args.name === 'string') entry.example = args.name;
  }
  return entry;
}

function safeLog(opts: McpOptions, entry: McpLogEntry) {
  try {
    opts.log?.(entry);
  } catch {
    // Logging must never break a tool call.
  }
}

export async function handleMcpRequest(request: Request, opts: McpOptions): Promise<Response> {
  const started = Date.now();
  const meta: RequestMeta = {
    userAgent: request.headers.get('user-agent') ?? undefined,
    ray: request.headers.get('cf-ray') ?? undefined
  };
  const reject = (status: number, code: number, message: string) => {
    safeLog(opts, { event: 'mcp', method: null, ...meta, status, ok: false, rpcError: { code, message }, ms: Date.now() - started });
    return json({ jsonrpc: '2.0', id: null, error: { code, message } }, status);
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method === 'DELETE') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'POST') {
    // No server-initiated stream: this server never sends requests or notifications on its own.
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST, OPTIONS', ...CORS_HEADERS } });
  }

  const raw = await request.text();
  if (raw.length > MAX_REQUEST_BYTES) return reject(413, -32600, 'Request too large');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return reject(400, -32700, 'Parse error');
  }

  const messages = (Array.isArray(body) ? body : [body]) as JsonRpcMessage[];
  const exchanges = messages.map((m) => ({ msg: m, reply: handleRpc(m, opts) }));
  const replies = exchanges.map((e) => e.reply).filter((r) => r !== null);
  const status = replies.length === 0 ? 202 : 200;
  if (opts.log) {
    const ms = Date.now() - started;
    for (const { msg, reply } of exchanges) safeLog(opts, describeExchange(msg, reply, { ...meta, status, ms }));
  }
  if (replies.length === 0) return new Response(null, { status: 202, headers: CORS_HEADERS });
  return json(Array.isArray(body) ? replies : replies[0]);
}
