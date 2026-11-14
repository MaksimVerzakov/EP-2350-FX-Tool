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
1. **`design_preset_from_description`**
   - Synthesizes a hardware-valid `PresetConfig` from a text prompt, validates it against hardware constraints, and runs offline 48 kHz DSP simulation across `idle`, `handle_pushed`, and `shake_burst`.
2. **`validate_preset`**
   - Validates a single preset or full 4-preset `config.json` pack (checks 16-row hardware limit, single-instance `DELAY`/`REVERB`/`HARMONY`/`SSB`, valid modulation row targets, and `SAMPLE` injector presence).
3. **`simulate_preset`**
   - Renders a preset offline through the 48 kHz DSP engine and returns quantitative acoustic telemetry (`rmsDb`, `peakDb`, `crestFactorDb`, 6-band spectral profile, `spectralCentroidHz`, `spectralRolloff85Hz`, `fundamentalHz`, `estimatedSemitones`, `inharmonicityScore`, `estimatedDelayMs`, `estimatedTailDecaySec`, and `inferredCues`).
4. **`analyze_reference_audio`**
   - Extracts the acoustic fingerprint and inferred effect cues from any target `.wav` file.
5. **`optimize_preset_parameters`**
   - Runs automated multi-scale STFT spectral + temporal envelope optimization to discover and tune EP-2350 knob values to match a reference `.wav` file.
6. **`export_pack_config`**
   - Serializes a 4-preset pack losslessly to hardware `config.json`.
7. **`push_to_live_ui`**
   - Pushes a preset or pack directly to the running Vite Web UI (`http://localhost:3000/__mcp_sync`) via Server-Sent Events so the user immediately sees and hears it in the browser.

> **Scale:** `preset` objects passed to tools use the editor scale (percent knobs `0..100`, percent mod depths `-100..100`). Hardware `config.json` files use `0.0..1.0`; pass those as `configJson` to `validate_preset`. Read `warnings` / `presetWarnings` and fix them before exporting.

## Recommended Agent Workflow

### Workflow A: Text Description -> Verified Preset
1. Call `design_preset_from_description` (or craft a custom `PresetConfig` using `ep2350://schema/effects-registry`).
2. Inspect the `simulation` telemetry (`idle` vs `handle_pushed` vs `shake_burst`):
   - Verify `isSilent` is `false` and `isClipping` is `false`.
   - Confirm spectral and temporal shifts match the prompt (e.g., `handle_pushed` increases `estimatedTailDecaySec` or shifts `spectralCentroidHz`).
3. If refining parameters manually, re-run `simulate_preset` and `validate_preset`.
4. Call `push_to_live_ui` (if the dev server is running) or `export_pack_config` to deliver the final `config.json`.

### Workflow B: Reference WAV -> Matched Effect Chain
1. Call `analyze_reference_audio` on the user's `referenceWavPath` (and optional `dryWavPath`).
2. Review `inferredCues` (e.g. detected echo delay lag in `ms`, pitch shift in semitones, highpass/lowpass roll-offs, or SSB/RING inharmonicity).
3. Call `optimize_preset_parameters` with `referenceWavPath` (optionally passing a `candidatePreset` topology informed by `inferredCues`).
4. Report the `finalDistance.similarityScore` (%), the matched effect chain parameters, and push or export the resulting `config.json`.
