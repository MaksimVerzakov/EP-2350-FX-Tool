import type { EffectMeta, EffectType } from '../types/config';
import {
  EFFECTS_REGISTRY,
  MAX_EFFECTS_PER_PRESET,
  getModDepthConfig
} from '../constants/effectsRegistry';

/**
 * JSON Schemas for MCP tool inputs/outputs, generated from EFFECTS_REGISTRY so parameter names
 * and ranges can never drift from the editor and DSP engine.
 *
 * All `preset` inputs use the editor (UI) scale, the same scale as the `preset` objects the tools
 * return: percent knobs are 0..100 and percent modulation depths are -100..100. The hardware
 * config.json scale (0.0..1.0) is only used by `configJson` / `hardwarePresetJson`.
 */

type JsonSchema = Record<string, any>;

const EFFECT_TYPES = Object.keys(EFFECTS_REGISTRY) as EffectType[];
const MAX_ROW = MAX_EFFECTS_PER_PRESET - 1;

function describeParam(effect: EffectType, name: string): JsonSchema {
  const p = EFFECTS_REGISTRY[effect].params.find((x) => x.name === name)!;
  const schema: JsonSchema = { type: 'number', minimum: p.min, maximum: p.max };
  if (p.unit) schema.description = p.unit;
  return schema;
}

function effectSchema(effect: EffectType): JsonSchema {
  const meta = EFFECTS_REGISTRY[effect];
  const properties: JsonSchema = {
    effect: { const: effect },
    id: { type: 'string' },
    BUS: { enum: [1, 2] }
  };
  for (const p of meta.params) {
    properties[p.name] = describeParam(effect, p.name);
  }
  return {
    type: 'object',
    title: effect,
    properties,
    required: ['effect'],
    additionalProperties: false
  };
}

function modDepthSummary(): string {
  return [
    'depth range depends on the target parameter:',
    `RING/SSB frequency ±${getModDepthConfig('RING', 'frequency').max} Hz,`,
    `DIST amount ±${getModDepthConfig('DIST', 'amount').max}x,`,
    `SAMPLE pitch ±${getModDepthConfig('SAMPLE', 'pitch').max} st, SAMPLE speed ±${getModDepthConfig('SAMPLE', 'speed').max}x,`,
    `HARMONY pitch ±${getModDepthConfig('HARMONY', 'pitch').max}x,`,
    `DELAY time ±${getModDepthConfig('DELAY', 'time').max} s,`,
    'every other (percent) parameter ±100 (%).'
  ].join(' ');
}

const rowSchema: JsonSchema = {
  type: 'integer',
  minimum: 0,
  maximum: MAX_ROW,
  description: 'Zero-based index into `list` of the effect row to modulate.'
};

const paramNameSchema: JsonSchema = {
  type: 'string',
  description: 'Name of a parameter of the effect on `row` (e.g. "cutoff", "mix", "frequency").'
};

export const EFFECT_ROW_SCHEMA: JsonSchema = {
  oneOf: EFFECT_TYPES.map(effectSchema)
};

export const PRESET_SCHEMA: JsonSchema = {
  type: 'object',
  description:
    'EP-2350 preset in editor (UI) scale: percent (%) knobs 0..100, percent modulation depths -100..100. Signal flows top to bottom through `list`; SAMPLE marks where the trigger sample is injected (appended automatically if missing). Optional BUS 1/2 rows run in parallel. Effect descriptions and modulation depth ranges: get_effects_reference.',
  properties: {
    id: { type: 'string' },
    pos: { type: 'integer', minimum: 0, maximum: 3, description: 'Preset slot (0..3).' },
    name: { type: 'string', description: 'Preset name, shown uppercase on the device.' },
    comment: { type: 'string' },
    list: {
      type: 'array',
      maxItems: MAX_EFFECTS_PER_PRESET,
      description: `Effect chain, max ${MAX_EFFECTS_PER_PRESET} rows. ${EFFECT_TYPES.filter((t) => EFFECTS_REGISTRY[t].singleInstance).join(', ')} may appear at most once.`,
      items: EFFECT_ROW_SCHEMA
    },
    handle: {
      type: 'object',
      description: `Squeeze-handle modulation. Either { row, param, depth } to sweep an effect parameter, or { target: "lfo", param: "speed", depth } to add depth Hz to the LFO speed at full squeeze. ${modDepthSummary()}`,
      properties: {
        row: rowSchema,
        target: { const: 'lfo' },
        param: paramNameSchema,
        depth: { type: 'number' }
      },
      required: ['param', 'depth'],
      additionalProperties: false
    },
    shake: {
      type: 'object',
      description: 'Accelerometer (shake) modulation burst; depth ranges as for handle.',
      properties: { row: rowSchema, param: paramNameSchema, depth: { type: 'number' } },
      required: ['row', 'param', 'depth'],
      additionalProperties: false
    },
    lfo: {
      type: 'object',
      description: 'Continuous LFO modulation of an effect parameter; depth ranges as for handle.',
      properties: {
        row: rowSchema,
        target: { const: 'lfo' },
        param: paramNameSchema,
        depth: { type: 'number' },
        shape: { enum: ['sine', 'square', 'sawtooth', 'random'] },
        speed: { type: 'number', minimum: 0, description: 'LFO rate in Hz.' },
        phase: { type: 'number', minimum: 0, maximum: 1 }
      },
      required: ['param', 'depth', 'shape', 'speed'],
      additionalProperties: false
    },
    trigger: {
      type: 'object',
      description: 'Row whose SAMPLE block is fired by the trigger button.',
      properties: { row: rowSchema },
      required: ['row'],
      additionalProperties: false
    }
  },
  required: ['list']
};

