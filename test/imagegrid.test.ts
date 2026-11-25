import { describe, it, expect } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawnSync } from "node:child_process";
import { runTool } from "../packages/agent/src/tools.js";

const win = process.platform === "win32";
describe.skipIf(!win)("image_grid", () => {
  it("combines a folder of images into one numbered grid image", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oc-grid-")));
    const mk = `Add-Type -AssemblyName System.Drawing; $c=@('Red','Green','Blue','Gold','Purple'); for($i=0;$i -lt 5;$i++){ $b=New-Object System.Drawing.Bitmap (200+$i*20),150; $g=[System.Drawing.Graphics]::FromImage($b); $g.Clear([System.Drawing.Color]::FromName($c[$i])); $b.Save("${root.replace(/\\/g, "\\\\")}\\\\f$($i+1).png"); $g.Dispose(); $b.Dispose() }`;
    spawnSync("powershell.exe", ["-NoProfile", "-Command", mk], { windowsHide: true });
    const ctx = { roots: [root], flags: { write: true } } as any;
    const r = await runTool(ctx, "image_grid", { folder: root });
    expect(r.image?.mimeType).toBe("image/jpeg"); expect(r.image!.data.length).toBeGreaterThan(1000);
    expect(r.text).toContain("5 images"); expect(r.text).toContain("1=f1.png"); expect(r.text).toContain("5=f5.png");
    await expect(runTool(ctx, "image_grid", { paths: path.join(root, "f1.png") })).rejects.toMatchObject({ code: "bad_arguments" });
    fs.rmSync(root, { recursive: true, force: true });
  }, 60_000);
});
