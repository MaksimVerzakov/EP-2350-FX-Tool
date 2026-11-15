import type { AnyEffect, EffectType, PackConfig, PresetConfig } from '../types/config';
import { EFFECTS_REGISTRY, MAX_EFFECTS_PER_PRESET, getModDepthConfig } from '../constants/effectsRegistry';
import { createEmptyPack } from '../constants/defaultPresets';
import { parseConfigJson } from '../utils/parser';
import { serializeToConfigJson } from '../utils/serializer';
import {
  DEFAULT_PUBLIC_APP_URL,
  buildPackShareUrl,
  buildPresetShareUrl,
  encodePackToHash,
  encodePresetToHash
} from '../utils/presetUrl';
import { type PresetIssue, checkPreset, describePreset, hasStructuralErrors } from './presetCheck';

/**
 * Pure preset tools behind the EP-2350 sound designer skill: the effects reference, preset
 * validation and config.json export. No I/O and no transport; the skill CLI (`src/skill/cli.ts`)
 * and the MCP server both call these.
 */

/** Web app that share links open in: the build's app URL when bundled into the skill. */
export const SHARE_APP_URL: string =
  typeof __EP2350_APP_URL__ !== 'undefined' ? __EP2350_APP_URL__ : DEFAULT_PUBLIC_APP_URL;

/** App version injected at build time (`__APP_VERSION__`), shared with the web UI. */
export const TOOLS_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0-dev';

/** Rules that are not expressed by parameter ranges alone. */
const EFFECTS_REFERENCE_RULES = [
  `A preset has at most ${MAX_EFFECTS_PER_PRESET} effect rows; signal flows top to bottom through \`list\`.`,
  'DELAY, REVERB, HARMONY and SSB may each appear at most once per preset.',
  'SAMPLE marks where the trigger sample is injected into the chain; it is appended automatically if missing.',
  'Rows with BUS 1 and BUS 2 run in parallel and are summed back together.',
  'Preset objects passed to the tools use the editor scale: percent (%) parameters are 0..100 and percent modulation depths -100..100. Hardware config.json stores them as 0.0..1.0; presets in that scale (e.g. hardwarePresetJson or the official packs) are detected and converted automatically, and the tools report inputScale.'
];

const MODULATION_REFERENCE = {
  handle:
    'Squeeze handle. { row, param, depth } sweeps a parameter of the effect on `row` (zero-based) by `depth` at full squeeze, or { target: "lfo", param: "speed", depth } adds `depth` Hz to the LFO rate.',
  shake: 'Accelerometer burst. { row, param, depth } kicks a parameter of the effect on `row` by `depth`.',
  lfo: 'Continuous LFO. { row, param, depth, shape: sine|square|sawtooth|random, speed (Hz), phase? (0..1) }.',
  trigger: '{ row } of the SAMPLE block fired by the trigger button.',
  depthRanges: 'Each parameter lists its modulation depth range in `modDepth` (min, max, unit).'
};

/** Effects, parameters (editor scale), modulation depth ranges and hardware rules. */
export function buildEffectsReference(effect?: string) {
  const wanted = effect ? String(effect).toUpperCase() : undefined;
  const metas = Object.values(EFFECTS_REGISTRY).filter((meta) => !wanted || meta.type === wanted);
  return {
    maxEffectsPerPreset: MAX_EFFECTS_PER_PRESET,
    parallelBuses: [1, 2],
    rules: EFFECTS_REFERENCE_RULES,
    modulation: MODULATION_REFERENCE,
    effects: metas.map((meta) => ({
      type: meta.type,
      displayName: meta.displayName,
      description: meta.description,
      singleInstance: meta.singleInstance,
      params: meta.params.map((p) => {
        const depth = getModDepthConfig(meta.type, p.name);
        return {
          name: p.name,
          label: p.label,
          min: p.min,
          max: p.max,
          step: p.step,
          defaultVal: p.defaultVal,
          unit: p.unit,
          modDepth: { min: depth.min, max: depth.max, unit: depth.unit }
        };
      })
    }))
  };
}

/**
 * Which scale a raw preset uses. The tools take the editor scale (percent parameters 0..100,
 * percent modulation depths -100..100), but config.json, the official-packs resource and every
 * `hardwarePresetJson` output use 0.0..1.0. A preset counts as config scale when it has at least
 * one non-zero percent value (effect parameters and percent modulation depths) and all of them
 * are within ±1: an editor-scale preset whose percentages are all 1% or less is not a realistic
 * intent (two official TE presets have a single percent value, e.g. `mix: 0.2`).
 */