/**
 * Compact preset reference for tools other than validate_preset / simulate_preset, so the full
 * schema is not repeated in every tool (it would add ~10 KB of tokens per copy to tools/list).
 */
export const PRESET_REF_SCHEMA: JsonSchema = {
  type: 'object',
  description:
    'EP-2350 preset in editor (UI) scale, same shape as validate_preset `preset` ({ name, list, handle, shake, lfo, trigger }).',
  properties: { list: { type: 'array', items: { type: 'object' } } },
  required: ['list']
};

export const PACK_SCHEMA: JsonSchema = {
  type: 'object',
  description: 'Full 4-preset pack in editor (UI) scale.',
  properties: {
    name: { type: 'string' },
    presets: { type: 'array', maxItems: 4, items: PRESET_REF_SCHEMA }
  },
  required: ['presets']
};

const slotSchema: JsonSchema = {
  type: 'integer',
  minimum: 0,
  maximum: 3,
  description: 'Preset slot (0..3). Defaults to 0.'
};
const uiUrlSchema: JsonSchema = {
  type: 'string',
  description: 'Optional base URL for the returned shareUrl deep-link.'
};
const localPath = (description: string): JsonSchema => ({
  type: 'string',
  description: `${description} (stdio transport only).`
});
const base64Wav = (description: string): JsonSchema => ({
  type: 'string',
  description: `${description} Base64-encoded .wav (a data: URL prefix is accepted).`
});

// ---------------------------------------------------------------------------
// Output schemas (kept open with additionalProperties so the payload can grow)
// ---------------------------------------------------------------------------
const issueSchema: JsonSchema = {
  type: 'object',
  properties: {
    type: { enum: ['error', 'warning'] },
    message: { type: 'string' },
    presetPos: { type: 'integer' }
  },
  required: ['type', 'message']
};
const shareFields: JsonSchema = {
  shareHash: { type: 'string', description: 'URL hash payload (#preset=… or #pack=…).' },
  shareUrl: { type: 'string', description: 'Opens the preset/pack in the EP-2350 web app.' }
};
const analysisSchema: JsonSchema = {
  type: 'object',
  description: 'Acoustic report: levels, 6-band spectrum, centroid, pitch, delay lag, tail decay, inferred cues.'
};
const scenarioReportsSchema: JsonSchema = {
  type: 'object',
  description: 'Acoustic report per modulation scenario.',
  additionalProperties: analysisSchema
};

