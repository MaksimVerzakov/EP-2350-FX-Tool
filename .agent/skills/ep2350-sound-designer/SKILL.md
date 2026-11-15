---
name: ep2350-sound-designer
description: Design, validate and export Teenage Engineering EP-2350 fx mic effect presets (config.json) from text descriptions using the EP-2350 MCP server.
---

# EP-2350 AI Sound Designer Skill

Use this skill whenever the user wants to:
1. **Create an EP-2350 effect chain (`config.json` preset) from a natural-language description** (e.g., *"Make a cyberpunk walkie-talkie voice with dub echo on the handle and SSB frequency scramble on shake"*).
2. **Validate or fix an existing `config.json`.**
3. **Export a pack or open a preset in the EP-2350 Web App** so the user can listen to it.

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
3. **`export_pack_config`**
   - Serializes up to 4 presets to hardware `config.json` with a shareable `#pack=` URL.
4. **`push_to_live_ui`**
   - Returns a `#preset=` share link; with the Vite dev server running it also loads the preset into the open Web UI.

> **Scale:** tools accept presets in the editor scale (percent knobs `0..100`, percent mod depths `-100..100`) or in hardware `config.json` scale (`0.0..1.0`, as in the official packs and `hardwarePresetJson`); the latter is detected and converted, and `inputScale` says which was used. Read `errors` / `warnings` and fix them before exporting.

## Recommended Agent Workflow

### Workflow: Text Description -> Preset
1. Call `get_effects_reference` and write the `PresetConfig` yourself (effect chain plus handle/shake/lfo modulation).
2. Call `validate_preset`. Fix every error: each one gives the exact `path`, what is wrong and a `fix`. Check warnings too, and read `summary` to confirm the preset does what the user asked (filter frequencies, echo timing, what the handle and shake change). Validate again until there are no errors.
3. Call `export_pack_config` (or `push_to_live_ui` with the dev server running) and give the user the `shareUrl` so they can listen in the web app.
