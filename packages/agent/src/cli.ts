import os from "node:os";
import { DEFAULT_PLUGIN_NAME } from "@opencommander/shared";
import { readSettings } from "./appdir.js";
import { AgentClient } from "./client.js";
import { Dashboard } from "./ui.js";
import { loadConfig, normalizeGatewayUrl, storeToken, tokenFilePath } from "./config.js";

const pretty = process.env.OC_PRETTY === "1";
const log = (e: Record<string, unknown>) => {
  if (!pretty) return console.log(JSON.stringify({ ts: new Date().toISOString(), ...e }));
  const t = new Date().toLocaleTimeString(); const { ev, ...rest } = e;
  if (ev === "call") console.log(`[${t}]  >> ${e.tool}  ${e.summary ?? ""}`);
  else if (ev === "call_done") console.log(`[${t}]  ${e.ok ? "OK  " : "FAIL"} ${e.tool}  ${e.ms} ms${e.ok ? "" : "  (" + e.code + ")"}`);
  else if (ev === "connected") console.log(`[${t}]  CONNECTED to gateway - ready for AI clients`);
  else if (ev === "disconnected") console.log(`[${t}]  link dropped (code ${e.code}, usually the network closing an idle connection) - reconnecting...`);
  else if (ev !== "starting") console.log(`[${t}]  ${ev} ${JSON.stringify(rest)}`);
};
const [cmd, ...rest] = process.argv.slice(2);
const adminCall = async (path: string, method = "GET") => {
  const base = normalizeGatewayUrl(process.env.OC_GATEWAY_URL ?? "");
  if (!process.env.OC_ADMIN_TOKEN) throw new Error("Set OC_ADMIN_TOKEN (the gateway's ADMIN_TOKEN secret).");
  const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${process.env.OC_ADMIN_TOKEN}` } });
  const j: any = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`Gateway said ${r.status}: ${j?.error ?? "error"}`); return j;
};

async function main() {
  switch (cmd) {
    case "pair": {
      const code = rest[0]; if (!code) throw new Error("Usage: pair <code>   (get a code with: admin pair-code)");
      const gw = normalizeGatewayUrl(process.env.OC_GATEWAY_URL ?? "");
      const r = await fetch(gw + "/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: process.env.OC_DEVICE_NAME || os.hostname() }) });
      const j: any = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`Pairing failed (${r.status}): ${j?.error ?? "error"}`);
      storeToken(j.id, j.token, gw);
      console.log(`Paired as ${j.id}. Token saved to ${tokenFilePath()} (not printed). Now run: npm run agent -- run`); return;
    }
    case "run": {
      const cfg = loadConfig();
      log({ ev: "starting", gateway: cfg.gatewayUrl, workspaces: cfg.workspaces.length, write: cfg.flags.write });
      // Full-screen dashboard on a real terminal; plain one-line logs otherwise (or with OC_PLAIN=1).
      const dash = pretty && process.stdout.isTTY && process.env.OC_PLAIN !== "1"
        ? new Dashboard({ brand: readSettings().name || DEFAULT_PLUGIN_NAME, gateway: cfg.gatewayUrl, device: cfg.deviceName, adminToken: process.env.OC_ADMIN_TOKEN, onQuit: () => bye() }) : null;
      const c = new AgentClient({ gatewayUrl: cfg.gatewayUrl, token: cfg.token, ctx: { roots: cfg.workspaces, flags: cfg.flags }, log: dash ? (e) => dash.event(e) : log });
      const bye = () => { dash?.stop(); c.stop(); process.exit(0); };
      dash?.start(); c.start();
      process.on("SIGINT", bye); process.on("SIGTERM", bye);
      setInterval(() => { if (c.fatal) { dash?.stop(); console.error(c.fatal); process.exit(2); } }, 1000);
      return;
    }
    case "livelink": {
      const { runLiveLinkViewer } = await import("./livelink-view.js");
      runLiveLinkViewer(rest[0]); return;
    }
    case "admin": {
      const sub = rest[0];
      if (sub === "pair-code") { const j = await adminCall("/admin/pairing-codes", "POST"); console.log(`Pairing code (valid 10 min, single use): ${j.code}`); }
      else if (sub === "devices") console.log(JSON.stringify(await adminCall("/admin/devices"), null, 2));
      else if (sub === "revoke" && rest[1]) { await adminCall(`/admin/devices/${encodeURIComponent(rest[1])}/revoke`, "POST"); console.log(`Revoked ${rest[1]}.`); }
      else if (sub === "reset-limits") console.log(`Cleared ${(await adminCall("/admin/reset-limits", "POST")).cleared} lockout counter(s).`);
      else throw new Error("Usage: admin pair-code | admin devices | admin revoke <deviceId> | admin reset-limits");
      return;
    }
    default: console.log("OpenCommander agent\n  pair <code>\n  run\n  admin pair-code | devices | revoke <id>");
  }
}
main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
