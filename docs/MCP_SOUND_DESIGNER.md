# EP-2350 AI Sound Designer & MCP Connector Guide

The **EP-2350 FX Tool** includes a built-in **Model Context Protocol (MCP) Server** (`mcp/server.mjs`) with four tools: an effects reference, a validator, `config.json` export, and a link to review the preset in the web app.

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
| `validate_preset` | Checks a preset or a whole `config.json` and explains it. Every problem names the exact field (`path`, e.g. `list[2].cutof`, `handle.row`), says what is wrong (`message`) and how to fix it (`fix`, with the closest valid name or the allowed range). `summary` describes in plain words what the preset will do: filter frequencies, echo timing and fade, pitch, and what the handle, shake and LFO change. |
| `export_pack_config` | Losslessly serializes up to 4 presets to hardware `config.json` and returns a shareable `#pack=` URL. |
| `push_to_live_ui` | Returns a stateless `#preset=` deep-link URL and, when a local Vite dev server is running, also loads the preset into open tabs (`/__mcp_sync`). Without a dev server the share link is the delivery (not an error). |

The model writes presets itself: there is no keyword-based "design from description" tool. The `design-fx-from-description` prompt walks through get_effects_reference → write → validate → export, then the user listens through the shareUrl.

### Tool Schemas & Preset Scale
- Every tool has a `title`, `annotations` (`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`) and an `outputSchema`; successful calls return `structuredContent` alongside the JSON text block.
- `validate_preset` publishes a full typed `preset` schema generated from `EFFECTS_REGISTRY` (effect names, every parameter with min/max, modulation rows 0..15, LFO shapes). Other tools reference the same shape to keep `tools/list` small.
- **Either preset scale is accepted.** The editor (UI) scale uses percent knobs `0..100` and percent modulation depths `-100..100`; hardware `config.json`, the official packs and every `hardwarePresetJson` / `normalizedPresetJson` output use `0.0..1.0`. A preset in `config.json` scale is detected (all non-zero percent values within ±1) and converted with the same parser as imported files; `validate_preset` reports `inputScale`. Tool outputs can be passed straight back in.
- `validate_preset` returns `errors` (the preset is invalid until they are fixed) and `warnings` (valid, but probably not intended). Each issue is `{ type, code, path, message, fix }`. Codes include `unknown_effect`, `unknown_param`, `param_not_number`, `out_of_range`, `duplicate_effect`, `too_many_rows`, `bad_bus`, `bad_row`, `bad_param`, `depth_out_of_range`, `bad_shape`, `bad_speed`, `trigger_not_sample` and `invalid_json` (with line/column); warnings include `missing_sample`, `silent_row`, `filter_extreme`, `zero_depth`, `runaway_feedback` and `firmware_support`.
- A preset that cannot be read at all (not an object, no `list`, a row that is not an object, an unknown effect) returns `isValid: false` with those errors and no share link; it never crashes the tool. `export_pack_config` and `push_to_live_ui` refuse such presets with the same errors.
- On HTTP transports, file-path arguments are not advertised at all and annotations reflect what a call can do there (for example, `export_pack_config` is read-only on HTTP).

### Transport Security
| Transport | Writing files (`outputPath`) | Browser origins | Live push (`push_to_live_ui`) |
| :--- | :--- | :--- | :--- |
| stdio (`npm run mcp`) | Allowed (trusted local process) | n/a | `EP2350_UI_URL` or any loopback `uiUrl` |
| Vite dev server `/mcp` | **Rejected**: use the returned `configJson` | Loopback only (`localhost`, `127.0.0.1`, `[::1]`) | Loopback `uiUrl` only |
| Cloudflare Worker `/mcp` | **Rejected**: use the returned `configJson` | Any (`*`) — no files, no outbound requests | Always returns `shareUrl` (never fetches) |

All HTTP `POST /mcp` requests must use `Content-Type: application/json` (cross-site `text/plain` requests get `415`) and are capped at 8 MiB (4 MiB on the Worker).

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
