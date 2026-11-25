import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { DEFAULT_PLUGIN_NAME, TOOLS, slugName } from "@opencommander/shared";
import type { CallOutcome } from "./hub.js";

export interface McpDeps {
  call(tool: string, args: Record<string, unknown>): Promise<CallOutcome>;
  devices(): Promise<{ id: string; name: string; online: boolean; revokedAt?: number }[]>;
}

const INSTRUCTIONS =
  "Remote control of the user's own Windows PC via a paired agent. Files (workspace folders): list_directory, search, read_file, write_file, edit_block, move_file, copy_file, delete_path. " +
  "Shell: start_process then read_process_output / interact_with_process; browser: call browser with args 'skills get core' first. " +
  "Local apps (Blender, Unity, other MCP servers on the PC): mcp_servers FIRST (it shows status, notes and each app's skills folder with SKILL.md paths - read the relevant skill with read_file before using that app), then mcp_list_tools, then mcp_call. " +
  "Several AIs may use this PC at once: use a unique --session NAME with the browser tool. Tools marked WARNING act on the real PC. If no device is online, ask the user to start the agent.";

/** Owner-chosen presentation: plugin name, logo URL and tools switched off in the manage script. */
export interface McpOpts { name: string; iconUrl?: string; disabled?: ReadonlySet<string> }

export function createMcpServer(deps: McpDeps, opts: McpOpts = { name: DEFAULT_PLUGIN_NAME }): McpServer {
  const server = new McpServer({
    name: slugName(opts.name), title: opts.name, version: "0.1.0",
    ...(opts.iconUrl ? { icons: [{ src: opts.iconUrl, mimeType: "image/svg+xml", sizes: ["any"] }] } : {}),
  }, { instructions: `You are connected to "${opts.name}" (OpenCommander). ${INSTRUCTIONS}` });
  for (const t of TOOLS) {
    if (opts.disabled?.has(t.name)) continue;
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [k, spec] of Object.entries(t.properties)) {
      let s: z.ZodTypeAny = spec.type === "number" ? z.number().min(0) : spec.type === "boolean" ? z.boolean()
        : spec.enum ? z.enum(spec.enum as [string, ...string[]]) : z.string().max(spec.max ?? 4096);
      s = s.describe(spec.description);
      shape[k] = t.required.includes(k) ? s : s.optional();
    }
    server.registerTool(t.name, {
      title: t.title, description: t.description, inputSchema: shape,
      annotations: t.kind === "read"
        ? { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        : { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: t.kind !== "write" },
    }, async (args: Record<string, unknown>) => {
      const r = await deps.call(t.name, args);
      if (!r.ok) return { isError: true, content: [{ type: "text" as const, text: `[${r.code}] ${r.message}` }] };
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [{ type: "text" as const, text: r.truncated ? r.text + "\n[output truncated]" : r.text }];
      if (r.image) content.push({ type: "image" as const, data: r.image.data, mimeType: r.image.mimeType });
      return { content };
    });
  }
  server.registerTool("list_devices", {
    title: "List devices", description: "List paired devices and whether each is online.", inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => ({ content: [{ type: "text" as const, text: JSON.stringify((await deps.devices()).filter((d) => !d.revokedAt).map((d) => ({ id: d.id, name: d.name, online: d.online })), null, 2) }] }));
  return server;
}

/** Stateless Streamable HTTP: one server+transport per request, JSON responses (no long-lived streams). */
export async function handleMcp(request: Request, deps: McpDeps, opts?: McpOpts): Promise<Response> {
  const server = createMcpServer(deps, opts);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try { return await transport.handleRequest(request); }
  finally { void server.close().catch(() => {}); }
}
