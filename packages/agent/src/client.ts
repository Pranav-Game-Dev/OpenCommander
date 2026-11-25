import WebSocket from "ws";
import os from "node:os";
import { HEARTBEAT_PING, PROTOCOL_VERSION, ToolError, type CallMsg, type ResultMsg } from "@opencommander/shared";
import { runTool, summarize, type ToolCtx } from "./tools.js";
import { callerStore, touchConnection } from "./livelink.js";

export interface ClientOpts {
  gatewayUrl: string; token: string; ctx: ToolCtx;
  log?: (e: Record<string, unknown>) => void;
  heartbeatMs?: number; deadAfterMs?: number; backoffMs?: [number, number]; maxConcurrent?: number;
}

/** Outbound-only agent connection: reconnects forever (except when the token is rejected/revoked). */
export class AgentClient {
  private ws: WebSocket | null = null;
  private stopped = false; private attempts = 0; private timer: NodeJS.Timeout | null = null; private hb: NodeJS.Timeout | null = null;
  private inFlight = 0; private lastRx = 0; private upSince = 0;
  fatal: string | null = null;
  private log: (e: Record<string, unknown>) => void;
  constructor(private o: ClientOpts) { this.log = o.log ?? (() => {}); }

  start() { this.connect(); }
  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); if (this.hb) clearInterval(this.hb); this.ws?.terminate(); }
  get connected() { return this.ws?.readyState === WebSocket.OPEN; }
  get busy() { return this.inFlight; }

  private connect() {
    if (this.stopped) return;
    const url = this.o.gatewayUrl.replace(/^http/, "ws") + "/agent";
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.o.token}` }, maxPayload: 1024 * 1024, handshakeTimeout: 15_000 });
    this.ws = ws;
    ws.on("open", () => {
      this.attempts = 0; this.lastRx = Date.now(); this.upSince = Date.now();
      this.log({ ev: "connected" });
      ws.send(JSON.stringify({ t: "hello", v: PROTOCOL_VERSION, agent: "opencommander-agent/0.1.0", platform: os.platform(), workspaces: this.o.ctx.roots.length }));
      if (this.hb) clearInterval(this.hb);
      // Short keepalive: home routers / ISPs / the edge silently drop idle TCP flows (shows up as close code 1006).
      const every = this.o.heartbeatMs ?? 15_000, dead = this.o.deadAfterMs ?? 45_000;
      this.hb = setInterval(() => {
        if (Date.now() - this.lastRx > dead) { this.log({ ev: "heartbeat_lost" }); ws.terminate(); return; }
        try { ws.send(HEARTBEAT_PING); ws.ping(); } catch {}
      }, every);
    });
    ws.on("pong", () => { this.lastRx = Date.now(); });
    ws.on("message", (data) => { this.lastRx = Date.now(); const s = data.toString(); if (s === "pong") return; void this.onCall(ws, s); });
    ws.on("unexpected-response", (_req, res) => {
      if (res.statusCode === 401 || res.statusCode === 403) { this.fatal = "Gateway rejected the device token (revoked or invalid). Re-pair the device."; this.log({ ev: "auth_rejected", status: res.statusCode }); this.stop(); }
      else this.log({ ev: "upgrade_failed", status: res.statusCode });
      res.resume();
    });
    ws.on("close", (code) => {
      if (this.hb) clearInterval(this.hb);
      this.log({ ev: "disconnected", code, upMs: this.upSince ? Date.now() - this.upSince : 0 }); this.upSince = 0;
      if (code === 4001) { this.fatal = "Device was revoked on the gateway."; this.stop(); return; }
      this.schedule();
    });
    ws.on("error", (e) => this.log({ ev: "ws_error", msg: String((e as Error).message).slice(0, 200) }));
  }
  private schedule() {
    if (this.stopped) return;
    const [min, max] = this.o.backoffMs ?? [1000, 60_000];
    const d = Math.min(max, min * 2 ** this.attempts++) * (0.5 + Math.random() / 2);
    this.timer = setTimeout(() => this.connect(), d);
  }
  private async onCall(ws: WebSocket, raw: string) {
    let m: CallMsg; try { m = JSON.parse(raw); } catch { return; }
    if (m?.t !== "call" || typeof m.id !== "string") return;
    this.log({ ev: "call", id: m.id, tool: m.tool, args: m.args, caller: m.caller, summary: summarize(m.args) });
    const reply = (r: Omit<ResultMsg, "t" | "id">) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "result", id: m.id, ...r })); };
    if (this.inFlight >= (this.o.maxConcurrent ?? 16)) return reply({ ok: false, error: { code: "device_busy", message: "Agent is busy" } });
    this.inFlight++; const t0 = Date.now();
    try {
      const deadline = Math.max(1000, Math.min(Number(m.deadlineMs) || 30_000, 120_000) - 500);
      const out = await Promise.race([
        (touchConnection(m.caller?.id), callerStore.run({ id: m.caller?.id ?? "", label: m.caller?.label ?? "" }, () => runTool(this.o.ctx, m.tool, m.args))),
        new Promise<never>((_, rej) => setTimeout(() => rej(new ToolError("timeout", "Tool exceeded its deadline on the device")), deadline)),
      ]);
      reply({ ok: true, text: out.text, truncated: out.truncated, ...(out.image ? { image: out.image } : {}) });
      this.log({ ev: "call_done", id: m.id, tool: m.tool, caller: m.caller, ms: Date.now() - t0, ok: true, bytes: out.text.length, truncated: out.truncated });
    } catch (e: any) {
      const code = e instanceof ToolError ? e.code : "internal";
      reply({ ok: false, error: { code, message: e instanceof ToolError ? e.message : "Internal agent error" } });
      this.log({ ev: "call_done", id: m.id, tool: m.tool, caller: m.caller, ms: Date.now() - t0, ok: false, code, detail: e instanceof ToolError ? e.message.slice(0, 160) : undefined });
    } finally { this.inFlight--; }
  }
}
