import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { checkRawPath, isInside, resolveInWorkspace } from "../packages/agent/src/paths.js";

const W = path.win32;
describe("Windows lexical rules (run on any OS)", () => {
  const bad: [string, RegExp][] = [
    ["\\\\server\\share\\x", /UNC/], ["\\\\?\\C:\\Windows", /UNC/], ["//?/C:/x", /UNC/], ["\\\\.\\PhysicalDrive0", /UNC/],
    ["C:foo", /Drive-relative/], ["file.txt:stream", /colon|stream/i], ["C:\\ws\\a.txt:hidden", /colon|stream/i],
    ["C:\\ws\\NUL", /device/i], ["C:\\ws\\con.txt", /device/i], ["C:\\ws\\COM1", /device/i],
    ["C:\\ws\\name.", /dot or space/], ["C:\\ws\\name ", /dot or space/], ["C:\\ws\\a*b", /Wildcard/], ["a\0b", /null/], ["", /non-empty/],
  ];
  for (const [p, re] of bad) it(`rejects ${JSON.stringify(p)}`, () => expect(() => checkRawPath(p, W)).toThrow(re));
  it("accepts ordinary paths", () => { for (const p of ["C:\\ws\\src\\a.ts", "src/a.ts", "..\\x", ".", "C:/ws/readme.md"]) expect(() => checkRawPath(p, W)).not.toThrow(); });
  it("isInside: prefix sibling, case, traversal, other drive", () => {
    expect(isInside("C:\\ws", "C:\\ws\\a", W)).toBe(true);
    expect(isInside("C:\\ws", "c:\\WS\\A", W)).toBe(true);
    expect(isInside("C:\\ws", "C:\\ws2\\a", W)).toBe(false);
    expect(isInside("C:\\ws", W.resolve("C:\\ws", "..\\secret"), W)).toBe(false);
    expect(isInside("C:\\ws", "D:\\ws\\a", W)).toBe(false);
    expect(isInside("C:\\ws", "C:\\ws", W)).toBe(true);
  });
});

// Windows: directory links use junctions (no admin needed); file symlinks need Developer Mode/admin, so those cases are skipped if unavailable.
const dirLink = (target: string, p: string) => fs.symlinkSync(target, p, process.platform === "win32" ? "junction" : undefined);
let fileLinkOk = true;

describe("resolveInWorkspace on the real filesystem", () => {
  let root: string, outside: string;
  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dcf-p-"))); outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dcf-o-")));
    fs.mkdirSync(path.join(root, "sub")); fs.writeFileSync(path.join(root, "sub", "a.txt"), "a"); fs.writeFileSync(path.join(outside, "s.txt"), "S");
    dirLink(outside, path.join(root, "link-dir")); dirLink(path.join(root, "sub"), path.join(root, "link-inside"));
    try { fs.symlinkSync(path.join(outside, "s.txt"), path.join(root, "link-file")); } catch { fileLinkOk = false; }
  });
  afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  it("allows relative + absolute inside paths", async () => {
    expect(await resolveInWorkspace([root], "sub/a.txt")).toBe(path.join(root, "sub", "a.txt"));
    expect(await resolveInWorkspace([root], path.join(root, "sub"))).toBe(path.join(root, "sub"));
    expect(await resolveInWorkspace([root], ".")).toBe(root);
  });
  it("allows a not-yet-existing path under the workspace", async () => { expect(await resolveInWorkspace([root], "sub/new/dir/f.txt")).toBe(path.join(root, "sub", "new", "dir", "f.txt")); });
  it("allows links that stay inside", async () => { expect(await resolveInWorkspace([root], "link-inside/a.txt")).toBe(path.join(root, "sub", "a.txt")); });
  for (const p of ["..", "../x", "sub/../../x", "sub/../..", () => outside, () => path.join(outside, "s.txt"), "link-dir", "link-dir/s.txt", "link-file", "link-dir/new-file"]) {
    it(`denies ${typeof p === "string" ? p : "absolute outside path"}`, async (ctx) => {
      if (p === "link-file" && !fileLinkOk) return ctx.skip();
      const input = typeof p === "string" ? p : p();
      await expect(resolveInWorkspace([root], input)).rejects.toMatchObject({ code: "path_denied" });
    });
  }
  it("denies sibling directory sharing a name prefix", async () => {
    const sib = root + "-evil"; fs.mkdirSync(sib);
    try { await expect(resolveInWorkspace([root], sib)).rejects.toMatchObject({ code: "path_denied" }); } finally { fs.rmSync(sib, { recursive: true }); }
  });
  it("denies null bytes", async () => { await expect(resolveInWorkspace([root], "a\0b")).rejects.toMatchObject({ code: "path_denied" }); });
  it("supports several roots", async () => { expect(await resolveInWorkspace([root, outside], path.join(outside, "s.txt"))).toBe(path.join(outside, "s.txt")); });
});