export function detectPresetScale(preset: Record<string, any>): 'editor' | 'config' {
  const values: number[] = [];
  const list: any[] = Array.isArray(preset?.list) ? preset.list : [];
  for (const fx of list) {
    const meta = EFFECTS_REGISTRY[String(fx?.effect ?? fx?.EFFECT ?? '').toUpperCase() as EffectType];
    if (!meta) continue;
    for (const p of meta.params) {
      if (p.unit === '%' && typeof fx[p.name] === 'number' && fx[p.name] !== 0) values.push(fx[p.name]);
    }
  }
  for (const key of ['handle', 'shake', 'lfo'] as const) {
    const mod = preset?.[key];
    if (!mod || typeof mod !== 'object' || mod.target === 'lfo' || typeof mod.depth !== 'number' || mod.depth === 0) continue;
    const target = typeof mod.row === 'number' ? list[mod.row] : undefined;
    const effect = String(target?.effect ?? target?.EFFECT ?? '').toUpperCase();
    if (getModDepthConfig(effect, mod.param).isNormalizedPercent) values.push(mod.depth);
  }
  return values.length >= 1 && values.every((v) => Math.abs(v) <= 1) ? 'config' : 'editor';
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

/**
 * Read a preset argument in either scale. Config-scale presets (0.0..1.0, e.g. copied from
 * hardwarePresetJson or the official packs) are converted with the same parser the web app uses
 * for imported config.json files.
 */
export function readPreset(
  raw: Record<string, any>,
  pos = 0
): { preset: PresetConfig; inputScale: 'editor' | 'config' } {
  const slot = Math.max(0, Math.min(3, typeof raw?.pos === 'number' ? raw.pos : pos));
  if (detectPresetScale(raw) === 'config') {
    const parsed = parseConfigJson(JSON.stringify({ name: 'MCP INPUT', presets: [{ ...raw, pos: slot }] }));
    const converted = parsed.pack?.presets.find((p) => p.pos === slot);
    if (converted) {
      return {
        preset: normalizeSinglePreset({ ...converted, id: raw.id, name: raw.name ?? converted.name }, slot),
        inputScale: 'config'
      };
    }
  }
  return { preset: normalizeSinglePreset(raw, slot), inputScale: 'editor' };
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

/**
 * Validate one preset (`preset`, either scale) or a whole config.json string (`configJson`).
 * Returns errors/warnings (each with path, message and fix), a plain-language summary, the
 * normalized hardware JSON and a share link that opens the result in the web app.
 */
export function validatePresetInput(
  args: { preset?: any; configJson?: unknown },
  shareBaseUrl: string = DEFAULT_PUBLIC_APP_URL
): Record<string, any> {
  const split = (issues: PresetIssue[]) => ({
    errors: issues.filter((i) => i.type === 'error'),
    warnings: issues.filter((i) => i.type === 'warning')
  });

  if (typeof args.configJson === 'string') {
    let rawPack: unknown;
    try {
      rawPack = JSON.parse(args.configJson);
    } catch (err) {
      const issue: PresetIssue = {
        type: 'error',
        code: 'invalid_json',
        path: '(configJson)',
        message: `configJson is not valid JSON: ${err instanceof Error ? err.message : String(err)}.`,
        fix: 'config.json must be strict JSON: double-quoted keys and strings, no trailing commas, no comments.'
      };
      return { isValid: false, errors: [issue], warnings: [], summary: [] };
    }
    const packIssues: PresetIssue[] = [];
    const addPack = (type: PresetIssue['type'], code: string, path: string, message: string, fix: string) =>
      packIssues.push({ type, code, path, message, fix });
    if (!rawPack || typeof rawPack !== 'object' || Array.isArray(rawPack)) {
      addPack('error', 'pack_not_object', '(configJson)', 'config.json must be an object with "name" and "presets".', 'Use { "name": "MY PACK", "presets": [ { "pos": 0, "name": "...", "list": [...] } ] }.');
      return { isValid: false, ...split(packIssues), summary: [] };
    }
    const packObj = rawPack as Record<string, any>;
    if (typeof packObj.name !== 'string' || !packObj.name.trim()) {
      addPack('warning', 'pack_name', 'name', 'The pack has no name.', 'Set "name", e.g. "DUB PACK".');
    }
    if (!Array.isArray(packObj.presets) || packObj.presets.length === 0) {
      addPack('error', 'missing_presets', 'presets', 'config.json has no "presets" array (or it is empty).', 'Add "presets": up to 4 presets with pos 0..3.');
      return { isValid: false, ...split(packIssues), summary: [] };
    }
    if (packObj.presets.length > 4) {
      addPack('error', 'too_many_presets', 'presets', `config.json has ${packObj.presets.length} presets; the mic has 4 slots.`, 'Keep at most 4 presets (pos 0..3).');
    }
    const seenPos = new Map<number, number>();
    packObj.presets.forEach((p: any, i: number) => {
      if (p && typeof p === 'object' && Number.isInteger(p.pos)) {
        if (seenPos.has(p.pos)) {
          addPack('error', 'duplicate_pos', `presets[${i}].pos`, `presets[${i}] and presets[${seenPos.get(p.pos)}] both use pos ${p.pos}.`, 'Give every preset its own slot 0..3.');
        } else seenPos.set(p.pos, i);
      }
      packIssues.push(...checkPreset(p, 'config', `presets[${i}].`));
    });
    if (hasStructuralErrors(packIssues)) {
      return { isValid: false, ...split(packIssues), summary: [] };
    }
    const parsed = parseConfigJson(args.configJson);
    if (parsed.error || !parsed.pack) {
      addPack('error', 'parse_failed', '(configJson)', parsed.error || 'config.json could not be read.', 'Fix the reported problem and validate again.');
      return { isValid: false, ...split(packIssues), summary: [] };
    }
    const normalizedConfigJson = JSON.parse(serializeToConfigJson(parsed.pack));
    const summary = parsed.pack.presets
      .filter((p) => p.list.length > 0)
      .flatMap((p) => [`Preset ${p.pos} "${p.name || ''}":`, ...describePreset(p).map((l) => `  ${l}`)]);
    const { errors, warnings } = split(packIssues);
    return {
      isValid: errors.length === 0,
      inputScale: 'config',
      errors,
      warnings,
      summary,
      normalizedConfigJson,
      shareHash: encodePackToHash(normalizedConfigJson),
      shareUrl: buildPackShareUrl(shareBaseUrl, normalizedConfigJson)
    };
  }

  if (args.preset !== undefined) {
    const raw = args.preset;
    const inputScale = raw && typeof raw === 'object' && !Array.isArray(raw) ? detectPresetScale(raw) : 'editor';
    const issues = checkPreset(raw, inputScale);
    if (hasStructuralErrors(issues)) {
      return { isValid: false, inputScale, ...split(issues), summary: [] };
    }
    const { preset: normPreset } = readPreset(raw, raw.pos ?? 0);
    const pack = wrapPresetInPack(normPreset);
    const serializedPack = JSON.parse(serializeToConfigJson(pack));
    const normalizedPresetJson = serializedPack.presets[normPreset.pos];
    const { errors, warnings } = split(issues);
    return {
      isValid: errors.length === 0,
      inputScale,
      errors,
      warnings,
      summary: describePreset(normPreset),
      normalizedPresetJson,
      shareHash: encodePresetToHash(normalizedPresetJson, normPreset.pos),
      shareUrl: buildPresetShareUrl(shareBaseUrl, normalizedPresetJson, normPreset.pos)
    };
  }

  return { error: 'Provide either `preset` (one preset object) or `configJson` (a config.json string).' };
}

/**
 * Build a hardware config.json from up to 4 presets (either scale). `pos` picks the slot,
 * otherwise array order is used; empty slots get a lone SAMPLE row.
 */
export function exportPackConfig(
  args: { packName?: unknown; presets?: unknown },
  shareBaseUrl: string = DEFAULT_PUBLIC_APP_URL
): Record<string, any> {
  const pack = createEmptyPack();
  pack.name = String(args.packName || 'AI FX PACK').trim();
  const issues: PresetIssue[] = [];
  if (Array.isArray(args.presets)) {
    args.presets.slice(0, 4).forEach((p: unknown, idx: number) => {
      const scale = p && typeof p === 'object' && !Array.isArray(p) ? detectPresetScale(p as Record<string, any>) : 'editor';
      issues.push(...checkPreset(p, scale, `presets[${idx}].`));
    });
  }
  if (hasStructuralErrors(issues)) {
    return {
      error: 'Some presets cannot be read; nothing was exported. Fix the errors below (validate_preset gives the same details).',
      errors: issues.filter((i) => i.type === 'error')
    };
  }
  if (Array.isArray(args.presets)) {
    args.presets.slice(0, 4).forEach((p: Record<string, any>, idx: number) => {
      const slot = typeof p.pos === 'number' ? Math.max(0, Math.min(3, p.pos)) : idx;
      pack.presets[slot] = readPreset(p, slot).preset;
    });
  }
  for (let i = 0; i < 4; i++) {
    if (pack.presets[i].list.length === 0) {
      pack.presets[i].list = [{ id: `smp-${i}`, effect: 'SAMPLE' }];
    }
  }

  const configJsonString = serializeToConfigJson(pack);
  const configJson = JSON.parse(configJsonString);
  const shareHash = encodePackToHash(configJson);
  const shareUrl = buildPackShareUrl(shareBaseUrl, configJson);

  return {
    packName: pack.name,
    validationIssues: issues,
    shareHash,
    shareUrl,
    configJson,
    configJsonString
  };
}