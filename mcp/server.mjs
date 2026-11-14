#!/usr/bin/env node
/**
 * EP-2350 FX Tool — Model Context Protocol (MCP) Server
 *
 * Exposes the EP-2350 DSP Engine, Acoustic Analyzer, Parameter Optimizer,
 * Hardware Validator, and Live Web UI Bridge over standard MCP stdio JSON-RPC 2.0.
 *
 * Usage:
 *   npm run mcp
 *   node mcp/server.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

let cachedEngineModules = null;

/**
 * Compile and load the TypeScript DSP & validation modules on the fly using Node 22+
 * built-in `stripTypeScriptTypes`. Zero external bundler or build step required.
 */
export async function loadEp2350EngineModules() {
  if (cachedEngineModules) return cachedEngineModules;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep2350-mcp-'));
  process.on('exit', () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  const filesToCompile = [
    'src/types/config.ts',
    'src/constants/effectsRegistry.ts',
    'src/constants/defaultPresets.ts',
    'src/utils/parser.ts',
    'src/utils/serializer.ts',
    'src/utils/presetUrl.ts',
    'src/utils/wavCodec.ts',
    'src/dsp/math.ts',
    'src/dsp/offlineRenderer.ts',
    'src/dsp/analyzer.ts',
    'src/dsp/optimizer.ts'
  ];

  for (const relPath of filesToCompile) {
    const absIn = path.join(ROOT_DIR, relPath);
    let source = fs.readFileSync(absIn, 'utf8');

    source = source.replace(
      /import\s+([a-zA-Z0-9_]+)\s+from\s+['"]([^'"]+)\?raw['"]/g,
      (_, varName, importPath) => {
        const fullJsonPath = path.resolve(path.dirname(absIn), importPath);
        const jsonContent = fs.readFileSync(fullJsonPath, 'utf8');
        return `const ${varName} = ${JSON.stringify(jsonContent)};`;
      }
    );

    const stripped = stripTypeScriptTypes(source);
    const rewritten = stripped.replace(
      /from\s+['"](\.[^'"]+)['"]/g,
      (_, spec) => `from '${spec}.mjs'`
    );

    const absOut = path.join(tmpDir, relPath.replace(/\.ts$/, '.mjs'));
    fs.mkdirSync(path.dirname(absOut), { recursive: true });
    fs.writeFileSync(absOut, rewritten, 'utf8');
  }

  const importMod = (relMjs) => import(pathToFileURL(path.join(tmpDir, relMjs)).href);

  const [
    effectsRegistryMod,
    defaultPresetsMod,
    parserMod,
    serializerMod,
    presetUrlMod,
    wavCodecMod,
    offlineRendererMod,
    analyzerMod,
    optimizerMod
  ] = await Promise.all([
    importMod('src/constants/effectsRegistry.mjs'),
    importMod('src/constants/defaultPresets.mjs'),
    importMod('src/utils/parser.mjs'),
    importMod('src/utils/serializer.mjs'),
    importMod('src/utils/presetUrl.mjs'),
    importMod('src/utils/wavCodec.mjs'),
    importMod('src/dsp/offlineRenderer.mjs'),
    importMod('src/dsp/analyzer.mjs'),
    importMod('src/dsp/optimizer.mjs')
  ]);

  cachedEngineModules = {
    ...effectsRegistryMod,
    ...defaultPresetsMod,
    ...parserMod,
    ...serializerMod,
    ...presetUrlMod,
    ...wavCodecMod,
    ...offlineRendererMod,
    ...analyzerMod,
    ...optimizerMod
  };

  return cachedEngineModules;
}

const MCP_RESOURCES = [
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

const MCP_PROMPTS = [
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

const MCP_TOOLS = [
  {
    name: 'design_preset_from_description',
    description:
      'Synthesize a hardware-valid EP-2350 preset chain from a natural language description (e.g. "gritty cyberpunk walkie-talkie with dub echo on handle and SSB scramble on shake"), validate it, and run an offline acoustic simulation.',
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
          description: 'Whether to run offline DSP simulation across idle, handle_pushed, and shake_burst (defaults to true).'
        },
        outputWavPath: {
          type: 'string',
          description: 'Optional file path to save the rendered 48kHz stereo WAV preview.'
        }
      },
      required: ['description']
    }
  },
  {
    name: 'validate_preset',
    description:
      'Validate an EP-2350 preset or full 4-preset pack against hardware constraints (16-effect limit, single-instance DELAY/REVERB/HARMONY/SSB, valid modulation row indices, SAMPLE block presence) and return lossless config.json.',
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
        }
      }
    }
  },
  {
    name: 'simulate_preset',
    description:
      'Render an EP-2350 preset offline through the 48kHz DSP engine and return quantitative acoustic telemetry (RMS, peak, 6-band spectrum, centroid, fundamental pitch shift, inharmonic sidebands, echo delay lag in ms, tail decay) across modulation scenarios.',
    inputSchema: {
      type: 'object',
      properties: {
        preset: {
          type: 'object',
          description: 'PresetConfig object to render and analyze.'
        },
        inputWavPath: {
          type: 'string',
          description: 'Optional path to a custom dry input .wav file (defaults to built-in broadband vocal phrase).'
        },
        scenarios: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['idle', 'handle_pushed', 'shake_burst', 'dynamic_performance']
          },
          description: 'Modulation scenarios to simulate (defaults to ["idle", "handle_pushed", "shake_burst"]).'
        },
        outputWavPath: {
          type: 'string',
          description: 'Optional path to write the rendered .wav file.'
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
          description: 'Path to the reference target .wav file.'
        },
        dryWavPath: {
          type: 'string',
          description: 'Optional path to the dry unprocessed .wav file for relative pitch/echo comparison.'
        }
      },
      required: ['referenceWavPath']
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
          description: 'Path to the target reference .wav file to match.'
        },
        dryWavPath: {
          type: 'string',
          description: 'Optional path to the dry input .wav file (defaults to built-in vocal phrase).'
        },
        candidatePreset: {
          type: 'object',
          description: 'Optional initial PresetConfig topology to tune. If omitted, automatically infers and screens candidate topologies.'
        },
        maxIterations: {
          type: 'number',
          description: 'Maximum headless render iterations (default 48, max 200).'
        },
        outputWavPath: {
          type: 'string',
          description: 'Optional path to save the best-matching rendered .wav file.'
        }
      },
      required: ['referenceWavPath']
    }
  },
  {
    name: 'export_pack_config',
    description:
      'Serialize a validated 4-preset EP-2350 pack to hardware config.json format and optionally save it to disk.',
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
          description: 'Optional file path to write the serialized config.json.'
        }
      },
      required: ['presets']
    }
  },
  {
    name: 'push_to_live_ui',
    description:
      'Push a generated preset or full pack directly into the open EP-2350 Web App UI in real time via the Vite live sync bridge.',
    inputSchema: {
      type: 'object',
      properties: {
        preset: {
          type: 'object',
          description: 'Single PresetConfig to hot-load into the active web UI.'
        },
        pack: {
          type: 'object',
          description: 'Optional full PackConfig to hot-load into the web UI.'
        },
        slot: {
          type: 'number',
          description: 'Target preset slot (0..3) when pushing a single preset.'
        },
        uiUrl: {
          type: 'string',
          description: 'Base URL of the running Vite dev server (defaults to http://localhost:3000).'
        }
      }
    }
  }
];

