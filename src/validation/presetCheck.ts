import type { EffectMeta, EffectType, ParamDef, PresetConfig } from '../types/config';
import { EFFECTS_REGISTRY, MAX_EFFECTS_PER_PRESET, getModDepthConfig } from '../constants/effectsRegistry';
import { busLanes } from '../utils/busRouting';

/**
 * Detailed preset checks and a plain-language summary for AI assistants.
 *
 * Checks run on the raw input (before normalization) so every issue can point at the exact
 * field (`list[2].cutof`, `handle.row`), say what is wrong, and say how to fix it.
 */

export type PresetScale = 'editor' | 'config';

export interface PresetIssue {
  type: 'error' | 'warning';
  /** Stable machine-readable code, e.g. `unknown_param`, `out_of_range`. */
  code: string;
  /** JSON path of the offending field, e.g. `list[2].cutof` or `presets[1].handle.row`. */
  path: string;
  /** What is wrong. */
  message: string;
  /** How to fix it. */
  fix: string;
  presetPos?: number;
}

const EFFECT_TYPES = Object.keys(EFFECTS_REGISTRY) as EffectType[];
const PRESET_KEYS = ['id', 'pos', 'name', 'comment', 'list', 'handle', 'shake', 'lfo', 'trigger'];
const ROW_META_KEYS = ['id', 'effect', 'EFFECT', 'BUS'];
const LFO_SHAPES = ['sine', 'square', 'sawtooth', 'random'];
const MOD_KEYS: Record<'handle' | 'shake' | 'lfo' | 'trigger', string[]> = {
  handle: ['row', 'target', 'param', 'depth'],
  shake: ['row', 'param', 'depth'],
  lfo: ['row', 'target', 'param', 'depth', 'shape', 'speed', 'phase'],
  trigger: ['row']
};
/** Common names agents use for effects that exist under another name. */
const EFFECT_ALIASES: Record<string, EffectType> = {
  ECHO: 'DELAY',
  EQ: 'EQUALISER',
  EQUALIZER: 'EQUALISER',
  DISTORTION: 'DIST',
  OVERDRIVE: 'DIST',
  FUZZ: 'DIST',
  PITCH: 'HARMONY',
  PITCHSHIFT: 'HARMONY',
  PITCH_SHIFT: 'HARMONY',
  RINGMOD: 'RING',
  RING_MOD: 'RING',
  RINGMODULATOR: 'RING',
  PAN: 'BALANCE',
  LPF: 'LOWPASS',
  LOW_PASS: 'LOWPASS',
  HPF: 'HIGHPASS',
  HIGH_PASS: 'HIGHPASS',
  FREQUENCYSHIFTER: 'SSB',
  FREQUENCY_SHIFT: 'SSB',
  SHIFTER: 'SSB'
};

/** Parameters whose 0..1 value is a filter frequency (shown in Hz in the summary). */
const CUTOFF_PARAMS = new Set(['cutoff', 'CUTOFF', 'lowpass-cutoff', 'highpass-cutoff']);
const cutoffHz = (ratio: number) => 20 * Math.pow(1000, Math.max(0, Math.min(1, ratio)));

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1)
      );
    }
  }
  return dp[a.length][b.length];
}

