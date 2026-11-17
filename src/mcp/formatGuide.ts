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

export const TE_GUIDE_URL = 'https://teenage.engineering/guides/ep-2350';

export function renderFormatGuide(_opts: FormatGuideOptions = {}): string {
  const effects = Object.values(EFFECTS_REGISTRY);
  const single = effects.filter((e) => e.singleInstance).map((e) => e.type);

  return `# EP-2350 format guide

The EP-2350 fx mic loads one file, \`config.json\`, holding 4 presets. Each preset is a chain of effects plus what the squeeze handle, a shake and an LFO do to it. This guide tells you how to write that file.

It follows Teenage Engineering's official EP-2350 guide (${TE_GUIDE_URL}) and adds the rules and value meanings that guide leaves out. \`validate_pack\` checks all of them, so you do not need any other source.

## Workflow

1. Write \`config.json\` following the rules, examples and effect tables below. If the user asked for one sound, put it in slot 0 and leave the other slots out. For a starting point in a style, call \`get_example_pack\` (broken_radio, dub, mysterious).
2. Call \`validate_pack\` with it. It returns every error with the exact field, what is wrong and how to fix it, then a plain-language summary of what each preset does. Fix every error and call it again until it says VALID. Read the summary and confirm it matches what the user asked for (filter frequencies, echo time, what the handle and shake change).
3. Give the user the share link from \`validate_pack\`. It opens the pack in the web app, where they can listen to it, tweak it and send it to the mic over USB-C.

Do not build a share link by hand; only \`validate_pack\` makes a working one.

## Rules

Check every preset against this list before calling \`validate_pack\`.

1. **Strict JSON.** Double quotes around every key and string, a comma between items and none after the last, no comments. A syntax error stops the mic from starting.
2. **Names exactly as written in this guide; they are case-sensitive.** Effect names are uppercase: \`DELAY\`, \`REVERB\`, \`EQUALISER\` (spelled with an S). Parameter names are lowercase with hyphens (\`wet-level\`, \`lowpass-cutoff\`), except EQUALISER's, which are uppercase: \`CUTOFF\`, \`Q\`, \`GAIN\`.
3. **Every preset has one \`{ "effect": "SAMPLE" }\` row.** It is where the trigger-button sample enters the chain. Effects above it process the voice only; effects below it process the voice and the sample. Put it last unless the sample should go through effects.
4. **\`trigger.row\` is the SAMPLE row's index.** Otherwise the trigger button plays nothing.
5. **SAMPLE never goes on BUS 2.** Leave \`BUS\` off the SAMPLE row, or set it to 1.
6. **${single.join(', ')} at most once per preset.** The other effects can repeat.
7. **At most ${MAX_EFFECTS_PER_PRESET} rows in \`list\`**, SAMPLE included.
8. **Rows are counted from 0.** \`handle\`, \`shake\`, \`lfo\` and \`trigger\` point at rows by their zero-based index in \`list\`.
9. **Knob values are fractions from 0 to 1, not percentages.** \`0.5\`, not \`50\`. Check each parameter's range in the tables; some use seconds, Hz, semitones or a ratio.
10. **At most 4 presets, each with its own \`pos\` 0..3.**
11. **Leave out the \`samples\` block.** It names WAV files on the mic's disk, and they cannot travel with the pack, so the mic uses its built-in sounds.

## Examples

\`\`\`json
{
  "name": "EXAMPLE PACK",
  "presets": [
    {
      "pos": 0,
      "name": "BAD RECEPTION",
      "comment": "broken radio. handle opens the filter, shake adds grit.",
      "list": [
        { "effect": "DIST", "amount": 10.0, "mix": 0.5 },
        { "effect": "LOWPASS", "cutoff": 0.2 },
        { "effect": "SAMPLE" }
      ],
      "handle": { "row": 1, "param": "cutoff", "depth": 0.8 },
      "shake": { "row": 0, "param": "mix", "depth": 0.5 },
      "trigger": { "row": 2 }
    },
    {
      "pos": 1,
      "name": "SPACE ECHO",
      "comment": "dub delay into a spring. handle raises the feedback.",
      "list": [
        { "effect": "DELAY", "time": 0.45, "echo": 0.6, "wet-level": 0.5, "highpass-cutoff": 0.3 },
        { "effect": "REVERB", "time": 0.5, "spring-mix": 0.7, "wet-level": 0.4 },
        { "effect": "SAMPLE" }
      ],
      "handle": { "row": 0, "param": "echo", "depth": 0.3 },
      "shake": { "row": 1, "param": "wet-level", "depth": 0.5 },
      "trigger": { "row": 2 }
    },
    {
      "pos": 2,
      "name": "PRESENCE",
      "comment": "telephone band with an EQ boost that breathes.",
      "list": [
        { "effect": "HIGHPASS", "cutoff": 0.4 },
        { "effect": "EQUALISER", "CUTOFF": 0.62, "Q": 0.6, "GAIN": 0.5 },
        { "effect": "LOWPASS", "cutoff": 0.72 },
        { "effect": "SAMPLE" }
      ],
      "handle": { "row": 1, "param": "CUTOFF", "depth": 0.15 },
      "lfo": { "row": 1, "param": "GAIN", "depth": 0.3, "shape": "sine", "speed": 0.5 },
      "trigger": { "row": 3 }
    },
    {
      "pos": 3,
      "name": "DUAL MONO",
      "comment": "dry voice on the right output, effects on the left. handle adds more effect.",
      "list": [
        { "effect": "BALANCE", "balance": 1.0, "BUS": 2 },
        { "effect": "SAMPLE", "BUS": 1 },
        { "effect": "DELAY", "time": 0.35, "echo": 0.4, "BUS": 1 },
        { "effect": "REVERB", "time": 0.6, "wet-level": 0.5, "BUS": 1 },
        { "effect": "BALANCE", "balance": 0.0, "BUS": 1 },
        { "effect": "BALANCE", "balance": 0.8 }
      ],
      "handle": { "row": 5, "param": "balance", "depth": -0.2 },
      "trigger": { "row": 1 }
    }
  ]
}
\`\`\`

- \`pos\` is the slot, 0..3. Slots you leave out stay empty (sample playback only).
- \`name\` is the preset name; keep it short and uppercase. \`comment\` is an optional note.
- \`list\` is the effect chain. The voice flows through it top to bottom.
- Parameters you leave out take the default from the tables below.

## Values

- Cutoffs (\`cutoff\`, \`lowpass-cutoff\`, \`highpass-cutoff\`, EQUALISER \`CUTOFF\`) map 0..1 to frequency as Hz = 20 × 1000^value: 0.0 = 20 Hz, 0.25 ≈ 110 Hz, 0.4 ≈ 320 Hz, 0.5 ≈ 630 Hz, 0.6 ≈ 1.3 kHz, 0.7 ≈ 2.5 kHz, 0.75 ≈ 3.6 kHz, 1.0 = 20 kHz.
- REVERB \`time\` 0..1 is 0 to 6 seconds of decay. DELAY \`time\` is in seconds, up to 1.1.
- EQUALISER \`GAIN\` -1..1 is -15 dB to +15 dB. \`Q\` 0..1 goes from wide to narrow.
- HARMONY \`pitch\` is a ratio, not semitones: 2 = octave up, 1.5 = fifth up, 1.26 = major third up, 0.75 = fourth down, 0.67 = fifth down, 0.5 = octave down.
- SAMPLE \`pitch\` is in semitones (-24..24) and \`speed\` is a playback rate (1 = normal).
- BALANCE and \`balance\`: 0 = left, 0.5 = centre, 1 = right.

## Buses

Rows without \`BUS\` run in series. Rows with \`"BUS": 1\` and rows with \`"BUS": 2\` form two parallel chains that each get the input and are summed at the end. A row without \`BUS\` placed after the bus rows processes that sum, as the last BALANCE in DUAL MONO does.

- Keep bus layouts simple: bus rows first, then optional rows without \`BUS\` for the mix. Buses are the least predictable part of the format.
- Two buses summed are louder than one. Lower the wet levels, and use small depths on anything that changes the mix.
- Dual mono (DUAL MONO above): a BALANCE fully right on BUS 2 sends a dry copy to the right output, BUS 1 holds the effects and ends with a BALANCE fully left, and a final BALANCE sets the dry and wet mix.

## Modulation

\`param\` must be a parameter of the effect on that row. \`depth\` is added to the parameter's value, and the result is clamped to the parameter's range; allowed depths are in the "modulation depth" column. A positive depth raises the value, a negative depth lowers it.

- \`handle\`: squeeze handle. \`{ "row", "param", "depth" }\` moves the parameter by \`depth\` at full squeeze. Alternatively \`{ "target": "lfo", "param": "speed", "depth" }\` adds \`depth\` Hz to the LFO rate (needs an \`lfo\`).
- \`shake\`: shaking the mic. \`{ "row", "param", "depth" }\` kicks the parameter by \`depth\`, then it fades back over about half a second.
- \`lfo\`: continuous. \`{ "row", "param", "depth", "shape", "speed" }\` with shape \`sine\`, \`square\`, \`sawtooth\` or \`random\`, speed in Hz (above 0; 0.2 to 8 is the useful range), optional \`phase\` 0..1.
- \`trigger\`: \`{ "row" }\` of the SAMPLE row the trigger button fires.

Each of the four is optional, with at most one of each per preset. \`trigger\` is optional only in form: without it the trigger button plays nothing.

## Sound design

Starting points; adjust by ear in the web app.

- **Keep the voice understandable.** Leave DELAY and REVERB \`dry-level\` at 1 unless the voice should drown. Use wet levels of 0.3 to 0.5.
- **Telephone or radio:** HIGHPASS 0.4 to 0.5 plus LOWPASS 0.65 to 0.72, optionally a little DIST.
- **Muffled, behind a wall:** LOWPASS 0.35 to 0.45.
- **DIST:** \`amount\` 3 to 10 adds grit; 20 and above is heavy and much louder, so lower \`mix\` or follow it with a LOWPASS.
- **DELAY:** \`time\` 0.08 to 0.15 for slapback, 0.3 to 0.6 for echoes. \`echo\` 0.3 to 0.6; above about 0.85 the repeats build up instead of fading.
- **REVERB:** \`time\` 0.2 to 0.3 for a room, 0.6 and up for a hall. \`spring-mix\` 0.5 and up for a dub spring.
- **HARMONY:** \`dry-level\` 1 for a harmony with the voice, 0 for the shifted voice alone (chipmunk at 2, monster at 0.5).
- **RING:** \`frequency\` 30 to 80 Hz for a robot growl, 200 to 1000 Hz for metallic, with \`mix\` 0.3 to 0.7.
- **SSB:** \`frequency\` 5 to 30 Hz for a subtle detuned shimmer, 100 Hz and up for alien, inharmonic voices.
- **EQUALISER:** \`GAIN\` 0.3 to 0.6 for a clear boost; \`CUTOFF\` 0.6 to 0.65 (1.3 to 1.8 kHz) adds presence.
- **Handle and shake:** good handle targets are a filter cutoff, a wet level, DELAY \`echo\` and HARMONY \`pitch\`. Shake suits short bursts: DELAY \`echo\`, a wet level, DIST \`amount\`.

## Effects

${effects.map(effectSection).join('\n')}
`;
}
