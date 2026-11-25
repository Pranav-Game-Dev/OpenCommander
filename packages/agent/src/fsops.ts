import fs from "node:fs/promises";
import path from "node:path";
import { ToolError } from "@opencommander/shared";
import { resolveInWorkspace } from "./paths.js";
import type { ToolCtx, ToolResult } from "./tools.js";

type Args = Record<string, unknown>;
const R = (ctx: ToolCtx, p: string) => resolveInWorkspace(ctx.roots, p, ctx.flavor);
const noRoot = (ctx: ToolCtx, p: string) => { if (ctx.roots.includes(p)) throw new ToolError("path_denied", "Cannot modify a workspace root itself"); };
const ok = (text: string): ToolResult => ({ text, truncated: false });

export async function writeFile(ctx: ToolCtx, a: Args): Promise<ToolResult> {
  const p = await R(ctx, a.path as string); noRoot(ctx, p);
  const content = a.content as string; const mode = (a.mode as string | undefined) ?? "rewrite";
  await fs.mkdir(path.dirname(p), { recursive: true });
  if (mode === "append") await fs.appendFile(p, content, "utf8"); else await fs.writeFile(p, content, "utf8");
  return ok(`Wrote ${Buffer.byteLength(content)} bytes to ${p} (${mode})`);
}

export async function createDirectory(ctx: ToolCtx, a: Args): Promise<ToolResult> {
  const p = await R(ctx, a.path as string);
  await fs.mkdir(p, { recursive: true });
  return ok(`Directory ready: ${p}`);
}

export async function moveFile(ctx: ToolCtx, a: Args): Promise<ToolResult> {
  const s = await R(ctx, a.source as string), d = await R(ctx, a.destination as string);
  noRoot(ctx, s); noRoot(ctx, d);
  let exists = true; try { await fs.lstat(d); } catch (e: any) { if (e?.code === "ENOENT") exists = false; else throw e; }
  if (exists) throw new ToolError("bad_arguments", "Destination already exists; refusing to overwrite");
  await fs.mkdir(path.dirname(d), { recursive: true });
  await fs.rename(s, d);
  return ok(`Moved ${s} -> ${d}`);
}

export async function editBlock(ctx: ToolCtx, a: Args): Promise<ToolResult> {
  const p = await R(ctx, a.path as string);
  const st = await fs.stat(p);
  if (!st.isFile()) throw new ToolError("not_a_file", "Not a regular file");
  if (st.size > 2 * 1024 * 1024) throw new ToolError("too_large", "File is larger than 2 MiB");
  const buf = await fs.readFile(p);
  if (buf.includes(0)) throw new ToolError("bad_arguments", "File appears to be binary");
  const text = buf.toString("utf8"); const old = a.old_string as string;
  if (!old) throw new ToolError("bad_arguments", "old_string must not be empty");
  const count = text.split(old).length - 1; const want = Math.floor((a.expected_replacements as number | undefined) ?? 1);
  if (count !== want) throw new ToolError("bad_arguments", `Found ${count} occurrence(s) of old_string, expected ${want}. No changes made.`);
  await fs.writeFile(p, text.split(old).join(a.new_string as string), "utf8");
  return ok(`Replaced ${count} occurrence(s) in ${p}`);
}