const OUTPUT_SCHEMAS: Record<string, JsonSchema> = {
  get_effects_reference: {
    type: 'object',
    properties: {
      maxEffectsPerPreset: { type: 'integer' },
      parallelBuses: { type: 'array', items: { type: 'integer' } },
      rules: { type: 'array', items: { type: 'string' } },
      modulation: { type: 'object', description: 'How handle, shake, lfo and trigger modulation are written.' },
      effects: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            displayName: { type: 'string' },
            description: { type: 'string' },
            singleInstance: { type: 'boolean' },
            params: { type: 'array', items: { type: 'object' } }
          },
          required: ['type', 'params']
        }
      }
    },
    required: ['maxEffectsPerPreset', 'rules', 'modulation', 'effects']
  },
  validate_preset: {
    type: 'object',
    properties: {
      isValid: { type: 'boolean' },
      errors: { type: 'array', items: issueSchema },
      warnings: { type: 'array', items: issueSchema },
      normalizedPresetJson: { type: 'object' },
      normalizedConfigJson: { type: 'object' },
      ...shareFields
    },
    required: ['isValid', 'errors', 'warnings', 'shareUrl']
  },
  simulate_preset: {
    type: 'object',
    properties: {
      presetName: { type: 'string' },
      ...shareFields,
      presetWarnings: { type: 'array', items: issueSchema },
      dryBaseline: analysisSchema,
      scenarios: scenarioReportsSchema,
      savedWavPath: { type: 'string' }
    },
    required: ['presetName', 'shareUrl', 'dryBaseline', 'scenarios']
  },
  analyze_reference_audio: {
    type: 'object',
    properties: {
      referenceWavPath: { type: 'string' },
      analysis: analysisSchema
    },
    required: ['analysis']
  },
  optimize_preset_parameters: {
    type: 'object',
    properties: {
      optimizedPreset: PRESET_REF_SCHEMA,
      hardwarePresetJson: { type: 'object' },
      ...shareFields,
      initialDistance: { type: 'object' },
      finalDistance: {
        type: 'object',
        description: 'Includes totalLoss and similarityScore (%).'
      },
      iterationsRun: { type: 'integer' },
      targetReport: analysisSchema,
      renderedReport: analysisSchema,
      savedWavPath: { type: 'string' }
    },
    required: ['optimizedPreset', 'hardwarePresetJson', 'shareUrl', 'finalDistance', 'iterationsRun']
  },
  export_pack_config: {
    type: 'object',
    properties: {
      packName: { type: 'string' },
      validationIssues: { type: 'array', items: issueSchema },
      writtenPath: { type: 'string' },
      ...shareFields,
      configJson: { type: 'object', description: 'Hardware config.json contents.' }
    },
    required: ['packName', 'validationIssues', 'shareUrl', 'configJson']
  },
  push_to_live_ui: {
    type: 'object',
    properties: {
      pushed: { type: 'boolean' },
      deliveryMode: { enum: ['shareUrl', 'live'] },
      endpoint: { type: 'string' },
      ...shareFields,
      message: { type: 'string' },
      response: { type: 'object' }
    },
    required: ['pushed', 'shareUrl']
  }
};

interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  /** Input properties that are file paths (removed on transports without file access). */
  pathArgs: string[];
  /** Tool reads/writes nothing outside its arguments when no path args are available. */
  pure: boolean;
}

