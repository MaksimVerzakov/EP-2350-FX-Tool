# EP-2350 AI Sound Designer & MCP Connector Guide

The **EP-2350 FX Tool** includes a built-in **Model Context Protocol (MCP) Server** (`mcp/server.mjs`) backed by a deterministic, headless 48 kHz DSP renderer (`src/dsp/offlineRenderer.ts`), an acoustic feature analyzer (`src/dsp/analyzer.ts`), and a coordinate-descent parameter optimizer (`src/dsp/optimizer.ts`).

---

## 1. Quick Start: Connecting to Any MCP Host

Install dependencies once, then run the MCP server with Node 22+. On startup it bundles the TypeScript MCP core with rolldown (about 70 ms), so source edits are picked up on the next start:

```bash
npm install
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
| `get_effects_reference` | Every effect with its parameters (editor scale, min/max, units), the modulation depth range of each parameter, how handle/shake/lfo/trigger modulation is written, and the hardware rules. Call it before writing a preset; pass `effect` for one effect. |
| `validate_preset` | Checks a preset or a `config.json` against the 16-row limit, single-instance rules (`DELAY`, `REVERB`, `HARMONY`, `SSB`), modulation rows, known parameter names/ranges and `SAMPLE` presence. |
| `simulate_preset` | Renders a preset offline at 48 kHz per scenario (`idle`, `handle_pushed`, `shake_burst`, `dynamic_performance`) and reports 6-band spectrum, centroid, rolloff, pitch shift, inharmonicity (`SSB`/`RING`), the first discrete echo (`estimatedDelayMs`) and the RT60-style tail (`estimatedTailDecaySec`), measured on an impulse probe. |
| `analyze_reference_audio` | Extracts an acoustic fingerprint and effect cues from a target `.wav` (blind estimate without the dry recording). |
| `optimize_preset_parameters` | Discovers and tunes an effect chain to minimize multi-resolution STFT + temporal envelope distance against a reference `.wav`. |
| `export_pack_config` | Losslessly serializes up to 4 presets to hardware `config.json` and returns a shareable `#pack=` URL. |
| `push_to_live_ui` | Returns a stateless `#preset=` deep-link URL and, when a local Vite dev server is running, also loads the preset into open tabs (`/__mcp_sync`). Without a dev server the share link is the delivery (not an error). |

The model writes presets itself: there is no keyword-based "design from description" tool. The `design-fx-from-description` prompt walks through get_effects_reference → write → validate → simulate → export.

---

## 3. Hosting Website + `/mcp` on the Same URL (Cloudflare Free Tier)

Running `npm run build` outputs both the static Vite web app (`dist/`) and a self-contained Cloudflare Worker (`dist/_worker.js` + `dist/_routes.json` + `wrangler.jsonc`):

- **`/` (Static Website & `#preset=...` Deep-Links)**: Served as static assets with **unlimited free requests** (`dist/_routes.json` routes only `/mcp` to the Worker).
- **`/mcp` (Streamable HTTP MCP Endpoint)**: Stateless JSON-response transport on the exact same domain: `POST /mcp` for JSON-RPC, `OPTIONS /mcp` for CORS, and `GET /mcp` (without `Accept: text/event-stream`) for a human-readable status page. There is no SSE stream or session, so `GET` with `Accept: text/event-stream` and `DELETE` return `405`. Supported protocol versions: `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`.
- **Multi-User Isolation**: Every preset/pack tool returns a `shareUrl` (`https://<your-domain>/#preset=<base64url>`). Clicking that link loads the preset directly inside that user's own browser tab and WebAudio DSP engine without affecting other users.

### Deploying to Cloudflare (Free Plan — $0)
1. In the Cloudflare dashboard, go to **Workers & Pages** → **Create** → **Connect to Git** and select `EP-2350-FX-Tool`.
2. Set:
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
3. Once deployed, both your website (`https://<your-project>.pages.dev/`) and your MCP endpoint (`https://<your-project>.pages.dev/mcp`) are live on the same URL.

### Connecting an MCP Client to the Hosted URL
```json
{
  "mcpServers": {
    "ep2350-fx-tool": {
      "url": "https://<your-project>.pages.dev/mcp"
    }
  }
}
```
