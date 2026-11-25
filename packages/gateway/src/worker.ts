import { DurableObject } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { ClientInfo, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { DEFAULT_LOGO_NAME, DEFAULT_LOGO_SVG, DEFAULT_PLUGIN_NAME, MAX_MESSAGE_BYTES, PRODUCT, TOOLS, cleanPluginName, cleanSvg, type Caller, type KV, type OcConfig } from "@opencommander/shared";
import { Hub, type CallOutcome } from "./hub.js";
import { handleMcp } from "./mcp.js";

export interface Env {
  HUB: DurableObjectNamespace<DeviceHub>; OAUTH_KV: KVNamespace;
  ADMIN_TOKEN: string; OWNER_PASSPHRASE: string; PUBLIC_URL?: string; // PUBLIC_URL optional: defaults to the request origin
  OWNER_TOTP_SECRET?: string; // optional 2FA (base32); when set, NEW authorizations also need an authenticator code
  OAUTH_PROVIDER: OAuthHelpers; // injected by the OAuth provider for the default handler
}
const log = (e: Record<string, unknown>) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...e }));
const hubStub = (env: Env) => env.HUB.get(env.HUB.idFromName("hub"));

/** One Durable Object holds every device socket (single-owner design). SQLite-backed => free plan. */
export class DeviceHub extends DurableObject<Env> {
  private hub: Hub;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const kv: KV = {
      get: (k) => ctx.storage.get(k), put: async (k, v) => { await ctx.storage.put(k, v); },
      delete: async (k) => { await ctx.storage.delete(k); }, list: (prefix) => ctx.storage.list({ prefix }) as Promise<Map<string, any>>,
    };
    this.hub = new Hub({ adminToken: env.ADMIN_TOKEN ?? "", kv, log });
    // Sockets survive hibernation; the in-memory relay does not. Rebuild it.
    for (const ws of ctx.getWebSockets()) { const a = ws.deserializeAttachment() as { deviceId?: string } | null; if (a?.deviceId) this.hub.relay.attach(a.deviceId, ws); }
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong")); // keepalive without waking the DO
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/agent") {
      if (request.headers.get("upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
      const deviceId = await this.hub.authenticateAgent(request);
      if (!deviceId) { log({ ev: "agent_auth_failed" }); return new Response("Unauthorized", { status: 401 }); }
      const pair = new WebSocketPair(); const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ deviceId });
      this.hub.relay.attach(deviceId, server);
      return new Response(null, { status: 101, webSocket: client });
    }
    return (await this.hub.handleHttp(request)) ?? new Response("Not found", { status: 404 });
  }
  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    const a = ws.deserializeAttachment() as { deviceId?: string } | null; if (!a?.deviceId) return;
    if (typeof msg !== "string") { ws.close(1003, "text only"); return; }
    if (msg.length > MAX_MESSAGE_BYTES) { ws.close(1009, "too large"); return; }
    this.hub.relay.onMessage(a.deviceId, ws, msg);
  }
  async webSocketClose(ws: WebSocket) { const a = ws.deserializeAttachment() as { deviceId?: string } | null; if (a?.deviceId) this.hub.relay.detach(a.deviceId, ws); }
  async webSocketError(ws: WebSocket) { return this.webSocketClose(ws); }

  // ---- RPC used by the Worker (never reachable from the internet) ----
  async callTool(tool: string, args: Record<string, unknown>, caller?: Caller): Promise<CallOutcome> { return this.hub.callTool(tool, args, undefined, caller); }
  async note(caller: Caller) { return this.hub.note(caller); }
  async listDevices() { return this.hub.listDevices(); }
  async verifyOwner(candidate: string, ip = "unknown", totpCode = "") { return this.hub.checkOwner(candidate, this.env.OWNER_PASSPHRASE, ip, this.env.OWNER_TOTP_SECRET, totpCode); }
  async adminOk(token: string | null) { return this.hub.adminOk(token); }
  async statsSnapshot() { return this.hub.stats.snapshot(); }
  async forgetConn(id: string) { return this.hub.stats.forget(id); }
}

