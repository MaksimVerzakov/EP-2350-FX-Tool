import type { AnyEffect, EffectType, PackConfig, PresetConfig } from '../types/config';
import { EFFECTS_REGISTRY, getModDepthConfig } from '../constants/effectsRegistry';
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
 * Pure preset validation behind the MCP server's validate_pack tool (src/mcp/mcpServer.ts). No I/O.
 */

/** App version injected at build time (`__APP_VERSION__`), shared with the web UI. */
export const TOOLS_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0-dev';

/**
 * Which scale a raw preset uses. The editor uses percent parameters 0..100 and percent modulation
 * depths -100..100, but config.json uses 0.0..1.0. A preset counts as config scale when it has at
 * least one non-zero percent value (effect parameters and percent modulation depths) and all of them
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
 * Read a preset argument in either scale. Config-scale presets (0.0..1.0, e.g. the
 * official packs) are converted with the same parser the web app uses
 * for imported config.json files.
 */
export function readPreset(
  raw: Record<string, any>,
  pos = 0
): { preset: PresetConfig; inputScale: 'editor' | 'config' } {
  const slot = Math.max(0, Math.min(3, typeof raw?.pos === 'number' ? raw.pos : pos));
  if (detectPresetScale(raw) === 'config') {
    const parsed = parseConfigJson(JSON.stringify({ name: 'INPUT', presets: [{ ...raw, pos: slot }] }));
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
    if (packObj.samples !== undefined) {
      addPack(
        'warning',
        'samples_block',
        'samples',
        'The pack has a "samples" block. WAV files cannot travel with the pack or its share link, so the mic would look for files the user does not have.',
        'Leave "samples" out; the mic then uses its built-in sounds.'
      );
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
    // Summarise only the presets that were sent; the parser fills empty slots with placeholders
    const sentPos = new Set(packObj.presets.map((p: any, i: number) => (p && typeof p.pos === 'number' ? p.pos : i)));
    const summary = parsed.pack.presets
      .filter((p) => sentPos.has(p.pos) && p.list.length > 0)
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
