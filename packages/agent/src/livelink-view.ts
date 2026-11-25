// Visible Live Link window: replays the room's JSONL event log and renders members, tasks and the chat live.
import fs from "node:fs";
import path from "node:path";
import { clip, vw } from "./ui.js";
import { llDir } from "./livelink.js";

const E = "\x1b[", R = `${E}0m`, B = `${E}1m`, DIM = `${E}2m`;
const fg = (n: number) => `${E}38;5;${n}m`;
const PALETTE = [75, 213, 114, 215, 141, 80, 203, 185, 111, 177, 156, 209];
const STATE_ICON: Record<string, string> = { active: "💬", working: "🛠 ", planning: "🧠", reviewing: "🔍", testing: "🧪", waiting: "⏳", blocked: "⛔", idle: "💤", away: "🌙" };
const KIND_ICON: Record<string, string> = { say: "💬", ask: "❓", answer: "💡", report: "📋", plan: "🧭", decision: "✅", task: "📌", block: "⛔", share: "📎", handover: "📦" };
const TASK_ICON: Record<string, string> = { todo: "☐", doing: "◐", done: "✔", blocked: "✖" };

interface VMember { name: string; role: string; state: string; note: string; etaAt: number; color: number; sent: number; since: number; seen: number }
interface VMsg { t: number; from: string; to: string[]; kind: string; text: string }
interface VTask { id: number; title: string; owner: string; state: string; note: string }
class View {
  members = new Map<string, VMember>(); msgs: VMsg[] = []; tasks = new Map<number, VTask>(); lead = ""; order = 0; start = Date.now(); msgCount = 0;
  colors = new Map<string, number>(); handover: { giver: string; receiver: string; phase: string; title: string } | null = null;
  colorOf(name: string) { let c = this.colors.get(name); if (c === undefined) { c = PALETTE[this.colors.size % PALETTE.length]!; this.colors.set(name, c); } return c; }
  apply(ev: any) {
    switch (ev.type) {
      case "boot": this.members.clear(); this.tasks.clear(); this.lead = ""; this.msgs.push({ t: ev.t, from: "•", to: ["all"], kind: "system", text: "room started" }); break;
      case "join": this.members.set(ev.name, { name: ev.name, role: ev.role ?? "", state: "active", note: "", etaAt: 0, color: this.colorOf(ev.name), sent: 0, since: ev.t, seen: ev.t }); this.lead = ev.lead || this.lead; break;
      case "leave": this.members.delete(ev.name); if (this.lead === ev.name) this.lead = [...this.members.keys()][0] ?? ""; break;
      case "handover": this.handover = ev.phase === "done" ? null : { giver: ev.giver, receiver: ev.receiver, phase: ev.phase, title: ev.title ?? "" }; break;
      case "seen": { const m = this.members.get(ev.name); if (m) m.seen = ev.t; break; }
      case "status": { const m = this.members.get(ev.name); if (m) { if (m.state !== ev.state) m.since = ev.t; m.state = ev.state; m.note = ev.note ?? ""; m.etaAt = ev.etaAt ?? 0; } break; }
      case "task": this.tasks.set(ev.id, { id: ev.id, title: ev.title, owner: ev.owner, state: ev.state, note: ev.note }); break;
      case "msg": { this.msgs.push({ t: ev.t, from: ev.from, to: ev.to ?? ["all"], kind: ev.kind, text: ev.text }); if (this.msgs.length > 400) this.msgs.shift(); if (ev.kind !== "system") { this.msgCount++; const m = this.members.get(ev.from); if (m) m.sent++; } break; }
    }
  }
}

