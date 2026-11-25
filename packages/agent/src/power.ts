import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolError, boundText } from "@opencommander/shared";
import { resolveInWorkspace } from "./paths.js";
import { interact, killProcess, listProcesses, listSessions, readOutput, setBlocked, startProcess, terminate } from "./procs.js";
import { runBrowser } from "./browser.js";
import { closeAll, mcpCall, mcpListTools, mcpServers } from "./mcpbridge.js";
import { convertFile } from "./convert.js";
import { archive } from "./archive.js";
import { captureScreen, imageGrid, readImage } from "./image.js";
import { liveLink } from "./livelink.js";
import type { ToolCtx, ToolResult } from "./tools.js";

type Args = Record<string, unknown>;
const R = (ctx: ToolCtx, p: string) => resolveInWorkspace(ctx.roots, p, ctx.flavor);
const noRoot = (ctx: ToolCtx, p: string) => { if (ctx.roots.includes(p)) throw new ToolError("path_denied", "Cannot modify a workspace root itself"); };
const off = (k: "EXEC" | "BROWSER" | "MCP", tool: string) => {
  if (process.env[`OC_DISABLE_${k}`] === "1") throw new ToolError("tool_disabled", `${tool} is turned off on this device (OC_DISABLE_${k}=1).`);
};

export async function runPower(ctx: ToolCtx, tool: string, a: Args): Promise<ToolResult> {
  switch (tool) {
    case "system_info": return systemInfo();
    case "copy_file": return await copyFile(ctx, a);
    case "delete_path": return await deletePath(ctx, a);
    case "start_process": off("EXEC", tool); return await startProcess(ctx, a);
    case "read_process_output": off("EXEC", tool); return await readOutput(a);
    case "interact_with_process": off("EXEC", tool); return await interact(a);
    case "force_terminate": off("EXEC", tool); return await terminate(a);
    case "list_sessions": off("EXEC", tool); return listSessions();
    case "list_processes": off("EXEC", tool); return await listProcesses();
    case "kill_process": off("EXEC", tool); return await killProcess(a);
    case "http_request": off("EXEC", tool); return await httpRequest(a);
    case "set_config_value": off("EXEC", tool); return await setConfig(ctx, a);
    case "shutdown": off("EXEC", tool); setTimeout(() => { void closeAll().finally(() => process.exit(0)); }, 500); return { text: "Agent shutting down. Start it again with start-opencommander.bat.", truncated: false };
    case "browser": off("BROWSER", tool); return await runBrowser(a);
    case "mcp_servers": off("MCP", tool); return await mcpServers(a);
    case "mcp_list_tools": off("MCP", tool); return await mcpListTools(a);
    case "mcp_call": off("MCP", tool); return await mcpCall(a);
    case "live_link": return await liveLink(a);
    case "read_image": return await readImage(ctx, a);
    case "image_grid": return await imageGrid(ctx, a);
    case "capture_screen": off("EXEC", tool); return await captureScreen(a);
    case "convert_file": off("EXEC", tool); return await convertFile(ctx, a);
    case "archive": off("EXEC", tool); return await archive(ctx, a);
    default: throw new ToolError("unknown_tool", `Unknown tool: ${tool}`);
  }
}

function systemInfo(): ToolResult {
  const gb = (b: number) => Math.round((b / 2 ** 30) * 10) / 10;
  return { truncated: false, text: JSON.stringify({
    platform: process.platform, release: os.release(), arch: os.arch(), hostname: os.hostname(), user: os.userInfo().username,
    cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memoryGB: { total: gb(os.totalmem()), free: gb(os.freemem()) },
    uptimeHours: Math.round(os.uptime() / 360) / 10, node: process.version,
  }, null, 2) };
}
async function copyFile(ctx: ToolCtx, a: Args): Promise<ToolResult> {
  const s = await R(ctx, a.source as string), d = await R(ctx, a.destination as string); noRoot(ctx, d);
  let exists = true; try { await fs.lstat(d); } catch (e: any) { if (e?.code === "ENOENT") exists = false; else throw e; }
  if (exists) throw new ToolError("bad_arguments", "Destination already exists; refusing to overwrite");
  await fs.mkdir(path.dirname(d), { recursive: true });
  await fs.cp(s, d, { recursive: true, errorOnExist: true, force: false });
  return { truncated: false, text: `Copied ${s} -> ${d}` };
}
async function deletePath(ctx: ToolCtx, a: Args): Promise<ToolResult> {
  const p = await R(ctx, a.path as string); noRoot(ctx, p);
  await fs.lstat(p);
  await fs.rm(p, { recursive: true, force: false });
  return { truncated: false, text: `Deleted ${p}` };
}
async function httpRequest(a: Args): Promise<ToolResult> {
  let url: URL; try { url = new URL(a.url as string); } catch { throw new ToolError("bad_arguments", "Invalid URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ToolError("bad_arguments", "Only http(s) URLs are allowed");
  let headers: Record<string, string> = {};
  if (a.headers) { try { headers = JSON.parse(a.headers as string); } catch { throw new ToolError("bad_arguments", "headers must be a JSON object string"); } }
  const method = (a.method as string | undefined) ?? "GET";
  let res: Response;
  try { res = await fetch(url, { method, headers, body: method === "GET" || a.body === undefined ? undefined : (a.body as string), signal: AbortSignal.timeout(30_000) }); }
  catch (e: any) { throw new ToolError("upstream", `Request failed: ${String(e?.cause?.code ?? e?.message ?? e).slice(0, 200)}`); }
  const buf = Buffer.from(await res.arrayBuffer()); const slice = buf.subarray(0, 300_000);
  const body = slice.includes(0) ? `[binary, ${buf.length} bytes]` : slice.toString("utf8");
  const head = `HTTP ${res.status} ${res.statusText}\ncontent-type: ${res.headers.get("content-type") ?? ""}\ncontent-length: ${buf.length}\n\n`;
  const b = boundText(head + body); return { text: b.text, truncated: b.truncated || buf.length > 300_000 };
}
async function setConfig(ctx: ToolCtx, a: Args): Promise<ToolResult> {
  const lines = (a.value as string).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  if (a.key === "blockedCommands") { setBlocked(lines); return { truncated: false, text: `blockedCommands set (${lines.length} entries)` }; }
  if (!lines.length) throw new ToolError("bad_arguments", "Give at least one folder");
  const real: string[] = [];
  for (const d of lines) {
    let r: string; try { r = await fs.realpath(path.resolve(d)); } catch { throw new ToolError("not_found", `Folder not found: ${d}`); }
    if (!(await fs.stat(r)).isDirectory()) throw new ToolError("not_a_directory", `Not a folder: ${d}`);
    real.push(r);
  }
  ctx.roots.splice(0, ctx.roots.length, ...real);
  return { truncated: false, text: `allowedDirectories now:\n${real.join("\n")}` };
}