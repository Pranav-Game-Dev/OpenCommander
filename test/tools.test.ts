import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { runTool } from "../packages/agent/src/tools.js";
import { MAX_OUTPUT_BYTES, boundText } from "../packages/shared/src/index.js";

let root: string; const ctx = () => ({ roots: [root] });
beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dcf-t-")));
  fs.writeFileSync(path.join(root, "small.txt", ), "héllo wörld\nline2\n");
  fs.writeFileSync(path.join(root, "big.txt"), "x".repeat(200_000));
  fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([1, 2, 0, 3]));
  fs.mkdirSync(path.join(root, "many")); for (let i = 0; i < 1100; i++) fs.writeFileSync(path.join(root, "many", `f${String(i).padStart(4, "0")}`), "");
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("tools", () => {
  it("list_directory", async () => { const r = await runTool(ctx(), "list_directory", {}); expect(r.text).toContain("[FILE] small.txt"); expect(r.text).toContain("[DIR]  many"); });
  it("list_directory caps huge directories", async () => { const r = await runTool(ctx(), "list_directory", { path: "many" }); expect(r.truncated).toBe(true); expect(r.text).toContain("100 more entries"); });
  it("get_file_info", async () => { const r = JSON.parse((await runTool(ctx(), "get_file_info", { path: "big.txt" })).text); expect(r).toMatchObject({ type: "file", size: 200_000 }); });
  it("read_file small", async () => { const r = await runTool(ctx(), "read_file", { path: "small.txt" }); expect(r.text).toContain("héllo wörld"); expect(r.truncated).toBe(false); });
  it("read_file bounds output and offers paging", async () => {
    const r = await runTool(ctx(), "read_file", { path: "big.txt" });
    expect(r.truncated).toBe(true); expect(new TextEncoder().encode(r.text).length).toBeLessThanOrEqual(MAX_OUTPUT_BYTES); expect(r.text).toContain("offset=65536");
    const r2 = await runTool(ctx(), "read_file", { path: "big.txt", offset: 65536, length: 10 }); expect(r2.text).toContain("[bytes 65536-65546 of 200000");
  });
  it("read_file length is capped at 64 KiB even if more is requested", async () => { const r = await runTool(ctx(), "read_file", { path: "big.txt", length: 10_000_000 }); expect(r.text).toContain("bytes 0-65536"); });
  it("refuses binary files", async () => { await expect(runTool(ctx(), "read_file", { path: "bin.dat" })).rejects.toMatchObject({ code: "bad_arguments" }); });
  it("errors are typed", async () => {
    await expect(runTool(ctx(), "read_file", { path: "missing" })).rejects.toMatchObject({ code: "not_found" });
    await expect(runTool(ctx(), "read_file", { path: "many" })).rejects.toMatchObject({ code: "not_a_file" });
    await expect(runTool(ctx(), "list_directory", { path: "small.txt" })).rejects.toMatchObject({ code: "not_a_directory" });
  });
  it("invalid arguments", async () => {
    for (const [tool, args] of [["read_file", {}], ["read_file", { path: 5 }], ["read_file", { path: "a", offset: -1 }], ["read_file", { path: "a", extra: 1 }], ["read_file", "str"], ["read_file", { path: "a", length: NaN }], ["nope", {}]] as const)
      await expect(runTool(ctx(), tool, args)).rejects.toMatchObject({ code: tool === "nope" ? "unknown_tool" : "bad_arguments" });
  });
  it("boundText never splits a UTF-8 character", () => { const r = boundText("é".repeat(10), 5); expect(r.truncated).toBe(true); expect(r.text).toBe("éé"); });
});
