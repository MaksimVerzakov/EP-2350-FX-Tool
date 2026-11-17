# EP-2350 FX Tool

A companion web workbench, DSP engine, hardware validator, and **MCP server for AI assistants** for designing, auditioning, and deploying effect packs on the [Teenage Engineering EP-2350 fx mic](https://teenage.engineering/guides/ep-2350).

- **Web App**: [maksimverzakov.github.io/EP-2350-FX-Tool](https://maksimverzakov.github.io/EP-2350-FX-Tool/) (also served at [ep-2350-fx-tool.xam-vz.workers.dev](https://ep-2350-fx-tool.xam-vz.workers.dev/), where MCP share links open)
- **MCP server**: `https://ep-2350-fx-tool.xam-vz.workers.dev/mcp`

---

## Overview

### 1. FX Tool Workbench
- **Preset & Chain Editor**: Build 4-preset packs across dual effect buses with control over Squeeze Handle, Shake, and LFO modulations.
- **Your Packs**: Keep as many packs as you like in the pack list. **NEW PACK**, imported `config.json` files and packs opened from links are all saved in your browser (`localStorage`), and edits save as you go. The official Teenage Engineering packs stay untouched: edits to them are kept only if you save the pack to the mic or export it, which adds a copy to Your Packs.
- **Instant Sharing**: Open and share individual presets or full packs via `#pack=` / `#preset=` links, with no account. The whole pack is in the link. Opening one adds it to Your Packs (a single preset becomes its own pack, named after the preset). If you already have a pack with that name but different contents, for example a fixed version re-sent by your AI, you choose **REPLACE** or **SAVE AS COPY**.
- **USB-C Hardware Integration**: **IMPORT** and **EXPORT** hardware `config.json` packs, or connect an EP-2350 in the browser over Web Serial for live parameter updates and saving.
- **Themes**: Switch between the **TING** (original EP-2350 green) and **FX** themes in the top-left badge.

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

Share links open the web app on the Worker's address (`ep-2350-fx-tool.xam-vz.workers.dev`), or on `EP2350_UI_URL` when that variable is set. Browsers keep saved data separately for each address, so packs opened there appear in Your Packs on that address, not on the GitHub Pages copy.

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

- **USB-C Live Mode** (Chrome or Edge on desktop): Click **Connect the mic**. The app opens the pack stored on the mic (listed as **ON THE MIC** in the pack list) and follows the mic's preset and sample slots. The block then splits into **SAVE**, which writes the open pack to the mic, and **EJECT**. Your Packs stay available, so you can open one and save it to the mic.
- **Disk Export**: Click **EXPORT**, mount the EP-2350 (`fx-mic disk`) over USB-C, copy `config.json` to the root folder, and eject the disk.
- **One tab at a time**: Only one tab can talk to the mic and save packs. Other tabs of the app are dimmed until you close the active one.
