import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ToolError, boundText } from "@opencommander/shared";
import { childEnv } from "./procs.js";
import type { ToolResult } from "./tools.js";

function resolveBin(): { file: string; pre: string[] } | null {
  const o = process.env.OC_AGENT_BROWSER_BIN; if (o && fs.existsSync(o)) return { file: o, pre: [] };
  for (let dir = process.cwd(), i = 0; i < 4; i++, dir = path.dirname(dir)) {
    const pkgDir = path.join(dir, "node_modules", "agent-browser");
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
      const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["agent-browser"] ?? Object.values(pkg.bin ?? {})[0];
      if (typeof rel === "string") { const p = path.join(pkgDir, rel); return /\.(c|m)?js$/.test(p) ? { file: process.execPath, pre: [p] } : { file: p, pre: [] }; }
    } catch { /* try parent folder */ }
  }
  return null;
}
export function splitArgs(s: string): string[] {
  const out: string[] = []; const re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}
export async function runBrowser(a: Record<string, unknown>): Promise<ToolResult> {
  const bin = resolveBin();
  if (!bin) throw new ToolError("unavailable", "agent-browser is not installed on the device. In the project folder run: npm i agent-browser -w @opencommander/agent --save-exact  then  npx agent-browser install");
  const argv = splitArgs(a.args as string); if (!argv.length) throw new ToolError("bad_arguments", "args is empty");
  return await new Promise<ToolResult>((resolve, reject) => {
    execFile(bin.file, [...bin.pre, ...argv], { timeout: 70_000, maxBuffer: 4_000_000, windowsHide: true, env: childEnv() }, (err, stdout, stderr) => {
      if (err && (err as any).killed) return reject(new ToolError("timeout", "Browser command timed out after 70 s"));
      const text = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}${err ? `\n[exit code ${(err as any).code ?? "error"}]` : ""}`;
      const b = boundText(text.trim() || "(no output)"); resolve({ text: b.text, truncated: b.truncated });
    });
  });
}