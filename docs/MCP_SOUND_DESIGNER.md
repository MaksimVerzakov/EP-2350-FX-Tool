# EP-2350 AI Sound Designer & MCP Connector Guide

The **EP-2350 FX Tool** includes a built-in **Model Context Protocol (MCP) Server** (`mcp/server.mjs`) backed by a deterministic, headless 48 kHz DSP renderer (`src/dsp/offlineRenderer.ts`), an acoustic feature analyzer (`src/dsp/analyzer.ts`), and a coordinate-descent parameter optimizer (`src/dsp/optimizer.ts`).

---

## 1. Quick Start: Connecting to Any MCP Host

Run the MCP server directly with Node 22+:

```bash
npm run mcp
# or
node mcp/server.mjs
```

### MCP Client Configuration (`mcp_config.json` / Claude Desktop / Cursor / Antigravity)

```json
{
  "mcpServers": {
    "ep2350-fx-tool": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/EP2350-FX-Tool/mcp/server.mjs"]
    }
  }
}
```

---

## 2. Capabilities Overview

### Resources
| URI | Description |
| :--- | :--- |
| `ep2350://schema/effects-registry` | Hardware constraints, all 11 effects, parameter ranges, units, and modulation depth scaling rules. |
| `ep2350://presets/official-packs` | All 12 official Teenage Engineering presets (`BROKEN RADIO`, `DUB`, `MYSTERIOUS`). |

### Tools
| Tool Name | Purpose |
| :--- | :--- |
| `design_preset_from_description` | Generates a hardware-validated EP-2350 preset from a text description and simulates its acoustic response across `idle`, `handle_pushed`, and `shake_burst`. |
| `validate_preset` | Checks any preset or `config.json` against the 16-effect limit, single-instance rules (`DELAY`, `REVERB`, `HARMONY`, `SSB`), modulation row bounds, and `SAMPLE` presence. |
| `simulate_preset` | Renders a preset offline at 48 kHz and computes 6-band spectral energy, centroid, rolloff, pitch shift ($f_0$), inharmonicity (`SSB`/`RING`), echo lag (`ms`), and tail decay (`s`). |
| `analyze_reference_audio` | Extracts an acoustic fingerprint and diagnostic effect cues from a target `.wav` file. |
| `optimize_preset_parameters` | Automatically discovers and tunes effect parameters to minimize Multi-Resolution STFT + Temporal Envelope distance against a reference `.wav`. |
| `export_pack_config` | Losslessly serializes a 4-preset pack to hardware `config.json`. |
| `push_to_live_ui` | Pushes a preset or pack over HTTP (`/__mcp_sync`) to the open Vite Web UI via Server-Sent Events. |
