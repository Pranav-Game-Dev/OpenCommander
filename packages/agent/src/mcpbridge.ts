import fs from "node:fs";
import { appFile } from "./appdir.js";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ToolError, boundText } from "@opencommander/shared";
import type { ToolResult } from "./tools.js";
import { fitBase64 } from "./image.js";

interface ServerCfg {
  command?: string; args?: string[]; env?: Record<string, string>; cwd?: string; url?: string; headers?: Record<string, string>;
  /** Folder of SKILL.md files for this app; indexed in mcp_servers so any AI finds them without being told. */
  skillsDir?: string;
  /** Free-text hints shown to the AI (e.g. "Open the Unity Editor first"). */
  notes?: string;
}
const conns = new Map<string, { client: Client; sig: string }>();
const pending = new Map<string, Promise<Client>>(); // dedupe simultaneous connects (several AIs at once)
const status = new Map<string, { lastOk?: number; lastError?: string }>();
const mk = () => new Client({ name: "opencommander", version: "0.1.0" });
const withTimeout = <T>(p: Promise<T>, ms: number, msg: string) => new Promise<T>((res, rej) => {
  const t = setTimeout(() => rej(new Error(msg)), ms); p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
});

export function configPath(): string {
  if (process.env.OC_MCP_CONFIG) return process.env.OC_MCP_CONFIG;
  const local = path.join(process.cwd(), "mcp-servers.json"); if (fs.existsSync(local)) return local;
  return appFile("mcp-servers.json");
}
function loadServers(): Record<string, ServerCfg> {
  const p = configPath(); let raw: string;
  try { raw = fs.readFileSync(p, "utf8"); }
  catch { throw new ToolError("unavailable", `No MCP server config found. Create ${p} like: {"mcpServers":{"blender":{"command":"uvx","args":["blender-mcp"]}}}`); }
  let j: any; try { j = JSON.parse(raw); } catch { throw new ToolError("bad_arguments", `Invalid JSON in ${p}`); }
  return (j.mcpServers ?? j.servers ?? {}) as Record<string, ServerCfg>;
}

/** Is `cmd` an existing file, or resolvable on PATH (with PATHEXT on Windows)? */
function findExe(cmd: string, cwd?: string): string | null {
  const exts = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")] : [""];
  const ok = (f: string) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
  if (/[\\/]/.test(cmd) || path.isAbsolute(cmd)) {
    const base = path.isAbsolute(cmd) ? cmd : path.resolve(cwd ?? process.cwd(), cmd);
    for (const e of exts) if (ok(base + e)) return base + e;
    return null;
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) for (const e of exts) if (dir && ok(path.join(dir, cmd + e))) return path.join(dir, cmd + e);
  return null;
}

