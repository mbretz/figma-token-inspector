# Figma Token Inspector (Plugin + MCP bridge)

Gives a coding agent the *directly bound* Figma variables (with alias chains) for a selection, on a non-Enterprise plan.

## How it works
Two pieces talk over a local WebSocket:

```
Claude Code ──stdio──▶ MCP server (node) ◀──ws://localhost:3055── plugin UI ──▶ Figma plugin code
```

- The **MCP server** (`server/dist/index.js`) is started by your MCP client (e.g. Claude Code) as a stdio server. It also opens a WebSocket server on `127.0.0.1:3055`.
- The **Figma plugin** runs inside Figma desktop. Its UI panel connects to that WebSocket, receives requests, reads the file through the Plugin API, and sends the results back.
- So a tool call only works when **both** are up: the MCP client has started the server, and the plugin panel is open in the file you want to read.

## Requirements
- Node 18 or later
- Figma **desktop** app (importing a development plugin from a manifest is not available in the browser)
- An MCP client that supports stdio servers (written and tested with Claude Code)

## Setup
1. `npm install && npm run build` (builds both `plugin/dist` and `server/dist`)
2. Figma desktop → Plugins → Development → Import plugin from manifest → `plugin/manifest.json`
3. Open the design file you want to read and run **Plugins → Development → Token Inspector (MCP bridge)**. Keep the panel open; it shows a green dot when connected and "Disconnected – retrying…" (retries every 2s) otherwise.
4. Register the server with your MCP client, in **one** consuming project only (see gotcha 1):
   - Copy `.mcp.json.example` into that project's `.mcp.json`, replacing `<path-to-this-repo>` with the absolute path to your clone, or
   - run `claude mcp add figma-tokens -- node /absolute/path/to/this/repo/server/dist/index.js`
5. Start (or restart) Claude Code in that project and approve the `figma-tokens` server when prompted. Ask for tokens, e.g. "get the tokens for node 12:34".

To check the connection, run `lsof -iTCP:3055 -P -n`. You want exactly one `node` process listening and one `Figma` connection to it.

### Gotchas
1. **Enable the server in one project at a time.** Every Claude Code window that loads the server starts its own copy, and only one process can bind port 3055. The second copy does not crash. It logs a WebSocket error to stderr and keeps running, but Figma is connected to the first, so its tools fail with "The Figma plugin is not connected". The server never retries the bind. If you see that error while the panel shows a green dot, you are talking to the wrong server process: close other windows, `kill` stray `server/dist/index.js` processes, restart Claude Code, then re-run the plugin.
2. **After rebuilding, reload both ends.** The server is a separate long-running process, so restart your MCP client (or the server process) to pick up `server/dist`. Figma caches the plugin's `code.js`: close the panel and re-run the plugin, and if it still behaves like the old version, re-import the manifest.
3. **The plugin only reads the file it is running in.** Open the panel in the file you care about. If you run it in two files, the most recent connection wins.
4. **Keep the panel open.** Closing it disconnects the bridge. Requests time out after 15 seconds if Figma does not answer (for example when the file has closed).
5. **`get_selection_tokens` needs a selection** in Figma. `get_node_tokens` takes node IDs from a Figma URL's `node-id` parameter (`12-34` and `12:34` both work).
6. **Library variables.** Bindings to remote (library) variables are resolved by importing them by key, which needs the library to be published and enabled for the file. If one cannot be resolved the binding shows `unresolvedAliasId` instead of a token. `list_variables` lists local collections in full but library collections by name only; the Plugin API exposes no values for them.
7. **Large selections produce large output.** Use `depth` to limit how far below each root it walks, and leave `includeIcons`/`includeVectors` off unless you need them.
8. **Security.** The WebSocket binds to loopback only (`127.0.0.1`) but is not authenticated, so any local process can connect to it as a plugin. Do not expose the port.
9. **Development plugin only.** The manifest allows `ws://localhost:3055` through `devAllowedDomains`, which applies to plugins imported from a manifest, not published ones.

### Changing the port
Set `FIGMA_TOKENS_PORT` for the server, and update the same port in `devAllowedDomains` in `plugin/manifest.json` and in the `URL` constant in `plugin/src/ui.html`, then rebuild and re-import.

## Tools
- `get_selection_tokens` – tokens bound to the current selection and descendants
- `get_node_tokens` – same, by node ID
- `get_variant_diff` – for a component set (or any node inside one): component `properties` (type, default, options), a `tokens` dictionary (chains + mode resolutions), `missingCombinations`, and for each non-default variant only what differs from the default, grouped by layer path. `variantFilter` is a plain substring match on the variant name (use `disabled=true`, not `disabled`). `includeBase` also returns the default variant's node details
- `list_variables` – local variables; library collections by name only

### Output shape (`get_selection_tokens` / `get_node_tokens`)
- `tokens` – each distinct token once: alias chain (names + collections, down to the primitive), resolved value, and, when a collection along the chain has several modes, `activeModes` and `modeResolutions` (final value in every mode)
- `nodes[].bindings` – `{ properties, token }`; properties sharing a token are grouped (`cornerRadius`, `strokeWeight`, `padding`, `paddingInline`, `paddingBlock`) and `token` is a key into `tokens`
- `nodes[].layout` / `component` / `text` / `effects` – auto-layout and sizing, main component and variant, text characters and styling, effect types
- `unboundValues` (with `includeUnbound`) – hard-coded literals only; never lists an aggregate whose per-side values are bound
- Vector and boolean-operation children are skipped unless they carry a binding; pass `includeVectors` to include them
- `layout.strokeAlign` – INSIDE/CENTER/OUTSIDE, only when a stroke is painted
- `includeIcons` – exports each icon instance (small, vector-only) as SVG markup in `svg`; the exported fills are literal colors, so use `bindings` for the token

## Agent rule (add to the consuming project's CLAUDE.md)
Use `get_selection_tokens` for design tokens. Use the directly bound token, never a primitive with the same value.

## Per-node fields
`index` (child order), `hidden` (only when true), `propertyRefs` (component property bound to visible/characters/swap), `opacity`, `reactions` (triggers, actions, transitions; `transition: null` means instant), `annotations` (Dev Mode), `layout.size` (rendered size), grow/align/min/max sizes, `text` (case, decoration, truncation, letter spacing always reported), and `effects` (`[]` = read and none). Output is compact JSON; paths are relative to each root (`(root)`, `ButtonLabel / Button Label`).

Default-valued layout fields (`layoutGrow` 0, `layoutAlign` INHERIT, unset min/max sizes) are omitted. In `get_variant_diff`, reactions are listed per variant (`reactions: ["ON_HOVER -> CHANGE_TO <id> (instant)"]`) and are not treated as a change.

Mode data (`modeValues`, `activeModes`, `modeResolutions`) appears only where modes change the token's final value; multi-mode collections that resolve identically (e.g. dark == light) are listed in `modesIdentical`. Containers report `childCount` and, if any are hidden, `hiddenChildCount`.