function closest(name: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = levenshtein(name, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best !== undefined && bestD <= Math.max(2, Math.floor(name.length / 3)) ? best : undefined;
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const fmt = (v: number) => String(Math.round(v * 1000) / 1000);
const metaOf = (effect: unknown): EffectMeta | undefined =>
  EFFECTS_REGISTRY[String(effect ?? '').toUpperCase() as EffectType];

/** Allowed range of a parameter in the scale the preset was given in. */
function paramRange(p: ParamDef, scale: PresetScale) {
  const f = p.unit === '%' && scale === 'config' ? 0.01 : 1;
  // 0..1 knobs whose unit describes what they control (reverb time in s, cutoff in Hz, EQ gain in
  // dB): the stored value has no unit, so show what the ends of the range mean, as the guide does.
  const normalized = p.unit !== '%' && p.unit !== '' && Math.abs(p.max) <= 1 && Math.abs(p.min) <= 1;
  const unit = (p.unit === '%' && scale === 'config') || normalized ? '' : p.unit;
  const ends = normalized && p.displayScale ? ` (${p.displayScale(p.min)} to ${p.displayScale(p.max)})` : '';
  return { min: p.min * f, max: p.max * f, unit, text: `${fmt(p.min * f)}..${fmt(p.max * f)}${unit ? ' ' + unit : ''}${ends}` };
}

function depthRange(effect: string, param: string, scale: PresetScale) {
  const cfg = getModDepthConfig(effect, param);
  const f = cfg.isNormalizedPercent && scale === 'config' ? 0.01 : 1;
  const unit = cfg.isNormalizedPercent && scale === 'config' ? '' : cfg.unit;
  const note = cfg.isNormalizedPercent ? scaleNote(scale) : '';
  return { min: cfg.min * f, max: cfg.max * f, text: `${fmt(cfg.min * f)}..${fmt(cfg.max * f)}${unit ? ' ' + unit : ''}`, note };
}

const scaleNote = (scale: PresetScale) =>
  scale === 'config'
    ? ' (this preset is read as config.json scale, where percent values are 0..1)'
    : ' (editor scale: percent values are 0..100)';

/**
 * Check one raw preset. `prefix` is prepended to paths (e.g. `presets[2].` for a pack).
 * Returns every problem found; errors make the preset invalid, warnings do not.
 */
export function checkPreset(raw: unknown, scale: PresetScale, prefix = ''): PresetIssue[] {
  const issues: PresetIssue[] = [];
  const pos = isObj(raw) && isNum(raw.pos) ? raw.pos : undefined;
  const add = (type: PresetIssue['type'], code: string, path: string, message: string, fix: string) =>
    issues.push({ type, code, path: prefix + path, message, fix, ...(pos !== undefined ? { presetPos: pos } : {}) });

  if (!isObj(raw)) {
    add(
      'error',
      'preset_not_object',
      prefix ? prefix.replace(/\.$/, '') : '(preset)',
      `The preset must be an object, got ${Array.isArray(raw) ? 'an array' : raw === null ? 'null' : typeof raw}.`,
      'Pass an object like { "name": "MY PRESET", "list": [ { "effect": "DELAY", "time": 0.3 }, { "effect": "SAMPLE" } ] }.'
    );
    return issues;
  }

  for (const key of Object.keys(raw)) {
    if (!PRESET_KEYS.includes(key)) {
      const guess = closest(key, PRESET_KEYS);
      add(
        'warning',
        'unknown_preset_key',
        key,
        `Unknown preset field "${key}"; it is ignored.`,
        guess ? `Did you mean "${guess}"?` : `Preset fields are: ${PRESET_KEYS.join(', ')}.`
      );
    }
  }
  if (raw.pos !== undefined && (!Number.isInteger(raw.pos) || raw.pos < 0 || raw.pos > 3)) {
    add('error', 'bad_pos', 'pos', `pos is ${JSON.stringify(raw.pos)}; it must be the preset slot 0, 1, 2 or 3.`, 'Set pos to an integer from 0 to 3, or leave it out.');
  }
  if (raw.name !== undefined && typeof raw.name !== 'string') {
    add('error', 'bad_name', 'name', `name must be a string, got ${typeof raw.name}.`, 'Use a short uppercase name, e.g. "SPACE ECHO".');
  }

  if (!Array.isArray(raw.list)) {
    add(
      'error',
      'missing_list',
      'list',
      raw.list === undefined ? 'The preset has no "list" (the effect chain).' : `"list" must be an array of effect rows, got ${typeof raw.list}.`,
      'Add "list": an array of rows in signal order, e.g. [ { "effect": "LOWPASS", "cutoff": 0.6 }, { "effect": "SAMPLE" } ].'
    );
    return issues;
  }
  const list: unknown[] = raw.list;
  const hasSample = list.some((fx) => isObj(fx) && metaOf(fx.effect ?? fx.EFFECT)?.type === 'SAMPLE');
  const effectiveRows = list.length + (hasSample ? 0 : 1);
  if (effectiveRows > MAX_EFFECTS_PER_PRESET) {
    add(
      'error',
      'too_many_rows',
      'list',
      `The chain has ${effectiveRows} rows${hasSample ? '' : ' (including the SAMPLE row export adds)'}; the hardware allows ${MAX_EFFECTS_PER_PRESET}.`,
      `Remove ${effectiveRows - MAX_EFFECTS_PER_PRESET} row(s).`
    );
  }
  if (list.length === 0) {
    add('warning', 'empty_chain', 'list', 'The effect chain is empty, so the preset only plays the dry voice.', 'Add effect rows to "list".');
  }

  const seen: Record<string, number[]> = {};
  list.forEach((fx, i) => {
    const rowPath = `list[${i}]`;
    if (!isObj(fx)) {
      add(
        'error',
        'row_not_object',
        rowPath,
        `${rowPath} must be an object, got ${fx === null ? 'null' : Array.isArray(fx) ? 'an array' : typeof fx}.`,
        'Each row looks like { "effect": "REVERB", "time": 0.5, "wet-level": 40 }.'
      );
      return;
    }
    const effectName = fx.effect ?? fx.EFFECT;
    if (effectName === undefined) {
      add('error', 'missing_effect', `${rowPath}.effect`, `${rowPath} has no "effect".`, `Set "effect" to one of: ${EFFECT_TYPES.join(', ')}.`);
      return;
    }
    const meta = metaOf(effectName);
    if (!meta) {
      const upper = String(effectName).toUpperCase().replace(/[\s-]/g, '_');
      const guess = EFFECT_ALIASES[upper] ?? EFFECT_ALIASES[upper.replace(/_/g, '')] ?? closest(String(effectName), EFFECT_TYPES);
      add(
        'error',
        'unknown_effect',
        `${rowPath}.effect`,
        `Unknown effect "${effectName}".`,
        `${guess ? `Did you mean "${guess}"? ` : ''}Effects are: ${EFFECT_TYPES.join(', ')}.`
      );
      return;
    }
    (seen[meta.type] ||= []).push(i);
    if (fx.BUS !== undefined && fx.BUS !== 1 && fx.BUS !== 2) {
      add('error', 'bad_bus', `${rowPath}.BUS`, `BUS is ${JSON.stringify(fx.BUS)}; it must be 1 or 2.`, 'Use BUS 1 or 2 to run rows in parallel, or leave BUS out for the main chain.');
    }
    if (meta.type === 'SAMPLE' && fx.BUS === 2) {
      add('error', 'sample_on_bus2', `${rowPath}.BUS`, 'SAMPLE is on BUS 2; the trigger sample must not go on bus 2.', 'Remove "BUS" from the SAMPLE row, or set it to 1.');
    }
    const paramNames = meta.params.map((p) => p.name);
    for (const [key, value] of Object.entries(fx)) {
      if (ROW_META_KEYS.includes(key)) continue;
      const p = meta.params.find((x) => x.name === key);
      if (!p) {
        const guess = closest(key, paramNames);
        add(
          'error',
          'unknown_param',
          `${rowPath}.${key}`,
          `${meta.type} has no parameter "${key}" (it would be ignored).`,
          `${guess ? `Did you mean "${guess}"? ` : ''}${meta.type} parameters: ${paramNames.join(', ') || 'none'}.`
        );
        continue;
      }
      const r = paramRange(p, scale);
      if (!isNum(value)) {
        add('error', 'param_not_number', `${rowPath}.${key}`, `${meta.type} ${key} must be a number, got ${JSON.stringify(value)}.`, `Use a number in ${r.text}.`);
        continue;
      }
      if (value < r.min || value > r.max) {
        add(
          'error',
          'out_of_range',
          `${rowPath}.${key}`,
          `${meta.type} ${key} is ${fmt(value)}, outside the allowed range ${r.text}${p.unit === '%' ? scaleNote(scale) : ''}.`,
          `Use a value between ${fmt(r.min)} and ${fmt(r.max)}.`
        );
      }
    }
    const pct = (k: string) => (isNum(fx[k]) ? (scale === 'config' ? fx[k] * 100 : fx[k]) : undefined);
    if ((meta.type === 'DELAY' || meta.type === 'REVERB') && pct('wet-level') === 0 && pct('dry-level') === 0) {
      add('warning', 'silent_row', rowPath, `${meta.type} has wet-level 0 and dry-level 0, so everything after this row is silent.`, 'Raise dry-level (to pass the voice) and/or wet-level (to hear the effect).');
    }
    if (meta.type === 'DELAY' && pct('echo') !== undefined && (pct('echo') as number) >= 100) {
      add('warning', 'runaway_feedback', `${rowPath}.echo`, 'DELAY echo (feedback) at 100% never fades and can build up.', 'Keep echo below about 85% for repeats that die away.');
    }
    if (meta.type === 'LOWPASS' && isNum(fx.cutoff) && fx.cutoff < 0.15) {
      add('warning', 'filter_extreme', `${rowPath}.cutoff`, `LOWPASS cutoff ${fmt(fx.cutoff)} is ≈${Math.round(cutoffHz(fx.cutoff))} Hz and removes almost all of the voice.`, 'Use about 0.35 (≈230 Hz, muffled) to 0.75 (≈3.6 kHz, slightly dark).');
    }
    if (meta.type === 'HIGHPASS' && isNum(fx.cutoff) && fx.cutoff > 0.85) {
      add('warning', 'filter_extreme', `${rowPath}.cutoff`, `HIGHPASS cutoff ${fmt(fx.cutoff)} is ≈${(cutoffHz(fx.cutoff) / 1000).toFixed(1)} kHz and removes almost all of the voice.`, 'Use about 0.3 (≈160 Hz, removes rumble) to 0.6 (≈1.3 kHz, telephone-thin).');
    }
  });

  for (const [type, rows] of Object.entries(seen)) {
    if (rows.length > 1 && EFFECTS_REGISTRY[type as EffectType].singleInstance) {
      add('error', 'duplicate_effect', `list[${rows[1]}].effect`, `${type} appears ${rows.length} times (rows ${rows.join(', ')}); the hardware allows it once per preset.`, `Keep one ${type} row and remove the others.`);
    }
  }
  if (!hasSample && list.length > 0) {
    add('warning', 'missing_sample', 'list', 'There is no SAMPLE row. Export appends one at the end, so the trigger sample enters after every effect.', 'Add { "effect": "SAMPLE" } where the trigger sample should enter the chain (usually last).');
  }

  const sampleRow = list.findIndex((fx) => isObj(fx) && metaOf(fx.effect ?? fx.EFFECT)?.type === 'SAMPLE');
  if (sampleRow >= 0 && (raw.trigger === undefined || raw.trigger === null)) {
    add(
      'warning',
      'missing_trigger',
      'trigger',
      `There is no trigger, and the trigger button only plays the sample when trigger.row points at the SAMPLE row. Export adds { "row": ${sampleRow} }.`,
      `Add "trigger": { "row": ${sampleRow} }.`
    );
  }

  // Modulation
  const rowEffect = (row: unknown) => (Number.isInteger(row) && (row as number) >= 0 && (row as number) < list.length && isObj(list[row as number]) ? metaOf((list[row as number] as any).effect ?? (list[row as number] as any).EFFECT) : undefined);
  for (const key of ['handle', 'shake', 'lfo', 'trigger'] as const) {
    const mod = raw[key];
    if (mod === undefined || mod === null) continue;
    if (!isObj(mod)) {
      add('error', 'mod_not_object', key, `${key} must be an object, got ${typeof mod}.`, `Write it like ${key === 'trigger' ? '{ "row": 3 }' : '{ "row": 0, "param": "cutoff", "depth": 50 }'}.`);
      continue;
    }
    for (const k of Object.keys(mod)) {
      if (!MOD_KEYS[key].includes(k)) {
        add('warning', 'unknown_mod_key', `${key}.${k}`, `Unknown ${key} field "${k}"; it is ignored.`, `${key} fields are: ${MOD_KEYS[key].join(', ')}.`);
      }
    }
    const targetsLfo = (key === 'handle' || key === 'lfo') && mod.target !== undefined;
    if (targetsLfo && mod.target !== 'lfo') {
      add('error', 'bad_target', `${key}.target`, `${key}.target is ${JSON.stringify(mod.target)}; the only allowed value is "lfo".`, `Leave target out to modulate an effect row, or use "lfo"${key === 'handle' ? ' with param "speed"' : ''}.`);
      continue;
    }
    if (key === 'handle' && mod.target === 'lfo') {
      if (mod.param !== undefined && mod.param !== 'speed') {
        add('error', 'bad_param', 'handle.param', `When handle targets the LFO, param must be "speed", got ${JSON.stringify(mod.param)}.`, 'Set handle to { "target": "lfo", "param": "speed", "depth": 4 } (depth in Hz).');
      }
      if (!isNum(mod.depth)) add('error', 'missing_depth', 'handle.depth', 'handle.depth (Hz added to the LFO rate at full squeeze) is missing or not a number.', 'Set depth, e.g. 4.');
      if (!isObj(raw.lfo)) add('warning', 'lfo_missing', 'handle.target', 'handle speeds up the LFO, but the preset has no lfo, so squeezing does nothing.', 'Add an lfo, or point the handle at an effect row instead.');
      continue;
    }
    if (key === 'lfo' && mod.target === 'lfo') {
      add('error', 'bad_target', 'lfo.target', 'The LFO cannot target itself.', 'Give lfo a row and param of an effect instead.');
      continue;
    }

    // row
    const listHint = list.map((fx, i) => `${i}=${isObj(fx) ? String(fx.effect ?? fx.EFFECT ?? '?').toUpperCase() : '?'}`).join(', ');
    if (mod.row === undefined) {
      add('error', 'missing_row', `${key}.row`, `${key}.row is missing.`, `Set row to the zero-based index of the target in "list" (${listHint}).`);
      continue;
    }
    if (!Number.isInteger(mod.row) || mod.row < 0 || mod.row >= list.length) {
      add('error', 'bad_row', `${key}.row`, `${key}.row is ${JSON.stringify(mod.row)}, but "list" has rows 0..${list.length - 1}.`, `Use a zero-based row index (${listHint}).`);
      continue;
    }
    const meta = rowEffect(mod.row);
    if (key === 'trigger') {
      if (meta && meta.type !== 'SAMPLE') {
        add('error', 'trigger_not_sample', 'trigger.row', `trigger.row ${mod.row} is ${meta.type}; the trigger button fires a SAMPLE row.`, sampleRow >= 0 ? `Set trigger.row to ${sampleRow}.` : 'Add a SAMPLE row and point trigger.row at it.');
      }
      continue;
    }
    if (!meta) continue; // the row itself is already reported
    // param
    const names = meta.params.map((p) => p.name);
    if (typeof mod.param !== 'string') {
      add('error', 'missing_param', `${key}.param`, `${key}.param is missing.`, `Use a parameter of row ${mod.row} (${meta.type}): ${names.join(', ')}.`);
      continue;
    }
    if (!names.includes(mod.param)) {
      const guess = closest(mod.param, names);
      add('error', 'bad_param', `${key}.param`, `${key} targets row ${mod.row} (${meta.type}), which has no parameter "${mod.param}".`, `${guess ? `Did you mean "${guess}"? ` : ''}Use one of: ${names.join(', ')}.`);
      continue;
    }
    // depth
    const dr = depthRange(meta.type, mod.param, scale);
    if (!isNum(mod.depth)) {
      add('error', 'missing_depth', `${key}.depth`, `${key}.depth is missing or not a number.`, `Set depth in ${dr.text}${dr.note}.`);
    } else if (mod.depth < dr.min || mod.depth > dr.max) {
      add('error', 'depth_out_of_range', `${key}.depth`, `${key}.depth ${fmt(mod.depth)} for ${meta.type} ${mod.param} is outside ${dr.text}${dr.note}.`, `Use a depth between ${fmt(dr.min)} and ${fmt(dr.max)}.`);
    } else if (mod.depth === 0) {
      add('warning', 'zero_depth', `${key}.depth`, `${key}.depth is 0, so ${key} does nothing.`, `Use a non-zero depth in ${dr.text}.`);
    }
    if (key === 'lfo') {
      if (!LFO_SHAPES.includes(mod.shape)) {
        add('error', 'bad_shape', 'lfo.shape', `lfo.shape is ${JSON.stringify(mod.shape)}.`, `Use one of: ${LFO_SHAPES.join(', ')}.`);
      }
      if (!isNum(mod.speed) || mod.speed <= 0) {
        add('error', 'bad_speed', 'lfo.speed', `lfo.speed is ${JSON.stringify(mod.speed)}; it must be a positive rate in Hz.`, 'Use e.g. 0.5 (slow sweep) to 8 (fast wobble).');
      }
      if (mod.phase !== undefined && (!isNum(mod.phase) || mod.phase < 0 || mod.phase > 1)) {
        add('error', 'bad_phase', 'lfo.phase', `lfo.phase is ${JSON.stringify(mod.phase)}; it must be 0..1.`, 'Use a value from 0 to 1, or leave phase out.');
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Plain-language summary (from the settings; no audio rendering)
// ---------------------------------------------------------------------------
function fmtHz(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)} kHz` : `${Math.round(hz)} Hz`;
}

/** Display a parameter value (editor scale) in human units. */
function showValue(effect: EffectType, param: string, value: number): string {
  if (CUTOFF_PARAMS.has(param)) {
    const ratio = getUnit(effect, param) === '%' ? value / 100 : value;
    return `≈${fmtHz(cutoffHz(ratio))}`;
  }
  const unit = getUnit(effect, param);
  if (unit === '%') return `${Math.round(value)}%`;
  if (unit === 's') return effect === 'REVERB' ? `${Math.round(value * 100)}%` : `${Math.round(value * 1000)} ms`;
  if (unit === 'x') return `${fmt(value)}x`;
  if (unit === 'st') return `${value > 0 ? '+' : ''}${fmt(value)} st`;
  if (unit === 'Hz') return `${Math.round(value)} Hz`;
  if (param === 'balance') return value === 0.5 ? 'centre' : value < 0.5 ? `left ${Math.round((0.5 - value) * 200)}%` : `right ${Math.round((value - 0.5) * 200)}%`;
  return fmt(value);
}

function getUnit(effect: EffectType, param: string): string {
  return EFFECTS_REGISTRY[effect]?.params.find((p) => p.name === param)?.unit ?? '';
}

/** Value of a parameter after adding a modulation depth, clamped like the engine does. */
function modulated(effect: EffectType, param: string, base: number, depth: number): number {
  const p = EFFECTS_REGISTRY[effect].params.find((x) => x.name === param)!;
  const cfg = getModDepthConfig(effect, param);
  if (cfg.isNormalizedPercent) {
    // Percent-style values are 0..100 in the editor; 0..1 ratios (cutoff, balance, REVERB time) stay 0..1
    const span = p.unit === '%' ? 100 : 1;
    return Math.max(p.min, Math.min(p.max, base + (depth / 100) * span));
  }
  return Math.max(p.min, Math.min(p.max, base + depth));
}

function describeRow(fx: Record<string, any>): string {
  const t = String(fx.effect).toUpperCase() as EffectType;
  const meta = EFFECTS_REGISTRY[t];
  const v = (k: string) => (isNum(fx[k]) ? fx[k] : meta.params.find((p) => p.name === k)?.defaultVal ?? 0);
  switch (t) {
    case 'LOWPASS': {
      const hz = cutoffHz(v('cutoff'));
      const tone = hz < 300 ? 'very muffled and much quieter' : hz < 1500 ? 'muffled, dark' : hz < 6000 ? 'slightly dark' : 'almost fully open';
      return `LOWPASS at ≈${fmtHz(hz)}: ${tone}`;
    }
    case 'HIGHPASS': {
      const hz = cutoffHz(v('cutoff'));
      const tone = hz > 2000 ? 'very thin' : hz > 500 ? 'thin, telephone-like' : hz > 120 ? 'removes low rumble' : 'barely changes the sound';
      return `HIGHPASS at ≈${fmtHz(hz)}: ${tone}`;
    }
    case 'DIST': {
      const tone =
        v('highpass-cutoff') > 0 || v('lowpass-cutoff') < 100
          ? `, tone band ${showValue(t, 'highpass-cutoff', v('highpass-cutoff'))}–${showValue(t, 'lowpass-cutoff', v('lowpass-cutoff'))}`
          : '';
      return `distortion: drive ${fmt(v('amount'))}x, mix ${Math.round(v('mix'))}%${tone}`;
    }
    case 'DELAY': {
      const ms = Math.round(v('time') * 1000);
      const fb = v('echo');
      const fade = fb <= 0 ? 'a single repeat' : fb >= 100 ? 'repeats never fade' : `repeats fade out over ≈${fmt(Math.round(((v('time') * 60) / (-20 * Math.log10(fb / 100))) * 10) / 10)} s`;
      return `echo every ${ms} ms, feedback ${Math.round(fb)}% (${fade}), wet ${Math.round(v('wet-level'))}%, dry ${Math.round(v('dry-level'))}%`;
    }
    case 'REVERB':
      return `reverb: time ${Math.round(v('time') * 100)}% (longer tail as it rises), wet ${Math.round(v('wet-level'))}%, dry ${Math.round(v('dry-level'))}%${v('spring-mix') > 0 ? `, spring ${Math.round(v('spring-mix'))}%` : ''}`;
    case 'RING':
      return `ring modulator at ${Math.round(v('frequency'))} Hz, mix ${Math.round(v('mix'))}% (metallic, robotic)`;
    case 'SSB': {
      const f = v('frequency');
      return f === 0 ? 'frequency shifter at 0 Hz (no change until modulated)' : `frequency shift ${f > 0 ? '+' : ''}${Math.round(f)} Hz (detuned, inharmonic)`;
    }
    case 'HARMONY': {
      const p = v('pitch');
      const st = 12 * Math.log2(Math.max(0.01, p));
      return `pitch shift ×${fmt(p)} (${st >= 0 ? '+' : ''}${st.toFixed(1)} semitones), dry ${Math.round(v('dry-level'))}%`;
    }
    case 'EQUALISER':
      return `EQ at ≈${fmtHz(cutoffHz(v('CUTOFF')))}, Q ${fmt(v('Q'))}, gain ${v('GAIN') > 0 ? '+' : ''}${fmt(v('GAIN'))}`;
    case 'BALANCE':
      return `pan ${showValue(t, 'balance', v('balance'))}`;
    case 'SAMPLE':
      return `trigger sample enters here (speed ${fmt(v('speed'))}x, pitch ${showValue(t, 'pitch', v('pitch'))}, level ${Math.round(v('level'))}%)`;
    default:
      return t;
  }
}

/**
 * What the preset does, in plain words, computed from its settings (editor scale, normalized).
 * Intended for agents: compare it with what the user asked for.
 */
export function describePreset(preset: PresetConfig): string[] {
  const lines: string[] = [];
  const list = preset.list as Array<Record<string, any>>;
  const lanes = busLanes(list);
  const chain = list.map((fx, i) => `${String(fx.effect).toUpperCase()}${lanes[i] === 'mix' ? ' (mix)' : fx.BUS ? ` (bus ${fx.BUS})` : ''}`);
  lines.push(`Signal chain: voice → ${chain.join(' → ') || '(no effects)'}${list.some((fx) => String(fx.effect).toUpperCase() === 'SAMPLE') ? '' : ' → SAMPLE (added on export)'}.`);
  if (list.some((fx) => fx.BUS)) {
    const mixRows = lanes.map((l, i) => (l === 'mix' ? i : -1)).filter((i) => i >= 0);
    lines.push(
      `Rows on BUS 1 and BUS 2 run in parallel and are mixed back together${mixRows.length ? `; row${mixRows.length > 1 ? 's' : ''} ${mixRows.join(', ')} (no BUS, after the bus rows) process${mixRows.length > 1 ? '' : 'es'} that mix` : ''}.`
    );
  }
  list.forEach((fx, i) => lines.push(`Row ${i} ${describeRow(fx)}.`));

  const target = (row: number | undefined) =>
    typeof row === 'number' && list[row] ? (String(list[row].effect).toUpperCase() as EffectType) : undefined;
  const baseOf = (row: number, param: string) => {
    const t = target(row)!;
    const p = EFFECTS_REGISTRY[t].params.find((x) => x.name === param)!;
    return isNum(list[row][param]) ? list[row][param] : p.defaultVal;
  };
  const sweep = (row: number, param: string, depth: number) => {
    const t = target(row)!;
    const base = baseOf(row, param);
    return { t, from: showValue(t, param, base), to: showValue(t, param, modulated(t, param, base, depth)), low: showValue(t, param, modulated(t, param, base, -Math.abs(depth))), high: showValue(t, param, modulated(t, param, base, Math.abs(depth))) };
  };
  const known = (row: unknown, param: unknown) =>
    typeof row === 'number' && typeof param === 'string' && !!target(row) && EFFECTS_REGISTRY[target(row)!].params.some((p) => p.name === param);

  const h = preset.handle;
  if (h && h.target === 'lfo') lines.push(`Squeezing the handle speeds the LFO up by ${fmt(h.depth)} Hz.`);
  else if (h && known(h.row, h.param) && isNum(h.depth)) {
    const s = sweep(h.row as number, h.param, h.depth);
    lines.push(`Squeezing the handle moves row ${h.row} ${s.t} ${h.param} from ${s.from} to ${s.to}.`);
  } else lines.push('Handle: not used (squeezing does nothing).');

  const sh = preset.shake;
  if (sh && known(sh.row, sh.param) && isNum(sh.depth)) {
    const s = sweep(sh.row, sh.param, sh.depth);
    lines.push(`Shaking briefly pushes row ${sh.row} ${s.t} ${sh.param} from ${s.from} to ${s.to}, fading back over ≈0.5 s.`);
  } else lines.push('Shake: not used.');

  const lfo = preset.lfo;
  if (lfo && lfo.target !== 'lfo' && known(lfo.row, lfo.param) && isNum(lfo.depth)) {
    const s = sweep(lfo.row as number, lfo.param, lfo.depth);
    lines.push(`LFO (${lfo.shape}, ${fmt(lfo.speed)} Hz) swings row ${lfo.row} ${s.t} ${lfo.param} between ${s.low} and ${s.high}.`);
  }
  const trig = preset.trigger;
  if (trig && typeof trig.row === 'number') lines.push(`The trigger button fires the sample on row ${trig.row}.`);
  return lines;
}

/** True when the issues include structural problems that prevent normalizing the preset. */
export function hasStructuralErrors(issues: PresetIssue[]): boolean {
  return issues.some((i) => ['preset_not_object', 'missing_list', 'row_not_object', 'missing_effect', 'unknown_effect'].includes(i.code));
}
