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
| `export_pack_config` | Losslessly serializes a 4-preset pack to hardware `config.json` and returns a shareable `#pack=` URL. |
| `push_to_live_ui` | Returns a stateless `#preset=` deep-link URL and pushes live over HTTP (`/__mcp_sync`) when connected to a local Vite Web UI. |

### Tool Schemas & Preset Scale
- Every tool has a `title`, `annotations` (`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`) and an `outputSchema`; successful calls return `structuredContent` alongside the JSON text block.
- `validate_preset` and `simulate_preset` publish a full typed `preset` schema generated from `EFFECTS_REGISTRY` (effect names, every parameter with min/max, modulation rows 0..15, LFO shapes). Other tools reference the same shape to keep `tools/list` small.
- **`preset` objects use the editor (UI) scale**: percent knobs `0..100`, percent modulation depths `-100..100`. Hardware `config.json` uses `0.0..1.0`; pass such files as `configJson`, or multiply by 100.
- `validate_preset` and `simulate_preset` warn about unknown parameter names, out-of-range values, modulation targets that don't exist on the row's effect, and presets that look like they use the 0..1 hardware scale.
- On HTTP transports, file-path arguments are not advertised at all and annotations reflect what a call can do there (for example, `export_pack_config` is read-only on HTTP).

### Transport Security
| Transport | Local file paths (`*WavPath`, `outputPath`) | Browser origins | Live push (`push_to_live_ui`) |
| :--- | :--- | :--- | :--- |
| stdio (`npm run mcp`) | Allowed (trusted local process) | n/a | `EP2350_UI_URL` or any loopback `uiUrl` |
| Vite dev server `/mcp` | **Rejected** — use `*Base64` inputs | Loopback only (`localhost`, `127.0.0.1`, `[::1]`) | Loopback `uiUrl` only |
| Cloudflare Worker `/mcp` | **Rejected** — use `*Base64` inputs | Any (`*`) — no files, no outbound requests | Always returns `shareUrl` (never fetches) |

All HTTP `POST /mcp` requests must use `Content-Type: application/json` (cross-site `text/plain` requests get `415`) and are capped at 8 MiB (4 MiB on the Worker). `optimize_preset_parameters.maxIterations` is clamped to 200 locally and 24 on the edge.

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
