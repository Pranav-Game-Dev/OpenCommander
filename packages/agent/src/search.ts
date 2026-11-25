import fs from "node:fs/promises";
import path from "node:path";
import { ToolError, boundText } from "@opencommander/shared";
import { assertNotSensitive, isInside, resolveInWorkspace } from "./paths.js";
import type { ToolCtx, ToolResult } from "./tools.js";

const MAX_FILE = 1024 * 1024;

export async function searchFiles(ctx: ToolCtx, a: Record<string, unknown>): Promise<ToolResult> {
  const f = ctx.flavor ?? path;
  const start = await resolveInWorkspace(ctx.roots, (a.path as string | undefined) ?? ctx.roots[0]!, ctx.flavor);
  if (!(await fs.stat(start)).isDirectory()) throw new ToolError("not_a_directory", "Not a directory");
  const root = ctx.roots.find((r) => isInside(r, start, f))!;
  const pattern = a.pattern as string; const content = a.type === "content";
  const max = Math.min(Math.floor((a.maxResults as number | undefined) ?? 100), 500);
  const ci = a.ignoreCase !== false;
  let test: (s: string) => boolean;
  if (a.regex === true) {
    let re: RegExp; try { re = new RegExp(pattern, ci ? "i" : ""); } catch { throw new ToolError("bad_arguments", "Invalid regular expression"); }
    test = (s) => re.test(s.slice(0, 2000));
  } else { const nd = ci ? pattern.toLowerCase() : pattern; test = (s) => (ci ? s.toLowerCase() : s).includes(nd); }

  const deadline = Date.now() + 20_000; const out: string[] = []; let scanned = 0; let stop = "";
  const queue = [start];
  outer: while (queue.length) {
    const dir = queue.shift()!;
    let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (out.length >= max) { stop = "max results"; break outer; }
      if (Date.now() > deadline) { stop = "time limit"; break outer; }
      if (++scanned > 50_000) { stop = "file limit"; break outer; }
      const full = f.join(dir, e.name);
      try { assertNotSensitive(f.relative(root, full), f); } catch { continue; }
      if (e.isSymbolicLink()) continue;
      const rel = f.relative(start, full);
      if (e.isDirectory()) {
        if (!content && test(e.name)) out.push(rel + f.sep);
        if (!(content && (e.name === ".git" || e.name === "node_modules"))) queue.push(full);
        continue;
      }
      if (!content) { if (test(e.name)) out.push(rel); continue; }
      if (!e.isFile()) continue;
      try {
        if ((await fs.stat(full)).size > MAX_FILE) continue;
        const buf = await fs.readFile(full); if (buf.includes(0)) continue;
        const lines = buf.toString("utf8").split("\n");
        for (let i = 0; i < lines.length && out.length < max; i++) if (test(lines[i]!)) out.push(`${rel}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
      } catch { /* unreadable file: skip */ }
    }
  }
  const body = out.length ? out.join("\n") : "(no matches)";
  const b = boundText(stop ? `${body}\n[stopped: ${stop}]` : body);
  return { text: b.text, truncated: b.truncated || !!stop };
}
