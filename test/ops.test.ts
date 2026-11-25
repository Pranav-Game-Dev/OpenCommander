import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { runTool } from "../packages/agent/src/tools.js";

let root: string, outside: string;
const rw = () => ({ roots: [root], flags: { write: true } });
const ro = () => ({ roots: [root] });
beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dcf-w-"))); outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dcf-x-")));
  fs.mkdirSync(path.join(root, "a", "b"), { recursive: true }); fs.writeFileSync(path.join(root, "a", "one.txt", ), "alpha\nbeta NEEDLE\n"); fs.writeFileSync(path.join(root, "a", "b", "two.md"), "gamma");
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1"); fs.writeFileSync(path.join(outside, "o.txt"), "o");
});
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });

describe("write tools", () => {
  it("are disabled unless the device owner enables them", async () => {
    for (const [t, a] of [["write_file", { path: "n.txt", content: "x" }], ["create_directory", { path: "d" }], ["move_file", { source: "a/one.txt", destination: "z.txt" }], ["edit_block", { path: "a/one.txt", old_string: "alpha", new_string: "x" }]] as const)
      await expect(runTool(ro(), t, a)).rejects.toMatchObject({ code: "tool_disabled" });
    expect(fs.existsSync(path.join(root, "n.txt"))).toBe(false);
  });
  it("write_file rewrite/append and creates parent dirs", async () => {
    await runTool(rw(), "write_file", { path: "new/dir/f.txt", content: "hi" }); await runTool(rw(), "write_file", { path: "new/dir/f.txt", content: "!", mode: "append" });
    expect(fs.readFileSync(path.join(root, "new", "dir", "f.txt"), "utf8")).toBe("hi!");
  });
  it("blocks writes outside the workspace, onto the root, and onto secret files", async () => {
    for (const p of [path.join(outside, "evil.txt"), "../evil.txt", ".env", ".ssh/authorized_keys", "AppData/x.txt"]) await expect(runTool(rw(), "write_file", { path: p, content: "x" })).rejects.toMatchObject({ code: "path_denied" });
    await expect(runTool(rw(), "write_file", { path: ".", content: "x" })).rejects.toMatchObject({ code: "path_denied" });
    expect(fs.existsSync(path.join(outside, "evil.txt"))).toBe(false); expect(fs.readFileSync(path.join(root, ".env"), "utf8")).toBe("SECRET=1");
  });
  it("create_directory + move_file (no overwrite, no escape)", async () => {
    await runTool(rw(), "create_directory", { path: "m/n" });
    await runTool(rw(), "move_file", { source: "a/b/two.md", destination: "m/n/moved.md" });
    expect(fs.existsSync(path.join(root, "m", "n", "moved.md"))).toBe(true);
    await expect(runTool(rw(), "move_file", { source: "a/one.txt", destination: "m/n/moved.md" })).rejects.toMatchObject({ code: "bad_arguments" });
    await expect(runTool(rw(), "move_file", { source: "a/one.txt", destination: path.join(outside, "o2.txt") })).rejects.toMatchObject({ code: "path_denied" });
    await expect(runTool(rw(), "move_file", { source: path.join(outside, "o.txt"), destination: "stolen.txt" })).rejects.toMatchObject({ code: "path_denied" });
  });
  it("edit_block replaces exactly the expected count, else changes nothing", async () => {
    await expect(runTool(rw(), "edit_block", { path: "a/one.txt", old_string: "zzz", new_string: "y" })).rejects.toMatchObject({ code: "bad_arguments" });
    await runTool(rw(), "edit_block", { path: "a/one.txt", old_string: "alpha", new_string: "ALPHA" });
    expect(fs.readFileSync(path.join(root, "a", "one.txt"), "utf8")).toContain("ALPHA");
    fs.writeFileSync(path.join(root, "dup.txt"), "x x");
    await expect(runTool(rw(), "edit_block", { path: "dup.txt", old_string: "x", new_string: "y" })).rejects.toMatchObject({ code: "bad_arguments" });
    expect(fs.readFileSync(path.join(root, "dup.txt"), "utf8")).toBe("x x");
    await runTool(rw(), "edit_block", { path: "dup.txt", old_string: "x", new_string: "y", expected_replacements: 2 });
    expect(fs.readFileSync(path.join(root, "dup.txt"), "utf8")).toBe("y y");
  });
});

describe("read-side additions", () => {
  it("list_directory depth hides secret files", async () => {
    const r = (await runTool(ro(), "list_directory", { depth: 2 })).text;
    expect(r).toContain("[DIR]  a"); expect(r).toContain("  [FILE] one.txt"); expect(r).not.toContain(".env");
  });
  it("search by name and by content, skipping secrets", async () => {
    expect((await runTool(ro(), "search", { pattern: "MOVED" })).text).toContain("moved.md");
    expect((await runTool(ro(), "search", { pattern: "needle", type: "content" })).text).toContain("one.txt:2:");
    expect((await runTool(ro(), "search", { pattern: "SECRET", type: "content" })).text).toBe("(no matches)");
    expect((await runTool(ro(), "search", { pattern: "gam+a", type: "content", regex: true })).text).toContain("moved.md:1:");
    await expect(runTool(ro(), "search", { pattern: "(", regex: true })).rejects.toMatchObject({ code: "bad_arguments" });
    await expect(runTool(ro(), "search", { pattern: "x", path: outside })).rejects.toMatchObject({ code: "path_denied" });
  });
  it("read_multiple_files tolerates individual failures", async () => {
    const r = (await runTool(ro(), "read_multiple_files", { paths: "a/one.txt\nmissing.txt\n.env" })).text;
    expect(r).toContain("NEEDLE"); expect(r).toContain("not_found"); expect(r).toContain("path_denied"); expect(r).not.toContain("SECRET=1");
  });
  it("get_config reports flags", async () => { expect(JSON.parse((await runTool(rw(), "get_config", {})).text).enabled.write).toBe(true); });
});