function normalizeSinglePreset(rawPreset, pos = 0) {
  const list = Array.isArray(rawPreset?.list)
    ? rawPreset.list.map((fx, idx) => ({
        id: fx.id || `fx-${pos}-${idx}`,
        ...fx,
        effect: String(fx.effect || 'SAMPLE').toUpperCase()
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

function wrapPresetInPack(preset, createEmptyPack, packName = 'AI CUSTOM PACK') {
  const pack = createEmptyPack();
  pack.name = packName;
  const slot = Math.max(0, Math.min(3, preset.pos ?? 0));
  pack.presets[slot] = normalizeSinglePreset(preset, slot);
  // Ensure other slots have a SAMPLE block so pack validation focuses on the target slot
  for (let i = 0; i < 4; i++) {
    if (i !== slot && pack.presets[i].list.length === 0) {
      pack.presets[i].list = [{ id: `smp-${i}`, effect: 'SAMPLE' }];
    }
  }
  return pack;
}

/**
 * Execute an MCP JSON-RPC 2.0 request and return the JSON-RPC response object
 * (or `null` for notifications).
 */
export async function handleMcpJsonRpcRequest(request) {
  if (!request || typeof request !== 'object') {
    return {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request' }
    };
  }

  const { id, method, params } = request;

  // Notifications have no `id` and expect no response
  if (id === undefined || id === null) {
    return null;
  }

  try {
    const engine = await loadEp2350EngineModules();

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
          maxEffectsPerPreset: engine.MAX_EFFECTS_PER_PRESET,
          parallelBuses: [1, 2],
          effects: Object.values(engine.EFFECTS_REGISTRY).map((meta) => ({
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
              modDepth: engine.getModDepthConfig(meta.type, p.name)
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
        const packsDoc = engine.OFFICIAL_TE_PACKS.map((p) => ({
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
                  text: `Design an EP-2350 vocal effect preset for: "${args.description || ''}". First call design_preset_from_description or read ep2350://schema/effects-registry, then run simulate_preset to verify the acoustic telemetry across idle, handle_pushed, and shake_burst, and finally output the validated config.json.`
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
                  text: `Find the best EP-2350 effect chain to match the reference audio at "${args.referenceWavPath || ''}". Call analyze_reference_audio first to inspect its spectral and echo fingerprint, then call optimize_preset_parameters to tune the knob values and report the similarity score.`
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
      const toolName = params?.name;
      const args = params?.arguments || {};
      const toolOutput = await executeToolCall(toolName, args, engine);
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

async function executeToolCall(toolName, args, engine) {
  const shareBaseUrl = String(
    args.uiUrl || process.env.EP2350_UI_URL || engine.DEFAULT_PUBLIC_APP_URL
  ).replace(/\/+$/, '');

  switch (toolName) {
    case 'design_preset_from_description': {
      const description = String(args.description || '').trim();
      if (!description) {
        return { error: 'description is required.' };
      }
      const slot = typeof args.slot === 'number' ? args.slot : 0;
      const { preset, rationale } = engine.synthesizePresetFromDescription(
        description,
        slot,
        args.name
      );
      const pack = wrapPresetInPack(preset, engine.createEmptyPack, args.name || 'AI DESIGNED PACK');
      const issues = engine.validatePackConfig(pack).filter((i) => i.presetPos === preset.pos);
      const serializedPack = JSON.parse(engine.serializeToConfigJson(pack));
      const hardwarePresetJson = serializedPack.presets[preset.pos];
      const shareHash = engine.encodePresetToHash(hardwarePresetJson, preset.pos);
      const shareUrl = engine.buildPresetShareUrl(shareBaseUrl, hardwarePresetJson, preset.pos);

      let simulation = undefined;
      if (args.simulate !== false) {
        const dryPcm = engine.generateSyntheticVocalPcm(48000, 1.6, 0.8);
        const idlePcm = engine.renderPresetOffline(preset, dryPcm, { scenario: 'idle' });
        const handlePcm = engine.renderPresetOffline(preset, dryPcm, { scenario: 'handle_pushed' });
        const shakePcm = engine.renderPresetOffline(preset, dryPcm, { scenario: 'shake_burst' });

        if (args.outputWavPath) {
          const outAbs = path.resolve(ROOT_DIR, args.outputWavPath);
          fs.mkdirSync(path.dirname(outAbs), { recursive: true });
          fs.writeFileSync(outAbs, engine.encodeWavBuffer(handlePcm));
        }

        simulation = {
          idle: engine.analyzePcmAudio(idlePcm, dryPcm),
          handle_pushed: engine.analyzePcmAudio(handlePcm, dryPcm),
          shake_burst: engine.analyzePcmAudio(shakePcm, dryPcm)
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
        const parsed = engine.parseConfigJson(args.configJson);
        if (parsed.error || !parsed.pack) {
          return { isValid: false, error: parsed.error || 'Failed to parse configJson' };
        }
        const issues = engine.validatePackConfig(parsed.pack);
        const errors = issues.filter((i) => i.type === 'error');
        const normalizedConfigJson = JSON.parse(engine.serializeToConfigJson(parsed.pack));
        return {
          isValid: errors.length === 0,
          errors,
          warnings: issues.filter((i) => i.type === 'warning'),
          normalizedConfigJson,
          shareHash: engine.encodePackToHash(normalizedConfigJson),
          shareUrl: engine.buildPackShareUrl(shareBaseUrl, normalizedConfigJson)
        };
      }

      if (args.preset && typeof args.preset === 'object') {
        const normPreset = normalizeSinglePreset(args.preset, args.preset.pos ?? 0);
        const pack = wrapPresetInPack(normPreset, engine.createEmptyPack);
        const issues = engine.validatePackConfig(pack).filter(
          (i) => i.presetPos === undefined || i.presetPos === normPreset.pos
        );
        const errors = issues.filter((i) => i.type === 'error');
        const serializedPack = JSON.parse(engine.serializeToConfigJson(pack));
        const normalizedPresetJson = serializedPack.presets[normPreset.pos];
        return {
          isValid: errors.length === 0,
          errors,
          warnings: issues.filter((i) => i.type === 'warning'),
          normalizedPresetJson,
          shareHash: engine.encodePresetToHash(normalizedPresetJson, normPreset.pos),
          shareUrl: engine.buildPresetShareUrl(shareBaseUrl, normalizedPresetJson, normPreset.pos)
        };
      }

      return { error: 'Provide either `preset` object or `configJson` string.' };
    }

    case 'simulate_preset': {
      if (!args.preset || typeof args.preset !== 'object') {
        return { error: '`preset` object is required.' };
      }
      const normPreset = normalizeSinglePreset(args.preset, args.preset.pos ?? 0);
      const dryPcm = args.inputWavPath
        ? engine.decodeWavBuffer(fs.readFileSync(path.resolve(ROOT_DIR, args.inputWavPath)))
        : engine.generateSyntheticVocalPcm(48000, 1.6, 0.8);

      const scenarios =
        Array.isArray(args.scenarios) && args.scenarios.length > 0
          ? args.scenarios
          : ['idle', 'handle_pushed', 'shake_burst'];

      const dryReport = engine.analyzePcmAudio(dryPcm);
      const reports = {};
      let lastRenderedPcm = null;

      for (const sc of scenarios) {
        const rendered = engine.renderPresetOffline(normPreset, dryPcm, { scenario: sc });
        lastRenderedPcm = rendered;
        reports[sc] = engine.analyzePcmAudio(rendered, dryPcm);
      }

      let savedWavPath = undefined;
      if (args.outputWavPath && lastRenderedPcm) {
        savedWavPath = path.resolve(ROOT_DIR, args.outputWavPath);
        fs.mkdirSync(path.dirname(savedWavPath), { recursive: true });
        fs.writeFileSync(savedWavPath, engine.encodeWavBuffer(lastRenderedPcm));
      }

      return {
        presetName: normPreset.name,
        dryBaseline: dryReport,
        scenarios: reports,
        savedWavPath
      };
    }

    case 'analyze_reference_audio': {
      if (!args.referenceWavPath) {
        return { error: '`referenceWavPath` is required.' };
      }
      const refAbs = path.resolve(ROOT_DIR, args.referenceWavPath);
      if (!fs.existsSync(refAbs)) {
        return { error: `Reference WAV not found at ${refAbs}` };
      }
      const refPcm = engine.decodeWavBuffer(fs.readFileSync(refAbs));
      const dryPcm = args.dryWavPath
        ? engine.decodeWavBuffer(fs.readFileSync(path.resolve(ROOT_DIR, args.dryWavPath)))
        : undefined;

      const analysis = engine.analyzePcmAudio(refPcm, dryPcm);
      return {
        referenceWavPath: refAbs,
        analysis
      };
    }

    case 'optimize_preset_parameters': {
      if (!args.referenceWavPath) {
        return { error: '`referenceWavPath` is required.' };
      }
      const refAbs = path.resolve(ROOT_DIR, args.referenceWavPath);
      if (!fs.existsSync(refAbs)) {
        return { error: `Reference WAV not found at ${refAbs}` };
      }
      const targetPcm = engine.decodeWavBuffer(fs.readFileSync(refAbs));
      const dryPcm = args.dryWavPath
        ? engine.decodeWavBuffer(fs.readFileSync(path.resolve(ROOT_DIR, args.dryWavPath)))
        : engine.generateSyntheticVocalPcm(targetPcm.sampleRate, 1.6, 0.8);

      const maxIterations = typeof args.maxIterations === 'number' ? args.maxIterations : 48;

      const optResult = args.candidatePreset
        ? engine.optimizePresetParameters(
            normalizeSinglePreset(args.candidatePreset, 0),
            targetPcm,
            { dryPcm, maxIterations }
          )
        : engine.matchReferenceAudio(targetPcm, { dryPcm, maxIterations });

      const pack = wrapPresetInPack(optResult.optimizedPreset, engine.createEmptyPack, 'MATCHED PACK');
      const hardwarePresetJson = JSON.parse(engine.serializeToConfigJson(pack)).presets[0];
      const shareHash = engine.encodePresetToHash(hardwarePresetJson, 0);
      const shareUrl = engine.buildPresetShareUrl(shareBaseUrl, hardwarePresetJson, 0);

      let savedWavPath = undefined;
      if (args.outputWavPath) {
        savedWavPath = path.resolve(ROOT_DIR, args.outputWavPath);
        fs.mkdirSync(path.dirname(savedWavPath), { recursive: true });
        fs.writeFileSync(savedWavPath, engine.encodeWavBuffer(optResult.renderedPcm));
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
      const pack = engine.createEmptyPack();
      pack.name = String(args.packName || 'AI FX PACK').trim();
      if (Array.isArray(args.presets)) {
        args.presets.slice(0, 4).forEach((p, idx) => {
          const slot = typeof p.pos === 'number' ? Math.max(0, Math.min(3, p.pos)) : idx;
          pack.presets[slot] = normalizeSinglePreset(p, slot);
        });
      }
      for (let i = 0; i < 4; i++) {
        if (pack.presets[i].list.length === 0) {
          pack.presets[i].list = [{ id: `smp-${i}`, effect: 'SAMPLE' }];
        }
      }

      const issues = engine.validatePackConfig(pack);
      const configJsonString = engine.serializeToConfigJson(pack);
      const configJson = JSON.parse(configJsonString);
      const shareHash = engine.encodePackToHash(configJson);
      const shareUrl = engine.buildPackShareUrl(shareBaseUrl, configJson);
      let writtenPath = undefined;
      if (args.outputPath) {
        writtenPath = path.resolve(ROOT_DIR, args.outputPath);
        fs.mkdirSync(path.dirname(writtenPath), { recursive: true });
        fs.writeFileSync(writtenPath, configJsonString, 'utf8');
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
      const baseUrl = String(args.uiUrl || process.env.EP2350_UI_URL || 'http://localhost:3000').replace(
        /\/$/,
        ''
      );
      const endpoint = `${baseUrl}/__mcp_sync`;
      const payload = {};
      let shareHash = '';
      let shareUrl = '';

      if (args.pack && typeof args.pack === 'object') {
        payload.pack = args.pack;
        shareHash = engine.encodePackToHash(args.pack, args.slot);
        shareUrl = engine.buildPackShareUrl(shareBaseUrl, args.pack, args.slot);
      } else if (args.preset && typeof args.preset === 'object') {
        const slot = typeof args.slot === 'number' ? args.slot : args.preset.pos ?? 0;
        payload.preset = normalizeSinglePreset(args.preset, slot);
        payload.slot = slot;
        shareHash = engine.encodePresetToHash(payload.preset, slot);
        shareUrl = engine.buildPresetShareUrl(shareBaseUrl, payload.preset, slot);
      } else {
        return { error: 'Provide either `preset` or `pack` to push to the live UI.' };
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

// Start stdio JSON-RPC loop when invoked directly as a CLI script
const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMainModule) {
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false
  });

  let queue = Promise.resolve();

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    queue = queue.then(async () => {
      try {
        const req = JSON.parse(trimmed);
        const res = await handleMcpJsonRpcRequest(req);
        if (res) {
          process.stdout.write(JSON.stringify(res) + '\n');
        }
      } catch {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' }
          }) + '\n'
        );
      }
    });
  });
}
