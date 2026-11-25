import fs from "node:fs/promises";
import path from "node:path";
import { MAX_OUTPUT_BYTES, TOOLS, ToolError, boundText, validateArgs } from "@opencommander/shared";
import { assertNotSensitive, isInside, resolveInWorkspace, type Flavor } from "./paths.js";
import { createDirectory, editBlock, moveFile, writeFile } from "./fsops.js";
import { searchFiles } from "./search.js";
import { runPower } from "./power.js";

export interface Flags { write: boolean }
export interface ToolCtx { roots: string[]; flavor?: Flavor; flags?: Flags }
export type ToolResult = { text: string; truncated: boolean; image?: { mimeType: string; data: string } };
export const READ_MAX = 65536;
const LIST_MAX = 1000;

function mapFsError(e: any): never {
  if (e instanceof ToolError) throw e;
  switch (e?.code) {
    case "ENOENT": throw new ToolError("not_found", "No such file or directory");
    case "ENOTDIR": throw new ToolError("not_a_directory", "Not a directory");
    case "EISDIR": throw new ToolError("not_a_file", "Is a directory");
    case "EACCES": case "EPERM": throw new ToolError("path_denied", "Permission denied by the operating system");
    default: throw new ToolError("internal", `Filesystem error${e?.code ? ` (${e.code})` : ""}`);
  }
}

const history: { t: number; tool: string; ms: number; ok: boolean; code?: string; arg: string }[] = [];
export function summarize(args: unknown): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const v = a.command ?? a.path ?? a.source ?? a.pattern ?? a.paths ?? a.args ?? a.url ?? (a.server ? `${a.server}/${a.tool ?? ""}` : "");
  return String(v).replace(/\s+/g, " ").slice(0, 120);
}
export async function runTool(ctx: ToolCtx, tool: string, rawArgs: unknown): Promise<ToolResult> {
  const t0 = Date.now();
  const rec = (ok: boolean, code?: string) => { history.push({ t: t0, tool, ms: Date.now() - t0, ok, code, arg: summarize(rawArgs) }); if (history.length > 200) history.shift(); };
  try { const r = await dispatch(ctx, tool, rawArgs); rec(true); return r; } catch (e: any) { rec(false, e?.code); throw e; }
}
function usage(): ToolResult {
  const by = new Map<string, { calls: number; fails: number; ms: number }>();
  for (const h of history) { const x = by.get(h.tool) ?? { calls: 0, fails: 0, ms: 0 }; x.calls++; if (!h.ok) x.fails++; x.ms += h.ms; by.set(h.tool, x); }
  return { truncated: false, text: JSON.stringify({ recentCalls: history.length, perTool: Object.fromEntries([...by].map(([k, x]) => [k, { calls: x.calls, failures: x.fails, avgMs: Math.round(x.ms / x.calls) }])) }, null, 2) };
}
function recent(a: Record<string, unknown>): ToolResult {
  const lim = Math.min(Math.floor((a.limit as number | undefined) ?? 20), 100);
  const rows = history.filter((h) => !a.tool || h.tool === a.tool).slice(-lim).map((h) => `${new Date(h.t).toISOString()} ${h.ok ? "ok " : "ERR"} ${h.tool} ${h.ms}ms ${h.code ?? ""} ${h.arg}`);
  return { truncated: false, text: rows.join("\n") || "(no calls yet)" };
}
async function dispatch(ctx: ToolCtx, tool: string, rawArgs: unknown): Promise<ToolResult> {
  const args = validateArgs(tool, rawArgs);
  const def = TOOLS.find((t) => t.name === tool)!;
  if (def.kind === "write" && !ctx.flags?.write)
    throw new ToolError("tool_disabled", `${tool} is disabled on this device. File writing is turned off on this device (OC_DISABLE_WRITE=1).`);
  try {
    switch (tool) {
      case "get_config": return getConfig(ctx);
      case "list_directory": return await listDirectory(ctx, args);
      case "get_file_info": return await getFileInfo(ctx, args);
      case "read_file": return await readFile(ctx, args);
      case "read_multiple_files": return await readMultiple(ctx, args);
      case "search": return await searchFiles(ctx, args);
      case "write_file": return await writeFile(ctx, args);
      case "create_directory": return await createDirectory(ctx, args);
      case "move_file": return await moveFile(ctx, args);
      case "edit_block": return await editBlock(ctx, args);
      case "get_usage_stats": return usage();
      case "get_recent_tool_calls": return recent(args);
      default: return await runPower(ctx, tool, args);
    }
  } catch (e) { mapFsError(e); }
}

