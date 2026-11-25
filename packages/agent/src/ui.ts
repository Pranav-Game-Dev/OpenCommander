import fs from "node:fs";
import { appFile } from "./appdir.js";
import os from "node:os";
import path from "node:path";
import { CF_DAILY_REQUEST_LIMIT } from "@opencommander/shared";

// ───────────────────────── terminal helpers ─────────────────────────
const E = "\x1b[";
const R = `${E}0m`, B = `${E}1m`, DIM = `${E}2m`;
const fg = (n: number) => `${E}38;5;${n}m`;
const bg = (n: number) => `${E}48;5;${n}m`;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const EMOJI = /\p{Extended_Pictographic}/u;
/** Visible width: ANSI ignored, emoji/CJK = 2 columns, variation selectors/ZWJ = 0. */
export function vw(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI, "")) {
    const c = ch.codePointAt(0)!;
    if (c === 0xfe0f || c === 0x200d || (c >= 0x300 && c < 0x370)) continue;
    w += EMOJI.test(ch) || (c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xff00 && c <= 0xff60))) ? 2 : 1;
  }
  return w;
}
/** Truncate to `w` visible columns (keeps ANSI codes intact), adding an ellipsis. */
export function clip(s: string, w: number): string {
  if (vw(s) <= w) return s;
  let out = "", cur = 0; const parts = s.split(/(\x1b\[[0-9;?]*[A-Za-z])/);
  for (const part of parts) {
    if (/^\x1b\[/.test(part)) { out += part; continue; }
    for (const ch of part) { const cw = vw(ch); if (cur + cw > w - 1) return out + "…" + R; out += ch; cur += cw; }
  }
  return out;
}
const pad = (s: string, w: number) => { const c = clip(s, w); return c + " ".repeat(Math.max(0, w - vw(c))); };
const num = (n: number) => n.toLocaleString("en-US");
const hhmmss = (t: number) => new Date(t).toLocaleTimeString("en-GB");
const dur = (ms: number) => { const s = Math.round(ms / 1000); if (s < 60) return `${s}s`; const m = Math.floor(s / 60); if (m < 60) return `${m}m ${s % 60}s`; const h = Math.floor(m / 60); return `${h}h ${m % 60}m`; };
const ago = (t: number) => { const s = Math.round((Date.now() - t) / 1000); return s < 5 ? "just now" : `${dur(s * 1000)} ago`; };

// ───────────────────────── what each tool looks like ─────────────────────────
const HOME = os.homedir();
const short = (p: unknown) => { const s = String(p ?? ""); return s.startsWith(HOME) ? "~" + s.slice(HOME.length) : s; };
const first = (v: unknown) => String(v ?? "").split(/\r?\n/).filter(Boolean)[0] ?? "";
const count = (v: unknown) => String(v ?? "").split(/\r?\n/).filter(Boolean).length;
const one = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();
type Fmt = [emoji: string, title: string, detail: (a: any) => string];
const TOOLS: Record<string, Fmt> = {
  list_directory: ["📂", "Listing folder", (a) => short(a.path)],
  read_file: ["📖", "Reading file", (a) => short(a.path)],
  read_multiple_files: ["📚", "Reading files", (a) => `${count(a.paths)} files · ${short(first(a.paths))}`],
  write_file: ["📝", "Writing file", (a) => `${short(a.path)} · ${String(a.content ?? "").length} chars${a.mode === "append" ? " (append)" : ""}`],
  edit_block: ["🔧", "Editing file", (a) => short(a.path)],
  search: ["🔎", "Searching", (a) => `"${one(a.pattern)}" in ${short(a.path)}`],
  get_file_info: ["🧾", "File info", (a) => short(a.path)],
  create_directory: ["📁", "Creating folder", (a) => short(a.path)],
  move_file: ["🚚", "Moving", (a) => `${short(a.source)} → ${short(a.destination)}`],
  copy_file: ["📋", "Copying", (a) => `${short(a.source)} → ${short(a.destination)}`],
  delete_path: ["🔥", "Deleting", (a) => short(a.path)],
  start_process: ["⚡", "Running command", (a) => one(a.command)],
  read_process_output: ["📟", "Reading process output", (a) => `pid ${a.pid}`],
  interact_with_process: ["💬", "Typing into process", (a) => `pid ${a.pid} · ${one(a.input).slice(0, 80)}`],
  force_terminate: ["🛑", "Stopping process", (a) => `pid ${a.pid}`],
  kill_process: ["💀", "Killing process", (a) => `pid ${a.pid}`],
  list_sessions: ["📑", "Listing sessions", () => ""],
  list_processes: ["📊", "Listing processes", () => ""],
  http_request: ["🌐", "HTTP request", (a) => `${a.method ?? "GET"} ${a.url}`],
  browser: ["🧭", "Browser", (a) => one(a.args)],
  mcp_servers: ["🔌", "Checking local apps", (a) => (a.check ? "active check" : "")],
  mcp_list_tools: ["🧰", "Listing app tools", (a) => String(a.server ?? "")],
  mcp_call: ["🎯", "Controlling app", (a) => `${a.server} → ${a.tool}`],
  read_image: ["📷", "Viewing image", (a) => short(a.path)],
  image_grid: ["🖼️", "Image grid", (a) => short(a.folder ?? String(a.paths ?? "").split(/\r?\n/)[0])],
  live_link: ["🔗", "Live Link", (a) => `${a.action ?? ""}${a.op ? ` ${a.op}` : ""}${a.me ? ` · ${a.me}` : a.name ? ` · ${a.name}` : ""}${a.to ? ` → ${a.to}` : ""}${a.text ? `: ${short(String(a.text))}` : ""}`],
  capture_screen: ["📸", "Capturing screen", (a) => String(a.screen ?? "primary")],
  convert_file: ["🔄", "Converting file", (a) => (a.action === "presets" ? "listing presets" : `${short(first(a.input))} → ${a.preset ?? a.to ?? "?"}`)],
  archive: ["📦", "Archive", (a) => `${a.action} · ${short(a.archive)}`],
  system_info: ["🩺", "System info", () => ""],
  get_config: ["🛠", "Reading config", () => ""],
  set_config_value: ["🧩", "Changing config", (a) => String(a.key ?? "")],
  get_usage_stats: ["📈", "Usage stats", () => ""],
  get_recent_tool_calls: ["🕑", "Recent calls", () => ""],
  shutdown: ["🔴", "Shutting down agent", () => ""],
};
const fmtTool = (tool: string, args: unknown): { emoji: string; title: string; detail: string } => {
  const f = TOOLS[tool]; const a = args && typeof args === "object" ? args : {};
  try { return f ? { emoji: f[0], title: f[1], detail: f[2](a) } : { emoji: "❓", title: tool, detail: "" }; } catch { return { emoji: "❓", title: tool, detail: "" }; }
};

// ───────────────────────── state ─────────────────────────
const PALETTE = [75, 213, 114, 215, 141, 80, 203, 185, 111, 177, 156, 209];
interface Conn { id: string; label: string; color: number; calls: number; errors: number; last: number; busy: number }
interface Entry { id: string; t: number; kind: "call" | "sys"; connId: string; emoji: string; title: string; detail: string; status: "run" | "ok" | "fail"; ms?: number; note?: string; sysColor?: number }
interface Remote { day: string; month: string; today: { req: number; calls: number }; thisMonth: { req: number; calls: number }; conns: Record<string, { label: string; req: number; calls: number; errors: number; last: number }> }
export interface DashOpts { brand: string; gateway: string; device: string; adminToken?: string; onQuit: () => void }

const colorFile = () => appFile("ui-colors.json");
const closeReason = (c: unknown) => c === 1006 ? "network dropped the idle link" : c === 1000 ? "gateway restarted or replaced the link" : c === 1001 ? "gateway going away" : `code ${c}`;

export class Dashboard {
  private conns = new Map<string, Conn>(); private feed: Entry[] = []; private colors: Record<string, number> = {};
  private online = false; private since = 0; private downAt = 0; private reconnects = 0; private started = Date.now();
  private calls = 0; private errors = 0; private totalMs = 0; private perTool = new Map<string, number>();
  private remote: Remote | null = null; private remoteErr = ""; private scroll = 0; private paused = false;
  private timer: NodeJS.Timeout | null = null; private poll: NodeJS.Timeout | null = null; private tick: NodeJS.Timeout | null = null; private dirty = true;
  constructor(private o: DashOpts) { try { this.colors = JSON.parse(fs.readFileSync(colorFile(), "utf8")); } catch { /* first run */ } }

  start() {
    const out = process.stdout;
    out.write(`${E}?1049h${E}?25l`);
    out.on("resize", () => this.draw());
    process.on("exit", () => this.stop()); // always give the terminal back, even on a crash
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true); process.stdin.resume();
      process.stdin.on("data", (d) => this.key(d.toString()));
    }
    this.tick = setInterval(() => { this.dirty = true; this.draw(); }, 1000);
    void this.fetchRemote(); this.poll = setInterval(() => void this.fetchRemote(), 15_000);
    this.draw();
  }
  stop() {
    if (this.tick) clearInterval(this.tick); if (this.poll) clearInterval(this.poll);
    if (process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch { /* ignore */ } }
    process.stdout.write(`${E}?25h${E}?1049l`);
  }
  private key(s: string) {
    if (s === "\x03" || s === "q") return this.o.onQuit();
    if (s === "c") { this.feed = []; this.scroll = 0; }
    else if (s === "\x1b[5~") this.scroll += 5; else if (s === "\x1b[6~") this.scroll = Math.max(0, this.scroll - 5);
    else if (s === "\x1b[H") this.scroll = 9999; else if (s === "\x1b[F") this.scroll = 0;
    else if (s === "p") this.paused = !this.paused;
    this.dirty = true; this.draw();
  }

  private async fetchRemote() {
    if (!this.o.adminToken) { this.remoteErr = "set OC_ADMIN_TOKEN for usage totals"; return; }
    try {
      const r = await fetch(this.o.gateway + "/admin/stats", { headers: { Authorization: `Bearer ${this.o.adminToken}` }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.remote = (await r.json()) as Remote; this.remoteErr = "";
    } catch (e: any) { this.remoteErr = `usage unavailable (${String(e?.message ?? e).slice(0, 40)})`; }
    this.dirty = true;
  }

  private colorFor(id: string): number {
    if (this.colors[id] !== undefined) return this.colors[id]!;
    const used = new Set(Object.values(this.colors)); const c = PALETTE.find((p) => !used.has(p)) ?? PALETTE[Object.keys(this.colors).length % PALETTE.length]!;
    this.colors[id] = c; try { fs.mkdirSync(path.dirname(colorFile()), { recursive: true }); fs.writeFileSync(colorFile(), JSON.stringify(this.colors)); } catch { /* cosmetic */ }
    return c;
  }
  private conn(caller: any): Conn {
    const id = String(caller?.id ?? "unknown"), label = String(caller?.label ?? "Unknown");
    let c = this.conns.get(id);
    if (!c) { c = { id, label, color: this.colorFor(id), calls: 0, errors: 0, last: 0, busy: 0 }; this.conns.set(id, c); }
    c.label = label; return c;
  }
  private sys(text: string, color = 244) { this.feed.push({ id: "", t: Date.now(), kind: "sys", connId: "", emoji: "", title: text, detail: "", status: "ok", sysColor: color }); this.trim(); }
  private trim() { if (this.feed.length > 500) this.feed.splice(0, this.feed.length - 500); }

  /** Feed agent log events in. */
  event(e: Record<string, unknown>) {
    switch (e.ev) {
      case "connected": {
        if (this.downAt) this.sys(`↻ link restored after ${dur(Date.now() - this.downAt)}`, 114); else this.sys("● connected to gateway", 114);
        this.online = true; this.since = Date.now(); this.downAt = 0; break;
      }
      case "disconnected": {
        this.online = false; if (!this.downAt) this.downAt = Date.now(); this.reconnects++;
        this.sys(`↻ ${closeReason(e.code)} — reconnecting`, 215); break;
      }
      case "call": {
        const c = this.conn(e.caller); c.calls++; c.busy++; c.last = Date.now(); this.calls++; this.perTool.set(String(e.tool), (this.perTool.get(String(e.tool)) ?? 0) + 1);
        const f = fmtTool(String(e.tool), e.args);
        this.feed.push({ id: String(e.id), t: Date.now(), kind: "call", connId: c.id, emoji: f.emoji, title: f.title, detail: f.detail, status: "run" }); this.trim(); break;
      }
      case "call_done": {
        const en = [...this.feed].reverse().find((x) => x.id === e.id); const c = this.conns.get(String((e.caller as any)?.id ?? "unknown")) ?? this.conn(e.caller);
        c.busy = Math.max(0, c.busy - 1); c.last = Date.now(); this.totalMs += Number(e.ms) || 0;
        if (!e.ok) { c.errors++; this.errors++; }
        if (en) { en.status = e.ok ? "ok" : "fail"; en.ms = Number(e.ms); en.note = e.ok ? undefined : `${e.code}${e.detail ? `: ${e.detail}` : ""}`; }
        break;
      }
      case "starting": case "heartbeat_lost": case "ws_error": case "upgrade_failed": case "auth_rejected":
        if (e.ev !== "starting") this.sys(`⚠ ${e.ev}${e.status ? ` ${e.status}` : ""}`, 203); break;
      default: break;
    }
    this.dirty = true; this.schedule();
  }
  private schedule() { if (this.timer) return; this.timer = setTimeout(() => { this.timer = null; this.draw(); }, 60); }

  // ───────────────────────── rendering ─────────────────────────
  private left(w: number): string[] {
    const L: string[] = []; const head = (t: string) => L.push(`${B}${fg(252)}${t}${R}`);
    const rc = this.remote?.conns ?? {}; const ids = new Set<string>([...this.conns.keys(), ...Object.keys(rc)]);
    const rows = [...ids].map((id) => {
      const l = this.conns.get(id); const r = rc[id];
      return { id, label: l?.label ?? r?.label ?? id, color: l?.color ?? this.colorFor(id), session: l?.calls ?? 0, total: Math.max(r?.calls ?? 0, l?.calls ?? 0), errors: Math.max(r?.errors ?? 0, l?.errors ?? 0), last: Math.max(l?.last ?? 0, r?.last ?? 0), busy: l?.busy ?? 0 };
    }).filter((x) => x.id !== "legacy" || x.total > 0).sort((a, b) => b.last - a.last);
    const STALE = 30 * 60_000; const live = rows.filter((x) => x.busy || Date.now() - x.last < STALE); const gone = rows.length - live.length;
    head(`CONNECTIONS (${live.length} active${gone ? ` · ${gone} inactive` : ""})`);
    if (!rows.length) L.push(`${DIM}none yet — connect an AI${R}`);
    for (const x of live.slice(0, 8)) {
      const active = Date.now() - x.last < 60_000; const dot = x.busy ? "◉" : active ? "●" : "○";
      L.push(`${fg(x.color)}${dot} ${B}${x.label}${R}${DIM}  ${num(x.total)} calls${x.errors ? ` · ${x.errors} err` : ""}${R}`);
      L.push(`${DIM}  ${x.busy ? `working (${x.busy})` : x.last ? `last ${ago(x.last)}` : "idle"}${x.session !== x.total ? ` · this session ${x.session}` : ""}${R}`);
    }
    if (live.length > 8) L.push(`${DIM}+${live.length - 8} more${R}`);
    for (const x of rows.filter((r) => !live.includes(r)).slice(0, 3)) L.push(`${DIM}✕ ${x.label}  inactive · ${x.last ? ago(x.last) : "never used"}${R}`);
    L.push("");
    head("USAGE · UTC day");
    const rm = this.remote;
    if (rm) {
      const frac = rm.today.req / CF_DAILY_REQUEST_LIMIT; const bw = Math.max(8, Math.min(24, w - 12)); const fill = Math.min(bw, Math.round(frac * bw));
      const col = frac < 0.6 ? 114 : frac < 0.85 ? 221 : 203;
      L.push(`${fg(col)}${"█".repeat(fill)}${R}${DIM}${"░".repeat(bw - fill)}${R} ${(frac * 100).toFixed(1)}%`);
      L.push(`Today  ${B}${num(rm.today.req)}${R} / ${num(CF_DAILY_REQUEST_LIMIT)} req`);
      L.push(`${DIM}       ${num(rm.today.calls)} tool calls${R}`);
      L.push(`Month  ${B}${num(rm.thisMonth.req)}${R} req · ${num(rm.thisMonth.calls)} calls`);
    } else L.push(`${DIM}${this.remoteErr || "loading…"}${R}`);
    if (rm && this.remoteErr) L.push(`${DIM}${this.remoteErr}${R}`);
    L.push("");
    head("THIS SESSION");
    L.push(`calls ${B}${num(this.calls)}${R}  errors ${this.errors ? fg(203) : ""}${this.errors}${R}  avg ${this.calls ? Math.round(this.totalMs / this.calls) : 0} ms`);
    L.push(`in flight ${B}${[...this.conns.values()].reduce((n, c) => n + c.busy, 0)}${R}  link resets ${this.reconnects}`);
    const top = [...this.perTool].sort((a, b) => b[1] - a[1]).slice(0, 4);
    if (top.length) { L.push(""); head("TOP TOOLS"); for (const [t, n] of top) L.push(`${fmtTool(t, {}).emoji} ${t} ${DIM}${n}${R}`); }
    return L.map((s) => pad(s, w));
  }

  private right(w: number, h: number): string[] {
    const blocks: string[][] = [];
    for (const en of this.feed) {
      if (en.kind === "sys") { blocks.push([`${fg(en.sysColor ?? 244)}▌${R} ${DIM}${hhmmss(en.t)}  ${en.title}${R}`]); continue; }
      const c = this.conns.get(en.connId); const col = c?.color ?? 244; const bar = `${fg(col)}▌${R}`;
      const status = en.status === "run" ? `${fg(221)}⏳ running…${R}` : en.status === "ok" ? `${fg(114)}✓ ${en.ms} ms${R}` : `${fg(203)}✗ ${en.note ?? "failed"}${R}`;
      const sw = vw(status.replace(ANSI, "")); const dw = Math.max(10, w - 3 - sw - 4);
      blocks.push([
        `${bar} ${DIM}${hhmmss(en.t)}${R}  ${en.emoji} ${fg(col)}${B}${c?.label ?? "?"}${R}  ${en.title}`,
        `${bar}    ${DIM}${clip(en.detail || "—", dw)}${R}  ${status}`,
      ]);
    }
    // newest at the bottom; one blank line between entries; PageUp/PageDown scroll
    const lines: string[] = []; for (const b of blocks) { lines.push(...b, ""); }
    if (lines.length) lines.pop();
    const maxScroll = Math.max(0, lines.length - h); this.scroll = Math.min(this.scroll, maxScroll);
    const view = lines.slice(Math.max(0, lines.length - h - this.scroll), lines.length - this.scroll);
    const filler = Array(Math.max(0, h - view.length)).fill("");
    if (!lines.length) filler[0] = `${DIM}Waiting for activity… ask an AI to use the tools.${R}`;
    return [...filler, ...view].map((s) => pad(s, w));
  }

  private draw() {
    if (!this.dirty && !this.timer) { /* periodic tick still refreshes clocks */ }
    const cols = process.stdout.columns || 100, rows = process.stdout.rows || 30; this.dirty = false;
    const status = this.online ? `${fg(114)}● ONLINE${R}` : `${fg(203)}● OFFLINE (reconnecting)${R}`;
    const topL = ` ${B}${this.o.brand}${R}  ${status}  ${DIM}${this.o.device} · up ${dur(Date.now() - (this.online ? this.since : this.started))}${R}`;
    const topR = `${DIM}${hhmmss(Date.now())} `;
    const top = `${bg(236)}${pad(topL, cols - vw(topR))}${topR}${R}`;
    const narrow = cols < 84; const bodyH = rows - 3;
    const lw = narrow ? 0 : Math.min(44, Math.max(34, Math.floor(cols * 0.34))); const rw = cols - lw - (narrow ? 0 : 3);
    const left = narrow ? [] : this.left(lw - 1);
    const hdrL = narrow ? "" : `${DIM}${"─".repeat(lw)}${R}`;
    const feedHead = `${B}${fg(252)}LIVE ACTIVITY${R}${this.scroll ? `${DIM}  (scrolled ${this.scroll} — End to follow)${R}` : ""}`;
    const right = this.right(rw - 1, bodyH - 1);
    const out: string[] = [top];
    out.push(narrow ? pad(feedHead, cols) : `${pad(left[0] ?? "", lw - 1)} ${DIM}│${R} ${pad(feedHead, rw - 1)}`);
    for (let i = 0; i < bodyH - 1; i++) {
      if (narrow) out.push(pad(right[i] ?? "", cols));
      else out.push(`${pad(left[i + 1] ?? "", lw - 1)} ${DIM}│${R} ${right[i] ?? " ".repeat(rw - 1)}`);
    }
    void hdrL;
    out.push(`${bg(236)}${pad(` ${DIM}Ctrl+C quit · c clear · PgUp/PgDn scroll · End follow${R}`, cols)}${R}`);
    process.stdout.write(`${E}H${out.slice(0, rows).map((l) => l + `${E}K`).join("\n")}${E}J`);
  }
}
