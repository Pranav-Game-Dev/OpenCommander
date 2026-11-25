// Small terminal UI kit for the manage console: framed screens, arrow-key menus, checklists, prompts.
import readline from "node:readline";
import { clip, vw } from "./ui.js";

const E = "\x1b[";
export const S = { r: `${E}0m`, b: `${E}1m`, dim: `${E}2m`, inv: `${E}7m`, fg: (n: number) => `${E}38;5;${n}m`, bg: (n: number) => `${E}48;5;${n}m` };
export const TONE = { acc: 111, ok: 114, warn: 221, bad: 203, mut: 244, hot: 215 };
export const tint = (n: number, s: string) => `${S.fg(n)}${s}${S.r}`;
export const bold = (s: string) => `${S.b}${s}${S.r}`;
export const dim = (s: string) => `${S.dim}${s}${S.r}`;
const pad = (s: string, w: number) => { const c = clip(s, w); return c + " ".repeat(Math.max(0, w - vw(c))); };

const chrome = { brand: "OpenCommander", status: "" };
export const setChrome = (c: Partial<typeof chrome>) => Object.assign(chrome, c);
const width = () => Math.max(64, Math.min(process.stdout.columns || 90, 100));
let first = true;

/** One full-screen frame: title bar, status line, body, footer keys. */
export function draw(title: string, body: string[], footer = ""): void {
  const w = width(), inner = w - 4, rows = process.stdout.rows || 30;
  const left = ` ◆ ${chrome.brand} `, right = ` ${title} `;
  const fill = Math.max(1, w - 2 - vw(left) - vw(right) - 2);
  const edge = (s: string) => dim(s);
  const out: string[] = [];
  out.push(`${edge("┌─")}${S.b}${S.fg(TONE.acc)}${left}${S.r}${edge("─".repeat(fill))}${S.b}${right}${S.r}${edge("─┐")}`);
  out.push(`${edge("│")} ${pad(chrome.status || dim("…"), inner)} ${edge("│")}`);
  out.push(edge(`├${"─".repeat(w - 2)}┤`));
  const room = Math.max(5, rows - 7);
  for (const l of body.slice(0, room)) out.push(`${edge("│")} ${pad(l, inner)} ${edge("│")}`);
  out.push(edge(`├${"─".repeat(w - 2)}┤`));
  out.push(`${edge("│")} ${pad(dim(footer), inner)} ${edge("│")}`);
  out.push(edge(`└${"─".repeat(w - 2)}┘`));
  process.stdout.write((first ? `${E}2J` : "") + `${E}H${E}?25l` + out.map((l) => l + `${E}K`).join("\n") + `${E}J`);
  first = false;
}
export const showCursor = () => process.stdout.write(`${E}?25h`);
export const clear = () => { first = true; };

// ───────── keys ─────────
readline.emitKeypressEvents(process.stdin);
export interface Key { name?: string; sequence: string; ctrl: boolean; shift: boolean }
export function readKey(): Promise<Key> {
  return new Promise((resolve) => {
    const stdin = process.stdin; stdin.setRawMode?.(true); stdin.resume();
    const on = (s: string | undefined, k: any) => {
      stdin.off("keypress", on); stdin.setRawMode?.(false); stdin.pause();
      const key: Key = { name: k?.name, sequence: s ?? k?.sequence ?? "", ctrl: !!k?.ctrl, shift: !!k?.shift };
      if (key.ctrl && key.name === "c") { showCursor(); process.stdout.write("\n"); process.exit(130); }
      resolve(key);
    };
    stdin.on("keypress", on);
  });
}
export async function pressAnyKey(msg = "Press any key to continue"): Promise<void> { process.stdout.write(`\n${dim(msg)}`); await readKey(); }

