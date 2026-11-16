# EP-2350 FX Tool

A companion web workbench, DSP engine, hardware validator, and **AI sound designer skill** for designing, auditioning, and deploying effect packs on the [Teenage Engineering EP-2350 fx mic](https://teenage.engineering/guides/ep-2350).

- **Web App**: [maksimverzakov.github.io/EP-2350-FX-Tool](https://maksimverzakov.github.io/EP-2350-FX-Tool/)
- **AI Skill**: [`ep2350-sound-designer.zip`](https://maksimverzakov.github.io/EP-2350-FX-Tool/skill/ep2350-sound-designer.zip)

---

## Overview

### 1. FX Tool Workbench
- **Preset & Chain Editor**: Build 4-preset packs across dual effect buses with control over Squeeze Handle, Shake, and LFO modulations.
- **Instant Sharing**: Open and share individual presets or full packs via stateless `#preset=` / `#pack=` links with zero account setup.
- **USB-C Hardware Integration**: Import and export hardware `config.json` packs, or connect an EP-2350 directly in the browser over Web Serial for live parameter updates and saving.

### 2. DSP Audio Engine
- **Live Browser Auditioning**: Real-time audio engine modeled on the EP-2350 effects, interactive mic controls (slot switcher, handle lever, shake trigger), built-in sample/speech sources, and custom `.wav` loading.

### 3. Hardware Validator
- Validates preset chains, effect counts, single-instance hardware constraints, modulation targets, and sample routing before exporting `config.json` or sending presets to a device.

### 4. AI Sound Designer Skill
- A folder of instructions any AI assistant can load to write presets from a description, check them, and return a link that loads them in your browser. Details below.

---

## AI Sound Designer Skill

A skill is a folder of instructions any AI assistant can load: `SKILL.md` (how to write a preset, with every effect and parameter range), a dependency-free validator script, and the official packs as examples. Nothing to host or connect; the assistant writes `config.json`, checks it, and returns a link that opens it in the web app.

- **Download**: [`ep2350-sound-designer.zip`](https://maksimverzakov.github.io/EP-2350-FX-Tool/skill/ep2350-sound-designer.zip)
- **Read online**: [`SKILL.md`](https://maksimverzakov.github.io/EP-2350-FX-Tool/skill/ep2350-sound-designer/SKILL.md)

### Installing
- **Claude Code**: unzip into `~/.claude/skills/` (or a project's `.claude/skills/`), so that `~/.claude/skills/ep2350-sound-designer/SKILL.md` exists.
- **Claude apps**: upload the zip as a custom skill in settings.
- **Any other assistant**: attach `SKILL.md` or give it the "Read online" link and ask for a preset. Assistants that can run Node.js 18+ use the validator; the rest follow the checklist in `SKILL.md` and return `config.json` for the web app's **Import**.

### Validator
```bash
node ep2350-sound-designer/scripts/ep2350.mjs validate config.json
```
Prints each error with the exact field and a fix, a plain-language summary of every preset, and a share link. Exit code is `0` when valid, `1` when not. `--out <file>` writes the normalized `config.json`; `--json` prints machine-readable output.

The skill is generated from the same effect registry and validation code as the web app (`npm run skill` builds it into `dist/skill/`; `npm run build` publishes it with the site).

---

## Local Development
```bash
npm install
npm run dev      # Web app at http://localhost:3000
npm test         # Run automated test suites
npm run skill    # Build the AI sound designer skill into dist/skill/
npm run build    # Build the static app and the skill into dist/
```

---

## Loading Config onto Hardware

- **USB-C Live Mode**: Click **Connect** in the web app to sync and tweak presets directly on a connected EP-2350 over Web Serial.
- **Disk Export**: Click **Export `config.json`**, mount the EP-2350 (`fx-mic disk`) over USB-C, copy `config.json` to the root folder, and eject the disk.
