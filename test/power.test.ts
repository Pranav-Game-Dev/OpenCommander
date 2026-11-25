import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import http from "node:http"; import { fileURLToPath } from "node:url";
import { runTool } from "../packages/agent/src/tools.js";
import { closeAll } from "../packages/agent/src/mcpbridge.js";

let root: string, outside: string, server: http.Server, port = 0;
const ctx = () => ({ roots: [root], flags: { write: true } });
const win = process.platform === "win32";
const echo = (s: string) => `echo ${s}`;
const sleepCmd = win ? "Start-Sleep 30" : "sleep 30";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dcf-p2-"))); outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dcf-p3-")));
  fs.mkdirSync(path.join(root, "d")); fs.writeFileSync(path.join(root, "d", "f.txt"), "x"); fs.writeFileSync(path.join(outside, "o.txt"), "o");
  server = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { res.setHeader("content-type", "text/plain"); res.end(`${req.method}:${b}`); }); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); port = (server.address() as any).port;
});
afterAll(async () => { await closeAll(); server.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });

describe("copy / delete / info / stats", () => {
  it("copy_file never overwrites or escapes", async () => {
    await runTool(ctx(), "copy_file", { source: "d", destination: "d2" }); expect(fs.readFileSync(path.join(root, "d2", "f.txt"), "utf8")).toBe("x");
    await expect(runTool(ctx(), "copy_file", { source: "d", destination: "d2" })).rejects.toMatchObject({ code: "bad_arguments" });
    await expect(runTool(ctx(), "copy_file", { source: path.join(outside, "o.txt"), destination: "s.txt" })).rejects.toMatchObject({ code: "path_denied" });
  });
  it("delete_path stays inside the workspace and spares the root", async () => {
    await runTool(ctx(), "delete_path", { path: "d2" }); expect(fs.existsSync(path.join(root, "d2"))).toBe(false);
    await expect(runTool(ctx(), "delete_path", { path: "." })).rejects.toMatchObject({ code: "path_denied" });
    await expect(runTool(ctx(), "delete_path", { path: path.join(outside, "o.txt") })).rejects.toMatchObject({ code: "path_denied" });
    expect(fs.existsSync(path.join(outside, "o.txt"))).toBe(true);
  });
  it("system_info, stats, recent calls", async () => {
    expect(JSON.parse((await runTool(ctx(), "system_info", {})).text).platform).toBe(process.platform);
    expect(JSON.parse((await runTool(ctx(), "get_usage_stats", {})).text).perTool.copy_file.calls).toBeGreaterThan(0);
    expect((await runTool(ctx(), "get_recent_tool_calls", { tool: "copy_file" })).text).toContain("copy_file");
  });
});

