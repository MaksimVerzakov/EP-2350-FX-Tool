import type { AnyEffect, EffectType, PackConfig, PresetConfig } from '../types/config';
import {
  EFFECTS_REGISTRY,
  MAX_EFFECTS_PER_PRESET,
  getModDepthConfig
} from '../constants/effectsRegistry';
import { OFFICIAL_TE_PACKS, createEmptyPack } from '../constants/defaultPresets';
import { parseConfigJson } from '../utils/parser';
import { serializeToConfigJson, validatePackConfig } from '../utils/serializer';
import {
  DEFAULT_PUBLIC_APP_URL,
  buildPackShareUrl,
  buildPresetShareUrl,
  encodePackToHash,
  encodePresetToHash
} from '../utils/presetUrl';
import {
  decodeWavBuffer,
  encodeWavBuffer,
  generateSyntheticVocalPcm
} from '../utils/wavCodec';
import type { ModulationScenario } from '../dsp/offlineRenderer';
import { renderPresetOffline } from '../dsp/offlineRenderer';
import { analyzeImpulseResponse, analyzePcmAudio, generateImpulseProbePcm } from '../dsp/analyzer';
import {
  matchReferenceAudio,
  optimizePresetParameters,
  synthesizePresetFromDescription
} from '../dsp/optimizer';
import { MCP_TOOL_NAMES, buildToolList, lintPresetAgainstRegistry } from './toolSchemas';

export interface McpRuntimeOptions {
  /** Base URL of the web UI for generating #preset= shareable deep-links */
  uiUrl?: string;
  /**
   * When true (Cloudflare Worker Free Tier), uses a compact synthetic vocal phrase
   * (24 kHz, 0.35s) and caps default optimizer iterations so execution stays well
   * under the 10ms Cloudflare Free CPU limit.
   */
  edgeMode?: boolean;
  /** Optional local filesystem callbacks (populated in Node.js CLI/Vite mode) */
  readLocalFile?: (pathStr: string) => Uint8Array;
  writeLocalFile?: (pathStr: string, data: Uint8Array | string) => string;
  resolveLocalPath?: (pathStr: string) => string;
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
  'Designs and verifies effect presets for the Teenage Engineering EP-2350 fx mic. Read ep2350://schema/effects-registry for effect parameters and hardware limits, then design (design_preset_from_description or a hand-written preset), check with validate_preset and simulate_preset, and deliver with export_pack_config or push_to_live_ui. Every preset tool returns a shareUrl that opens the preset in the web app.';

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
const MAX_OPTIMIZER_ITERATIONS = 200;
const MAX_OPTIMIZER_ITERATIONS_EDGE = 24;
const LOCAL_PATH_ARGS = [
  'inputWavPath',
  'referenceWavPath',
  'dryWavPath',
  'outputWavPath',
  'outputPath'
];

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
      'All 3 official TE preset packs (BROKEN RADIO, DUB, MYSTERIOUS = 12 hardware presets) for few-shot sound design reference.',
    mimeType: 'application/json'
  }
];

export const MCP_PROMPTS = [
  {
    name: 'design-fx-from-description',
    description:
      'Design, simulate, and acoustically verify an EP-2350 vocal effect chain from a natural language description.',
    arguments: [
      {
        name: 'description',
        description: 'Desired vocal effect sound and expressive Handle/Shake behavior',
        required: true
      }
    ]
  },
  {
    name: 'match-reference-audio',
    description:
      'Analyze a target reference WAV file and optimize an EP-2350 effect chain to match its spectral and temporal signature.',
    arguments: [
      {
        name: 'referenceWavPath',
        description: 'Path to the target reference .wav file',
        required: true
      },
      {
        name: 'dryWavPath',
        description: 'Optional path to the dry unprocessed .wav file',
        required: false
      }
    ]
  }
];

/** Full tool list as advertised on the stdio transport (local file access available). */
export const MCP_TOOLS = buildToolList({ localFiles: true, edgeMode: false });