const TOOL_DEFS: ToolDef[] = [
  {
    name: 'get_effects_reference',
    title: 'Effects reference',
    description:
      'Look up every EP-2350 effect with its parameters (editor scale, min/max, units, defaults), the modulation depth range of each parameter, how handle/shake/lfo/trigger modulation is written, and the hardware rules (16 rows, single-instance effects, SAMPLE, parallel BUS 1/2). Call this before writing a preset. Pass `effect` to get a single effect.',
    inputSchema: {
      type: 'object',
      properties: {
        effect: { enum: EFFECT_TYPES, description: 'Optional: return only this effect.' }
      }
    },
    pathArgs: [],
    pure: true
  },
  {
    name: 'validate_preset',
    title: 'Validate preset or config.json',
    description:
      'Check a preset (editor scale) or a full config.json string against hardware rules: 16-row limit, single DELAY/REVERB/HARMONY/SSB, valid modulation rows, known parameter names and ranges, SAMPLE presence. Returns normalized hardware JSON and a shareable URL.',
    inputSchema: {
      type: 'object',
      properties: {
        preset: PRESET_SCHEMA,
        configJson: {
          type: 'string',
          description: 'Raw hardware config.json string (0.0..1.0 scale) to parse and validate.'
        },
        uiUrl: uiUrlSchema
      }
    },
    pathArgs: [],
    pure: true
  },
  {
    name: 'simulate_preset',
    title: 'Simulate preset',
    description:
      'Render a preset offline through the DSP engine and return acoustic telemetry (RMS, peak, 6-band spectrum, centroid, pitch shift, inharmonicity, echo lag in ms, tail decay) for each modulation scenario.',
    inputSchema: {
      type: 'object',
      properties: {
        preset: PRESET_SCHEMA,
        inputWavPath: localPath('Path to a dry input .wav (defaults to a built-in vocal phrase)'),
        inputWavBase64: base64Wav('Optional dry input audio.'),
        scenarios: {
          type: 'array',
          items: { enum: ['idle', 'handle_pushed', 'shake_burst', 'dynamic_performance'] },
          uniqueItems: true,
          description: 'Scenarios to simulate (default ["idle", "handle_pushed", "shake_burst"]).'
        },
        outputWavPath: localPath('Path to write the last rendered scenario as .wav')
      },
      required: ['preset']
    },
    pathArgs: ['inputWavPath', 'outputWavPath'],
    pure: true
  },
  {
    name: 'analyze_reference_audio',
    title: 'Analyze reference audio',
    description:
      'Extract an acoustic fingerprint from a reference .wav (6-band spectrum, pitch ratio, SSB/RING inharmonicity, DELAY echo lag, REVERB tail, DIST crest factor) and infer candidate EP-2350 effects.',
    inputSchema: {
      type: 'object',
      properties: {
        referenceWavPath: localPath('Path to the reference .wav'),
        referenceWavBase64: base64Wav('Reference audio.'),
        dryWavPath: localPath('Path to the dry unprocessed .wav for relative pitch/echo comparison'),
        dryWavBase64: base64Wav('Optional dry unprocessed audio.')
      }
    },
    pathArgs: ['referenceWavPath', 'dryWavPath'],
    pure: true
  },
  {
    name: 'optimize_preset_parameters',
    title: 'Match reference audio',
    description:
      'Discover and/or tune an EP-2350 effect chain to match a reference .wav using multi-resolution STFT spectral + temporal envelope loss.',
    inputSchema: {
      type: 'object',
      properties: {
        referenceWavPath: localPath('Path to the target reference .wav'),
        referenceWavBase64: base64Wav('Target reference audio.'),
        dryWavPath: localPath('Path to the dry input .wav (defaults to a built-in vocal phrase)'),
        dryWavBase64: base64Wav('Optional dry input audio.'),
        candidatePreset: {
          ...PRESET_REF_SCHEMA,
          description:
            'Optional starting chain to tune. If omitted, candidate topologies are inferred and screened automatically.'
        },
        maxIterations: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'Maximum render iterations (default 48 locally, 12 on the hosted edge; edge cap 24).'
        },
        outputWavPath: localPath('Path to save the best-matching render as .wav'),
        uiUrl: uiUrlSchema
      }
    },
    pathArgs: ['referenceWavPath', 'dryWavPath', 'outputWavPath'],
    pure: true
  },
  {
    name: 'export_pack_config',
    title: 'Export pack config.json',
    description:
      'Serialize up to 4 presets (editor scale) into a hardware config.json pack, return it with a shareable #pack= URL, and optionally write it to disk.',
    inputSchema: {
      type: 'object',
      properties: {
        packName: { type: 'string', description: 'Name of the preset pack.' },
        presets: {
          type: 'array',
          maxItems: 4,
          items: PRESET_REF_SCHEMA,
          description: 'Up to 4 presets; `pos` picks the slot, otherwise array order is used.'
        },
        outputPath: localPath('File path to write config.json (e.g. the root of the "fx-mic disk")'),
        uiUrl: uiUrlSchema
      },
      required: ['presets']
    },
    pathArgs: ['outputPath'],
    pure: true
  },
  {
    name: 'push_to_live_ui',
    title: 'Push to web app',
    description:
      'Deliver a preset or pack to the EP-2350 web app. Always returns a shareUrl deep-link; with a local Vite dev server running it also loads the preset into open browser tabs immediately (replacing that slot).',
    inputSchema: {
      type: 'object',
      properties: {
        preset: PRESET_REF_SCHEMA,
        pack: PACK_SCHEMA,
        slot: { ...slotSchema, description: 'Target slot (0..3) when pushing a single preset.' },
        uiUrl: {
          type: 'string',
          description: 'Base URL of the web app. Live push only goes to localhost / 127.0.0.1.'
        }
      }
    },
    pathArgs: [],
    pure: false
  }
];

export interface ToolListOptions {
  /** Local file access available (stdio transport). */
  localFiles: boolean;
  /** Hosted edge: never makes outbound requests. */
  edgeMode: boolean;
}

function omitKeys(obj: JsonSchema, keys: string[]): JsonSchema {
  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(obj)) if (!keys.includes(k)) out[k] = v;
  return out;
}

/**
 * Builds the `tools/list` payload for a transport. Path arguments are only advertised where
 * file access exists, and annotations reflect what a call can actually do on that transport.
 */
