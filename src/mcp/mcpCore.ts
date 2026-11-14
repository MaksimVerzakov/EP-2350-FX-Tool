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
import { analyzePcmAudio } from '../dsp/analyzer';
import {
  matchReferenceAudio,
  optimizePresetParameters,
  synthesizePresetFromDescription
} from '../dsp/optimizer';

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

export const MCP_TOOLS = [
  {
    name: 'design_preset_from_description',
    description:
      'Synthesize a hardware-valid EP-2350 preset chain from a natural language description (e.g. "gritty cyberpunk walkie-talkie with dub echo on handle and SSB scramble on shake"), validate it, run an offline acoustic simulation, and return a shareable #preset= URL.',
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Natural language description of the desired sound and modulation behavior.'
        },
        name: {
          type: 'string',
          description: 'Optional preset name (e.g. "CYBER RADIO").'
        },
        slot: {
          type: 'number',
          description: 'Preset slot index (0, 1, 2, or 3). Defaults to 0.'
        },
        simulate: {
          type: 'boolean',
          description:
            'Whether to run offline DSP simulation across idle, handle_pushed, and shake_burst (defaults to true).'
        },
        outputWavPath: {
          type: 'string',
          description: 'Optional file path to save the rendered 48kHz stereo WAV preview (local mode).'
        },
        uiUrl: {
          type: 'string',
          description: 'Optional base URL for the returned shareUrl deep-link.'
        }
      },
      required: ['description']
    }
  },
  {
    name: 'validate_preset',
    description:
      'Validate an EP-2350 preset or full 4-preset pack against hardware constraints (16-effect limit, single-instance DELAY/REVERB/HARMONY/SSB, valid modulation row indices, SAMPLE block presence) and return lossless config.json plus a shareable #preset= URL.',
    inputSchema: {
      type: 'object',
      properties: {
        preset: {
          type: 'object',
          description: 'Single PresetConfig object ({ pos, name, list, handle, shake, lfo, trigger }).'
        },
        configJson: {
          type: 'string',
          description: 'Raw config.json string to parse and validate.'
        },
        uiUrl: {
          type: 'string',
          description: 'Optional base URL for the returned shareUrl deep-link.'
        }
      }
    }
  },
  {
    name: 'simulate_preset',
    description:
      'Render an EP-2350 preset offline through the DSP engine and return quantitative acoustic telemetry (RMS, peak, 6-band spectrum, centroid, fundamental pitch shift, inharmonic sidebands, echo delay lag in ms, tail decay) across modulation scenarios.',
    inputSchema: {
      type: 'object',
      properties: {
        preset: {
          type: 'object',
          description: 'PresetConfig object to render and analyze.'
        },
        inputWavPath: {
          type: 'string',
          description:
            'Optional path to a custom dry input .wav file (defaults to built-in broadband vocal phrase).'
        },
        inputWavBase64: {
          type: 'string',
          description: 'Optional Base64-encoded dry input .wav file (for remote HTTP/Cloudflare MCP).'
        },
        scenarios: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['idle', 'handle_pushed', 'shake_burst', 'dynamic_performance']
          },
          description:
            'Modulation scenarios to simulate (defaults to ["idle", "handle_pushed", "shake_burst"]).'
        },
        outputWavPath: {
          type: 'string',
          description: 'Optional path to write the rendered .wav file (local mode).'
        }
      },
      required: ['preset']
    }
  },
  {
    name: 'analyze_reference_audio',
    description:
      'Extract an acoustic fingerprint from a reference .wav file (6-band spectrum, pitch ratio, inharmonicity for SSB/RING detection, echo autocorrelation lag in ms for DELAY, RT60 tail for REVERB, crest factor for DIST) and infer candidate EP-2350 effects.',
    inputSchema: {
      type: 'object',
      properties: {
        referenceWavPath: {
          type: 'string',
          description: 'Path to the reference target .wav file (local mode).'
        },
        referenceWavBase64: {
          type: 'string',
          description: 'Optional Base64-encoded reference .wav file (for remote HTTP/Cloudflare MCP).'
        },
        dryWavPath: {
          type: 'string',
          description:
            'Optional path to the dry unprocessed .wav file for relative pitch/echo comparison.'
        },
        dryWavBase64: {
          type: 'string',
          description: 'Optional Base64-encoded dry .wav file.'
        }
      }
    }
  },
  {
    name: 'optimize_preset_parameters',
    description:
      'Automatically discover and/or tune EP-2350 effect chain parameters to match a reference .wav file using multi-resolution STFT spectral + temporal envelope loss optimization.',
    inputSchema: {
      type: 'object',
      properties: {
        referenceWavPath: {
          type: 'string',
          description: 'Path to the target reference .wav file to match (local mode).'
        },
        referenceWavBase64: {
          type: 'string',
          description: 'Optional Base64-encoded target reference .wav file (remote HTTP/Cloudflare mode).'
        },
        dryWavPath: {
          type: 'string',
          description: 'Optional path to the dry input .wav file (defaults to built-in vocal phrase).'
        },
        dryWavBase64: {
          type: 'string',
          description: 'Optional Base64-encoded dry input .wav file.'
        },
        candidatePreset: {
          type: 'object',
          description:
            'Optional initial PresetConfig topology to tune. If omitted, automatically infers and screens candidate topologies.'
        },
        maxIterations: {
          type: 'number',
          description: 'Maximum headless render iterations (default 48 locally, 12 on edge).'
        },
        outputWavPath: {
          type: 'string',
          description: 'Optional path to save the best-matching rendered .wav file (local mode).'
        },
        uiUrl: {
          type: 'string',
          description: 'Optional base URL for the returned shareUrl deep-link.'
        }
      }
    }
  },
  {
    name: 'export_pack_config',
    description:
      'Serialize a validated 4-preset EP-2350 pack to hardware config.json format, return a shareable #pack= URL, and optionally save it to disk.',
    inputSchema: {
      type: 'object',
      properties: {
        packName: {
          type: 'string',
          description: 'Name of the preset pack.'
        },
        presets: {
          type: 'array',
          items: { type: 'object' },
          description: 'Array of up to 4 PresetConfig objects.'
        },
        outputPath: {
          type: 'string',
          description: 'Optional file path to write the serialized config.json (local mode).'
        },
        uiUrl: {
          type: 'string',
          description: 'Optional base URL for the returned shareUrl deep-link.'
        }
      },
      required: ['presets']
    }
  },
  {
    name: 'push_to_live_ui',
    description:
      'Deliver a generated preset or full pack to the EP-2350 Web App UI via a stateless shareable #preset= deep-link URL (and push live over SSE when connected to a local Vite dev server).',
    inputSchema: {
      type: 'object',
      properties: {
        preset: {
          type: 'object',
          description: 'Single PresetConfig to load into the web UI.'
        },
        pack: {
          type: 'object',
          description: 'Optional full PackConfig to load into the web UI.'
        },
        slot: {
          type: 'number',
          description: 'Target preset slot (0..3) when pushing a single preset.'
        },
        uiUrl: {
          type: 'string',
          description: 'Base URL of the web app (defaults to current origin or public site URL).'
        }
      }
    }
  }
];

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
  if (!request || typeof request !== 'object') {
    return {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request' }
    };
  }

  const { id, method, params } = request;

  if (id === undefined || id === null) {
    return null;
  }

  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: {
            resources: {},
            tools: {},
            prompts: {}
          },
          serverInfo: {
            name: 'ep2350-fx-mcp-server',
            version: '1.0.0'
          }
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

      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: `Unknown resource URI: ${uri}` }
      };
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
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: `Unknown prompt: ${promptName}` }
      };
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: MCP_TOOLS }
      };
    }

    if (method === 'tools/call') {
      const toolName = String(params?.name || '');
      const args = params?.arguments || {};
      const toolOutput = await executeMcpToolCall(toolName, args, options);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(toolOutput, null, 2)
            }
          ],
          isError: Boolean(toolOutput?.error)
        }
      };
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    };
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: err instanceof Error ? err.message : String(err)
      }
    };
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
        const idlePcm = renderPresetOffline(preset, dryPcm, { scenario: 'idle' });
        const handlePcm = renderPresetOffline(preset, dryPcm, { scenario: 'handle_pushed' });
        const shakePcm = renderPresetOffline(preset, dryPcm, { scenario: 'shake_burst' });

        if (args.outputWavPath && options.writeLocalFile) {
          options.writeLocalFile(args.outputWavPath, encodeWavBuffer(handlePcm));
        }

        simulation = {
          idle: analyzePcmAudio(idlePcm, dryPcm),
          handle_pushed: analyzePcmAudio(handlePcm, dryPcm),
          shake_burst: analyzePcmAudio(shakePcm, dryPcm)
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
        const issues = validatePackConfig(parsed.pack);
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
        const issues = validatePackConfig(pack).filter(
          (i) => i.presetPos === undefined || i.presetPos === normPreset.pos
        );
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

      const dryReport = analyzePcmAudio(dryPcm);
      const reports: Record<string, any> = {};
      let lastRenderedPcm = null;

      for (const sc of scenarios) {
        const rendered = renderPresetOffline(normPreset, dryPcm, { scenario: sc });
        lastRenderedPcm = rendered;
        reports[sc] = analyzePcmAudio(rendered, dryPcm);
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
      const maxIterations =
        typeof args.maxIterations === 'number' ? args.maxIterations : defaultIter;

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

      // On remote Cloudflare edge, deliver via stateless shareUrl deep-link immediately
      if (isEdge && !args.uiUrl) {
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
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id'
};

/**
 * Web-standard Fetch handler for MCP Streamable HTTP (`POST /mcp`, `GET /mcp`, `OPTIONS /mcp`).
 * Runs natively in Cloudflare Workers, Cloudflare Pages Functions, and Node 20+.
 */
export async function handleMcpHttpFetch(
  request: Request,
  options: McpRuntimeOptions = {}
): Promise<Response> {
  const url = new URL(request.url);
  const effectiveOptions: McpRuntimeOptions = {
    ...options,
    uiUrl: options.uiUrl || `${url.protocol}//${url.host}`
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: MCP_CORS_HEADERS
    });
  }

  if (request.method === 'DELETE') {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        ...MCP_CORS_HEADERS,
        'Content-Type': 'application/json'
      }
    });
  }

  if (request.method === 'GET') {
    const accept = request.headers.get('accept') || '';
    if (accept.includes('text/event-stream') && !accept.includes('text/html')) {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(': ep2350-fx-mcp-server ready\n\n'));
          controller.close();
        }
      });
      return new Response(stream, {
        status: 200,
        headers: {
          ...MCP_CORS_HEADERS,
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache'
        }
      });
    }

    return new Response(
      JSON.stringify(
        {
          name: 'ep2350-fx-mcp-server',
          version: '1.0.0',
          status: 'ok',
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
          ...MCP_CORS_HEADERS,
          'Content-Type': 'application/json'
        }
      }
    );
  }

  if (request.method === 'POST') {
    let bodyJson: unknown;
    try {
      const rawText = await request.text();
      bodyJson = JSON.parse(rawText);
    } catch {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' }
        }),
        {
          status: 400,
          headers: {
            ...MCP_CORS_HEADERS,
            'Content-Type': 'application/json'
          }
        }
      );
    }

    if (Array.isArray(bodyJson)) {
      const responses = (
        await Promise.all(
          bodyJson.map((item) =>
            handleMcpCoreRequest(item as Record<string, any>, effectiveOptions)
          )
        )
      ).filter((r) => r !== null);

      if (responses.length === 0) {
        return new Response(null, {
          status: 202,
          headers: MCP_CORS_HEADERS
        });
      }

      return new Response(JSON.stringify(responses), {
        status: 200,
        headers: {
          ...MCP_CORS_HEADERS,
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
        headers: MCP_CORS_HEADERS
      });
    }

    return new Response(JSON.stringify(rpcResponse), {
      status: 200,
      headers: {
        ...MCP_CORS_HEADERS,
        'Content-Type': 'application/json'
      }
    });
  }

  return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
    status: 405,
    headers: {
      ...MCP_CORS_HEADERS,
      'Content-Type': 'application/json'
    }
  });
}