function decodeBase64Bytes(b64: string): Uint8Array {
  const cleaned = b64.replace(/^data:audio\/[^;]+;base64,/, '').trim();
  const bin = atob(cleaned);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

export function normalizeSinglePreset(rawPreset: Record<string, any>, pos = 0): PresetConfig {
  const list: AnyEffect[] = Array.isArray(rawPreset?.list)
    ? rawPreset.list.map((fx: Record<string, any>, idx: number) => ({
        id: fx.id || `fx-${pos}-${idx}`,
        ...fx,
        effect: String(fx.effect || 'SAMPLE').toUpperCase() as EffectType
      }))
    : [];
  return {
    id: rawPreset?.id || `preset-${pos}`,
    pos: typeof rawPreset?.pos === 'number' ? rawPreset.pos : pos,
    name: rawPreset?.name || `PRESET ${pos + 1}`,
    comment: rawPreset?.comment || '',
    list,
    handle: rawPreset?.handle,
    shake: rawPreset?.shake,
    lfo: rawPreset?.lfo,
    trigger: rawPreset?.trigger
  };
}

function wrapPresetInPack(preset: PresetConfig, packName = 'AI CUSTOM PACK'): PackConfig {
  const pack = createEmptyPack();
  pack.name = packName;
  const slot = Math.max(0, Math.min(3, preset.pos ?? 0));
  pack.presets[slot] = normalizeSinglePreset(preset, slot);
  for (let i = 0; i < 4; i++) {
    if (i !== slot && pack.presets[i].list.length === 0) {
      pack.presets[i].list = [{ id: `smp-${i}`, effect: 'SAMPLE' }];
    }
  }
  return pack;
}

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
        const schemaDoc = {
          maxEffectsPerPreset: MAX_EFFECTS_PER_PRESET,
          parallelBuses: [1, 2],
          effects: Object.values(EFFECTS_REGISTRY).map((meta) => ({
            type: meta.type,
            displayName: meta.displayName,
            description: meta.description,
            singleInstance: meta.singleInstance,
            params: meta.params.map((p) => ({
              name: p.name,
              label: p.label,
              min: p.min,
              max: p.max,
              step: p.step,
              defaultVal: p.defaultVal,
              unit: p.unit,
              modDepth: getModDepthConfig(meta.type, p.name)
            }))
          }))
        };
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
                  text: `Design an EP-2350 vocal effect preset for: "${args.description || ''}". First call design_preset_from_description or read ep2350://schema/effects-registry, then run simulate_preset to verify the acoustic telemetry across idle, handle_pushed, and shake_burst, and finally output the validated config.json and shareUrl.`
                }
              }
            ]
          }
        };
      }
      if (promptName === 'match-reference-audio') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            description: 'Match a reference WAV file with an EP-2350 effect chain',
            messages: [
              {
                role: 'user',
                content: {
                  type: 'text',
                  text: `Find the best EP-2350 effect chain to match the reference audio at "${args.referenceWavPath || ''}". Call analyze_reference_audio first to inspect its spectral and echo fingerprint, then call optimize_preset_parameters to tune the knob values and report the similarity score and shareUrl.`
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
            localFiles: Boolean(options.readLocalFile && options.writeLocalFile),
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
  const defaultSampleRate = isEdge ? 24000 : 48000;
  const defaultTotalSec = isEdge ? 0.35 : 1.6;
  const defaultVoiceSec = isEdge ? 0.2 : 0.8;
  // Echo/decay are measured on an impulse probe (a short burst then silence), long enough for a
  // 1.1 s delay plus its first repeat locally; on the edge it is shorter to save CPU.
  const probeSec = isEdge ? 1.3 : 2.4;
  const analyzeScenario = (
    preset: PresetConfig,
    dryPcm: ReturnType<typeof generateSyntheticVocalPcm>,
    scenario: ModulationScenario
  ) => {
    const rendered = renderPresetOffline(preset, dryPcm, { scenario });
    const probe = generateImpulseProbePcm(dryPcm.sampleRate, probeSec);
    const impulse = analyzeImpulseResponse(renderPresetOffline(preset, probe, { scenario }));
    return { rendered, report: analyzePcmAudio(rendered, dryPcm, impulse) };
  };

  // Local filesystem access is only wired up for trusted transports (stdio). Over HTTP the
  // callbacks are stripped, so reject path arguments explicitly instead of silently ignoring them.
  if (!options.readLocalFile || !options.writeLocalFile) {
    const pathArgs = LOCAL_PATH_ARGS.filter(
      (key) => typeof args[key] === 'string' && args[key].trim() !== ''
    );
    if (pathArgs.length > 0) {
      return {
        error: `Local file paths are not available on this transport (${pathArgs.join(', ')}). Pass input audio as *Base64 arguments and use the returned configJson/shareUrl instead of output paths, or run the stdio server (npm run mcp) for file access.`
      };
    }
  }

  switch (toolName) {
    case 'design_preset_from_description': {
      const description = String(args.description || '').trim();
      if (!description) {
        return { error: 'description is required.' };
      }
      const slot = typeof args.slot === 'number' ? args.slot : 0;
      const { preset, rationale } = synthesizePresetFromDescription(description, slot, args.name);
      const pack = wrapPresetInPack(preset, args.name || 'AI DESIGNED PACK');
      const issues = validatePackConfig(pack).filter((i) => i.presetPos === preset.pos);
      const serializedPack = JSON.parse(serializeToConfigJson(pack));
      const hardwarePresetJson = serializedPack.presets[preset.pos];
      const shareHash = encodePresetToHash(hardwarePresetJson, preset.pos);
      const shareUrl = buildPresetShareUrl(shareBaseUrl, hardwarePresetJson, preset.pos);

      let simulation: Record<string, any> | undefined = undefined;
      if (args.simulate !== false) {
        const dryPcm = generateSyntheticVocalPcm(
          defaultSampleRate,
          defaultTotalSec,
          defaultVoiceSec
        );
        const idle = analyzeScenario(preset, dryPcm, 'idle');
        const handle = analyzeScenario(preset, dryPcm, 'handle_pushed');
        const shake = analyzeScenario(preset, dryPcm, 'shake_burst');

        if (args.outputWavPath && options.writeLocalFile) {
          options.writeLocalFile(args.outputWavPath, encodeWavBuffer(handle.rendered));
        }

        simulation = {
          idle: idle.report,
          handle_pushed: handle.report,
          shake_burst: shake.report
        };
      }

      return {
        preset,
        hardwarePresetJson,
        shareHash,
        shareUrl,
        rationale,
        validationIssues: issues,
        simulation
      };
    }

    case 'validate_preset': {
      if (typeof args.configJson === 'string') {
        const parsed = parseConfigJson(args.configJson);
        if (parsed.error || !parsed.pack) {
          return { isValid: false, error: parsed.error || 'Failed to parse configJson' };
        }
        const issues = [
          ...validatePackConfig(parsed.pack),
          ...parsed.pack.presets.flatMap((p) => lintPresetAgainstRegistry(p))
        ];
        const errors = issues.filter((i) => i.type === 'error');
        const normalizedConfigJson = JSON.parse(serializeToConfigJson(parsed.pack));
        return {
          isValid: errors.length === 0,
          errors,
          warnings: issues.filter((i) => i.type === 'warning'),
          normalizedConfigJson,
          shareHash: encodePackToHash(normalizedConfigJson),
          shareUrl: buildPackShareUrl(shareBaseUrl, normalizedConfigJson)
        };
      }

      if (args.preset && typeof args.preset === 'object') {
        const normPreset = normalizeSinglePreset(args.preset, args.preset.pos ?? 0);
        const pack = wrapPresetInPack(normPreset);
        const issues = [
          ...validatePackConfig(pack).filter(
            (i) => i.presetPos === undefined || i.presetPos === normPreset.pos
          ),
          ...lintPresetAgainstRegistry(normPreset)
        ];
        const errors = issues.filter((i) => i.type === 'error');
        const serializedPack = JSON.parse(serializeToConfigJson(pack));
        const normalizedPresetJson = serializedPack.presets[normPreset.pos];
        return {
          isValid: errors.length === 0,
          errors,
          warnings: issues.filter((i) => i.type === 'warning'),
          normalizedPresetJson,
          shareHash: encodePresetToHash(normalizedPresetJson, normPreset.pos),
          shareUrl: buildPresetShareUrl(shareBaseUrl, normalizedPresetJson, normPreset.pos)
        };
      }

      return { error: 'Provide either `preset` object or `configJson` string.' };
    }

    case 'simulate_preset': {
      if (!args.preset || typeof args.preset === 'object' === false) {
        return { error: '`preset` object is required.' };
      }
      const normPreset = normalizeSinglePreset(args.preset, args.preset.pos ?? 0);
      let dryPcm;
      if (typeof args.inputWavBase64 === 'string' && args.inputWavBase64.trim()) {
        dryPcm = decodeWavBuffer(decodeBase64Bytes(args.inputWavBase64));
      } else if (args.inputWavPath && options.readLocalFile) {
        dryPcm = decodeWavBuffer(options.readLocalFile(args.inputWavPath));
      } else {
        dryPcm = generateSyntheticVocalPcm(defaultSampleRate, defaultTotalSec, defaultVoiceSec);
      }

      const scenarios: ModulationScenario[] =
        Array.isArray(args.scenarios) && args.scenarios.length > 0
          ? args.scenarios
          : ['idle', 'handle_pushed', 'shake_burst'];

      // Analyse the dry input against itself so its own rhythm is not reported as an echo.
      const dryReport = analyzePcmAudio(dryPcm, dryPcm);
      const reports: Record<string, any> = {};
      let lastRenderedPcm = null;

      for (const sc of scenarios) {
        const { rendered, report } = analyzeScenario(normPreset, dryPcm, sc);
        lastRenderedPcm = rendered;
        reports[sc] = report;
      }

      let savedWavPath: string | undefined = undefined;
      if (args.outputWavPath && lastRenderedPcm && options.writeLocalFile) {
        savedWavPath = options.writeLocalFile(args.outputWavPath, encodeWavBuffer(lastRenderedPcm));
      }

      const shareHash = encodePresetToHash(normPreset, normPreset.pos);
      const shareUrl = buildPresetShareUrl(shareBaseUrl, normPreset, normPreset.pos);

      return {
        presetName: normPreset.name,
        shareHash,
        shareUrl,
        presetWarnings: lintPresetAgainstRegistry(normPreset),
        dryBaseline: dryReport,
        scenarios: reports,
        savedWavPath
      };
    }

    case 'analyze_reference_audio': {
      let refBytes: Uint8Array | null = null;
      let resolvedPath = args.referenceWavPath;

      if (typeof args.referenceWavBase64 === 'string' && args.referenceWavBase64.trim()) {
        refBytes = decodeBase64Bytes(args.referenceWavBase64);
      } else if (args.referenceWavPath && options.readLocalFile) {
        try {
          resolvedPath = options.resolveLocalPath
            ? options.resolveLocalPath(args.referenceWavPath)
            : args.referenceWavPath;
          refBytes = options.readLocalFile(args.referenceWavPath);
        } catch {
          return { error: `Reference WAV not found at ${resolvedPath}` };
        }
      } else {
        return {
          error: isEdge
            ? 'Provide `referenceWavBase64` when calling analyze_reference_audio over remote HTTP.'
            : '`referenceWavPath` is required.'
        };
      }

      const refPcm = decodeWavBuffer(refBytes);
      let dryPcm = undefined;
      if (typeof args.dryWavBase64 === 'string' && args.dryWavBase64.trim()) {
        dryPcm = decodeWavBuffer(decodeBase64Bytes(args.dryWavBase64));
      } else if (args.dryWavPath && options.readLocalFile) {
        dryPcm = decodeWavBuffer(options.readLocalFile(args.dryWavPath));
      }

      const analysis = analyzePcmAudio(refPcm, dryPcm);
      return {
        referenceWavPath: resolvedPath,
        analysis
      };
    }

    case 'optimize_preset_parameters': {
      let refBytes: Uint8Array | null = null;
      let resolvedPath = args.referenceWavPath;

      if (typeof args.referenceWavBase64 === 'string' && args.referenceWavBase64.trim()) {
        refBytes = decodeBase64Bytes(args.referenceWavBase64);
      } else if (args.referenceWavPath && options.readLocalFile) {
        try {
          resolvedPath = options.resolveLocalPath
            ? options.resolveLocalPath(args.referenceWavPath)
            : args.referenceWavPath;
          refBytes = options.readLocalFile(args.referenceWavPath);
        } catch {
          return { error: `Reference WAV not found at ${resolvedPath}` };
        }
      } else {
        return {
          error: isEdge
            ? 'Provide `referenceWavBase64` when calling optimize_preset_parameters over remote HTTP.'
            : '`referenceWavPath` is required.'
        };
      }

      const targetPcm = decodeWavBuffer(refBytes);
      let dryPcm;
      if (typeof args.dryWavBase64 === 'string' && args.dryWavBase64.trim()) {
        dryPcm = decodeWavBuffer(decodeBase64Bytes(args.dryWavBase64));
      } else if (args.dryWavPath && options.readLocalFile) {
        dryPcm = decodeWavBuffer(options.readLocalFile(args.dryWavPath));
      } else {
        dryPcm = generateSyntheticVocalPcm(
          targetPcm.sampleRate,
          isEdge ? 0.35 : 1.6,
          isEdge ? 0.2 : 0.8
        );
      }

      const defaultIter = isEdge ? 12 : 48;
      const iterCap = isEdge ? MAX_OPTIMIZER_ITERATIONS_EDGE : MAX_OPTIMIZER_ITERATIONS;
      const maxIterations =
        typeof args.maxIterations === 'number' && Number.isFinite(args.maxIterations)
          ? Math.max(1, Math.min(iterCap, Math.floor(args.maxIterations)))
          : defaultIter;

      const optResult = args.candidatePreset
        ? optimizePresetParameters(normalizeSinglePreset(args.candidatePreset, 0), targetPcm, {
            dryPcm,
            maxIterations
          })
        : matchReferenceAudio(targetPcm, { dryPcm, maxIterations });

      const pack = wrapPresetInPack(optResult.optimizedPreset, 'MATCHED PACK');
      const hardwarePresetJson = JSON.parse(serializeToConfigJson(pack)).presets[0];
      const shareHash = encodePresetToHash(hardwarePresetJson, 0);
      const shareUrl = buildPresetShareUrl(shareBaseUrl, hardwarePresetJson, 0);

      let savedWavPath: string | undefined = undefined;
      if (args.outputWavPath && options.writeLocalFile) {
        savedWavPath = options.writeLocalFile(
          args.outputWavPath,
          encodeWavBuffer(optResult.renderedPcm)
        );
      }

      return {
        optimizedPreset: optResult.optimizedPreset,
        hardwarePresetJson,
        shareHash,
        shareUrl,
        initialDistance: optResult.initialDistance,
        finalDistance: optResult.finalDistance,
        iterationsRun: optResult.iterationsRun,
        targetReport: optResult.targetReport,
        renderedReport: optResult.renderedReport,
        savedWavPath
      };
    }

    case 'export_pack_config': {
      const pack = createEmptyPack();
      pack.name = String(args.packName || 'AI FX PACK').trim();
      if (Array.isArray(args.presets)) {
        args.presets.slice(0, 4).forEach((p: Record<string, any>, idx: number) => {
          const slot = typeof p.pos === 'number' ? Math.max(0, Math.min(3, p.pos)) : idx;
          pack.presets[slot] = normalizeSinglePreset(p, slot);
        });
      }
      for (let i = 0; i < 4; i++) {
        if (pack.presets[i].list.length === 0) {
          pack.presets[i].list = [{ id: `smp-${i}`, effect: 'SAMPLE' }];
        }
      }

      const issues = validatePackConfig(pack);
      const configJsonString = serializeToConfigJson(pack);
      const configJson = JSON.parse(configJsonString);
      const shareHash = encodePackToHash(configJson);
      const shareUrl = buildPackShareUrl(shareBaseUrl, configJson);
      let writtenPath: string | undefined = undefined;
      if (args.outputPath && options.writeLocalFile) {
        writtenPath = options.writeLocalFile(args.outputPath, configJsonString);
      }

      return {
        packName: pack.name,
        validationIssues: issues,
        writtenPath,
        shareHash,
        shareUrl,
        configJson
      };
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
        const slot = typeof args.slot === 'number' ? args.slot : args.preset.pos ?? 0;
        payload.preset = normalizeSinglePreset(args.preset, slot);
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
            endpoint,
            shareHash,
            shareUrl,
            error: `UI server responded with status ${res.status}`
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
        return {
          pushed: false,
          endpoint,
          shareHash,
          shareUrl,
          error: `Could not reach running Vite UI at ${endpoint} (${err instanceof Error ? err.message : String(err)}). Open shareUrl directly to load this preset in your browser.`
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
  const {
    readLocalFile: _readLocalFile,
    writeLocalFile: _writeLocalFile,
    resolveLocalPath: _resolveLocalPath,
    ...httpSafeOptions
  } = options;
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