// ───────── menu ─────────
export interface Item { key: string; label: string; hint?: string; tone?: number; section?: boolean }
export async function menu(title: string, items: Item[], opts: { intro?: string[]; footer?: string; start?: string } = {}): Promise<string | null> {
  const sel = items.map((it, i) => (it.section ? -1 : i)).filter((i) => i >= 0);
  let at = Math.max(0, sel.findIndex((i) => items[i]!.key === opts.start));
  for (;;) {
    const body: string[] = [...(opts.intro ?? []), ...(opts.intro?.length ? [""] : [])];
    let n = 0;
    items.forEach((it, i) => {
      if (it.section) { body.push(`${n ? "" : ""}${dim("  " + it.label.toUpperCase())}`); return; }
      n++; const on = sel[at] === i; const num = n <= 9 ? String(n) : " ";
      const label = pad(it.label, 30);
      const line = `${on ? tint(TONE.acc, "▸") : " "} ${dim(num)} ${it.tone ? tint(it.tone, label) : label}${it.hint ? dim(it.hint) : ""}`;
      body.push(on ? `${S.bg(236)}${pad(line, width() - 4)}${S.r}` : line);
    });
    draw(title, body, opts.footer ?? "↑/↓ move · Enter select · 1-9 jump · Esc back");
    const k = await readKey();
    if (k.name === "up" || k.name === "k") at = (at - 1 + sel.length) % sel.length;
    else if (k.name === "down" || k.name === "j") at = (at + 1) % sel.length;
    else if (k.name === "home") at = 0; else if (k.name === "end") at = sel.length - 1;
    else if (k.name === "return") return items[sel[at]!]!.key;
    else if (k.name === "escape" || k.name === "q" || k.name === "left") return null;
    else if (/^[1-9]$/.test(k.sequence)) { const i = Number(k.sequence) - 1; if (i < sel.length) return items[sel[i]!]!.key; }
  }
}

// ───────── checklist ─────────
export interface CItem { key: string; label: string; hint?: string; group: string; tone?: number }
export interface Preset { key: string; label: string; pick: (it: CItem) => boolean }
export async function checklist(title: string, items: CItem[], initial: Iterable<string>, opts: { intro?: string[]; presets?: Preset[] } = {}): Promise<Set<string> | null> {
  const on = new Set(initial); let at = 0; const groups = [...new Set(items.map((i) => i.group))];
  const ordered = groups.flatMap((g) => items.filter((i) => i.group === g));
  for (;;) {
    const body: string[] = [...(opts.intro ?? [])]; if (opts.intro?.length) body.push("");
    const view: { line: string; idx: number }[] = [];
    let last = "";
    ordered.forEach((it, i) => {
      if (it.group !== last) { last = it.group; const gi = ordered.filter((x) => x.group === it.group); view.push({ line: `${dim("  " + it.group.toUpperCase())}${dim(`  ${gi.filter((x) => on.has(x.key)).length}/${gi.length} on`)}`, idx: -1 }); }
      const cur = i === at; const box = on.has(it.key) ? tint(TONE.ok, "[x]") : dim("[ ]");
      const text = `${cur ? tint(TONE.acc, "▸") : " "} ${box} ${pad(it.label, 26)}${dim(it.hint ?? "")}`;
      view.push({ line: cur ? `${S.bg(236)}${pad(text, width() - 4)}${S.r}` : text, idx: i });
    });
    const room = Math.max(6, (process.stdout.rows || 30) - 7 - body.length - 3);
    const pos = view.findIndex((v) => v.idx === at); const startAt = Math.max(0, Math.min(pos - Math.floor(room / 2), view.length - room));
    body.push(...view.slice(startAt, startAt + room).map((v) => v.line));
    body.push("", `${tint(TONE.ok, String(on.size))}${dim(` of ${items.length} enabled`)}${opts.presets?.length ? dim("   presets: " + opts.presets.map((p, i) => `${i + 1}=${p.label}`).join("  ")) : ""}`);
    draw(title, body, "↑/↓ move · Space toggle · G group · A all · N none · Enter save · Esc cancel");
    const k = await readKey();
    if (k.name === "up" || k.name === "k") at = (at - 1 + ordered.length) % ordered.length;
    else if (k.name === "down" || k.name === "j") at = (at + 1) % ordered.length;
    else if (k.name === "space") { const key = ordered[at]!.key; on.has(key) ? on.delete(key) : on.add(key); }
    else if (k.name === "g") { const g = ordered[at]!.group; const gi = ordered.filter((x) => x.group === g); const all = gi.every((x) => on.has(x.key)); gi.forEach((x) => (all ? on.delete(x.key) : on.add(x.key))); }
    else if (k.name === "a") ordered.forEach((x) => on.add(x.key));
    else if (k.name === "n") on.clear();
    else if (/^[1-9]$/.test(k.sequence) && opts.presets?.[Number(k.sequence) - 1]) { const p = opts.presets[Number(k.sequence) - 1]!; on.clear(); ordered.filter(p.pick).forEach((x) => on.add(x.key)); }
    else if (k.name === "return") return on;
    else if (k.name === "escape" || k.name === "q") return null;
  }
}

