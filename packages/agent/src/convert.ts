import fs from "node:fs/promises";
import fss from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolError } from "@opencommander/shared";
import { resolveInWorkspace } from "./paths.js";
import { needExe, runBounded } from "./exe.js";
import type { ToolCtx, ToolResult } from "./tools.js";

/** File Converter (https://github.com/Tichau/FileConverter): `FileConverter.exe --conversion-preset "<name>" <files...>`; output lands next to each input. */
export interface Preset { name: string; out: string; inputs: string[] }
const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const INSTALL = "C:\\Program Files\\File Converter";

export function parsePresets(xml: string): Preset[] {
  const out: Preset[] = [];
  for (const m of xml.matchAll(/<ConversionPreset\s+([^>]*)>([\s\S]*?)<\/ConversionPreset>/g)) {
    const name = /Name="([^"]*)"/.exec(m[1]!)?.[1]; const type = /OutputType="([^"]*)"/.exec(m[1]!)?.[1];
    if (!name || !type) continue;
    out.push({ name: unesc(name), out: type, inputs: [...m[2]!.matchAll(/<InputTypes>([^<]*)<\/InputTypes>/g)].map((x) => x[1]!.trim().toLowerCase()) });
  }
  return out;
}
export function loadPresets(): Preset[] {
  const byName = new Map<string, Preset>();
  const files = [path.join(process.env.OC_FILECONVERTER_DIR || INSTALL, "Settings.default.xml"), path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "FileConverter", "Settings.user.xml")];
  for (const f of files) { try { for (const p of parsePresets(fss.readFileSync(f, "utf8"))) byName.set(p.name.toLowerCase(), p); } catch { /* optional */ } }
  return [...byName.values()];
}

let chain: Promise<unknown> = Promise.resolve(); // File Converter is a single GUI app: one job at a time
const exclusive = <T>(fn: () => Promise<T>): Promise<T> => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

const snap = async (dir: string) => { const m = new Map<string, number>(); for (const n of await fs.readdir(dir)) { try { const s = await fs.stat(path.join(dir, n)); if (s.isFile()) m.set(n, s.mtimeMs); } catch { /* raced */ } } return m; };
const uniq = async (dir: string, name: string) => {
  const ext = path.extname(name), base = path.basename(name, ext); let n = name, i = 1;
  while (fss.existsSync(path.join(dir, n))) n = `${base} (${i++})${ext}`;
  return path.join(dir, n);
};

export async function convertFile(ctx: ToolCtx, a: Record<string, unknown>): Promise<ToolResult> {
  const presets = loadPresets();
  if ((a.action as string | undefined) === "presets") {
    if (!presets.length) throw new ToolError("unavailable", "No File Converter presets found. Is File Converter installed?");
    return { truncated: false, text: presets.map((p) => `${p.name}  ->  ${p.out}   (accepts: ${p.inputs.join(", ")})`).join("\n") };
  }
  const exe = needExe("File Converter", "OC_FILECONVERTER", [path.join(INSTALL, "FileConverter.exe")]);
  const lines = String(a.input ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  if (!lines.length) throw new ToolError("bad_arguments", "input is required (one or more file paths)");
  if (lines.length > 20) throw new ToolError("bad_arguments", "At most 20 files per call");
  let preset: Preset | undefined;
  if (a.preset) preset = presets.find((p) => p.name.toLowerCase() === String(a.preset).toLowerCase());
  else if (a.to) preset = presets.find((p) => p.name.toLowerCase() === `to ${String(a.to).toLowerCase()}`);
  else throw new ToolError("bad_arguments", "Give preset=<exact name> or to=<format> (see action=presets)");
  if (!preset) throw new ToolError("bad_arguments", `Unknown preset/format. Use action=presets. Available: ${presets.map((p) => p.name).slice(0, 40).join(", ")}`);

  const files: string[] = [];
  for (const l of lines) {
    const p = await resolveInWorkspace(ctx.roots, l, ctx.flavor);
    let st; try { st = await fs.stat(p); } catch { throw new ToolError("not_found", `Input not found: ${l}`); }
    if (!st.isFile()) throw new ToolError("not_a_file", `Not a file: ${l}`);
    const ext = path.extname(p).slice(1).toLowerCase();
    if (!preset.inputs.includes(ext)) {
      const ok = presets.filter((x) => x.inputs.includes(ext)).map((x) => x.name).slice(0, 15);
      throw new ToolError("bad_arguments", `Preset "${preset.name}" does not accept .${ext} files.${ok.length ? ` Presets that do: ${ok.join(", ")}` : " No preset accepts that type."}`);
    }
    files.push(p);
  }
  const outDir = a.output_dir ? await resolveInWorkspace(ctx.roots, String(a.output_dir), ctx.flavor) : null;
  if (outDir) await fs.mkdir(outDir, { recursive: true });

  return exclusive(async () => {
    const dirs = [...new Set(files.map((f) => path.dirname(f)))];
    const before = new Map<string, Map<string, number>>(); for (const d of dirs) before.set(d, await snap(d));
    const t0 = Date.now();
    const r = await runBounded(exe, ["--conversion-preset", preset!.name, ...files], 105_000, { hide: false });
    const made: string[] = [];
    for (const d of dirs) {
      const b = before.get(d)!; const after = await snap(d);
      for (const [n, m] of after) if ((!b.has(n) || (b.get(n)! < m && m >= t0 - 1000)) && !files.includes(path.join(d, n))) made.push(path.join(d, n));
    }
    if (!made.length) throw new ToolError(r.timedOut ? "timeout" : "upstream", r.timedOut ? "File Converter did not finish in time and was stopped (try a smaller file or a lower-quality preset)." : `File Converter produced no output (exit ${r.code}). The file may be corrupt or the preset unsuitable.${r.out.trim() ? " " + r.out.trim().slice(0, 300) : ""}`);
    const finalPaths: string[] = [];
    for (const f of made) {
      if (!outDir) { finalPaths.push(f); continue; }
      const dest = await uniq(outDir, path.basename(f));
      try { await fs.rename(f, dest); } catch { await fs.copyFile(f, dest); await fs.unlink(f); }
      finalPaths.push(dest);
    }
    const rows = await Promise.all(finalPaths.map(async (p) => `${p}  (${(await fs.stat(p)).size} bytes)`));
    return { truncated: false, text: `Converted with "${preset!.name}" in ${((Date.now() - t0) / 1000).toFixed(1)} s${r.timedOut ? " (timed out; results may be partial)" : ""}:\n${rows.join("\n")}` };
  });
}
