import { EFFECTS_REGISTRY, MAX_EFFECTS_PER_PRESET, getModDepthConfig } from '../constants/effectsRegistry';
import type { EffectMeta } from '../types/config';

/**
 * Renders the EP-2350 format guide returned by the MCP get_format_guide tool. Every effect,
 * parameter, range and modulation depth comes from EFFECTS_REGISTRY, so the guide cannot drift
 * from the editor and the validator. All values are shown in the hardware config.json scale
 * (percent knobs 0.0..1.0), because config.json is what the assistant writes.
 */

export interface FormatGuideOptions {
  /** Public web app URL. Kept for callers; the guide itself does not print it. */
  appUrl?: string;
}

const num = (v: number) => String(Math.round(v * 1000) / 1000);

/** Range/default of a parameter in config.json scale. */
function configRange(p: EffectMeta['params'][number]) {
  const k = p.unit === '%' ? 0.01 : 1;
  return { min: num(p.min * k), max: num(p.max * k), def: num(p.defaultVal * k) };
}

function configDepth(effect: string, param: string): string {
  const d = getModDepthConfig(effect, param);
  const k = d.isNormalizedPercent ? 0.01 : 1;
  const unit = d.isNormalizedPercent ? '' : ` ${d.unit}`;
  return `${num(d.min * k)} .. ${num(d.max * k)}${unit}`;
}

function effectSection(meta: EffectMeta): string {
  const head = `### ${meta.type}\n\n${meta.description}${meta.singleInstance ? ' **At most one per preset.**' : ''}\n`;
  if (meta.params.length === 0) return `${head}\nNo parameters.\n`;
  const rows = meta.params.map((p) => {
    const r = configRange(p);
    // 0..1 knobs whose unit describes what they control (cutoff in Hz, EQ gain in dB): the unit
    // does not apply to the stored value, so show what the ends of the range mean instead.
    const normalized = p.unit !== '%' && p.unit !== '' && Math.abs(p.max) <= 1 && Math.abs(p.min) <= 1;
    const unit = p.unit === '%' || normalized ? '' : p.unit ? ` ${p.unit}` : '';
    const ends = normalized && p.displayScale ? ` (${p.displayScale(p.min)} to ${p.displayScale(p.max)})` : '';
    return `| \`${p.name}\` | ${p.label.toLowerCase()} | ${r.min} .. ${r.max}${unit}${ends} | ${r.def} | ${configDepth(meta.type, p.name)} |`;
  });
  return [
    head,
    '| param | meaning | range | default | modulation depth |',
    '| :--- | :--- | :--- | :--- | :--- |',
    ...rows,
    ''
  ].join('\n');
}

export function renderFormatGuide(_opts: FormatGuideOptions = {}): string {
  const effects = Object.values(EFFECTS_REGISTRY);
  const single = effects.filter((e) => e.singleInstance).map((e) => e.type);

  return `# EP-2350 format guide

The EP-2350 fx mic loads one file, \`config.json\`, holding 4 presets. Each preset is a chain of effects plus what the squeeze handle, a shake and an LFO do to it. This guide tells you how to write that file.

## Workflow

1. Write \`config.json\` following the format and effect tables below. If the user asked for one sound, put it in slot 0 and leave the other slots out. For a starting point in a style, call \`get_example_pack\` (broken_radio, dub, mysterious).
2. Call \`validate_pack\` with it. It returns every error with the exact field, what is wrong and how to fix it, then a plain-language summary of what each preset does. Fix every error and call it again until it says VALID. Read the summary and confirm it matches what the user asked for (filter frequencies, echo time, what the handle and shake change).
3. Give the user the share link from \`validate_pack\`. It opens the pack in the web app, where they can listen to it, tweak it and send it to the mic over USB-C.

Do not build a share link by hand; only \`validate_pack\` makes a working one.

## config.json format

\`\`\`json
{
  "name": "DUB PACK",
  "presets": [
    {
      "pos": 0,
      "name": "SPACE ECHO",
      "comment": "classic dub delay. handle increases feedback.",
      "list": [
        { "effect": "DELAY", "time": 0.9, "echo": 0.6, "wet-level": 0.5, "highpass-cutoff": 0.1 },
        { "effect": "REVERB", "time": 0.5, "dry-level": 1.0 },
        { "effect": "SAMPLE" }
      ],
      "handle": { "row": 0, "param": "echo", "depth": 0.69 },
      "shake": { "row": 1, "param": "wet-level", "depth": 0.5 },
      "trigger": { "row": 2 }
    }
  ]
}
\`\`\`

- \`pos\` is the slot, 0..3. Slots you leave out stay empty (sample playback only).
- \`name\` is the preset name; keep it short and uppercase.
- \`list\` is the effect chain. The voice flows through it top to bottom.
- Parameters you leave out take the default from the tables below.
- Knob-style values (levels, mixes, cutoffs, feedback) are fractions from 0.0 to 1.0, not percentages. Times are in seconds, frequencies in Hz, pitch in semitones where the table says so.

## Rules

- At most ${MAX_EFFECTS_PER_PRESET} rows in \`list\`.
- ${single.join(', ')} may each appear at most once per preset.
- \`SAMPLE\` marks where the trigger-button sample enters the chain. Every preset needs one (validate_pack adds it at the end if missing), and \`trigger.row\` must point at it.
- Rows can carry \`"BUS": 1\` or \`"BUS": 2\`. Bus 1 rows and bus 2 rows run in parallel and are summed. Rows without \`BUS\` run in series.
- Cutoff values map to frequency as Hz = 20 × 1000^value: 0.0 = 20 Hz, 0.25 ≈ 110 Hz, 0.5 ≈ 630 Hz, 0.75 ≈ 3.6 kHz, 1.0 = 20 kHz.

## Modulation

Rows are zero-based indexes into \`list\`. \`param\` must be a parameter of the effect on that row. \`depth\` is added to the parameter's value, and the result is clamped to the parameter's range; allowed depths are in the "modulation depth" column.

- \`handle\`: squeeze handle. \`{ "row", "param", "depth" }\` moves the parameter by \`depth\` at full squeeze. Alternatively \`{ "target": "lfo", "param": "speed", "depth" }\` adds \`depth\` Hz to the LFO rate (needs an \`lfo\`).
- \`shake\`: shaking the mic. \`{ "row", "param", "depth" }\` kicks the parameter by \`depth\` for a moment.
- \`lfo\`: continuous. \`{ "row", "param", "depth", "shape", "speed" }\` with shape \`sine\`, \`square\`, \`sawtooth\` or \`random\`, speed in Hz, optional \`phase\` 0..1.
- \`trigger\`: \`{ "row" }\` of the SAMPLE row the trigger button fires.

Each of the four is optional and there is one of each per preset.

## Effects

${effects.map(effectSection).join('\n')}
`;
}
