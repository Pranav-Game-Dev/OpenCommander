import { DeviceRegistry, Relay, TOOLS, ToolError, timingSafeEqual, validateArgs, verifyTotp, type Caller, type KV } from "@opencommander/shared";
import { Stats } from "./stats.js";

export type Logger = (e: Record<string, unknown>) => void;
export interface HubOpts { adminToken: string; kv: KV; log?: Logger; now?: () => number }
export type CallOutcome = { ok: true; text: string; truncated: boolean; image?: { mimeType: string; data: string } } | { ok: false; code: string; message: string };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const bearer = (req: Request) => /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? null;

/** Runtime-neutral gateway core: device registry, relay, pairing/admin HTTP, rate limiting. */
export class Hub {
  readonly relay: Relay; readonly registry: DeviceRegistry; readonly stats: Stats;
  private log: Logger; private now: () => number;
  constructor(private o: HubOpts) {
    this.log = o.log ?? (() => {}); this.now = o.now ?? Date.now;
    this.relay = new Relay(this.log); this.registry = new DeviceRegistry(o.kv, this.now); this.stats = new Stats(o.kv, this.now);
  }

  // ---- failure rate limiting (persisted so it survives restarts) ----
  async blocked(key: string, max: number, windowMs: number): Promise<boolean> {
    const r = await this.o.kv.get(`rl:${key}`);
    return !!r && r.start + windowMs > this.now() && r.n >= max;
  }
  async fail(key: string, windowMs: number): Promise<void> {
    const r = await this.o.kv.get(`rl:${key}`); const t = this.now();
    await this.o.kv.put(`rl:${key}`, r && r.start + windowMs > t ? { start: r.start, n: r.n + 1 } : { start: t, n: 1 });
  }
  /** Owner passphrase check for the OAuth consent page. 5 failures / 10 min then locked. */
  async verifyOwner(candidate: string, secret: string | undefined, ip = "unknown"): Promise<boolean> {
    return (await this.checkOwner(candidate, secret, ip)).ok;
  }
  /** Per-IP lockout (a stranger can't lock the owner out), counter resets on success, whitespace-trimmed. */
  async checkOwner(candidate: string, secret: string | undefined, ip = "unknown", totpSecret?: string, totpCode = ""): Promise<{ ok: boolean; reason?: "locked" | "wrong" | "unconfigured"; left?: number }> {
    const sec = (secret ?? "").trim();
    if (sec.length < 12) { this.log({ ev: "owner_passphrase_not_configured" }); return { ok: false, reason: "unconfigured" }; }
    const key = `owner:${ip.slice(0, 64)}`;
    if (await this.blocked(key, 5, 600_000)) return { ok: false, reason: "locked" };
    const passOk = timingSafeEqual(candidate.trim(), sec);
    let totpOk = true; let step: number | null = null;
    const ts = (totpSecret ?? "").trim();
    if (ts.length >= 16) { // optional 2nd factor; only enforced for NEW authorizations (existing tokens never re-check it)
      step = await verifyTotp(ts, totpCode, this.now());
      const last = (await this.o.kv.get("totp:last")) as number | undefined;
      totpOk = step !== null && (last === undefined || step > last); // a code works once (replay protection)
    }
    if (passOk && totpOk) { if (step !== null) await this.o.kv.put("totp:last", step); await this.o.kv.delete(`rl:${key}`); return { ok: true }; }
    await this.fail(key, 600_000); this.log({ ev: "owner_auth_failed", ip });
    const r = await this.o.kv.get(`rl:${key}`);
    return { ok: false, reason: "wrong", left: Math.max(0, 5 - (r?.n ?? 5)) };
  }
  async resetLimits(): Promise<number> {
    let n = 0; for (const k of (await this.o.kv.list("rl:")).keys()) { await this.o.kv.delete(k); n++; } return n;
  }

  async authenticateAgent(req: Request): Promise<string | null> {
    const t = bearer(req); return t ? this.registry.verify(t) : null;
  }

