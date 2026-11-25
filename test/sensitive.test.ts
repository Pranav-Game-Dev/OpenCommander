import { describe, it, expect } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { resolveInWorkspace } from "../packages/agent/src/paths.js";

describe("secret locations are blocked inside a workspace", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dcf-s-")));
  for (const p of [".env", ".env.local", "proj/.env", ".ssh/id_rsa", "x/.ssh", "AppData/Roaming/a.txt", ".wrangler/config/x.toml", "k/server.pem", "a/id_ed25519", "packages/gateway/.dev.vars", ".npmrc", "opencommander/device.json"])
    it(`denies ${p}`, async () => { await expect(resolveInWorkspace([root], p)).rejects.toMatchObject({ code: "path_denied" }); });
  for (const p of ["README.md", "src/env.ts", "notes/environment.txt", "package.json"])
    it(`allows ${p}`, async () => { await expect(resolveInWorkspace([root], p)).resolves.toBeTypeOf("string"); });
});
