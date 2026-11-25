import { DEFAULT_CALL_TIMEOUT_MS, MAX_CALL_TIMEOUT_MS, MAX_OUTPUT_BYTES, ToolError, boundText, parseAgentMsg, validateArgs, cleanImage, type CallMsg, type Caller, type ImageData } from "./protocol.js";

/** Runtime-neutral socket handle (ws, Cloudflare WebSocket, or a test fake). */
export interface Conn { send(data: string): void; close(code?: number, reason?: string): void }
export interface DeviceInfo { id: string; online: boolean; agent?: string; platform?: string; connectedAt?: number }

interface Pending {
  deviceId: string; conn: Conn;
  resolve(v: { text: string; truncated: boolean; image?: ImageData }): void; reject(e: ToolError): void; timer: ReturnType<typeof setTimeout>;
}
const MAX_IN_FLIGHT_PER_DEVICE = 16;

/**
 * Routes tool calls to the right device connection and matches results by request id.
 * A result is accepted only from the connection the call was sent to, so devices can never
 * answer each other's requests, and callers can never see each other's results.
 */
export class Relay {
  private conns = new Map<string, Conn>();
  private meta = new Map<string, Omit<DeviceInfo, "id" | "online">>();
  private pending = new Map<string, Pending>();
  constructor(private log: (e: Record<string, unknown>) => void = () => {}) {}

  attach(deviceId: string, conn: Conn): void {
    const old = this.conns.get(deviceId);
    this.conns.set(deviceId, conn);
    this.meta.set(deviceId, { connectedAt: Date.now() });
    if (old && old !== conn) { this.failPending(deviceId, old, "disconnected", "Device reconnected; request lost"); try { old.close(1000, "replaced"); } catch {} }
    this.log({ ev: "device_attached", device: deviceId });
  }
  detach(deviceId: string, conn: Conn): void {
    if (this.conns.get(deviceId) === conn) { this.conns.delete(deviceId); this.meta.delete(deviceId); }
    this.failPending(deviceId, conn, "disconnected", "Device disconnected during the call");
    this.log({ ev: "device_detached", device: deviceId });
  }
  /** Kick a device (revocation): close its socket and fail anything in flight. */
  disconnect(deviceId: string): void {
    const c = this.conns.get(deviceId);
    if (c) { this.detach(deviceId, c); try { c.close(4001, "revoked"); } catch {} }
  }
  onMessage(deviceId: string, conn: Conn, raw: string): void {
    const m = parseAgentMsg(raw);
    if (!m) { this.log({ ev: "bad_frame", device: deviceId }); return; }
    if (m.t === "hello") { this.meta.set(deviceId, { ...this.meta.get(deviceId), agent: m.agent, platform: m.platform }); return; }
    const p = this.pending.get(m.id);
    if (!p || p.conn !== conn || p.deviceId !== deviceId) { this.log({ ev: "unmatched_result", device: deviceId }); return; }
    clearTimeout(p.timer); this.pending.delete(m.id);
    if (m.ok) { const b = boundText(m.text ?? "", MAX_OUTPUT_BYTES); const image = cleanImage(m.image); p.resolve({ text: b.text, truncated: b.truncated || m.truncated === true, ...(image ? { image } : {}) }); }
    else p.reject(new ToolError(m.error?.code ?? "internal", String(m.error?.message ?? "Tool failed").slice(0, 2000)));
  }
  devices(known: string[]): DeviceInfo[] {
    return known.map((id) => ({ id, online: this.conns.has(id), ...this.meta.get(id) }));
  }
  isOnline(id: string) { return this.conns.has(id); }
  onlineIds() { return [...this.conns.keys()]; }

  /** Pick a target: explicit id, or the single online device. */
  pick(explicit?: string): string {
    if (explicit) { if (!this.conns.has(explicit)) throw new ToolError("device_offline", `Device ${explicit} is not connected`); return explicit; }
    const ids = this.onlineIds();
    if (ids.length === 0) throw new ToolError("device_offline", "No device is connected. Start the agent on your PC.");
    if (ids.length > 1) throw new ToolError("device_ambiguous", `Several devices online (${ids.join(", ")}); pass "device".`);
    return ids[0]!;
  }

  call(deviceId: string, tool: string, args: unknown, timeoutMs = DEFAULT_CALL_TIMEOUT_MS, caller?: Caller): Promise<{ text: string; truncated: boolean; image?: ImageData }> {
    let clean: Record<string, unknown>;
    try { clean = validateArgs(tool, args); } catch (e) { return Promise.reject(e); } // never throw synchronously
    const conn = this.conns.get(deviceId);
    if (!conn) return Promise.reject(new ToolError("device_offline", `Device ${deviceId} is not connected`));
    let inFlight = 0; for (const p of this.pending.values()) if (p.deviceId === deviceId) inFlight++;
    if (inFlight >= MAX_IN_FLIGHT_PER_DEVICE) return Promise.reject(new ToolError("device_busy", "Too many requests in flight for this device"));
    const t = Math.min(Math.max(timeoutMs, 1), MAX_CALL_TIMEOUT_MS);
    const id = crypto.randomUUID();
    const { device: _omit, ...agentArgs } = clean;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.log({ ev: "call_timeout", device: deviceId, tool });
        reject(new ToolError("timeout", `Device did not answer within ${t} ms`));
      }, t);
      this.pending.set(id, { deviceId, conn, resolve, reject, timer });
      const msg: CallMsg = { t: "call", id, tool, args: agentArgs, deadlineMs: t, ...(caller ? { caller: { id: caller.id.slice(0, 80), label: caller.label.slice(0, 40) } } : {}) };
      try { conn.send(JSON.stringify(msg)); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new ToolError("disconnected", "Failed to send to device")); }
      this.log({ ev: "call", device: deviceId, tool, id });
    });
  }
  private failPending(deviceId: string, conn: Conn, code: "disconnected", message: string) {
    for (const [id, p] of this.pending) if (p.deviceId === deviceId && p.conn === conn) {
      clearTimeout(p.timer); this.pending.delete(id); p.reject(new ToolError(code, message));
    }
  }
  pendingCount() { return this.pending.size; }
}
