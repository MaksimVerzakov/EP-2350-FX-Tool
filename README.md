# EP-2350 FX Tool

A companion web workbench, DSP engine, hardware validator, and **MCP server** for designing, auditioning, and deploying effect packs on the [Teenage Engineering EP-2350 fx mic](https://teenage.engineering/guides/ep-2350).

- **Web App**: [ep-2350-fx-tool.xam-vz.workers.dev](https://ep-2350-fx-tool.xam-vz.workers.dev/) · [GitHub Pages](https://maksimverzakov.github.io/EP-2350-FX-Tool/)
- **Public MCP Endpoint**: `https://ep-2350-fx-tool.xam-vz.workers.dev/mcp`

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

### 4. MCP Server (AI Sound Design)
- Four tools over the **Model Context Protocol (MCP)**, hosted publicly over Streamable HTTP at `/mcp` or runnable locally over `stdio`: an effects reference (format, parameters, rules), a validator, `config.json` export, and a link to review the preset in the web app.
- AI assistants write the preset themselves, validate it, and return a clickable URL that loads it directly in your browser to listen.
- Full tool, resource, and Cloudflare deployment details: [`docs/MCP_SOUND_DESIGNER.md`](docs/MCP_SOUND_DESIGNER.md).

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

## Using the MCP Server

### Hosted (Zero Setup)
Add the public endpoint to your MCP client configuration (Antigravity, Claude Desktop, Cursor, etc.):

```json
{
  "mcpServers": {
    "ep2350-fx-tool": {
      "url": "https://ep-2350-fx-tool.xam-vz.workers.dev/mcp"
    }
  }
}
```

### Local Development
```bash
npm install
npm run dev      # Web app + local /mcp at http://localhost:3000
npm run mcp      # Local stdio MCP server
npm test         # Run automated test suites
npm run skill    # Build the AI sound designer skill into dist/skill/
npm run build    # Build static app, Cloudflare Worker bundle and skill
```

---

## Loading Config onto Hardware

- **USB-C Live Mode**: Click **Connect** in the web app to sync and tweak presets directly on a connected EP-2350 over Web Serial.
- **Disk Export**: Click **Export `config.json`**, mount the EP-2350 (`fx-mic disk`) over USB-C, copy `config.json` to the root folder, and eject the disk.
