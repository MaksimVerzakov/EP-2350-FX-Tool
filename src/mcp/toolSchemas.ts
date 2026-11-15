import type { EffectType } from '../types/config';
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
    'EP-2350 preset in editor (UI) scale: percent (%) knobs 0..100, percent modulation depths -100..100. A preset in config.json scale (0.0..1.0, as in hardwarePresetJson or the official packs) is detected and converted automatically; the result reports inputScale. Signal flows top to bottom through `list`; SAMPLE marks where the trigger sample is injected (appended automatically if missing). Optional BUS 1/2 rows run in parallel. Effect descriptions and modulation depth ranges: get_effects_reference.',
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
 * Compact preset reference for tools other than validate_preset, so the full
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

// ---------------------------------------------------------------------------
// Output schemas (kept open with additionalProperties so the payload can grow)
// ---------------------------------------------------------------------------
const issueSchema: JsonSchema = {
  type: 'object',
  properties: {
    type: { enum: ['error', 'warning'] },
    code: { type: 'string', description: 'Stable issue code, e.g. unknown_param, out_of_range, bad_row.' },
    path: { type: 'string', description: 'Exact field, e.g. list[2].cutof or handle.row.' },
    message: { type: 'string', description: 'What is wrong.' },
    fix: { type: 'string', description: 'How to fix it.' },
    presetPos: { type: 'integer' }
  },
  required: ['type', 'code', 'path', 'message', 'fix']
};
const shareFields: JsonSchema = {
  shareHash: { type: 'string', description: 'URL hash payload (#preset=… or #pack=…).' },
  shareUrl: { type: 'string', description: 'Opens the preset/pack in the EP-2350 web app.' }
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
      inputScale: { enum: ['editor', 'config'], description: 'Scale the preset argument was given in.' },
      errors: { type: 'array', items: issueSchema },
      warnings: { type: 'array', items: issueSchema },
      summary: {
        type: 'array',
        items: { type: 'string' },
        description: 'What the preset does, in plain words, computed from its settings. Compare it with the request.'
      },
      normalizedPresetJson: { type: 'object' },
      normalizedConfigJson: { type: 'object' },
      ...shareFields
    },
    required: ['isValid', 'errors', 'warnings', 'summary']
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
      'Check a preset (or a whole config.json) and explain it. Every problem comes back with the exact field (`path`, e.g. list[2].cutof or handle.row), what is wrong (`message`) and how to fix it (`fix`): unknown effects or parameters (with the closest valid name), wrong types, values out of range (with the allowed range), duplicate single-instance effects, more than 16 rows, bad modulation rows/params/depths, a trigger not on SAMPLE, and settings that make the sound inaudible. `summary` describes in plain words what the preset will do (filter frequencies, echo timing and fade, what the handle, shake and LFO change). Fix every error and validate again before exporting. Accepts editor scale (0..100) or config.json scale (0..1).',
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