async function open(cfg: ServerCfg): Promise<Client> {
  if (cfg.url) {
    const url = new URL(cfg.url); const init = cfg.headers ? { requestInit: { headers: cfg.headers } } : {};
    const c1 = mk();
    try { await c1.connect(new StreamableHTTPClientTransport(url, init)); return c1; }
    catch (e1: any) {
      await c1.close().catch(() => {}); const c2 = mk();
      try { await c2.connect(new SSEClientTransport(url, init as any)); return c2; }
      catch (e2: any) { throw new Error(`HTTP connect failed (${String(e1?.message ?? e1).slice(0, 120)}; SSE fallback: ${String(e2?.message ?? e2).slice(0, 120)}). Is the app running and listening at ${cfg.url}? Its URL/port can change when the app restarts.`); }
    }
  }
  if (!cfg.command) throw new Error("config needs a command or a url");
  if (!findExe(cfg.command, cfg.cwd)) throw new Error(`command not found: "${cfg.command}" (not an existing file and not on PATH). Use the full path to the executable, or e.g. uv's full path with args ["--directory","<repo>\\\\mcp","run","blender-mcp"]. This is an install/path problem, not a connection problem.`);
  const c = mk(); let tail = "";
  const tr = new StdioClientTransport({ command: cfg.command, args: cfg.args ?? [], env: { ...getDefaultEnvironment(), ...(cfg.env ?? {}) }, cwd: cfg.cwd, stderr: "pipe" });
  tr.stderr?.on("data", (d: Buffer) => { tail = (tail + d.toString()).slice(-600); });
  try { await c.connect(tr); }
  catch (e: any) { await c.close().catch(() => {}); throw new Error(`${String(e?.message ?? e).slice(0, 200)}${tail ? ` | process stderr: ${tail.trim().slice(-400)}` : ""}`); }
  return c;
}
async function ensure(name: string, timeoutMs = 30_000): Promise<Client> {
  const cfg = loadServers()[name];
  if (!cfg) throw new ToolError("not_found", `Unknown MCP server "${name}". Use mcp_servers to list the configured ones.`);
  const sig = JSON.stringify(cfg); const cur = conns.get(name);
  if (cur && cur.sig === sig) return cur.client;
  const inflight = pending.get(name); if (inflight) return inflight;
  const p = (async () => {
    if (cur) { await cur.client.close().catch(() => {}); conns.delete(name); }
    let client: Client;
    try { client = await withTimeout(open(cfg), timeoutMs, `timed out after ${Math.round(timeoutMs / 1000)} s`); }
    catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 700); status.set(name, { ...status.get(name), lastError: msg });
      throw new ToolError("upstream", `Could not connect to "${name}": ${msg}${/command not found/.test(msg) ? "" : ". Is the app running and its MCP server/plugin enabled?"}`);
    }
    client.onclose = () => { if (conns.get(name)?.client === client) conns.delete(name); };
    conns.set(name, { client, sig }); status.set(name, { lastOk: Date.now() }); return client;
  })().finally(() => pending.delete(name));
  pending.set(name, p); return p;
}

