import { EFFECTS_REGISTRY, MAX_EFFECTS_PER_PRESET, getModDepthConfig } from '../constants/effectsRegistry';
import type { EffectMeta } from '../types/config';

/**
 * Renders SKILL.md for the EP-2350 sound designer skill. Every effect, parameter, range and
 * modulation depth comes from EFFECTS_REGISTRY, so the skill cannot drift from the editor and
 * the validator. All values are shown in the hardware config.json scale (percent knobs 0.0..1.0),
 * because config.json is what the skill produces.
 */

export const SKILL_NAME = 'ep2350-sound-designer';

export interface SkillDocOptions {
  /** Public web app URL (opens share links, imports config.json). */
  appUrl: string;
  /** Public URL of the hosted skill folder (where SKILL.md and scripts/ are served). */
  skillUrl: string;
  version: string;
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

export function renderSkillMarkdown({ appUrl, skillUrl, version }: SkillDocOptions): string {
  const effects = Object.values(EFFECTS_REGISTRY);
  const single = effects.filter((e) => e.singleInstance).map((e) => e.type);
  const cli = 'scripts/ep2350.mjs';

  return `---
name: ${SKILL_NAME}
description: Design effect presets for the Teenage Engineering EP-2350 fx mic. Use when the user wants a vocal effect, preset or pack for the EP-2350 (robot voice, dub echo, radio, monster, etc.), or wants an existing EP-2350 config.json checked, fixed or explained. Produces a valid config.json and a link that opens it in the EP-2350 FX Tool web app.
---

# EP-2350 sound designer

The EP-2350 fx mic loads one file, \`config.json\`, holding 4 presets. Each preset is a chain of effects plus what the squeeze handle, a shake and an LFO do to it. This skill tells you how to write that file, check it, and hand it to the user.

Skill version ${version}. Web app: ${appUrl}/

## Workflow

1. Write \`config.json\` following the format and effect tables below. If the user asked for one sound, put it in slot 0 and leave the other slots out.
2. Check it. If you can run Node.js (18 or newer):

   \`\`\`bash
   node ${cli} validate config.json
   \`\`\`

   The script is in this skill's folder. If you only have this file, get it from ${skillUrl}/${cli}. It prints every error with the exact field, what is wrong and how to fix it, then a plain-language summary of what each preset does, then a share link. Fix every error and run it again. Read the summary and confirm it matches what the user asked for (filter frequencies, echo time, what the handle and shake change).
3. If you cannot run code, go through the checklist under "Checking by hand" instead.
4. Give the user:
   - the share link from the validator (it opens the pack in the web app, where they can listen to it and send it to the mic), or, without the validator, the \`config.json\` text and a note to load it with **Import** at ${appUrl}/
   - \`config.json\` itself. To put it on the mic: connect the EP-2350 by USB-C, copy \`config.json\` to the root of the "fx-mic disk", eject.

\`node ${cli} validate config.json --out config.json\` also rewrites the file in normalized form (missing slots filled, SAMPLE rows added). Add \`--json\` for machine-readable output.

Do not build a share link by hand; base64 done without code is unreliable.

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
- \`SAMPLE\` marks where the trigger-button sample enters the chain. Every preset needs one (the validator adds it at the end if missing), and \`trigger.row\` must point at it.
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
## Checking by hand

Use this only when you cannot run the validator.

- Every \`effect\` is one of: ${effects.map((e) => e.type).join(', ')}.
- Every parameter name appears in that effect's table, spelled exactly as shown (EQUALISER's are uppercase).
- Every value is inside its range. A value such as 50 for a 0..1 knob is the most common mistake.
- No more than ${MAX_EFFECTS_PER_PRESET} rows; ${single.join(', ')} at most once each.
- There is a \`SAMPLE\` row and \`trigger.row\` is its index.
- \`handle\`, \`shake\` and \`lfo\` rows exist in \`list\`, their \`param\` belongs to the effect on that row, and \`depth\` is inside the modulation depth range.
- At most 4 presets, each with a different \`pos\` from 0 to 3.
- The file is strict JSON: double quotes, no comments, no trailing commas.

Tell the user the file was not machine-checked.

## Examples

\`examples/\` holds the three official Teenage Engineering packs (12 presets). Read one when you want a starting point for a style: \`broken_radio.json\`, \`dub.json\`, \`mysterious.json\`.
`;
}