// ───────── prompts ─────────
export async function ask(title: string, lines: string[], label: string, def = "", opts: { secret?: boolean } = {}): Promise<string | null> {
  draw(title, [...lines, "", `${tint(TONE.acc, "›")} ${label}${def ? dim(` [${def}]`) : ""}`], "Enter confirm · Esc / empty = cancel");
  const rows = process.stdout.rows || 30; void rows;
  showCursor(); process.stdout.write(`${E}${Math.min(lines.length + 7, (process.stdout.rows || 30) - 2)};${vw(label) + 6}H`);
  if (opts.secret) {
    return await new Promise((resolve) => {
      let s = ""; const stdin = process.stdin; stdin.setRawMode?.(true); stdin.resume();
      const on = (ch: string | undefined, k: any) => {
        if (k?.ctrl && k.name === "c") { process.stdout.write("\n"); process.exit(130); }
        if (k?.name === "return") { stdin.off("keypress", on); stdin.setRawMode?.(false); stdin.pause(); return resolve(s || def || null); }
        if (k?.name === "escape") { stdin.off("keypress", on); stdin.setRawMode?.(false); stdin.pause(); return resolve(null); }
        if (k?.name === "backspace") { if (s) { s = s.slice(0, -1); process.stdout.write("\b \b"); } return; }
        if (ch && ch >= " ") { s += ch; process.stdout.write("•"); }
      };
      stdin.on("keypress", on);
    });
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return await new Promise((resolve) => {
    rl.on("SIGINT", () => { process.stdout.write("\n"); process.exit(130); });
    process.stdin.once("keypress", function esc(_s, k) { if (k?.name === "escape") { rl.close(); resolve(null); } });
    rl.question("", (a) => { rl.close(); resolve(a.trim() || def || null); });
  });
}
export async function confirm(title: string, lines: string[], q: string, tone = TONE.warn): Promise<boolean> {
  draw(title, [...lines, "", `${tint(tone, "?")} ${q} ${dim("(y / n)")}`], "Y = yes · N / Esc = no");
  for (;;) { const k = await readKey(); if (k.name === "y") return true; if (k.name === "n" || k.name === "escape" || k.name === "return") return false; }
}
export async function info(title: string, lines: string[], tone?: number): Promise<void> {
  draw(title, tone ? lines.map((l) => tint(tone, l)) : lines, "Press any key to continue");
  await readKey();
}
/** Leave the frame, let a child process print normally, then wait for a key. */
export async function liveOutput(title: string, run: () => Promise<void> | void): Promise<void> {
  showCursor(); process.stdout.write(`${E}2J${E}H${S.b}${title}${S.r}\n\n`);
  await run(); await pressAnyKey(); clear();
}
export async function busy<T>(title: string, label: string, fn: () => Promise<T>): Promise<T> {
  const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"; let i = 0; const t = setInterval(() => draw(title, ["", `  ${tint(TONE.acc, frames[i++ % frames.length]!)} ${label}`], "Working…"), 90);
  try { return await fn(); } finally { clearInterval(t); }
}