// ---------------- connection identity (who is calling) ----------------
const hostOf = (u: string) => { try { return new URL(u).hostname; } catch { return ""; } };
/** Friendly family name from the OAuth client's own metadata. */
export function familyOf(c: Pick<ClientInfo, "clientName" | "redirectUris"> | null | undefined): string {
  const name = (c?.clientName ?? "").toLowerCase(); const hosts = (c?.redirectUris ?? []).map(hostOf).join(" ").toLowerCase(); const all = `${name} ${hosts}`;
  const known: [RegExp, string][] = [[/chatgpt|openai/, "ChatGPT"], [/claude|anthropic/, "Claude"], [/gemini|google|bard/, "Gemini"], [/perplexity/, "Perplexity"], [/mistral/, "Mistral"], [/opencode/, "OpenCode"], [/cursor/, "Cursor"], [/copilot|microsoft/, "Copilot"], [/grok|x\.ai/, "Grok"]];
  for (const [re, n] of known) if (re.test(all)) return n;
  const w = (c?.clientName ?? "").replace(/[^A-Za-z0-9]/g, " ").trim().split(/\s+/)[0] ?? "";
  return (w || hostOf(c?.redirectUris?.[0] ?? "").split(".").slice(-2, -1)[0] || "Client").slice(0, 12);
}
const shortId = (grantId: string) => (grantId.split(":").pop() ?? grantId).replace(/[^A-Za-z0-9]/g, "").slice(-4).toUpperCase().padStart(4, "0");
export const labelFor = (c: Pick<ClientInfo, "clientName" | "redirectUris"> | null | undefined, grantId: string) => `${familyOf(c)}_${shortId(grantId)}`;

async function lookupClient(env: Env, clientId: string): Promise<ClientInfo | null> {
  try { const c = await env.OAUTH_PROVIDER?.lookupClient(clientId); if (c) return c; } catch { /* fall through */ }
  try { const j = await env.OAUTH_KV.get(`client:${clientId}`, "json"); if (j) return j as ClientInfo; } catch { /* ignore */ }
  return null;
}
// Display-name overrides (set from the manage script). One KV key, cached for 30 s per isolate.
let aliasCache: { t: number; v: Record<string, string> } | null = null;
async function getAliases(env: Env): Promise<Record<string, string>> {
  if (aliasCache && Date.now() - aliasCache.t < 30_000) return aliasCache.v;
  const v = ((await env.OAUTH_KV.get("dcf:aliases", "json").catch(() => null)) as Record<string, string> | null) ?? {};
  aliasCache = { t: Date.now(), v }; return v;
}
async function setAliases(env: Env, v: Record<string, string>) { await env.OAUTH_KV.put("dcf:aliases", JSON.stringify(v)); aliasCache = { t: Date.now(), v }; }

// ---------------- owner settings: plugin name, logo, enabled tools (KV key oc:config, edited from the manage script) ----------------
let cfgCache: { t: number; v: OcConfig } | null = null;
export async function getConfig(env: Env): Promise<OcConfig> {
  if (cfgCache && Date.now() - cfgCache.t < 15_000) return cfgCache.v;
  const v = ((await env.OAUTH_KV.get("oc:config", "json").catch(() => null)) as OcConfig | null) ?? {};
  cfgCache = { t: Date.now(), v }; return v;
}
async function setConfig(env: Env, v: OcConfig) { await env.OAUTH_KV.put("oc:config", JSON.stringify(v)); cfgCache = { t: Date.now(), v }; }
const nameOf = (c: OcConfig) => c.name || DEFAULT_PLUGIN_NAME;
const logoOf = (c: OcConfig) => c.logo?.svg || DEFAULT_LOGO_SVG;
const KNOWN_TOOLS = new Set<string>(TOOLS.map((t) => t.name));

function logoResponse(c: OcConfig): Response {
  return new Response(logoOf(c), { headers: {
    "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox", "access-control-allow-origin": "*",
  } });
}

