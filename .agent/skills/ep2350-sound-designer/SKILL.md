---
name: ep2350-sound-designer
description: Design, simulate, acoustically analyze, and optimize Teenage Engineering EP-2350 Ting FX effect chains from text descriptions or reference WAV files using the EP-2350 MCP Server and Headless DSP Engine.
---

# EP-2350 AI Sound Designer Skill

Use this skill whenever the user wants to:
1. **Create an EP-2350 effect chain (`config.json` preset) from a natural-language description** (e.g., *"Make a cyberpunk walkie-talkie voice with dub echo on the handle and SSB frequency scramble on shake"*).
2. **Match a reference audio file (`.wav`)** to find the closest EP-2350 effect chain and parameter settings.
3. **Simulate, analyze, or push presets live** to the open EP-2350 Web App UI.

## Available MCP Server & Tools

The repository includes a Model Context Protocol (MCP) server at `mcp/server.mjs` (`npm install` once, then `npm run mcp`).

### MCP Resources
- `ep2350://schema/effects-registry` — Full specification of all 11 effects (`DELAY`, `DIST`, `EQUALISER`, `HARMONY`, `LOWPASS`, `HIGHPASS`, `SAMPLE`, `REVERB`, `RING`, `SSB`, `BALANCE`), parameter ranges, units, single-instance rules, parallel `BUS: 1 | 2` routing, and modulation depth rules.
- `ep2350://presets/official-packs` — All 12 official Teenage Engineering presets across `BROKEN RADIO`, `DUB`, and `MYSTERIOUS`.

### MCP Tools
1. **`get_effects_reference`**
   - All 11 effects with parameters (editor scale), modulation depth ranges, modulation syntax and hardware rules. Call it before writing a preset.
2. **`validate_preset`**
   - Validates a single preset or full 4-preset `config.json` pack (16-row limit, single-instance `DELAY`/`REVERB`/`HARMONY`/`SSB`, valid modulation rows, known parameter names and ranges, `SAMPLE` presence).
3. **`simulate_preset`**
   - Renders a preset offline per scenario and returns telemetry (`rmsDb`, `peakDb`, 6-band spectrum, `spectralCentroidHz`, `estimatedSemitones`, `inharmonicityScore`, `estimatedDelayMs` (first discrete echo), `estimatedTailDecaySec` (RT60), `inferredCues`).
4. **`analyze_reference_audio`**
   - Acoustic fingerprint and effect cues of a target `.wav` file.
5. **`optimize_preset_parameters`**
   - Discovers and tunes an effect chain to match a reference `.wav`.
6. **`export_pack_config`**
   - Serializes up to 4 presets to hardware `config.json` with a shareable `#pack=` URL.
7. **`push_to_live_ui`**
   - Returns a `#preset=` share link; with the Vite dev server running it also loads the preset into the open Web UI.

## Recommended Agent Workflow

### Workflow A: Text Description -> Verified Preset
1. Call `get_effects_reference` and write the `PresetConfig` yourself (effect chain plus handle/shake/lfo modulation).
2. Call `validate_preset`; fix every error and warning.
3. Call `simulate_preset` and compare the telemetry with the description:
   - `isSilent` / `isClipping` are `false`.
   - Echo time (`estimatedDelayMs`), tail (`estimatedTailDecaySec`), spectrum and pitch change as intended between `idle`, `handle_pushed` and `shake_burst`.
4. Adjust and re-simulate until it matches, then call `export_pack_config` (or `push_to_live_ui` with the dev server running) and give the user the `shareUrl`.

### Workflow B: Reference WAV -> Matched Effect Chain
1. Call `analyze_reference_audio` on the user's `referenceWavPath` (and optional `dryWavPath`).
2. Review `inferredCues` (e.g. detected echo delay lag in `ms`, pitch shift in semitones, highpass/lowpass roll-offs, or SSB/RING inharmonicity).
3. Call `optimize_preset_parameters` with `referenceWavPath` (optionally passing a `candidatePreset` topology informed by `inferredCues`).
4. Report the `finalDistance.similarityScore` (%), the matched effect chain parameters, and push or export the resulting `config.json`.
