import type { KV } from "@opencommander/shared";

export interface ConnStat { label: string; req: number; calls: number; errors: number; first: number; last: number }
export interface StatsData { days: Record<string, { req: number; calls: number }>; months: Record<string, { req: number; calls: number }>; conns: Record<string, ConnStat> }
const empty = (): StatsData => ({ days: {}, months: {}, conns: {} });

/**
 * Cheap usage counters: kept in memory and written to storage at most every FLUSH_MS (one row), so counting
 * never eats the free-plan write budget. Days/months are UTC, matching Cloudflare's quota reset.
 */
export class Stats {
  private d: StatsData | null = null; private dirty = false; private lastFlush = 0;
  static FLUSH_MS = 10_000;
  constructor(private kv: KV, private now: () => number = Date.now) {}
  private async load(): Promise<StatsData> { if (!this.d) this.d = ((await this.kv.get("stats")) as StatsData | undefined) ?? empty(); return this.d; }
  private async maybeFlush(force = false) {
    if (!this.d || !this.dirty) return;
    if (!force && this.now() - this.lastFlush < Stats.FLUSH_MS) return;
    this.lastFlush = this.now(); this.dirty = false;
    const keys = Object.keys(this.d.days).sort(); for (const k of keys.slice(0, Math.max(0, keys.length - 62))) delete this.d.days[k];
    const mk = Object.keys(this.d.months).sort(); for (const k of mk.slice(0, Math.max(0, mk.length - 24))) delete this.d.months[k];
    for (const [id, c] of Object.entries(this.d.conns)) if (this.now() - c.last > 90 * 86_400_000) delete this.d.conns[id];
    await this.kv.put("stats", this.d);
  }
  /** kind "call" = a tool call (also a request); "req" = any other MCP HTTP request. */
  async bump(id: string, label: string, kind: "req" | "call", failed = false) {
    const d = await this.load(); const t = new Date(this.now()); const day = t.toISOString().slice(0, 10), mon = day.slice(0, 7);
    const dd = (d.days[day] ??= { req: 0, calls: 0 }), mm = (d.months[mon] ??= { req: 0, calls: 0 });
    const c = (d.conns[id] ??= { label, req: 0, calls: 0, errors: 0, first: this.now(), last: this.now() });
    c.label = label; c.last = this.now(); c.req++; dd.req++; mm.req++;
    if (kind === "call") { c.calls++; dd.calls++; mm.calls++; if (failed) c.errors++; }
    this.dirty = true; await this.maybeFlush();
  }
  async forget(id: string) { const d = await this.load(); delete d.conns[id]; this.dirty = true; await this.maybeFlush(true); }
  async snapshot() {
    await this.maybeFlush(true); const d = await this.load(); const t = new Date(this.now()).toISOString(); const day = t.slice(0, 10), mon = day.slice(0, 7);
    return { now: this.now(), day, month: mon, today: d.days[day] ?? { req: 0, calls: 0 }, thisMonth: d.months[mon] ?? { req: 0, calls: 0 }, conns: d.conns };
  }
}