export function buildToolList({ localFiles, edgeMode }: ToolListOptions) {
  return TOOL_DEFS.map((def) => {
    const writesFiles = localFiles && def.pathArgs.some((a) => /^output/.test(a));
    const pushesLive = def.name === 'push_to_live_ui' && !edgeMode;
    const readOnly = !writesFiles && !pushesLive;
    const inputSchema = localFiles
      ? def.inputSchema
      : { ...def.inputSchema, properties: omitKeys(def.inputSchema.properties, def.pathArgs) };
    return {
      name: def.name,
      title: def.title,
      description: def.description,
      inputSchema,
      outputSchema: OUTPUT_SCHEMAS[def.name],
      annotations: {
        title: def.title,
        readOnlyHint: readOnly,
        // Writing to an output path may overwrite a file; a live push replaces a UI slot.
        destructiveHint: !readOnly,
        idempotentHint: true,
        openWorldHint: false
      }
    };
  });
}

export const MCP_TOOL_NAMES = TOOL_DEFS.map((t) => t.name);

// ---------------------------------------------------------------------------
// Registry lint: catches unknown parameter names and out-of-range values that
// the hardware serializer would otherwise pass through silently.
// ---------------------------------------------------------------------------
export interface PresetLintIssue {
  type: 'warning';
  message: string;
  presetPos?: number;
}

const ROW_META_KEYS = new Set(['id', 'effect', 'BUS']);

export function lintPresetAgainstRegistry(preset: Record<string, any>): PresetLintIssue[] {
  const issues: PresetLintIssue[] = [];
  const pos = typeof preset?.pos === 'number' ? preset.pos : undefined;
  const warn = (message: string) => issues.push({ type: 'warning', message, presetPos: pos });
  const list: any[] = Array.isArray(preset?.list) ? preset.list : [];

  let percentValues = 0;
  let percentValuesAtMostOne = 0;

  list.forEach((fx, row) => {
    const meta = EFFECTS_REGISTRY[String(fx?.effect || '').toUpperCase() as EffectType];
    if (!meta) {
      warn(`Row ${row}: unknown effect "${fx?.effect}". Valid: ${EFFECT_TYPES.join(', ')}.`);
      return;
    }
    for (const [key, value] of Object.entries(fx)) {
      if (ROW_META_KEYS.has(key)) continue;
      const p = meta.params.find((x) => x.name === key);
      if (!p) {
        warn(
          `Row ${row} (${meta.type}): unknown parameter "${key}". Valid: ${meta.params.map((x) => x.name).join(', ') || 'none'}.`
        );
        continue;
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        warn(`Row ${row} (${meta.type}): "${key}" must be a number.`);
        continue;
      }
      if (value < p.min || value > p.max) {
        warn(`Row ${row} (${meta.type}): "${key}"=${value} is outside ${p.min}..${p.max}${p.unit ? ' ' + p.unit : ''}.`);
      }
      if (p.unit === '%') {
        percentValues++;
        if (value > 0 && value <= 1) percentValuesAtMostOne++;
      }
    }
  });

  if (percentValues >= 2 && percentValuesAtMostOne === percentValues) {
    warn(
      'All percent parameters are between 0 and 1. `preset` uses the editor scale (0..100); values from config.json (0.0..1.0) must be multiplied by 100, or pass the file as configJson.'
    );
  }

  for (const key of ['handle', 'shake', 'lfo'] as const) {
    const mod = preset?.[key];
    if (!mod || typeof mod !== 'object' || mod.target === 'lfo') continue;
    if (typeof mod.row !== 'number') continue;
    const target = list[mod.row];
    const meta: EffectMeta | undefined = target
      ? EFFECTS_REGISTRY[String(target.effect || '').toUpperCase() as EffectType]
      : undefined;
    if (!meta) continue;
    if (!meta.params.some((p) => p.name === mod.param)) {
      warn(
        `${key}: row ${mod.row} is ${meta.type}, which has no parameter "${mod.param}". Valid: ${meta.params.map((p) => p.name).join(', ') || 'none'}.`
      );
      continue;
    }
    const depthCfg = getModDepthConfig(meta.type, mod.param);
    if (typeof mod.depth === 'number' && (mod.depth < depthCfg.min || mod.depth > depthCfg.max)) {
      warn(
        `${key}: depth ${mod.depth} for ${meta.type}.${mod.param} is outside ${depthCfg.min}..${depthCfg.max} ${depthCfg.unit}.`
      );
    }
  }

  return issues;
}
