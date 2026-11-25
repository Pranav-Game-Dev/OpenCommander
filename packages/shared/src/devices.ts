/** Device pairing + token registry over any tiny key/value store (DO storage in prod, Map in tests). */
export interface KV { get(k: string): Promise<any>; put(k: string, v: any): Promise<void>; delete(k: string): Promise<void>; list(prefix: string): Promise<Map<string, any>> }
export class MemoryKV implements KV {
  m = new Map<string, any>();
  async get(k: string) { return this.m.get(k); }
  async put(k: string, v: any) { this.m.set(k, v); }
  async delete(k: string) { this.m.delete(k); }
  async list(prefix: string) { return new Map([...this.m].filter(([k]) => k.startsWith(prefix))); }
}
export interface DeviceRecord { id: string; name: string; tokenHash: string; createdAt: number; revokedAt?: number }
const PAIR_TTL_MS = 10 * 60_000;

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}

export class DeviceRegistry {
  constructor(private kv: KV, private now: () => number = Date.now) {}

  /** Single-use, short-lived code. Only its hash is stored. */
  async createPairingCode(): Promise<{ code: string; expiresAt: number }> {
    const code = randomToken(9); const expiresAt = this.now() + PAIR_TTL_MS;
    await this.kv.put(`pair:${await sha256Hex(code)}`, { expiresAt });
    return { code, expiresAt };
  }
  async redeem(code: string, name: string): Promise<{ id: string; token: string } | null> {
    const key = `pair:${await sha256Hex(code)}`;
    const rec = await this.kv.get(key);
    if (!rec) return null;
    await this.kv.delete(key); // single use even if expired
    if (rec.expiresAt < this.now()) return null;
    const id = "dev_" + randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, "x");
    const token = "dcf_" + randomToken(32);
    const d: DeviceRecord = { id, name: name.slice(0, 64) || "device", tokenHash: await sha256Hex(token), createdAt: this.now() };
    await this.kv.put(`dev:${id}`, d);
    return { id, token };
  }
  /** Returns device id if token is valid and not revoked. Constant-time hash compare. */
  async verify(token: string): Promise<string | null> {
    if (!token.startsWith("dcf_") || token.length > 200) return null;
    const h = await sha256Hex(token);
    let found: DeviceRecord | null = null;
    for (const [, v] of await this.kv.list("dev:")) { const r = v as DeviceRecord; if (timingSafeEqual(r.tokenHash, h) && !r.revokedAt) found = r; }
    return found?.id ?? null;
  }
  async revoke(id: string): Promise<boolean> {
    const r = (await this.kv.get(`dev:${id}`)) as DeviceRecord | undefined;
    if (!r) return false;
    r.revokedAt = this.now(); await this.kv.put(`dev:${id}`, r); return true;
  }
  async list(): Promise<Pick<DeviceRecord, "id" | "name" | "createdAt" | "revokedAt">[]> {
    return [...(await this.kv.list("dev:")).values()].map((r: DeviceRecord) => ({ id: r.id, name: r.name, createdAt: r.createdAt, revokedAt: r.revokedAt }));
  }
  async activeIds(): Promise<string[]> { return (await this.list()).filter((d) => !d.revokedAt).map((d) => d.id); }
}
