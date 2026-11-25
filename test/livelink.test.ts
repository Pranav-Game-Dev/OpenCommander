import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcf-ll-"));
process.env.OC_LIVELINK_DIR = dir; process.env.OC_LIVELINK_WINDOW = "0";
const { liveLink, resetLiveLink, sweepLiveLink } = await import("../packages/agent/src/livelink.js");
const L = async (a: Record<string, unknown>) => (await liveLink(a)).text;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => { resetLiveLink(); delete process.env.OC_LIVELINK_IDLE_MIN; });
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("live link", () => {
  it("join returns identity, rules and roster", async () => {
    const t = await L({ action: "join", name: "Claude_A", role: "lead" });
    expect(t).toContain('as Claude_A'); expect(t).toContain("LIVE LINK RULES"); expect(t).toContain("Lead: Claude_A");
    const t2 = await L({ action: "join", name: "GPT_B" });
    expect(t2).toContain("Claude_A★");
  });
  it("delivers messages and wait wakes on them", async () => {
    await L({ action: "join", name: "A" }); await L({ action: "join", name: "B" });
    const waiting = L({ action: "wait", me: "A", seconds: 20 });
    await sleep(200);
    const sent = await L({ action: "say", me: "B", to: "A", text: "ctx ready", type: "report" });
    expect(sent).toMatch(/^sent #/);
    const got = await waiting;
    expect(got).toContain("B→A [report]: ctx ready");
    expect(await L({ action: "read", me: "A" })).toBe("No new messages.");
  });
  it("wait times out with a helpful hint", async () => {
    await L({ action: "join", name: "A" }); await L({ action: "join", name: "B" });
    await L({ action: "status", me: "B", state: "working", note: "build", eta_min: 5 });
    await L({ action: "read", me: "A" });
    const r = await L({ action: "wait", me: "A", seconds: 3 });
    expect(r).toContain("No new messages after 3s"); expect(r).toContain("B"); expect(r).toContain("eta");
  });
  it("wait wakes when a peer joins", async () => {
    await L({ action: "join", name: "A" });
    const w = L({ action: "wait", me: "A", seconds: 20 });
    await sleep(150); await L({ action: "join", name: "B" });
    expect(await w).toContain("B joined the Live Link");
  });
  it("private messages stay private; unknown recipient rejected", async () => {
    await L({ action: "join", name: "A" }); await L({ action: "join", name: "B" }); await L({ action: "join", name: "C" });
    await L({ action: "say", me: "A", to: "B", text: "secret plan" });
    expect(await L({ action: "read", me: "C" })).not.toContain("secret plan");
    expect(await L({ action: "read", me: "B" })).toContain("secret plan");
    await expect(L({ action: "say", me: "A", to: "Nobody", text: "hi" })).rejects.toThrow(/No member/);
  });
  it("rate limits and suppresses duplicates", async () => {
    await L({ action: "join", name: "A" }); await L({ action: "join", name: "B" });
    await L({ action: "say", me: "A", text: "same" });
    await expect(L({ action: "say", me: "A", text: "same" })).rejects.toThrow(/Same message/);
    for (let i = 0; i < 19; i++) await L({ action: "say", me: "A", text: `m${i}` });
    await expect(L({ action: "say", me: "A", text: "one more" })).rejects.toThrow(/Too many/);
  });
  it("share/get store big context once", async () => {
    await L({ action: "join", name: "A" }); await L({ action: "join", name: "B" });
    await L({ action: "share", me: "A", title: "ctx", text: "x".repeat(100_000), to: "B" });
    const msg = await L({ action: "read", me: "B" }); expect(msg).toContain("S1"); expect(msg.length).toBeLessThan(300);
    const part = await L({ action: "get", me: "B", id: 1 }); expect(part).toContain("more: action=get");
    expect(await L({ action: "get", me: "B", id: 1, offset: 40000 })).toContain("[40000-80000 of 100000]");
  });
  it("tasks: assign, start, done notifies creator", async () => {
    await L({ action: "join", name: "A" }); await L({ action: "join", name: "B" });
    await L({ action: "task", me: "A", op: "add", title: "Make rig", to: "B" });
    expect(await L({ action: "read", me: "B" })).toContain("T1: Make rig");
    await L({ action: "task", me: "B", op: "start", id: 1 });
    await L({ action: "task", me: "B", op: "done", id: 1, note: "rig.blend" });
    expect(await L({ action: "read", me: "A" })).toContain("T1 done: rig.blend");
    expect(await L({ action: "task", me: "A", op: "list" })).toContain("[done]");
  });
  it("marks silent members away (not removed), and they resume where they left off", async () => {
    process.env.OC_LIVELINK_IDLE_MIN = "0.001";
    await L({ action: "join", name: "A" }); await L({ action: "join", name: "Gem" });
    await L({ action: "say", me: "A", to: "Gem", text: "please do X" });
    await sleep(150); await L({ action: "who", me: "A" }); sweepLiveLink();
    const a = await L({ action: "read", me: "A" });
    expect(a).toContain("Gem went quiet"); expect(a).not.toContain("left the Live Link");
    expect(await L({ action: "who", me: "A" })).toContain("away");
    delete process.env.OC_LIVELINK_IDLE_MIN;
    const back = await L({ action: "read", me: "Gem" }); // its missed message is still waiting for it
    expect(back).toContain("please do X");
    expect(await L({ action: "read", me: "A" })).toContain("Gem is back");
  });
  it("re-adds an unknown caller automatically (agent restart / forgotten join)", async () => {
    const r = await L({ action: "say", me: "Ghost", text: "hello?" });
    expect(r).toContain("re-added automatically");
    expect(await L({ action: "who", me: "Ghost" })).toContain("Members:");
  });
  it("accepts very long messages and status rides on say", async () => {
    await L({ action: "join", name: "A" }); await L({ action: "join", name: "B" });
    const big = "line of context\n".repeat(2000);
    await L({ action: "say", me: "A", to: "B", text: big, state: "planning", note: "designing" });
    expect((await L({ action: "read", me: "B" })).length).toBeGreaterThan(30_000);
    expect(await L({ action: "who", me: "B" })).toContain("planning");
  });
  it("guided handover: giver -> receiver, questions, both leave", async () => {
    const giver = await L({ action: "handover", op: "start", side: "giver", name: "GPT" });
    expect(giver).toContain("GIVER"); expect(giver).toContain("not here yet");
    const w = L({ action: "wait", me: "GPT", seconds: 20 });
    const rec = await L({ action: "handover", op: "start", side: "receiver", name: "Gemini" });
    expect(rec).toContain("RECEIVER");
    expect(await w).toContain("Handover GPT (giver)");
    await expect(L({ action: "handover", op: "send", me: "GPT", goal: "x" })).rejects.toThrow(/goal, status and timeline/);
    await L({ action: "handover", op: "send", me: "GPT", goal: "Portfolio site", timeline: "P1 User: build a portfolio site / Done: created index.html", status: "70% done", files: "C:/site/index.html", issues: "canvas size bug" });
    const pkg = await L({ action: "wait", me: "Gemini", seconds: 20 });
    expect(pkg).toContain("## Goal"); expect(pkg).toContain("canvas size bug");
    await L({ action: "handover", op: "questions", me: "Gemini", text: "Which browser did you test in?" });
    expect(await L({ action: "wait", me: "GPT", seconds: 20 })).toContain("Which browser");
    await L({ action: "handover", op: "answer", me: "GPT", text: "Chromium 130" });
    expect(await L({ action: "wait", me: "Gemini", seconds: 20 })).toContain("Chromium 130");
    expect(await L({ action: "handover", op: "done", me: "Gemini" })).toContain("Waiting for GPT");
    expect(await L({ action: "wait", me: "GPT", seconds: 20 })).toContain("I have what I need");
    const wg = L({ action: "wait", me: "Gemini", seconds: 20 });
    await sleep(150);
    expect(await L({ action: "handover", op: "done", me: "GPT" })).toContain("Handover complete");
    expect(await wg).toContain("Handover complete");
    await expect(L({ action: "say", me: "GPT", text: "again" })).rejects.toThrow(/handover .* is complete/);
  });
  it("name collision gets a suffix; leave announces", async () => {
    await L({ action: "join", name: "A" });
    expect(await L({ action: "join", name: "A" })).toContain("as A_2");
    await L({ action: "leave", me: "A_2", note: "done" });
    expect(await L({ action: "join", name: "A", me: "A" })).toContain("as A."); // same identity returning keeps its name
    expect(await L({ action: "read", me: "A" })).toContain("A_2 left the Live Link (done)");
  });
  it("writes an event log for the window", async () => {
    await L({ action: "join", name: "A", room: "logroom" });
    const lines = fs.readFileSync(path.join(dir, "logroom.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(expect.arrayContaining(["boot", "join", "msg"]));
  });
});
