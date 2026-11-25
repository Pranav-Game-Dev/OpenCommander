import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryKV, b32decode, b32encode, newTotpSecret, totpNow, verifyTotp } from "@opencommander/shared";
import { runTool } from "../packages/agent/src/tools.js";
import { parsePresets } from "../packages/agent/src/convert.js";
import { clip, vw } from "../packages/agent/src/ui.js";
import { Stats } from "../packages/gateway/src/stats.js";

const has7z = fs.existsSync("C:\\Program Files\\7-Zip\\7z.exe") || !!process.env.OC_7ZIP;
let dir: string; let ctx: any;
beforeAll(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dcf-nt-"))); ctx = { roots: [dir], flags: { write: true } }; });
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("totp", () => {
  it("matches RFC 6238 vector", async () => {
    const secret = b32encode(new TextEncoder().encode("12345678901234567890"));
    expect(await totpNow(secret, 59_000)).toBe("287082");
    expect(await verifyTotp(secret, "287082", 59_000)).toBe(1);
    expect(await verifyTotp(secret, "000000", 59_000)).toBeNull();
  });
  it("round-trips base32 and accepts +-1 step only", async () => {
    const s = newTotpSecret(); expect(b32encode(b32decode(s))).toBe(s);
    const t = 1_700_000_000_000; const code = await totpNow(s, t);
    expect(await verifyTotp(s, code, t + 30_000)).not.toBeNull();
    expect(await verifyTotp(s, code, t + 90_000)).toBeNull();
  });
});

describe("file converter presets", () => {
  it("parses presets and input types", () => {
    const p = parsePresets(`<ConversionPreset Name="To Png" OutputType="Png" IsDefaultSettings="true"><InputTypes>jpg</InputTypes><InputTypes>BMP</InputTypes></ConversionPreset>`);
    expect(p).toEqual([{ name: "To Png", out: "Png", inputs: ["jpg", "bmp"] }]);
  });
});

describe.skipIf(!has7z)("archive (7-Zip)", () => {
  it("creates, lists, tests, extracts and deletes inside the workspace", async () => {
    fs.mkdirSync(path.join(dir, "src")); fs.writeFileSync(path.join(dir, "src", "a.txt"), "hello"); fs.writeFileSync(path.join(dir, "src", ".env"), "SECRET=1");
    const created = await runTool(ctx, "archive", { action: "create", archive: path.join(dir, "t.7z"), paths: path.join(dir, "src"), format: "7z" });
    expect(created.text).toMatch(/Created/);
    const list = await runTool(ctx, "archive", { action: "list", archive: path.join(dir, "t.7z") });
    expect(list.text).toMatch(/a\.txt/); expect(list.text).not.toMatch(/\.env/); // secrets are never packed
    expect((await runTool(ctx, "archive", { action: "test", archive: path.join(dir, "t.7z") })).text).toMatch(/Everything is Ok/);
    await runTool(ctx, "archive", { action: "extract", archive: path.join(dir, "t.7z"), output: path.join(dir, "out") });
    expect(fs.readFileSync(path.join(dir, "out", "src", "a.txt"), "utf8")).toBe("hello");
    await runTool(ctx, "archive", { action: "delete", archive: path.join(dir, "t.7z"), paths: "src/a.txt" });
    expect((await runTool(ctx, "archive", { action: "list", archive: path.join(dir, "t.7z") })).text).not.toMatch(/a\.txt/);
  });
  it("refuses paths outside the workspace and option-like entry names", async () => {
    await expect(runTool(ctx, "archive", { action: "list", archive: "C:\\Windows\\notepad.exe" })).rejects.toMatchObject({ code: "path_denied" });
    await expect(runTool(ctx, "archive", { action: "extract", archive: path.join(dir, "t.7z"), paths: "-aoa" })).rejects.toMatchObject({ code: "bad_arguments" });
  });
});

describe("dashboard text helpers", () => {
  it("measures emoji as two columns and clips safely", () => {
    expect(vw("ab")).toBe(2); expect(vw("📂 x")).toBe(4); expect(vw("\x1b[31mred\x1b[0m")).toBe(3);
    expect(vw(clip("📂📂📂📂📂", 5))).toBeLessThanOrEqual(5);
  });
});

describe("usage stats", () => {
  it("counts per connection, day and month and survives a reload", async () => {
    const kv = new MemoryKV(); const now = () => Date.UTC(2026, 10, 7, 12); const s = new Stats(kv, now);
    await s.bump("g1", "ChatGPT_AB12", "call"); await s.bump("g1", "ChatGPT_AB12", "call", true); await s.bump("g2", "Claude_CD34", "req");
    const snap = await s.snapshot();
    expect(snap.today).toEqual({ req: 3, calls: 2 }); expect(snap.conns.g1).toMatchObject({ calls: 2, errors: 1, req: 2 }); expect(snap.conns.g2).toMatchObject({ calls: 0, req: 1 });
    expect((await new Stats(kv, now).snapshot()).thisMonth.req).toBe(3);
    await s.forget("g1"); expect((await s.snapshot()).conns.g1).toBeUndefined();
  });
});
