import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer, type WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Action, BridgeRequest, BridgeResponse } from "../../shared/types";

const PORT = Number(process.env.FIGMA_TOKENS_PORT ?? 3055);
const TIMEOUT_MS = 15000;
const NOT_CONNECTED =
  "The Figma plugin is not connected. In Figma desktop, open the target file and run Plugins → Development → Token Inspector (MCP bridge), then retry.";

// ---- WebSocket side (plugin UI is the client) ----
let plugin: WebSocket | null = null;
const pending = new Map<string, { resolve: (r: BridgeResponse) => void; timer: ReturnType<typeof setTimeout> }>();

const wss = new WebSocketServer({ port: PORT, host: "127.0.0.1" });
wss.on("connection", (ws) => {
  plugin = ws; // latest connection wins
  ws.on("message", (data) => {
    const res = JSON.parse(data.toString()) as BridgeResponse;
    const p = pending.get(res.id);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(res.id);
      p.resolve(res);
    }
  });
  ws.on("close", () => {
    if (plugin === ws) plugin = null;
  });
});
wss.on("error", (e) => console.error("[figma-tokens] websocket error:", e.message));

function ask(action: Action, params: BridgeRequest["params"]): Promise<BridgeResponse> {
  return new Promise((resolve) => {
    if (!plugin || plugin.readyState !== 1) return resolve({ id: "", ok: false, error: NOT_CONNECTED });
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ id, ok: false, error: "Timed out waiting for the Figma plugin (is the file still open?)." });
    }, TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    plugin.send(JSON.stringify({ id, action, params } satisfies BridgeRequest));
  });
}

async function run(action: Action, params: BridgeRequest["params"]) {
  const res = await ask(action, params);
  if (!res.ok) return { isError: true, content: [{ type: "text" as const, text: res.error ?? "Unknown error" }] };
  return { content: [{ type: "text" as const, text: JSON.stringify(res.result) }] };
}

// ---- MCP side (stdio) ----
const server = new McpServer({ name: "figma-token-inspector", version: "0.1.0" });

const depth = z.number().int().min(0).optional().describe("Max child depth below each root (default: full subtree)");
const includeUnbound = z
  .boolean()
  .optional()
  .describe("Also report hard-coded values that have no variable bound");
const includeVectors = z
  .boolean()
  .optional()
  .describe("Also descend into vector/boolean-operation shapes (default: skipped unless they carry a binding)");

const includeIcons = z
  .boolean()
  .optional()
  .describe("Export each icon instance (small, vector-only, no text) as SVG markup in `svg`; bound fills still come from `bindings`");

server.registerTool(
  "get_selection_tokens",
  {
    description:
      "Get the design tokens (Figma variables) bound to the currently selected node(s) and their descendants. " +
      "Returns a top-level `tokens` dictionary (each token once, with its full alias chain down to the primitive and per-mode values) and per-node `bindings` that group properties sharing a token (e.g. cornerRadius, paddingInline) and refer to it by key. " +
      "Nodes also carry layout/sizing, component/variant info, text characters and effect types. " +
      "Always use the directly bound token; never substitute a primitive that happens to have the same value.",
    inputSchema: { depth, includeUnbound, includeVectors, includeIcons },
  },
  (args) => run("get_selection_tokens", args)
);

server.registerTool(
  "get_node_tokens",
  {
    description:
      "Same as get_selection_tokens but for specific node IDs (e.g. '12:34' or '12-34' from a Figma URL's node-id param).",
    inputSchema: { nodeIds: z.array(z.string()).min(1), depth, includeUnbound, includeVectors, includeIcons },
  },
  (args) => run("get_node_tokens", args)
);

server.registerTool(
  "get_variant_diff",
  {
    description:
      "For a component set (pass the set's ID, or any variant/descendant inside it), returns the set's component `properties` (type, default, options), a `tokens` dictionary (chains and mode resolutions for every token used), `missingCombinations`, and for every non-default variant only the properties that differ from the default (token or literal, grouped by layer path). Add includeBase to also get the default variant's node details. " +
      "(token or literal, per layer path). Use this to find hover/pressed/disabled/destructive state styling without inspecting each variant. variantFilter keeps variants whose name contains the text (a plain substring match, so use \"disabled=true\", not \"disabled\", which also matches \"disabled=false\").",
    inputSchema: {
      nodeId: z.string(),
      variantFilter: z.string().optional(),
      includeBase: z
        .boolean()
        .optional()
        .describe("Also return the default variant's full node details (default: false; get_node_tokens gives the same)"),
    },
  },
  (args) => run("get_variant_diff", args)
);

server.registerTool(
  "list_variables",
  {
    description:
      "List local variable collections and variables (name, id, type, per-mode values), to validate token names. Library collections are listed by name only.",
    inputSchema: { collection: z.string().optional(), nameFilter: z.string().optional() },
  },
  (args) => run("list_variables", args)
);

await server.connect(new StdioServerTransport());