async function adminConfig(request: Request, env: Env): Promise<Response> {
  const auth = await hubStub(env).adminOk(bearerOf(request));
  if (!auth.ok) return Response.json({ error: auth.status === 429 ? "too many attempts, try later" : auth.status === 503 ? "admin API not configured" : "unauthorized" }, { status: auth.status ?? 401 });
  const cur = await getConfig(env);
  if (request.method === "GET") return Response.json({ name: nameOf(cur), customName: !!cur.name, logoName: cur.logo?.name ?? DEFAULT_LOGO_NAME, disabledTools: cur.disabledTools ?? [], tools: TOOLS.map((t) => ({ name: t.name, title: t.title, kind: t.kind })), product: PRODUCT });
  if (request.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
  const b = (await request.json().catch(() => ({}))) as { name?: string; resetName?: boolean; logoName?: string; logoSvg?: string; resetLogo?: boolean; disabledTools?: string[] };
  const next: OcConfig = { ...cur };
  try {
    if (b.resetName) delete next.name; else if (b.name !== undefined) next.name = cleanPluginName(b.name);
    if (b.resetLogo) delete next.logo; else if (b.logoSvg !== undefined) next.logo = { name: String(b.logoName ?? "custom.svg").slice(0, 80), svg: cleanSvg(b.logoSvg) };
    if (b.disabledTools !== undefined) {
      if (!Array.isArray(b.disabledTools)) throw new Error("disabledTools must be a list");
      next.disabledTools = [...new Set(b.disabledTools.map(String).filter((n) => KNOWN_TOOLS.has(n)))].sort();
    }
  } catch (e: any) { return Response.json({ error: String(e?.message ?? e) }, { status: 400 }); }
  await setConfig(env, next); log({ ev: "config_updated" });
  return Response.json({ ok: true, name: nameOf(next), logoName: next.logo?.name ?? DEFAULT_LOGO_NAME, disabledTools: next.disabledTools ?? [] });
}

// ---------------- OAuth consent (owner passphrase [+ optional authenticator code]) ----------------
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const GRANTABLE = new Set(["mcp:read"]);
const html = (body: string, headers?: Headers, status = 200) => {
  const h = new Headers(headers); h.set("content-type", "text/html; charset=utf-8");
  h.set("cache-control", "no-store"); h.set("referrer-policy", "no-referrer"); h.set("x-frame-options", "DENY");
  h.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  return new Response(body, { status, headers: h });
};
const KNOWN = /(^|\.)(chatgpt\.com|openai\.com|claude\.ai|claude\.com|anthropic\.com|google\.com|perplexity\.ai|mistral\.ai|microsoft\.com|cursor\.com|poe\.com|x\.ai|grok\.com)$/i;

interface ConsentView { brand: string; clientName: string; clientDomain?: string; redirectHost: string; loopback: boolean; handle: string; totp: boolean; error?: string }
const CSS = `:root{color-scheme:dark;--bg:#08080a;--panel:#0f0f12;--line:#26262d;--fg:#ececf1;--mut:#85859a;--acc:#9db8ff;--bad:#ff6b6b;--warn:#ffb454}
*{box-sizing:border-box;border-radius:0}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1rem;background:var(--bg);color:var(--fg);font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
main{width:min(27rem,100%);border:1px solid var(--line);background:var(--panel)}
.bar{display:flex;justify-content:space-between;padding:.7rem 1.1rem;border-bottom:1px solid var(--line);color:var(--mut);font-size:11px;letter-spacing:.16em;text-transform:uppercase}
.bar b{color:var(--acc);font-weight:600}
.in{padding:1.25rem 1.1rem}
h1{margin:0 0 .35rem;font-size:19px;font-weight:600;letter-spacing:-.01em}
p{margin:.35rem 0;color:var(--mut)} p b{color:var(--fg);font-weight:600}
.box{margin:1rem 0;padding:.7rem .8rem;border:1px solid var(--line);color:var(--mut);font-size:12.5px}
.warn{border-color:var(--warn);color:var(--warn)} .err{border-color:var(--bad);color:var(--bad)}
label{display:block;margin-top:1rem;color:var(--mut);font-size:11px;letter-spacing:.14em;text-transform:uppercase}
input{width:100%;margin-top:.4rem;padding:.65rem .7rem;background:#0a0a0d;border:1px solid var(--line);color:var(--fg);font:inherit;outline:none}
input:focus{border-color:var(--acc)}
.row{display:flex;gap:.6rem;margin-top:1.3rem}
button{flex:1;padding:.7rem;border:1px solid var(--line);background:transparent;color:var(--fg);font:inherit;font-weight:600;cursor:pointer}
button.go{background:var(--acc);border-color:var(--acc);color:#0a0a0d} button:hover{filter:brightness(1.15)}`;
function consentPage(v: ConsentView): string {
  const unknown = !v.loopback && !KNOWN.test(v.redirectHost);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize ${esc(v.clientName)} · ${esc(v.brand)}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><style>${CSS}</style>
<main><div class="bar"><b><img src="/logo.svg" alt="" width="18" height="18" style="vertical-align:-4px;margin-right:.55rem">${esc(v.brand)}</b><span>authorize</span></div><div class="in">
<h1>Allow ${esc(v.clientName)}?</h1>
<p>${v.clientDomain ? `Published by <b>${esc(v.clientDomain)}</b>. ` : "Self-registered app, name not verified. "}Access is returned to <b>${esc(v.redirectHost)}</b>.</p>
<div class="box">Grants this app control of your PC through ${esc(v.brand)}: files, shell, browser and local apps.</div>
${v.loopback ? `<div class="box warn">This sends access to an app running on your own computer.</div>` : ""}
${unknown ? `<div class="box warn">Unrecognized app (${esc(v.redirectHost)}). Continue only if you started this connection yourself.</div>` : ""}
${v.error ? `<div class="box err">${esc(v.error)}</div>` : ""}
<form method="post"><input type="hidden" name="handle" value="${esc(v.handle)}"><input type="hidden" name="scope" value="mcp:read">
<input type="hidden" name="cn" value="${esc(v.clientName)}"><input type="hidden" name="cd" value="${esc(v.clientDomain ?? "")}"><input type="hidden" name="rh" value="${esc(v.redirectHost)}"><input type="hidden" name="lb" value="${v.loopback ? "1" : ""}">
<label>Owner passphrase<input type="password" name="passphrase" autocomplete="current-password" required autofocus></label>
${v.totp ? `<label>Authenticator code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" placeholder="000000" required></label>` : ""}
<div class="row"><button name="decision" value="deny" formnovalidate>Deny</button><button class="go" name="decision" value="approve">Allow</button></div></form>
</div></main>`;
}

const bearerOf = (r: Request) => /^Bearer (\S+)$/.exec(r.headers.get("authorization") ?? "")?.[1] ?? null;
/** Admin API for connections (grants). Uses the OAuth helpers, so it must live in the default handler. */
async function adminConnections(request: Request, env: Env, path: string): Promise<Response> {
  const stub = hubStub(env);
  const auth = await stub.adminOk(bearerOf(request));
  if (!auth.ok) return Response.json({ error: auth.status === 429 ? "too many attempts, try later" : auth.status === 503 ? "admin API not configured" : "unauthorized" }, { status: auth.status ?? 401 });
  const oauth = env.OAUTH_PROVIDER;
  const m = /^\/admin\/connections(?:\/([^/]+)(?:\/(rename))?)?$/.exec(path);
  if (!m) return Response.json({ error: "not found" }, { status: 404 });
  const id = m[1] ? decodeURIComponent(m[1]) : undefined;
  if (!id && request.method === "GET") {
    const [grants, snap, aliases] = await Promise.all([oauth.listUserGrants("owner", { limit: 100 }), stub.statsSnapshot(), getAliases(env)]);
    const rows = await Promise.all(grants.items.map(async (g) => {
      const c = await lookupClient(env, g.clientId); const st = snap.conns[g.id];
      return { id: g.id, clientId: g.clientId, client: c?.clientName ?? null, label: aliases[g.id] ?? labelFor(c, g.id), createdAt: g.createdAt, requests: st?.req ?? 0, calls: st?.calls ?? 0, errors: st?.errors ?? 0, lastSeen: st?.last ?? null };
    }));
    return Response.json({ connections: rows });
  }
  if (id && !m[2] && request.method === "DELETE") {
    await oauth.revokeGrant(id, "owner"); await stub.forgetConn(id);
    const a = { ...(await getAliases(env)) }; delete a[id]; await setAliases(env, a);
    log({ ev: "connection_revoked" }); return Response.json({ revoked: id });
  }
  if (id && m[2] === "rename" && request.method === "POST") {
    const b = (await request.json().catch(() => ({}))) as { name?: string }; const name = String(b.name ?? "").trim();
    if (!/^[A-Za-z0-9_.\- ]{1,24}$/.test(name)) return Response.json({ error: "name must be 1-24 letters, digits, space, _ . -" }, { status: 400 });
    await setAliases(env, { ...(await getAliases(env)), [id]: name }); return Response.json({ renamed: id, name });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url); const p = url.pathname;
    if (p === "/authorize") {
      const oauth = env.OAUTH_PROVIDER; const totp = (env.OWNER_TOTP_SECRET ?? "").trim().length >= 16;
      if (request.method === "GET") {
        try {
          const req = await oauth.parseAuthRequest(request);
          const d = await oauth.describeConsent(req);
          const consent = await oauth.beginConsent(req);
          return html(consentPage({ brand: nameOf(await getConfig(env)), clientName: d.clientName, clientDomain: d.clientDomain, redirectHost: d.redirectHost, loopback: !!d.redirectIsLoopback, handle: consent.handle, totp }), consent.headers);
        } catch (e: any) { return html(`<style>${CSS}</style><main><div class="in"><h1>Invalid request</h1><p>Restart the connection from your AI app.</p></div></main>`, undefined, 400); }
      }
      if (request.method === "POST") {
        const form = await request.formData(); const handle = String(form.get("handle") ?? "");
        if (form.get("decision") !== "approve") { const d = await oauth.denyConsent(request, handle); return new Response(null, { status: 302, headers: d.headers }); }
        const chk = await hubStub(env).verifyOwner(String(form.get("passphrase") ?? ""), request.headers.get("cf-connecting-ip") ?? "unknown", String(form.get("code") ?? ""));
        if (!chk.ok) {
          const msg = chk.reason === "locked" ? "Too many wrong attempts from your network. Wait 10 minutes, then restart the connection from your AI app."
            : chk.reason === "unconfigured" ? "The server has no owner passphrase configured (OWNER_PASSPHRASE secret missing or under 12 characters)."
            : `${totp ? "Passphrase or authenticator code is incorrect" : "Wrong passphrase"} (${chk.left ?? 0} attempts left).`;
          // Re-render the form on the same consent handle so the user can just retry.
          return html(consentPage({ brand: nameOf(await getConfig(env)), clientName: String(form.get("cn") ?? "App"), clientDomain: String(form.get("cd") ?? "") || undefined, redirectHost: String(form.get("rh") ?? ""), loopback: form.get("lb") === "1", handle, totp, error: msg }), undefined, 403);
        }
        const scope = form.getAll("scope").map(String).filter((s) => GRANTABLE.has(s));
        const approved = await oauth.approveConsent(request, handle, { scope });
        const { redirectTo } = await oauth.completeAuthorization({ request: approved.request, userId: "owner", metadata: {}, scope: approved.request.scope, props: { userId: "owner" } });
        approved.headers.set("Location", redirectTo);
        return new Response(null, { status: 302, headers: approved.headers });
      }
      return new Response("Method not allowed", { status: 405 });
    }
    if ((p === "/logo.svg" || p === "/favicon.svg" || p === "/favicon.ico") && request.method === "GET") return logoResponse(await getConfig(env));
    if (p === "/admin/config") return adminConfig(request, env);
    if (p === "/admin/connections" || p.startsWith("/admin/connections/")) return adminConnections(request, env, p);
    if (p === "/health" || p === "/pair" || p.startsWith("/admin/") || p === "/agent") {
      // Cheap pre-check so junk websocket attempts never reach (or bill) the Durable Object.
      if (p === "/agent" && !/^Bearer dcf_\S+$/.test(request.headers.get("authorization") ?? "")) return new Response("Unauthorized", { status: 401 });
      return hubStub(env).fetch(request);
    }
    return new Response("Not found", { status: 404 });
  },
};

/** Any web AI platform may register (https, no userinfo/fragment) or loopback http; the passphrase is the real gate. */
const ALLOWED_REDIRECTS = [/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//];
function okRedirect(u: string): boolean {
  if (ALLOWED_REDIRECTS.some((re) => re.test(u))) return true;
  try { const x = new URL(u); return x.protocol === "https:" && !x.username && !x.password && !x.hash && x.hostname.includes("."); } catch { return false; }
}
function registrationPolicy({ clientMetadata }: { clientMetadata: Record<string, unknown> }) {
  const uris = clientMetadata.redirect_uris;
  if (Array.isArray(uris) && uris.length > 0 && uris.every((u) => typeof u === "string" && okRedirect(u))) return;
  log({ ev: "dcr_rejected" });
  return { code: "invalid_redirect_uri", description: "Redirect URI is not allowed for this server", status: 400 };
}

type Props = { userId?: string; grantId?: string; label?: string };
const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: Props; auth?: { scope: string[] } }): Promise<Response> {
    const props = ctx.props ?? {};
    if (props.userId !== "owner") return new Response("Forbidden", { status: 403 });
    // Old tokens have no identity until their next refresh (they pick it up then); show them as "Unlabeled".
    const id = props.grantId ?? "legacy"; const label = (await getAliases(env))[id] ?? props.label ?? "Unlabeled";
    const caller: Caller = { id, label }; const stub = hubStub(env);
    let isCall = false;
    if (request.method === "POST") { try { const j = JSON.parse(await request.clone().text()); isCall = (Array.isArray(j) ? j : [j]).some((x: any) => x?.method === "tools/call"); } catch { /* not JSON-RPC */ } }
    if (!isCall) ctx.waitUntil(stub.note(caller).catch(() => {})); // tool calls are counted when they run
    const cfg = await getConfig(env); const base = env.PUBLIC_URL ? new URL(env.PUBLIC_URL).origin : new URL(request.url).origin;
    const disabled = new Set(cfg.disabledTools ?? []);
    return handleMcp(request, {
      call: (tool, args) => (disabled.has(tool) ? Promise.resolve({ ok: false as const, code: "tool_disabled" as const, message: `${tool} is turned off by the owner.` }) : stub.callTool(tool, args, caller)),
      devices: () => stub.listDevices(),
    }, { name: nameOf(cfg), iconUrl: `${base}/logo.svg?v=${encodeURIComponent((cfg.logo?.name ?? DEFAULT_LOGO_NAME).slice(0, 40))}-${(cfg.logo?.svg ?? "").length}`, disabled });
  },
};

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const base = env.PUBLIC_URL ? new URL(env.PUBLIC_URL).origin : new URL(request.url).origin;
    // Alias of the path-aware document the provider serves, for clients that probe the root path.
    if (request.method === "GET" && new URL(request.url).pathname === "/.well-known/oauth-protected-resource")
      return Promise.resolve(Response.json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["mcp:read"], bearer_methods_supported: ["header"] }));
    return new OAuthProvider<Env>({
      apiRoute: "/mcp", apiHandler: mcpHandler as any, defaultHandler: defaultHandler as any,
      authorizeEndpoint: "/authorize", tokenEndpoint: "/oauth/token", clientRegistrationEndpoint: "/oauth/register",
      scopesSupported: ["mcp:read", "offline_access"], requiredScopes: ["mcp:read"],
      resourceMetadata: { resource: `${base}/mcp`, authorization_servers: [base] },
      clientIdMetadataDocumentEnabled: true, clientRegistrationCallback: registrationPolicy,
      // Stamp every grant's tokens with a stable identity (grant id + friendly label). Existing grants get it on their next refresh.
      tokenExchangeCallback: async (o) => {
        const old = (o.props ?? {}) as Props;
        const label = old.grantId === o.grantId && old.label ? old.label : labelFor(await lookupClient(o.env as Env, o.clientId), o.grantId);
        return { newProps: { ...old, userId: "owner", grantId: o.grantId, label } };
      },
    }).fetch(request, env, ctx);
  },
};