/** One line per skill: name, absolute path, description (from SKILL.md frontmatter). */
function skillIndex(dir: string): { lines: string[]; count: number; error?: string } {
  const found: string[] = [];
  const walk = (d: string, depth: number) => {
    let ents: fs.Dirent[]; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(d, e.name);
      if (e.isFile() && /^skill\.md$/i.test(e.name)) found.push(f);
      else if (e.isDirectory() && depth < 3 && !e.name.startsWith(".")) walk(f, depth + 1);
    }
  };
  if (!fs.existsSync(dir)) return { lines: [], count: 0, error: `skillsDir not found: ${dir}` };
  walk(dir, 0); found.sort();
  const lines = found.slice(0, 80).map((f) => {
    let desc = ""; try { const m = /^description:\s*(.+)$/im.exec(fs.readFileSync(f, "utf8").slice(0, 3000)); desc = (m?.[1] ?? "").replace(/^["']|["']$/g, "").slice(0, 160); } catch { /* ignore */ }
    return `${path.basename(path.dirname(f))} | ${f}${desc ? ` | ${desc}` : ""}`;
  });
  return { lines, count: found.length };
}
const ago = (t: number) => `${Math.max(0, Math.round((Date.now() - t) / 1000))}s ago`;

export async function mcpServers(a: Record<string, unknown> = {}): Promise<ToolResult> {
  const servers = loadServers(); const check = a.check === "yes";
  const results = new Map<string, { toolCount?: number; error?: string }>();
  if (check) await Promise.all(Object.keys(servers).map(async (n) => {
    try { const c = await ensure(n, 20_000); results.set(n, { toolCount: (await withTimeout(c.listTools(), 10_000, "listTools timed out")).tools.length }); }
    catch (e: any) { results.set(n, { error: String(e?.message ?? e).slice(0, 600) }); }
  }));
  const rows = Object.entries(servers).map(([name, c]) => {
    const st = status.get(name); const live = conns.has(name); const r = results.get(name);
    const state = r?.error ? "error" : live ? "connected" : st?.lastError ? "error (last attempt failed)" : "idle (connects automatically on first use)";
    const row: Record<string, unknown> = { name, type: c.url ? "http" : "stdio", target: c.url ?? `${c.command} ${(c.args ?? []).join(" ")}`.trim(), status: state, connected: live };
    if (st?.lastOk) row.lastConnected = ago(st.lastOk);
    if (r?.error || (!live && st?.lastError)) row.lastError = r?.error ?? st?.lastError;
    if (r?.toolCount !== undefined) { row.toolCount = r.toolCount; if (r.toolCount === 0) row.hint = "Connected but no tools: the app's plugin/add-on is probably not running (Unity: open the Editor with the plugin; Blender: enable the add-on and start its server)."; }
    if (c.notes) row.notes = c.notes;
    if (c.skillsDir) { const ix = skillIndex(c.skillsDir); row.skillsDir = c.skillsDir; row.skillCount = ix.count; if (ix.error) row.skillsError = ix.error; else row.skills = ix.lines; row.skillsHint = "Read the relevant SKILL.md (read_file) before operating this app."; }
    return row;
  });
  const b = boundText(JSON.stringify({ config: configPath(), servers: rows }, null, 2));
  return { truncated: b.truncated, text: b.text };
}
export async function mcpListTools(a: Record<string, unknown>): Promise<ToolResult> {
  const name = a.server as string; const cfg = loadServers()[name];
  const client = await ensure(name);
  const { tools } = await client.listTools();
  const head = [cfg?.notes ? `Notes: ${cfg.notes}` : "", cfg?.skillsDir ? `Skills folder: ${cfg.skillsDir} (call mcp_servers for the index; read the relevant SKILL.md first)` : ""].filter(Boolean).join("\n");
  const body = tools.map((t) => `- ${t.name}: ${(t.description ?? "").slice(0, 300)}\n  input: ${JSON.stringify(t.inputSchema).slice(0, 1500)}`).join("\n")
    || "(server connected but exposes no tools - the app's plugin/add-on is probably not running yet)";
  const b = boundText((head ? head + "\n\n" : "") + body); return { text: b.text, truncated: b.truncated };
}
export async function mcpCall(a: Record<string, unknown>): Promise<ToolResult> {
  let args: Record<string, unknown> = {};
  if (a.arguments) { try { args = JSON.parse(a.arguments as string); } catch { throw new ToolError("bad_arguments", "arguments must be a JSON object string"); } }
  const client = await ensure(a.server as string);
  let res: any;
  try { res = await client.callTool({ name: a.tool as string, arguments: args }, undefined, { timeout: 90_000 }); }
  catch (e: any) { throw new ToolError("upstream", String(e?.message ?? e).slice(0, 1000)); }
  const parts: string[] = []; let image: ToolResult["image"]; let extra = 0;
  for (const c of (res.content ?? []) as any[]) {
    if (c.type === "text") parts.push(c.text);
    else if (c.type === "image") {
      if (image) { extra++; continue; } // one image per tool result; extras are mentioned, not dropped silently
      const f = await fitBase64(String(c.data ?? ""), String(c.mimeType ?? "image/png"));
      if (f.image) { image = f.image; parts.push(`[image ${f.image.mimeType} returned]`); } else parts.push(`[image ${c.mimeType}: ${f.note ?? "not returned"}]`);
    } else parts.push(JSON.stringify(c).slice(0, 2000));
  }
  if (extra) parts.push(`[${extra} more image(s) not returned - only the first is attached; call again for others]`);
  if (!parts.length && res.structuredContent) parts.push(JSON.stringify(res.structuredContent));
  const b = boundText(parts.join("\n") || "(empty result)");
  if (res.isError) throw new ToolError("upstream", b.text.slice(0, 2000));
  return { text: b.text, truncated: b.truncated, ...(image ? { image } : {}) };
}
export async function closeAll() { for (const { client } of conns.values()) await client.close().catch(() => {}); conns.clear(); }
