# EP-2350 FX Tool

A companion web workbench, DSP engine, hardware validator, and **MCP server for AI assistants** for designing, auditioning, and deploying effect packs on the [Teenage Engineering EP-2350 fx mic](https://teenage.engineering/guides/ep-2350).

- **Web App**: [maksimverzakov.github.io/EP-2350-FX-Tool](https://maksimverzakov.github.io/EP-2350-FX-Tool/)
- **MCP server**: `https://ep-2350-fx-tool.xam-vz.workers.dev/mcp`

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

### 4. MCP Server for AI Assistants
- Connect your AI once, describe the sound you want, and get a link that opens the pack in the web app. Details below.

---

## Connect Your AI (MCP)

Add this link to your AI app as a connector (remote MCP server):

```
https://ep-2350-fx-tool.xam-vz.workers.dev/mcp
```

- **Claude**: Settings › Connectors › Add custom connector.
- **ChatGPT**: Settings › Apps & Connectors › Developer mode › Create.
- **Agents** (Claude Code, Cursor, Gemini CLI and others): add it as a remote MCP server over HTTP, e.g. `claude mcp add --transport http ep2350 https://ep-2350-fx-tool.xam-vz.workers.dev/mcp`.

Then ask for a sound ("a broken radio voice that gets clearer when I squeeze the handle"). The server gives the assistant three tools:

| Tool | What it does |
| :--- | :--- |
| `get_format_guide` | The `config.json` format and every effect's parameters, ranges and modulation depths. |
| `validate_pack` | Checks a pack or preset: every error with the exact field and a fix, a plain-language summary, and a share link that opens it in the web app. |
| `get_example_pack` | The three official Teenage Engineering packs as starting points. |

The server is stateless, needs no account and runs on a Cloudflare Worker next to the web app (`src/mcp/`). It uses the same effect registry and validation code as the editor.

---

## Local Development
```bash
npm install
npm run dev      # Web app at http://localhost:3000, MCP at http://localhost:3000/mcp
npm test         # Run automated test suites
npm run build    # Build the static app and the Cloudflare Worker into dist/
```

---

## Loading Config onto Hardware

- **USB-C Live Mode**: Click **Connect** in the web app to sync and tweak presets directly on a connected EP-2350 over Web Serial.
- **Disk Export**: Click **Export `config.json`**, mount the EP-2350 (`fx-mic disk`) over USB-C, copy `config.json` to the root folder, and eject the disk.