function getConfig(ctx: ToolCtx): ToolResult {
  return { truncated: false, text: JSON.stringify({ platform: process.platform, workspaces: ctx.roots, enabled: { read: true, write: !!ctx.flags?.write }, limits: { readBytes: READ_MAX, outputBytes: MAX_OUTPUT_BYTES } }, null, 2) };
}

async function listDirectory(ctx: ToolCtx, a: Record<string, unknown>): Promise<ToolResult> {
  const f = ctx.flavor ?? path;
  const dir = await resolveInWorkspace(ctx.roots, (a.path as string | undefined) ?? ctx.roots[0]!, ctx.flavor);
  if (!(await fs.stat(dir)).isDirectory()) throw new ToolError("not_a_directory", "Not a directory");
  const depth = Math.min(Math.max(Math.floor((a.depth as number | undefined) ?? 1), 1), 3);
  const hidden = (full: string) => {
    const root = ctx.roots.find((r) => isInside(r, full, f)); if (!root) return true;
    try { assertNotSensitive(f.relative(root, full), f); return false; } catch { return true; }
  };
  const lines: string[] = []; let more = 0;
  const walk = async (d: string, level: number) => {
    const entries = (await fs.readdir(d, { withFileTypes: true })).filter((e) => !hidden(f.join(d, e.name)));
    entries.sort((x, y) => x.name.localeCompare(y.name));
    const cap = level === 1 ? LIST_MAX : 100; const pad = "  ".repeat(level - 1);
    for (const e of entries.slice(0, cap)) {
      if (e.isSymbolicLink()) lines.push(`${pad}[LINK] ${e.name}`); // never follow links when listing
      else if (e.isDirectory()) { lines.push(`${pad}[DIR]  ${e.name}`); if (level < depth) await walk(f.join(d, e.name), level + 1); }
      else { let size = "?"; try { size = String((await fs.lstat(f.join(d, e.name))).size); } catch {} lines.push(`${pad}[FILE] ${e.name} (${size} bytes)`); }
    }
    if (entries.length > cap) { more += entries.length - cap; lines.push(`${pad}... ${entries.length - cap} more entries not shown`); }
  };
  await walk(dir, 1);
  const b = boundText(lines.join("\n") || "(empty directory)");
  return { text: b.text, truncated: b.truncated || more > 0 };
}

async function getFileInfo(ctx: ToolCtx, a: Record<string, unknown>): Promise<ToolResult> {
  const p = await resolveInWorkspace(ctx.roots, a.path as string, ctx.flavor);
  const s = await fs.stat(p);
  return { truncated: false, text: JSON.stringify({
    path: p, type: s.isDirectory() ? "directory" : s.isFile() ? "file" : "other",
    size: s.size, modified: s.mtime.toISOString(), created: s.birthtime.toISOString(),
  }, null, 2) };
}

async function readFile(ctx: ToolCtx, a: Record<string, unknown>): Promise<ToolResult> {
  const p = await resolveInWorkspace(ctx.roots, a.path as string, ctx.flavor);
  const offset = Math.floor((a.offset as number | undefined) ?? 0);
  const length = Math.min(Math.floor((a.length as number | undefined) ?? READ_MAX), READ_MAX);
  const fh = await fs.open(p, "r");
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new ToolError("not_a_file", "Not a regular file");
    const buf = Buffer.alloc(Math.max(0, Math.min(length, st.size - offset)));
    const { bytesRead } = buf.length ? await fh.read(buf, 0, buf.length, offset) : { bytesRead: 0 };
    const chunk = buf.subarray(0, bytesRead);
    if (chunk.includes(0)) throw new ToolError("bad_arguments", "File appears to be binary; refusing to return it as text");
    const next = offset + bytesRead;
    const more = next < st.size;
    const header = `[bytes ${offset}-${next} of ${st.size}${more ? `; more available, call again with offset=${next}` : ""}]\n`;
    const b = boundText(header + chunk.toString("utf8"));
    return { text: b.text, truncated: more || b.truncated };
  } finally { await fh.close(); }
}

async function readMultiple(ctx: ToolCtx, a: Record<string, unknown>): Promise<ToolResult> {
  const paths = (a.paths as string).split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 20);
  if (!paths.length) throw new ToolError("bad_arguments", "No paths given");
  const out: string[] = [];
  for (const p of paths) {
    try { out.push(`=== ${p} ===\n${(await readFile(ctx, { path: p, length: 32768 })).text}`); }
    catch (e: any) { let m = "error"; try { mapFsError(e); } catch (x: any) { m = `${x.code}: ${x.message}`; } out.push(`=== ${p} ===\n[${m}]`); }
  }
  const b = boundText(out.join("\n\n"));
  return { text: b.text, truncated: b.truncated };
}