const wrap = (text: string, w: number): string[] => {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue;
      if (vw(line + word) <= w) { line += word; continue; }
      if (line.trim()) out.push(line.trimEnd());
      line = "";
      let rest = word.trimStart();
      while (vw(rest) > w) { let cut = ""; for (const ch of rest) { if (vw(cut + ch) > w) break; cut += ch; } out.push(cut); rest = rest.slice(cut.length); }
      line = rest;
    }
    out.push(line.trimEnd());
  }
  return out;
};
const pad = (s: string, w: number) => { const c = clip(s, w); return c + " ".repeat(Math.max(0, w - vw(c))); };
const hms = (t: number) => new Date(t).toLocaleTimeString("en-GB");
const mins = (ms: number) => (ms < 60_000 ? `${Math.floor(ms / 1000)}s` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 3_600_000)}h${Math.floor((ms % 3_600_000) / 60_000)}m`);

export function runLiveLinkViewer(roomArg?: string) {
  const dir = llDir(); fs.mkdirSync(dir, { recursive: true });
  const pidFile = path.join(dir, "viewer.pid");
  if (!process.stdout.isTTY) { console.error("Live Link needs a terminal window. Run livelink.bat."); process.exit(1); }
  try {
    const old = Number(fs.readFileSync(pidFile, "utf8"));
    if (old && old !== process.pid) {
      const fresh = Date.now() - fs.statSync(pidFile).mtimeMs < 8000;
      let alive = true; try { process.kill(old, 0); } catch { alive = false; }
      if (alive && fresh) { console.log("A Live Link window is already open."); return; }
      if (alive) { try { process.kill(old); } catch { /* not ours to kill */ } } // stale/hidden leftover
    }
  } catch { /* none */ }
  fs.writeFileSync(pidFile, String(process.pid));
  setInterval(() => { try { const t = new Date(); fs.utimesSync(pidFile, t, t); } catch { try { fs.writeFileSync(pidFile, String(process.pid)); } catch { /* ignore */ } } }, 2000).unref();
  let pinned = roomArg || ""; let current = ""; let offset = 0; let rest = ""; let view = new View(); let scroll = 0; let dirty = true;
  const files = () => { try { return fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => ({ room: f.slice(0, -6), m: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m); } catch { return []; } };
  const switchTo = (room: string) => { current = room; offset = 0; rest = ""; view = new View(); scroll = 0; dirty = true; };
  const poll = () => {
    const fl = files();
    const want = pinned || fl[0]?.room || "";
    if (want && want !== current) switchTo(want);
    if (!current) return;
    try {
      const f = path.join(dir, current + ".jsonl"); const st = fs.statSync(f);
      if (st.size < offset) switchTo(current);
      if (st.size > offset) {
        const fd = fs.openSync(f, "r"); const buf = Buffer.alloc(st.size - offset); fs.readSync(fd, buf, 0, buf.length, offset); fs.closeSync(fd); offset = st.size;
        const lines = (rest + buf.toString("utf8")).split("\n"); rest = lines.pop() ?? "";
        for (const l of lines) { if (!l) continue; try { view.apply(JSON.parse(l)); } catch { /* skip bad line */ } }
        dirty = true; if (scroll > 0) scroll = scroll; // keep position while reading history
      }
    } catch { /* file not ready */ }
  };
  const render = () => {
    const cols = process.stdout.columns || 100, rows = process.stdout.rows || 30;
    const wide = cols >= 84; const lw = wide ? Math.min(40, Math.max(30, Math.floor(cols * 0.3))) : 0; const rw = wide ? cols - lw - 1 : cols;
    const out: string[] = [];
    const nm = view.members.size;
    out.push(`${B}${fg(111)} 🔗 LIVE LINK ${R}${DIM} room${R} ${B}${current || "-"}${R}${DIM}  ·  ${R}👥 ${nm}${DIM}  ·  ${R}💬 ${view.msgCount}${DIM}  ·  ${R}📌 ${[...view.tasks.values()].filter((t) => t.state !== "done").length} open${DIM}  ·  up ${mins(Date.now() - view.start)}${R}`);
    const ho = view.handover;
    out.push(ho ? `${B}${fg(221)} 📦 HANDOVER${R} ${fg(view.colorOf(ho.giver))}${ho.giver || "?"}${R} ${DIM}→${R} ${fg(view.colorOf(ho.receiver))}${ho.receiver || "?"}${R}${DIM}  ·  phase: ${R}${B}${ho.phase}${R}${ho.title ? `${DIM}  ·  ${ho.title}${R}` : ""}` : `${DIM}${"─".repeat(cols)}${R}`);
    const body = rows - 4;
    // left panel
    const left: string[] = [];
    left.push(`${B}${DIM}MEMBERS${R}`);
    if (!nm) left.push(`${DIM}  nobody here yet. Waiting for AIs to join…${R}`);
    for (const m of view.members.values()) {
      const eta = m.etaAt > Date.now() ? ` · eta ${mins(m.etaAt - Date.now())}` : "";
      left.push(`${fg(m.color)}●${R} ${B}${fg(m.color)}${m.name}${R}${m.name === view.lead ? " ★" : ""}`);
      left.push(`${DIM}  ${m.role || "member"}${R}`);
      const quiet = m.state !== "waiting" && m.state !== "away" && Date.now() - m.seen > 90_000 ? ` · ${fg(214)}silent ${mins(Date.now() - m.seen)}${R}` : "";
      left.push(`  ${STATE_ICON[m.state] ?? "•"} ${m.state}${DIM} ${mins(Date.now() - m.since)}${eta} · ${m.sent} msg${quiet}${R}`);
      if (m.note) left.push(`${DIM}  ${m.note}${R}`);
    }
    left.push("", `${B}${DIM}TASKS${R}`);
    const tasks = [...view.tasks.values()]; if (!tasks.length) left.push(`${DIM}  none${R}`);
    for (const t of tasks.slice(-12)) { const c = t.owner ? view.colorOf(t.owner) : 244; left.push(`${fg(c)}${TASK_ICON[t.state] ?? "?"}${R} T${t.id} ${t.state === "done" ? DIM : ""}${t.title}${R}${DIM}${t.owner ? " · " + t.owner : ""}${R}`); }
    // chat
    const cw = Math.max(20, rw - 3); const chat: string[] = [];
    for (const m of view.msgs.slice(-200)) {
      if (m.kind === "system") { chat.push(`${DIM}  ${hms(m.t)}  — ${m.text} —${R}`, ""); continue; }
      const c = view.colorOf(m.from); const dst = m.to.includes("all") ? `${DIM}→ everyone${R}` : m.to.map((n) => `${fg(view.colorOf(n))}${n}${R}`).join(`${DIM}, ${R}`) .replace(/^/, `${DIM}→ ${R}`);
      chat.push(`${fg(c)}▌${R} ${DIM}${hms(m.t)}${R}  ${B}${fg(c)}${m.from}${R} ${dst}  ${KIND_ICON[m.kind] ?? "💬"}${m.kind === "say" ? "" : `${DIM} ${m.kind}${R}`}`);
      const wrapped = wrap(m.text, cw);
      for (const l of wrapped.slice(0, 80)) chat.push(`${fg(c)}▌${R}  ${l}`);
      if (wrapped.length > 80) chat.push(`${fg(c)}▌${R}  ${DIM}… +${wrapped.length - 80} more lines (full text in the transcript)${R}`);
      chat.push("");
    }
    const maxScroll = Math.max(0, chat.length - body); if (scroll > maxScroll) scroll = maxScroll;
    const shown = chat.slice(Math.max(0, chat.length - body - scroll), chat.length - scroll);
    while (shown.length < body) shown.unshift("");
    if (!wide) { // narrow: one line of members above the chat
      out.push(pad([...view.members.values()].map((m) => `${fg(m.color)}●${R}${m.name} ${STATE_ICON[m.state] ?? ""}`).join("  ") || `${DIM}nobody here yet${R}`, cols));
      for (let i = 0; i < body - 1; i++) out.push(pad(shown[i + 1] ?? "", cols));
    } else for (let i = 0; i < body; i++) out.push(pad(left[i] ?? "", lw) + `${DIM}│${R}` + pad(shown[i] ?? "", rw));
    out.push(`${DIM}${"─".repeat(cols)}${R}`);
    out.push(`${DIM} q quit · PgUp/PgDn/Home/End scroll · n next room${scroll ? `  ·  ↑ scrolled ${scroll} lines` : ""}${R}`);
    process.stdout.write(`${E}H` + out.slice(0, rows).map((l) => l + `${E}K`).join("\r\n"));
  };
  const cleanup = () => { try { fs.unlinkSync(pidFile); } catch { /* gone */ } process.stdout.write(`${E}?25h${E}?1049l`); };
  process.stdout.write(`${E}?1049h${E}?25l${E}2J`);
  const timer = setInterval(() => { poll(); render(); }, 500);
  const quit = () => { clearInterval(timer); cleanup(); process.exit(0); };
  process.on("SIGINT", quit); process.on("SIGTERM", quit); process.on("exit", () => { try { fs.unlinkSync(pidFile); } catch { /* gone */ } });
  process.stdout.on("resize", () => { process.stdout.write(`${E}2J`); dirty = true; });
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true); process.stdin.resume();
    process.stdin.on("data", (d) => {
      const k = d.toString();
      if (k === "\x03" || k === "q" || k === "Q") quit();
      else if (k === "\x1b[5~") scroll += 8; else if (k === "\x1b[6~") scroll = Math.max(0, scroll - 8);
      else if (k === "\x1b[H" || k === "\x1b[1~") scroll = 99999; else if (k === "\x1b[F" || k === "\x1b[4~") scroll = 0;
      else if (k === "n" || k === "N") { const fl = files(); if (fl.length) { const i = fl.findIndex((f) => f.room === current); pinned = fl[(i + 1) % fl.length]!.room; switchTo(pinned); } }
      render();
    });
  }
  poll(); render(); void dirty;
}