describe("processes", () => {
  it("runs a command and returns output", async () => {
    const r = await runTool(ctx(), "start_process", { command: echo("hello-dcf"), wait_ms: 6000 }); expect(r.text).toContain("hello-dcf"); expect(r.text).toMatch(/exited code=0|running/);
  });
  it("runs in the workspace by default and refuses cwd outside it", async () => {
    const r = await runTool(ctx(), "start_process", { command: win ? "(Get-Location).Path" : "pwd", wait_ms: 8000 }); expect(r.text.toLowerCase()).toContain(path.basename(root).toLowerCase());
    await expect(runTool(ctx(), "start_process", { command: echo("x"), cwd: outside })).rejects.toMatchObject({ code: "path_denied" });
  });
  it("does not leak the agent's OC_* secrets to children", async () => {
    process.env.OC_TEST_SECRET = "s3cret-value";
    const cmd = win ? "$n = 'OC' + '_TEST_SECRET'; Write-Output ('[' + [Environment]::GetEnvironmentVariable($n) + ']')" : "n=OC; n=${n}_TEST_SECRET; echo \"[${!n}]\"";
    const r = await runTool(ctx(), "start_process", { command: cmd, wait_ms: 8000 });
    expect(r.text).toContain("[]"); expect(r.text).not.toContain("s3cret-value"); delete process.env.OC_TEST_SECRET;
  });
  it("blocks catastrophic and credential-touching commands", async () => {
    for (const c of ["shutdown /s /t 0", "Remove-Item C:\\ -Recurse -Force", "rm -rf /", "format C:", "type device.json", "echo $env:OC_ADMIN_TOKEN"])
      await expect(runTool(ctx(), "start_process", { command: c })).rejects.toMatchObject({ code: "blocked" });
    const ok = await runTool(ctx(), "start_process", { command: "echo \"rm ./file-is-fine\"", wait_ms: 8000 }); expect(ok.text).toContain("rm ./file-is-fine");
  });
  it("lists sessions, reads output, terminates", async () => {
    const r = await runTool(ctx(), "start_process", { command: sleepCmd, wait_ms: 300 }); const pid = Number(/pid=(\d+)/.exec(r.text)![1]);
    expect((await runTool(ctx(), "list_sessions", {})).text).toContain(String(pid));
    expect((await runTool(ctx(), "read_process_output", { pid, wait_ms: 200 })).text).toContain("running");
    await runTool(ctx(), "force_terminate", { pid }); await delay(1500);
    expect((await runTool(ctx(), "read_process_output", { pid, wait_ms: 200 })).text).toContain("exited");
    await expect(runTool(ctx(), "force_terminate", { pid: 999999 })).rejects.toMatchObject({ code: "process_not_found" });
  });
  it("interact_with_process feeds stdin", async () => {
    const r = await runTool(ctx(), "start_process", { command: "node -e \"process.stdin.on('data',d=>{console.log('got:'+d.toString().trim());process.exit(0)})\"", wait_ms: 1500 });
    const pid = Number(/pid=(\d+)/.exec(r.text)![1]);
    expect((await runTool(ctx(), "interact_with_process", { pid, input: "ping", wait_ms: 4000 })).text).toContain("got:ping");
  });
  it("list_processes works; kill_process refuses the agent itself", async () => {
    expect((await runTool(ctx(), "list_processes", {})).text).toContain("pid");
    await expect(runTool(ctx(), "kill_process", { pid: process.pid })).rejects.toMatchObject({ code: "blocked" });
  });
  it("can be switched off", async () => {
    process.env.OC_DISABLE_EXEC = "1";
    try { await expect(runTool(ctx(), "start_process", { command: echo("x") })).rejects.toMatchObject({ code: "tool_disabled" }); } finally { delete process.env.OC_DISABLE_EXEC; }
  });
  it("set_config_value changes folders and blocked commands", async () => {
    await runTool(ctx(), "set_config_value", { key: "blockedCommands", value: "forbidden-word" });
    await expect(runTool(ctx(), "start_process", { command: "echo FORBIDDEN-WORD" })).rejects.toMatchObject({ code: "blocked" });
    await runTool(ctx(), "set_config_value", { key: "blockedCommands", value: "" });
    const c = ctx(); await runTool(c, "set_config_value", { key: "allowedDirectories", value: `${root}\n${outside}` }); expect(c.roots.length).toBe(2);
    await expect(runTool(ctx(), "set_config_value", { key: "allowedDirectories", value: "Z:\\no\\such\\folder" })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("http_request", () => {
  it("reaches a local service", async () => {
    const r = await runTool(ctx(), "http_request", { url: `http://127.0.0.1:${port}/x`, method: "POST", body: "hi" }); expect(r.text).toContain("HTTP 200"); expect(r.text).toContain("POST:hi");
  });
  it("rejects non-http URLs", async () => { await expect(runTool(ctx(), "http_request", { url: "file:///C:/Windows/win.ini" })).rejects.toMatchObject({ code: "bad_arguments" }); });
});

describe("local MCP bridge", () => {
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "echo-mcp.mjs");
  beforeAll(() => { const cfg = path.join(outside, "mcp.json"); fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [fixture] }, dead: { command: "definitely-not-a-real-program-xyz" } } })); process.env.OC_MCP_CONFIG = cfg; });
  afterAll(() => { delete process.env.OC_MCP_CONFIG; });
  it("lists configured servers", async () => { const j = JSON.parse((await runTool(ctx(), "mcp_servers", {})).text); expect(j.servers.map((s: any) => s.name).sort()).toEqual(["dead", "echo"]); });
  it("lists tools and calls one", async () => {
    expect((await runTool(ctx(), "mcp_list_tools", { server: "echo" })).text).toContain("echo: Echo text");
    expect((await runTool(ctx(), "mcp_call", { server: "echo", tool: "echo", arguments: "{\"text\":\"hi\"}" })).text).toBe("echo:hi");
  });
  it("surfaces tool errors and bad input clearly", async () => {
    await expect(runTool(ctx(), "mcp_call", { server: "echo", tool: "boom" })).rejects.toMatchObject({ code: "upstream" });
    await expect(runTool(ctx(), "mcp_call", { server: "echo", tool: "echo", arguments: "not json" })).rejects.toMatchObject({ code: "bad_arguments" });
    await expect(runTool(ctx(), "mcp_list_tools", { server: "nope" })).rejects.toMatchObject({ code: "not_found" });
    await expect(runTool(ctx(), "mcp_list_tools", { server: "dead" })).rejects.toMatchObject({ code: "upstream" });
  });
});

describe("browser", () => {
  it("reports clearly if agent-browser is missing, otherwise runs it", async () => {
    try { const r = await runTool(ctx(), "browser", { args: "--version" }); expect(r.text.length).toBeGreaterThan(0); }
    catch (e: any) { expect(["unavailable", "timeout"]).toContain(e.code); }
  });
});
