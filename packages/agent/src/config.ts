import fs from "node:fs";
import { appFile } from "./appdir.js";
import os from "node:os";
import path from "node:path";

export interface AgentConfig { gatewayUrl: string; token: string; workspaces: string[]; deviceName: string; flags: { write: boolean } }
export const tokenFilePath = (env = process.env) =>
  env.OC_TOKEN_FILE || appFile("device.json");

export function normalizeGatewayUrl(u: string): string {
  const url = new URL(u);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("OC_GATEWAY_URL must be https:// (http:// only for localhost)");
  return url.origin;
}

/** Resolve + validate workspace roots: must exist, be directories, and not be a whole drive/filesystem root. */
export function resolveWorkspaces(raw: string | undefined, env = process.env): string[] {
  const parts = (raw ?? "").split(path.delimiter).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("Set OC_WORKSPACES to one or more folders (separated by '" + path.delimiter + "').");
  return parts.map((p) => {
    const real = fs.realpathSync(path.resolve(p));
    if (!fs.statSync(real).isDirectory()) throw new Error(`Workspace is not a directory: ${p}`);
    if (path.parse(real).root === real && env.OC_ALLOW_DRIVE_ROOT !== "1") throw new Error(`Refusing to expose a whole drive: ${p}. Pick a project folder.`);
    return real;
  });
}

export function readStoredToken(env = process.env): { id: string; token: string } | null {
  try { const j = JSON.parse(fs.readFileSync(tokenFilePath(env), "utf8")); return j?.token ? j : null; } catch { return null; }
}
export function storeToken(id: string, token: string, gateway: string, env = process.env) {
  const f = tokenFilePath(env); fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ id, token, gateway }), { mode: 0o600 });
}

export function loadConfig(env = process.env): AgentConfig {
  if (!env.OC_GATEWAY_URL) throw new Error("Set OC_GATEWAY_URL (your gateway's https URL).");
  const token = env.OC_DEVICE_TOKEN || readStoredToken(env)?.token;
  if (!token) throw new Error("No device token. Run:  npm run agent -- pair <code>");
  return { gatewayUrl: normalizeGatewayUrl(env.OC_GATEWAY_URL), token, workspaces: resolveWorkspaces(env.OC_WORKSPACES, env), deviceName: env.OC_DEVICE_NAME || os.hostname(), flags: { write: env.OC_DISABLE_WRITE !== "1" } };
}
