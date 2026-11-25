import fs from "node:fs/promises";
import path from "node:path";
import { ToolError, boundText } from "@opencommander/shared";
import { resolveInWorkspace } from "./paths.js";
import { needExe, runBounded } from "./exe.js";
import type { ToolCtx, ToolResult } from "./tools.js";

/** Files never packed when a folder is archived (so an archive can't be used to smuggle secrets out). */
const EXCLUDE = ["-xr!.env", "-xr!.env.*", "-xr!.ssh", "-xr!*.pem", "-xr!*.key", "-xr!device.json", "-xr!.npmrc", "-xr!.wrangler"];

const lines = (v: unknown) => String(v ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
function member(n: string): string {
  if (n.startsWith("-") || n.startsWith("@") || /[\0]/.test(n)) throw new ToolError("bad_arguments", `Illegal entry name: ${n}`);
  return n;
}

export async function archive(ctx: ToolCtx, a: Record<string, unknown>): Promise<ToolResult> {
  const exe = needExe("7-Zip", "OC_7ZIP", ["C:\\Program Files\\7-Zip\\7z.exe", "C:\\Program Files (x86)\\7-Zip\\7z.exe"]);
  const action = String(a.action);
  const arch = await resolveInWorkspace(ctx.roots, String(a.archive), ctx.flavor);
  const pw = a.password ? String(a.password) : "";
  const pwArg = pw ? [`-p${pw}`] : [];
  const base = ["-y", "-bsp0", "-sccUTF-8"];
  let args: string[]; let after: (() => Promise<string>) | null = null;
  const exists = async (p: string) => !!(await fs.stat(p).catch(() => null));

  if (action === "list" || action === "test") {
    if (!(await exists(arch))) throw new ToolError("not_found", "Archive not found");
    args = [action === "list" ? "l" : "t", ...base, ...pwArg, "--", arch];
  } else if (action === "extract") {
    if (!(await exists(arch))) throw new ToolError("not_found", "Archive not found");
    const dest = a.output ? await resolveInWorkspace(ctx.roots, String(a.output), ctx.flavor)
      : await resolveInWorkspace(ctx.roots, path.join(path.dirname(arch), path.basename(arch, path.extname(arch))), ctx.flavor);
    await fs.mkdir(dest, { recursive: true });
    const mode = ({ skip: "-aos", overwrite: "-aoa", rename: "-aou" } as Record<string, string>)[String(a.overwrite ?? "skip")] ?? "-aos";
    args = ["x", ...base, mode, `-o${dest}`, ...pwArg, "--", arch, ...lines(a.paths).map(member)];
    after = async () => `Extracted to ${dest}`;
  } else if (action === "create" || action === "add") {
    const items = lines(a.paths); if (!items.length) throw new ToolError("bad_arguments", "paths is required (files/folders to add)");
    const resolved: string[] = []; for (const i of items) resolved.push(await resolveInWorkspace(ctx.roots, i, ctx.flavor));
    const had = await exists(arch);
    if (action === "create" && had) throw new ToolError("bad_arguments", "Archive already exists; use action=add to add to it or choose another name");
    if (action === "add" && !had) throw new ToolError("not_found", "Archive not found; use action=create");
    const fmt = String(a.format ?? "7z"); const lvl = Math.min(9, Math.max(0, Math.floor(Number(a.level ?? 5))));
    const typeArgs = action === "create" ? [`-t${fmt}`] : [];
    const enc = pw ? (fmt === "zip" ? ["-mem=AES256"] : fmt === "7z" ? ["-mhe=on"] : []) : [];
    args = ["a", ...base, ...typeArgs, `-mx=${lvl}`, ...enc, ...EXCLUDE, ...pwArg, "--", arch, ...resolved];
    after = async () => `${action === "create" ? "Created" : "Updated"} ${arch} (${(await fs.stat(arch)).size} bytes)`;
  } else if (action === "delete") {
    if (!(await exists(arch))) throw new ToolError("not_found", "Archive not found");
    const names = lines(a.paths).map(member); if (!names.length) throw new ToolError("bad_arguments", "paths is required (entry names to delete)");
    args = ["d", ...base, ...pwArg, "--", arch, ...names];
    after = async () => `Deleted ${names.length} entr${names.length === 1 ? "y" : "ies"} from ${arch}`;
  } else throw new ToolError("bad_arguments", `Unknown action: ${action}`);

  const r = await runBounded(exe, args, 105_000);
  let out = r.out; if (pw) out = out.split(pw).join("***");
  if (r.timedOut) throw new ToolError("timeout", "7-Zip did not finish in time and was stopped. For huge archives run 7z.exe with start_process.");
  if (r.code !== 0 && r.code !== 1) throw new ToolError("upstream", `7-Zip failed (exit ${r.code}): ${out.trim().slice(-1500)}`);
  const head = after ? await after() : "";
  const b = boundText((head ? head + (r.code === 1 ? " (with warnings)\n" : "\n") : "") + (action === "list" || r.code === 1 || action === "test" ? out : out.trim().split(/\r?\n/).slice(-6).join("\n")));
  return { text: b.text, truncated: b.truncated };
}
