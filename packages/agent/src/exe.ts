import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import { ToolError } from "@opencommander/shared";
import { childEnv } from "./procs.js";

export const fileExists = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** Locate a tool: env override, then the usual install path(s). Throws a clear "unavailable" error. */
export function needExe(label: string, envVar: string, candidates: string[]): string {
  const c = [process.env[envVar], ...candidates].filter((x): x is string => !!x);
  for (const p of c) if (fileExists(p)) return p;
  throw new ToolError("unavailable", `${label} was not found (looked in: ${c.join("; ")}). Install it or set ${envVar} to its full path.`);
}

export function killTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === "win32") execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
  else { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
}

/** Run a program without a shell, merge stdout+stderr (bounded), kill it after `ms`. */
export function runBounded(file: string, args: string[], ms: number, opts: { cwd?: string; hide?: boolean; env?: Record<string, string> } = {}): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let out = ""; let timedOut = false; let done = false;
    const child = spawn(file, args, { cwd: opts.cwd, env: { ...childEnv(), ...(opts.env ?? {}) }, windowsHide: opts.hide !== false, stdio: ["ignore", "pipe", "pipe"] });
    const add = (d: Buffer) => { if (out.length < 400_000) out += d.toString("utf8"); };
    child.stdout.on("data", add); child.stderr.on("data", add);
    const finish = (code: number | null) => { if (done) return; done = true; clearTimeout(t); resolve({ code, out, timedOut }); };
    const t = setTimeout(() => { timedOut = true; killTree(child.pid); setTimeout(() => finish(null), 1500); }, ms);
    child.on("error", (e) => { out += `\n[spawn error: ${e.message}]`; finish(null); });
    child.on("close", (code) => finish(code));
  });
}