  /** Admin bearer check with the shared lockout, for admin routes handled outside handleHttp. */
  async adminOk(token: string | null): Promise<{ ok: boolean; status?: number }> {
    if (this.o.adminToken.length < 16) return { ok: false, status: 503 };
    if (await this.blocked("admin", 10, 600_000)) return { ok: false, status: 429 };
    if (!token || !timingSafeEqual(token, this.o.adminToken)) { await this.fail("admin", 600_000); this.log({ ev: "admin_auth_failed" }); return { ok: false, status: 401 }; }
    return { ok: true };
  }
  async note(caller: Caller) { await this.stats.bump(caller.id, caller.label, "req"); }

  async callTool(tool: string, args: unknown, timeoutMs?: number, caller?: Caller): Promise<CallOutcome> {
    let failed = false;
    try {
      const clean = validateArgs(tool, args);
      const id = this.relay.pick(clean.device as string | undefined);
      const r = await this.relay.call(id, tool, clean, timeoutMs ?? TOOLS.find((t) => t.name === tool)?.timeoutMs, caller);
      return { ok: true, ...r };
    } catch (e) {
      failed = true;
      if (e instanceof ToolError) return { ok: false, code: e.code, message: e.message };
      this.log({ ev: "internal_error", msg: String((e as Error)?.message).slice(0, 200) });
      return { ok: false, code: "internal", message: "Internal gateway error" };
    } finally {
      if (caller) await this.stats.bump(caller.id, caller.label, "call", failed).catch(() => {});
    }
  }

  async listDevices() {
    const recs = await this.registry.list();
    const live = new Map(this.relay.devices(recs.map((r) => r.id)).map((d) => [d.id, d]));
    return recs.map((r) => ({ ...r, online: live.get(r.id)?.online ?? false, agent: live.get(r.id)?.agent, platform: live.get(r.id)?.platform }));
  }

  /** Public HTTP surface handled here: /health, /pair, /admin/*. Returns null for other paths. */
  async handleHttp(req: Request): Promise<Response | null> {
    const { pathname: p } = new URL(req.url);
    if (p === "/health" && req.method === "GET") return json({ ok: true, devicesOnline: this.relay.onlineIds().length, inFlight: this.relay.pendingCount() });

    if (p === "/pair" && req.method === "POST") {
      if (await this.blocked("pair", 10, 600_000)) return json({ error: "too many attempts, try later" }, 429);
      const raw = await req.text(); if (raw.length > 4096) return json({ error: "body too large" }, 413);
      let b: any; try { b = JSON.parse(raw); } catch { return json({ error: "invalid json" }, 400); }
      if (typeof b?.code !== "string" || b.code.length > 200) return json({ error: "invalid request" }, 400);
      const r = await this.registry.redeem(b.code, typeof b.name === "string" ? b.name : "device");
      if (!r) { await this.fail("pair", 600_000); this.log({ ev: "pair_failed" }); return json({ error: "invalid or expired code" }, 401); }
      this.log({ ev: "device_paired", device: r.id });
      return json(r);
    }

    if (p.startsWith("/admin/")) {
      if (this.o.adminToken.length < 16) return json({ error: "admin API not configured" }, 503);
      if (await this.blocked("admin", 10, 600_000)) return json({ error: "too many attempts, try later" }, 429);
      const t = bearer(req);
      if (!t || !timingSafeEqual(t, this.o.adminToken)) { await this.fail("admin", 600_000); this.log({ ev: "admin_auth_failed" }); return json({ error: "unauthorized" }, 401); }
      if (p === "/admin/pairing-codes" && req.method === "POST") return json(await this.registry.createPairingCode());
      if (p === "/admin/devices" && req.method === "GET") return json({ devices: await this.listDevices() });
      if (p === "/admin/stats" && req.method === "GET") return json({ ...(await this.stats.snapshot()), devicesOnline: this.relay.onlineIds().length, inFlight: this.relay.pendingCount() });
      if (p === "/admin/reset-limits" && req.method === "POST") { await this.o.kv.delete("rl:admin"); return json({ cleared: await this.resetLimits() }); }
      const m = /^\/admin\/devices\/([\w-]{1,64})\/revoke$/.exec(p);
      if (m && req.method === "POST") {
        const ok = await this.registry.revoke(m[1]!);
        if (ok) { this.relay.disconnect(m[1]!); this.log({ ev: "device_revoked", device: m[1] }); }
        return ok ? json({ revoked: m[1] }) : json({ error: "no such device" }, 404);
      }
      return json({ error: "not found" }, 404);
    }
    return null;
  }
}
