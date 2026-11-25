/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) on WebCrypto, so it runs in Workers and Node alike. Works with Google/Microsoft Authenticator. */
const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function b32encode(b: Uint8Array): string {
  let bits = 0, v = 0, out = "";
  for (const x of b) { v = (v << 8) | x; bits += 8; while (bits >= 5) { out += A[(v >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += A[(v << (5 - bits)) & 31];
  return out;
}
export function b32decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[\s=-]/g, ""); const out: number[] = []; let bits = 0, v = 0;
  for (const c of clean) { const i = A.indexOf(c); if (i < 0) throw new Error("invalid base32"); v = (v << 5) | i; bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  return Uint8Array.from(out);
}
export function newTotpSecret(): string { return b32encode(crypto.getRandomValues(new Uint8Array(20))); }
export function otpauthUri(secret: string, account: string, issuer: string): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
async function hotp(key: Uint8Array, counter: number): Promise<string> {
  const k = await crypto.subtle.importKey("raw", key as unknown as ArrayBuffer, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const buf = new ArrayBuffer(8); const dv = new DataView(buf);
  dv.setUint32(0, Math.floor(counter / 2 ** 32)); dv.setUint32(4, counter >>> 0);
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", k, buf));
  const o = h[19]! & 15;
  const n = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, "0");
}
export const totpNow = (secret: string, now = Date.now()) => hotp(b32decode(secret), Math.floor(now / 30_000));
/** Returns the matched 30-second step (so callers can reject replays), or null. Accepts +-1 step of clock drift. */
export async function verifyTotp(secret: string, code: string, now = Date.now(), window = 1): Promise<number | null> {
  const c = code.replace(/\s/g, ""); if (!/^\d{6}$/.test(c)) return null;
  const step = Math.floor(now / 30_000); const key = b32decode(secret); let hit: number | null = null;
  for (let i = -window; i <= window; i++) if ((await hotp(key, step + i)) === c) hit = step + i; // no early exit: constant-ish time
  return hit;
}
