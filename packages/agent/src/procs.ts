import { spawn, execFile, type ChildProcess } from "node:child_process";
import { ToolError, boundText } from "@opencommander/shared";
import { resolveInWorkspace } from "./paths.js";
import type { ToolCtx, ToolResult } from "./tools.js";

type Args = Record<string, unknown>;
const MAX_SESSIONS = 16, BUF_MAX = 1_000_000, LIFETIME_MS = 4 * 3600_000, MAX_WAIT = 10_000, CHUNK = 200_000;
interface Sess { child: ChildProcess; pid: number; command: string; started: number; out: string; base: number; readPos: number; exited: boolean; code: number | null }
const sessions = new Map<number, Sess>(); let fake = 0;
const win = process.platform === "win32";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let extraBlocked: string[] = [];
export const setBlocked = (l: string[]) => { extraBlocked = l; };

// Best-effort safety net against catastrophic commands and against reading the agent's own credentials.
const BLOCKED: [RegExp, string][] = [
  [/(^|[;&|(\s])format(\.com)?\s+[a-z]:|\bFormat-Volume\b|\bdiskpart\b|\bbcdedit\b|\bvssadmin\b|\bcipher\s+\/w\b|\bClear-Disk\b|\bInitialize-Disk\b/i, "disk-destroying command"],
  [/(^|[;&|(\s])shutdown(\.exe)?\s|\bRestart-Computer\b|\bStop-Computer\b/i, "shutting down the PC"],
  [/\b(rm|rmdir|rd|del|erase|Remove-Item|ri)\b[^\n]*(?:^|[\s'"])(?:[a-z]:[\\/]?|\/|~|\$env:(?:userprofile|systemroot|windir|programfiles)[\\/]?|%(?:userprofile|systemroot|windir|programfiles)%[\\/]?)(?=$|[\s'";|&])/i, "deleting a drive/system/profile root"],
  [/device\.json|\b(?:OC|DCF)_[A-Z_]+|\.wrangler|xdg\.config/i, "agent credentials"],
];

/** Environment for child processes: everything except the agent's own OC_* secrets. */
export function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^OC_/i.test(k)) env[k] = v;
  return env;
}
export const run = (file: string, args: string[], ms = 10_000) =>
  new Promise<string>((res) => execFile(file, args, { timeout: ms, windowsHide: true, maxBuffer: 4_000_000 }, (e, out, err) => res((out || "") + (err || "") || (e ? String(e.message) : ""))));

function add(s: Sess, d: string) { s.out += d; if (s.out.length > BUF_MAX) { const cut = s.out.length - BUF_MAX; s.out = s.out.slice(cut); s.base += cut; } }
const waitMs = (a: Args) => Math.min(Math.max(Math.floor((a.wait_ms as number | undefined) ?? 2500), 0), MAX_WAIT);
async function settle(s: Sess, ms: number) {
  const t0 = Date.now(); let last = Date.now(); let len = s.base + s.out.length;
  while (!s.exited && Date.now() - t0 < ms) {
    await sleep(100);
    const l = s.base + s.out.length;
    if (l !== len) { len = l; last = Date.now(); } else if (len > s.readPos && Date.now() - last >= 600) break;
  }
}
function drain(s: Sess, tail?: number): ToolResult {
  const status = s.exited ? `[exited code=${s.code}]` : `[running pid=${s.pid}]`;
  let text: string;
  if (tail) text = s.out.split(/\r?\n/).slice(-tail).join("\n");
  else { const from = Math.max(s.readPos, s.base) - s.base; const chunk = s.out.slice(from, from + CHUNK); s.readPos = s.base + from + chunk.length; text = chunk; }
  const b = boundText(`${status}\n${text}`); return { text: b.text, truncated: b.truncated };
}
function killTree(pid: number) {
  if (pid <= 0) return;
  if (win) execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
  else { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
}
function prune() { for (const [pid, s] of sessions) if (s.exited && Date.now() - s.started > 600_000) sessions.delete(pid); }
const get = (a: Args) => { const s = sessions.get(Math.floor(a.pid as number)); if (!s) throw new ToolError("process_not_found", "No such session. Use list_sessions."); return s; };

export async function startProcess(ctx: ToolCtx, a: Args): Promise<ToolResult> {
  const command = a.command as string;
  for (const [re, why] of BLOCKED) if (re.test(command)) throw new ToolError("blocked", `Command blocked: ${why}`);
  for (const sub of extraBlocked) if (sub && command.toLowerCase().includes(sub.toLowerCase())) throw new ToolError("blocked", "Command matches a blockedCommands entry");
  prune();
  if ([...sessions.values()].filter((x) => !x.exited).length >= MAX_SESSIONS) throw new ToolError("limit", "Too many running sessions; terminate some first");
  const cwd = await resolveInWorkspace(ctx.roots, (a.cwd as string | undefined) ?? ctx.roots[0]!, ctx.flavor);
  const sh = (a.shell as string | undefined) ?? "powershell";
  let file: string, argv: string[], verbatim = false;
  if (!win) { file = "bash"; argv = ["-c", command]; }
  else if (sh === "cmd") { file = "cmd.exe"; argv = ["/d", "/s", "/c", `"${command}"`]; verbatim = true; }
  else { file = "powershell.exe"; argv = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; " + command]; }
  const child = spawn(file, argv, { cwd, env: childEnv(), windowsHide: true, windowsVerbatimArguments: verbatim, stdio: ["pipe", "pipe", "pipe"] });
  const s: Sess = { child, pid: child.pid ?? -(++fake), command, started: Date.now(), out: "", base: 0, readPos: 0, exited: false, code: null };
  child.stdout!.setEncoding("utf8"); child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (d: string) => add(s, d)); child.stderr!.on("data", (d: string) => add(s, d));
  child.stdin!.on("error", () => {});
  child.on("error", (e) => { add(s, `[spawn error: ${e.message}]\n`); s.exited = true; s.code = -1; });
  child.on("exit", (code) => setTimeout(() => { s.exited = true; s.code = code; }, 150));
  setTimeout(() => { if (!s.exited) killTree(s.pid); }, LIFETIME_MS).unref();
  sessions.set(s.pid, s);
  if (process.env.OC_PRETTY === "1") console.log(`            $ ${command.slice(0, 200)}   (pid ${s.pid}, in ${cwd})`);
  await settle(s, waitMs(a));
  return drain(s);
}
export async function readOutput(a: Args): Promise<ToolResult> {
  const s = get(a); const tail = a.lines as number | undefined;
  if (!tail) await settle(s, waitMs(a));
  return drain(s, tail ? Math.floor(tail) : undefined);
}
export async function interact(a: Args): Promise<ToolResult> {
  const s = get(a); if (s.exited) throw new ToolError("bad_arguments", "Process has already exited");
  s.child.stdin!.write((a.input as string) + "\n");
  await sleep(150); await settle(s, waitMs(a));
  return drain(s);
}
export async function terminate(a: Args): Promise<ToolResult> {
  const s = get(a); killTree(s.pid); await sleep(300);
  return { text: `Terminate signal sent to ${s.pid}`, truncated: false };
}
export function listSessions(): ToolResult {
  prune();
  const rows = [...sessions.values()].map((s) => `${s.pid}\t${s.exited ? `exited(${s.code})` : "running"}\t${Math.round((Date.now() - s.started) / 1000)}s\t${s.command.slice(0, 80)}`);
  return { text: rows.join("\n") || "(no sessions)", truncated: false };
}
export async function listProcesses(): Promise<ToolResult> {
  let rows: string[];
  if (win) rows = (await run("tasklist", ["/fo", "csv", "/nh"])).split(/\r?\n/).map((l) => /^"([^"]*)","(\d+)","[^"]*","\d+","([^"]*)"/.exec(l)).filter(Boolean).map((m) => `${m![2]}\t${m![1]}\t${m![3]}`);
  else rows = (await run("ps", ["-eo", "pid,comm,rss"])).split(/\r?\n/).slice(1).filter(Boolean);
  const b = boundText("pid\tname\tmemory\n" + rows.slice(0, 400).join("\n")); return { text: b.text, truncated: b.truncated || rows.length > 400 };
}
export async function killProcess(a: Args): Promise<ToolResult> {
  const pid = Math.floor(a.pid as number);
  if (pid === process.pid || pid === process.ppid) throw new ToolError("blocked", "Refusing to kill the agent itself");
  if (pid <= 4) throw new ToolError("blocked", "Refusing to kill a system process");
  let out: string;
  if (win) out = await run("taskkill", ["/PID", String(pid), "/T", "/F"]);
  else { try { process.kill(pid, "SIGKILL"); out = "killed"; } catch (e: any) { out = String(e?.message); } }
  return { text: out.trim().slice(0, 2000) || "done", truncated: false };
}