/**
 * OpenCommander management console: plugin name, logo, tools, connections, passphrase, 2FA, gateway, devices.
 * Run:  manage.bat   (or: npm run manage)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { CF_DAILY_REQUEST_LIMIT, DEFAULT_LOGO_NAME, DEFAULT_PLUGIN_NAME, PRODUCT, cleanPluginName, cleanSvg, newTotpSecret, otpauthUri, verifyTotp } from "@opencommander/shared";
import { normalizeGatewayUrl, storeToken, tokenFilePath } from "./config.js";
import { readSettings, writeSettings } from "./appdir.js";
import { TONE, ask, busy, checklist, confirm, draw, info, liveOutput, menu, setChrome, tint, dim, bold, type CItem } from "./tui.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GW_DIR = path.join(ROOT, "packages", "gateway");
const ENV_FILE = path.join(ROOT, ".env");
const LOGO_DIR = path.join(ROOT, "OpenCommander Logo");

// ───────── env / admin API ─────────
function readEnv(): Record<string, string> {
  const o: Record<string, string> = {};
  try { for (const l of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(l); if (m) o[m[1]!] = m[2]!.replace(/^["']|["']$/g, ""); } } catch { /* none */ }
  return o;
}
function setEnv(key: string, val: string | null) {
  let lines: string[] = []; try { lines = fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/); } catch { /* new file */ }
  const re = new RegExp(`^\\s*${key}\\s*=`); const i = lines.findIndex((l) => re.test(l));
  if (val === null) { if (i >= 0) lines.splice(i, 1); } else if (i >= 0) lines[i] = `${key}=${val}`; else lines.push(`${key}=${val}`);
  fs.writeFileSync(ENV_FILE, lines.join("\n").replace(/\n*$/, "\n"));
}
const gateway = () => normalizeGatewayUrl(process.env.OC_GATEWAY_URL ?? readEnv().OC_GATEWAY_URL ?? "");
const adminToken = () => process.env.OC_ADMIN_TOKEN ?? readEnv().OC_ADMIN_TOKEN ?? "";
async function api(p: string, method = "GET", body?: unknown, tokenOverride?: string, base = gateway()): Promise<any> {
  const r = await fetch(base + p, { method, headers: { Authorization: `Bearer ${tokenOverride ?? adminToken()}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
  const j: any = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${r.status}: ${j?.error ?? "error"}`); return j;
}

// ───────── wrangler ─────────
function wrangler(args: string[], input?: string): { code: number; out: string } {
  const r = spawnSync("npx", ["wrangler", ...args], { cwd: GW_DIR, shell: true, input, encoding: "utf8", windowsHide: true });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const wranglerLive = (args: string[]) => spawnSync("npx", ["wrangler", ...args], { cwd: GW_DIR, shell: true, stdio: "inherit" }).status ?? 1;
function putSecret(name: string, value: string): boolean { const r = wrangler(["secret", "put", name], value); if (r.code !== 0) console.log(tint(TONE.bad, r.out.trim().slice(-400))); return r.code === 0; }
function deploy(): Promise<{ code: number; url?: string }> {
  return new Promise((resolve) => {
    const ch = spawn("npx", ["wrangler", "deploy"], { cwd: GW_DIR, shell: true, stdio: ["inherit", "pipe", "pipe"] }); let out = "";
    const on = (d: Buffer) => { process.stdout.write(d); out += d.toString(); }; ch.stdout.on("data", on); ch.stderr.on("data", on);
    ch.on("close", (code) => resolve({ code: code ?? 1, url: /https:\/\/[\w.-]+\.workers\.dev/.exec(out)?.[0] }));
  });
}
const rand = (n: number, alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789") => Array.from(crypto.randomBytes(n), (b) => alphabet[b % alphabet.length]).join("");
const ago = (t: number | null) => { if (!t) return "never"; const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
const totpEnabled = () => /OWNER_TOTP_SECRET/.test(wrangler(["secret", "list"]).out);

// ───────── state / header ─────────
let cfg: { name: string; logoName: string; disabledTools: string[]; tools: { name: string; title: string; kind: string }[] } | null = null;
let twofa: boolean | null = null;
async function refresh(): Promise<void> {
  try {
    cfg = await api("/admin/config");
    writeSettings({ name: cfg!.name });
    const h: any = await (await fetch(gateway() + "/health", { signal: AbortSignal.timeout(6000) })).json();
    setChrome({ brand: cfg!.name, status: `${tint(TONE.ok, "● online")}  ${dim(`${h.devicesOnline} device(s)`)}  ${dim("·")} ${dim("logo")} ${cfg!.logoName.replace(/\.svg$/, "")}  ${dim("·")} ${cfg!.disabledTools.length ? tint(TONE.warn, `${cfg!.disabledTools.length} tool(s) off`) : dim("all tools on")}  ${dim("·")} 2FA ${twofa === null ? dim("?") : twofa ? tint(TONE.ok, "on") : dim("off")}` });
  } catch (e: any) {
    setChrome({ brand: readSettings().name || DEFAULT_PLUGIN_NAME, status: tint(TONE.bad, `● gateway unreachable: ${String(e.message).slice(0, 50)}`) });
  }
}

// ───────── screens ─────────
async function status() {
  const lines: string[] = [];
  const g = gateway(); lines.push(`${dim("Gateway ")} ${g}`, `${dim("Connector")} ${g}/mcp`, `${dim("Plugin   ")} ${cfg?.name ?? "?"}   ${dim("(" + PRODUCT + ")")}`);
  try {
    const s = await busy("Status", "Loading…", () => api("/admin/stats"));
    const pct = Math.min(100, Math.round((s.today.req / CF_DAILY_REQUEST_LIMIT) * 100)); const bar = "█".repeat(Math.round(pct / 5)) + "░".repeat(20 - Math.round(pct / 5));
    lines.push("", `${dim("Today    ")} ${bar} ${s.today.req.toLocaleString()} / ${CF_DAILY_REQUEST_LIMIT.toLocaleString()} requests · ${s.today.calls} tool calls`, `${dim("Month    ")} ${s.thisMonth.req.toLocaleString()} requests · ${s.thisMonth.calls} tool calls`, "");
    for (const x of (await api("/admin/devices")).devices) lines.push(`${dim("Device   ")} ${x.name ?? x.id} ${x.revokedAt ? tint(TONE.bad, "revoked") : x.online ? tint(TONE.ok, "online") : tint(TONE.warn, "offline")}  ${dim(x.id)}`);
  } catch (e: any) { lines.push(tint(TONE.bad, `Admin API: ${e.message}`)); }
  await info("Status", lines);
}

async function rename() {
  const cur = cfg?.name ?? DEFAULT_PLUGIN_NAME;
  const v = await ask("Rename plugin", ["Your plugin name appears in every AI app (server title), the consent page, the dashboard and this console.", `Letters, digits, space . _ - (max 32). Type ${bold("default")} to reset to "${DEFAULT_PLUGIN_NAME}".`], "Plugin name", cur);
  if (!v) return;
  try {
    if (v.toLowerCase() === "default") await api("/admin/config", "POST", { resetName: true }); else await api("/admin/config", "POST", { name: cleanPluginName(v) });
    await refresh(); await info("Rename plugin", [tint(TONE.ok, `Plugin is now “${cfg?.name}”.`), "", dim("AI apps pick the new name when they re-check the connector (reconnect or refresh tools).")]);
  } catch (e: any) { await info("Rename plugin", [tint(TONE.bad, e.message)]); }
}

async function logos() {
  const files = fs.existsSync(LOGO_DIR) ? fs.readdirSync(LOGO_DIR).filter((f) => f.toLowerCase().endsWith(".svg")).sort() : [];
  const items = [
    ...files.map((f) => ({ key: f, label: f.replace(/\.svg$/, ""), hint: f === (cfg?.logoName ?? DEFAULT_LOGO_NAME) ? "  ← current" : f === DEFAULT_LOGO_NAME ? "  default" : "", tone: f === cfg?.logoName ? TONE.ok : undefined })),
    { key: "#custom", label: "Use my own SVG file…", hint: "  path to any .svg (≤ 24 KB)" },
    { key: "#reset", label: "Reset to default logo", tone: TONE.mut },
  ];
  const k = await menu("Logo", items, { intro: [dim(`Current: ${cfg?.logoName ?? DEFAULT_LOGO_NAME}`), dim(`Folder: ${LOGO_DIR}`), dim("Tip: open the SVGs in a browser to preview them.")], start: cfg?.logoName });
  if (!k) return;
  try {
    if (k === "#reset") await api("/admin/config", "POST", { resetLogo: true });
    else {
      let file = path.join(LOGO_DIR, k);
      if (k === "#custom") { const p = await ask("Custom logo", ["Path to an .svg file (no scripts / external links)."], "SVG path"); if (!p) return; file = p.replace(/^"|"$/g, ""); }
      const svg = cleanSvg(fs.readFileSync(file, "utf8")); await api("/admin/config", "POST", { logoName: path.basename(file), logoSvg: svg });
      writeSettings({ logo: path.basename(file) });
    }
    await refresh(); await info("Logo", [tint(TONE.ok, `Logo set: ${cfg?.logoName}`), "", dim(`Served at ${gateway()}/logo.svg`), dim("AI apps show it when they refresh the connector; support varies per app.")]);
  } catch (e: any) { await info("Logo", [tint(TONE.bad, e.message)]); }
}

async function tools() {
  if (!cfg) await refresh(); if (!cfg) return info("Tools", [tint(TONE.bad, "Gateway unreachable.")]);
  const off = new Set(cfg.disabledTools); const items: CItem[] = cfg.tools.map((t) => ({ key: t.name, label: t.name, hint: t.title, group: t.kind }));
  const all = new Set(cfg.tools.map((t) => t.name));
  const res = await checklist("Tools for AIs", items, [...all].filter((n) => !off.has(n)), {
    intro: [dim("Checked = AIs can see and use it. Unchecked tools disappear from the tool list.")],
    presets: [
      { key: "all", label: "all", pick: () => true },
      { key: "ro", label: "read-only", pick: (i) => i.group === "read" },
      { key: "nobrowser", label: "no browser/mcp", pick: (i) => i.group !== "browser" && i.group !== "mcp" },
      { key: "noexec", label: "no shell", pick: (i) => i.group !== "exec" },
    ],
  });
  if (!res) return;
  const disabled = [...all].filter((n) => !res.has(n));
  try { await api("/admin/config", "POST", { disabledTools: disabled }); await refresh(); await info("Tools for AIs", [tint(TONE.ok, `Saved: ${all.size - disabled.length} on, ${disabled.length} off.`), "", dim("AIs see the change when they re-check tools (or reconnect)."), ...(disabled.length ? ["", dim("Off: " + disabled.join(", "))] : [])]); }
  catch (e: any) { await info("Tools", [tint(TONE.bad, e.message)]); }
}

async function connections() {
  for (;;) {
    let rows: any[]; try { rows = (await api("/admin/connections")).connections; } catch (e: any) { return info("Connections", [tint(TONE.bad, e.message)]); }
    const items = [...rows.map((x, i) => ({ key: String(i), label: x.label, hint: `  ${x.client ?? "app"} · ${x.calls} calls · last ${ago(x.lastSeen)}` })), { key: "#all", label: "Delete ALL connections", tone: TONE.bad }];
    const k = await menu("Connections", rows.length ? items : [{ key: "#none", label: "No connections yet" }], { intro: [dim("AI apps that passed the passphrase. Select one to rename or remove.")] });
    if (!k || k === "#none") return;
    if (k === "#all") { if (await confirm("Connections", [`Remove all ${rows.length} connections? Each AI must reconnect.`], "Delete all?", TONE.bad)) { for (const x of rows) await api(`/admin/connections/${encodeURIComponent(x.id)}`, "DELETE"); } continue; }
    const x = rows[Number(k)]; const a = await menu(x.label, [{ key: "r", label: "Rename" }, { key: "d", label: "Remove", tone: TONE.bad }]);
    if (a === "r") { const n = await ask("Rename connection", [], "New name", x.label); if (n) try { await api(`/admin/connections/${encodeURIComponent(x.id)}/rename`, "POST", { name: n }); } catch (e: any) { await info("Rename", [tint(TONE.bad, e.message)]); } }
    if (a === "d" && (await confirm("Remove", [`${x.label} will be disconnected immediately.`], "Remove?", TONE.bad))) await api(`/admin/connections/${encodeURIComponent(x.id)}`, "DELETE");
  }
}

async function passphrase() {
  const m = await menu("Owner passphrase", [{ key: "g", label: "Generate a strong one" }, { key: "t", label: "Type a new one" }], { intro: [dim("Asked once when a NEW AI connects; connected AIs keep working.")] });
  if (!m) return; let pw = "";
  if (m === "g") pw = rand(20);
  else { pw = (await ask("New passphrase", ["Minimum 12 characters."], "Passphrase", "", { secret: true })) ?? ""; if (pw.length < 12) return info("Passphrase", [tint(TONE.bad, "Too short / cancelled.")]); if (pw !== (await ask("New passphrase", [], "Repeat", "", { secret: true }))) return info("Passphrase", [tint(TONE.bad, "Did not match.")]); }
  const ok = await busy("Passphrase", "Updating secret…", async () => wrangler(["secret", "put", "OWNER_PASSPHRASE"], pw).code === 0);
  await info("Passphrase", ok ? [tint(TONE.ok, "Passphrase updated."), ...(m === "g" ? ["", `New passphrase: ${bold(pw)}`, dim("Save it now; it is not stored anywhere.")] : [])] : [tint(TONE.bad, "Failed to update.")]);
}

async function twoFactor() {
  const on = await busy("Two-factor", "Checking…", async () => totpEnabled()); twofa = on;
  if (on) { if (await confirm("Two-factor", ["2FA is ON for new connections."], "Turn it off?")) { const r = wrangler(["secret", "delete", "OWNER_TOTP_SECRET"], "y\n"); twofa = r.code === 0 ? false : twofa; await info("Two-factor", [r.code === 0 ? "2FA is now off." : r.out.slice(-300)]); } return; }
  if (!(await confirm("Two-factor", ["Authenticator-app codes for NEW connections.", "Already-connected AIs are never asked again."], "Set up 2FA now?"))) return;
  const secret = newTotpSecret(); const uri = otpauthUri(secret, "owner", process.env.OC_ISSUER || cfg?.name || PRODUCT);
  const qr = (await QRCode.toString(uri, { type: "terminal", small: true })).split("\n");
  for (let i = 0; i < 3; i++) {
    const code = await ask("Two-factor setup", ["Scan with Google/Microsoft Authenticator:", ...qr, `Manual key: ${bold(secret.match(/.{1,4}/g)!.join(" "))}`], "6-digit code");
    if (code && (await verifyTotp(secret, code)) !== null) { const ok = putSecret("OWNER_TOTP_SECRET", secret); twofa = ok; return info("Two-factor", [ok ? tint(TONE.ok, "2FA enabled.") : "Failed."]); }
  }
  await info("Two-factor", [tint(TONE.bad, "2FA was NOT enabled (code mismatch).")]);
}

function upsertGatewayEnv(url: string, token: string) { setEnv("OC_GATEWAY_URL", url); setEnv("OC_ADMIN_TOKEN", token); }
async function pairThisPc(url: string, token: string) {
  const code = (await api("/admin/pairing-codes", "POST", undefined, token, url)).code;
  const r = await fetch(url + "/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: readEnv().OC_DEVICE_NAME || os.hostname() }) });
  const j: any = await r.json(); if (!r.ok) throw new Error(j?.error ?? "pairing failed"); storeToken(j.id, j.token, url);
}

async function relink() {
  if (!(await confirm("Link Cloudflare", ["Sign in → deploy a fresh gateway → new secrets → re-pair this PC.", "Every AI connection must be re-added (new URL)."], "Continue?"))) return;
  await liveOutput("Link to Cloudflare", async () => {
    if (spawnSync("cmd", ["/c", "echo"]).status === 0) { /* noop */ }
    wranglerLive(["logout"]);
    if (wranglerLive(["login"]) !== 0) return console.log("Login failed.");
    const d = await deploy(); if (d.code !== 0) return console.log("Deploy failed.");
    const url = normalizeGatewayUrl(d.url ?? ""); if (!url) return console.log("Could not detect the gateway URL.");
    const adminTok = rand(40), pw = rand(20);
    if (!putSecret("ADMIN_TOKEN", adminTok) || !putSecret("OWNER_PASSPHRASE", pw)) return;
    await deploy(); upsertGatewayEnv(url, adminTok);
    try { await pairThisPc(url, adminTok); } catch (e: any) { return console.log(`Pairing failed: ${e.message}`); }
    console.log(`\nDone.\nConnector URL: ${url}/mcp\nOwner passphrase: ${pw}  (save it)\nRestart the agent (start-opencommander.bat).`);
  });
}

async function unlink() {
  if (!(await confirm("Unlink this PC", ["Removes the device token and gateway settings from .env; signs out of Cloudflare.", "The deployed gateway is NOT deleted."], "Continue?", TONE.bad))) return;
  try { fs.copyFileSync(ENV_FILE, ENV_FILE + ".bak"); } catch { /* ok */ }
  setEnv("OC_GATEWAY_URL", null); setEnv("OC_ADMIN_TOKEN", null); try { fs.unlinkSync(tokenFilePath()); } catch { /* none */ }
  wrangler(["logout"]); await info("Unlink", ["Unlinked. .env backed up to .env.bak."]);
}

async function device() {
  const a = await menu("Device", [{ key: "p", label: "Re-pair this PC with the gateway" }, { key: "l", label: "List devices" }, { key: "r", label: "Revoke a device", tone: TONE.bad }]); if (!a) return;
  try {
    if (a === "p") { await pairThisPc(gateway(), adminToken()); await info("Device", ["Paired. Restart the agent."]); }
    else if (a === "l") await info("Devices", (await api("/admin/devices")).devices.map((x: any) => `${x.name ?? ""} ${x.id} ${x.revokedAt ? "revoked" : x.online ? "online" : "offline"}`));
    else { const d = (await api("/admin/devices")).devices as any[]; const k = await menu("Revoke device", d.map((x) => ({ key: x.id, label: x.name ?? x.id, hint: "  " + (x.online ? "online" : "offline") }))); if (k && (await confirm("Revoke", ["That PC will be disconnected."], "Revoke?", TONE.bad))) { await api(`/admin/devices/${encodeURIComponent(k)}/revoke`, "POST"); await info("Device", ["Revoked."]); } }
  } catch (e: any) { await info("Device", [tint(TONE.bad, e.message)]); }
}

async function main() {
  if (!process.stdin.isTTY) { console.log("Run manage.bat in a terminal window."); return; }
  await busy("Starting", "Connecting…", async () => { await refresh(); });
  let last = "status";
  for (;;) {
    const k = await menu("Main menu", [
      { key: "status", label: "Status & usage", hint: "  health, requests, devices" },
      { key: "s1", label: "Customize", section: true },
      { key: "rename", label: "Rename plugin", hint: `  now: ${cfg?.name ?? DEFAULT_PLUGIN_NAME}` },
      { key: "logo", label: "Choose logo", hint: `  now: ${(cfg?.logoName ?? DEFAULT_LOGO_NAME).replace(/\.svg$/, "")}` },
      { key: "tools", label: "Enable / disable tools", hint: cfg?.disabledTools.length ? `  ${cfg.disabledTools.length} off` : "  all on" },
      { key: "s2", label: "Security", section: true },
      { key: "conns", label: "Connections", hint: "  AI apps" },
      { key: "pass", label: "Owner passphrase" },
      { key: "2fa", label: "Two-factor (2FA)" },
      { key: "s3", label: "Gateway & devices", section: true },
      { key: "device", label: "Device" },
      { key: "deploy", label: "Deploy gateway update" },
      { key: "limits", label: "Clear lockouts" },
      { key: "relink", label: "Link Cloudflare account / gateway", tone: TONE.warn },
      { key: "unlink", label: "Unlink this PC", tone: TONE.bad },
    ], { start: last, footer: "↑/↓ move · Enter select · 1-9 jump · Esc / Q exit" });
    if (!k) { process.stdout.write("\x1b[?25h\x1b[2J\x1b[H"); return; }
    last = k;
    try {
      if (k === "status") await status(); else if (k === "rename") await rename(); else if (k === "logo") await logos(); else if (k === "tools") await tools();
      else if (k === "conns") await connections(); else if (k === "pass") await passphrase(); else if (k === "2fa") await twoFactor();
      else if (k === "device") await device(); else if (k === "relink") await relink(); else if (k === "unlink") await unlink();
      else if (k === "limits") await info("Lockouts", [`Cleared ${(await api("/admin/reset-limits", "POST")).cleared} counter(s).`]);
      else if (k === "deploy") await liveOutput("Deploying gateway", async () => { const d = await deploy(); console.log(d.code === 0 ? "\nDeployed. The agent reconnects by itself." : "\nDeploy failed."); });
    } catch (e: any) { await info("Error", [tint(TONE.bad, e.message)]); }
    await refresh();
  }
}
void main().then(() => process.exit(0));
