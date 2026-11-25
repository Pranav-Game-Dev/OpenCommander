// Per-user data folder (%APPDATA%\OpenCommander): device token, dashboard colours, Live Link logs, local settings.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let resolved: string | undefined;
/** The data folder. A folder from the project's earlier name (dc-free) is moved over once so nothing needs re-pairing. */
export function appDir(): string {
  if (process.env.OC_APP_DIR) return process.env.OC_APP_DIR;
  if (resolved) return resolved;
  const base = process.env.APPDATA || path.join(os.homedir(), ".config");
  const dir = path.join(base, "OpenCommander"), legacy = path.join(base, "dc-free");
  try {
    if (!fs.existsSync(dir) && fs.existsSync(legacy)) {
      try { fs.renameSync(legacy, dir); } catch { fs.cpSync(legacy, dir, { recursive: true }); }
    }
  } catch { /* fall through; callers create the folder when they write */ }
  return (resolved = dir);
}
export const appFile = (...p: string[]) => path.join(appDir(), ...p);

export interface Settings { name?: string; logo?: string }
const settingsPath = () => appFile("settings.json");
export function readSettings(): Settings {
  try { const j = JSON.parse(fs.readFileSync(settingsPath(), "utf8")); return j && typeof j === "object" ? j : {}; } catch { return {}; }
}
export function writeSettings(patch: Settings & { reset?: ("name" | "logo")[] }) {
  const { reset, ...rest } = patch; const cur: Settings = { ...readSettings(), ...rest };
  for (const k of reset ?? []) delete cur[k];
  fs.mkdirSync(appDir(), { recursive: true }); fs.writeFileSync(settingsPath(), JSON.stringify(cur, null, 2));
}
