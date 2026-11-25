/** Wire protocol + tool definitions shared by the gateway and the Windows agent. */

export const PROTOCOL_VERSION = 1;
export const MAX_OUTPUT_BYTES = 256 * 1024; // hard cap on any tool result text
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;
export const MAX_CALL_TIMEOUT_MS = 120_000;
export const MAX_MESSAGE_BYTES = 1024 * 1024; // largest WS frame we accept
export const HEARTBEAT_PING = "ping"; // text frames; the Durable Object auto-answers "pong"
export const HEARTBEAT_PONG = "pong";

export type ErrorCode =
  | "bad_arguments" | "path_denied" | "not_found" | "not_a_file" | "not_a_directory"
  | "too_large" | "timeout" | "device_offline" | "device_ambiguous" | "device_busy"
  | "unknown_tool" | "internal" | "disconnected" | "tool_disabled" | "blocked" | "process_not_found" | "limit" | "unavailable" | "upstream" | "not_joined" | "rate_limited" | "duplicate";

export class ToolError extends Error {
  constructor(public code: ErrorCode, message: string) { super(message); this.name = "ToolError"; }
}

/** gateway -> agent */
export interface Caller { id: string; label: string }
export interface CallMsg { t: "call"; id: string; tool: string; args: unknown; deadlineMs: number; caller?: Caller }
/** agent -> gateway */
export interface HelloMsg { t: "hello"; v: number; agent: string; platform: string; workspaces: number }
/** One image returned alongside text (base64, no data: prefix). Kept under the WebSocket frame limit. */
export interface ImageData { mimeType: string; data: string }
export const MAX_IMAGE_B64 = 900_000;
const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export function cleanImage(x: unknown): ImageData | undefined {
  const i = x as ImageData | undefined;
  if (!i || typeof i.mimeType !== "string" || typeof i.data !== "string") return undefined;
  if (!IMAGE_MIME.has(i.mimeType) || i.data.length === 0 || i.data.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/]+=*$/.test(i.data)) return undefined;
  return { mimeType: i.mimeType, data: i.data };
}
export interface ResultMsg {
  t: "result"; id: string; ok: boolean;
  text?: string; truncated?: boolean; image?: ImageData;
  error?: { code: ErrorCode; message: string };
}
export type AgentMsg = HelloMsg | ResultMsg;

export function parseAgentMsg(raw: string): AgentMsg | null {
  if (raw.length > MAX_MESSAGE_BYTES) return null;
  let m: any;
  try { m = JSON.parse(raw); } catch { return null; }
  if (!m || typeof m !== "object") return null;
  if (m.t === "hello" && typeof m.v === "number") return m as HelloMsg;
  if (m.t === "result" && typeof m.id === "string" && typeof m.ok === "boolean") return m as ResultMsg;
  return null;
}

/** Truncate to a UTF-8 byte budget without splitting a character. */
export function boundText(text: string, max = MAX_OUTPUT_BYTES): { text: string; truncated: boolean } {
  const enc = new TextEncoder();
  const bytes = enc.encode(text);
  if (bytes.length <= max) return { text, truncated: false };
  let end = max;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--; // back up to a char boundary
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}

/** read = inspect only; write = changes files inside the workspace (needs OC_ENABLE_WRITE=1 on the device). */
export type Kind = "read" | "write" | "exec" | "browser" | "mcp";
export interface Prop { type: "string" | "number" | "boolean"; description: string; max?: number; enum?: string[] }
export interface ToolDef {
  name: string; title: string; kind: Kind; description: string; timeoutMs?: number;
  properties: Record<string, Prop>; required: string[];
}
const s = (description: string, max?: number, en?: string[]): Prop => ({ type: "string", description, ...(max ? { max } : {}), ...(en ? { enum: en } : {}) });
const n = (description: string): Prop => ({ type: "number", description });
const b = (description: string): Prop => ({ type: "boolean", description });
const dev = s("Device id. Optional when exactly one device is online.");
const T = (name: string, title: string, kind: Kind, description: string, props: Record<string, Prop>, required: string[] = [], timeoutMs?: number): ToolDef =>
  ({ name, title, kind, description, properties: { ...props, device: dev }, required, ...(timeoutMs ? { timeoutMs } : {}) });

export const TOOLS: ToolDef[] = [
  T("get_config", "Get config", "read", "Show the device's allowed workspace folders, which tool groups are enabled, and limits.", {}),
  T("list_directory", "List directory", "read", "List files/folders in a workspace directory. depth 1-3 for recursive listing. Relative paths resolve against the first workspace.",
    { path: s("Directory path (default: first workspace root)"), depth: n("1 (default) to 3") }),
  T("get_file_info", "Get file info", "read", "Size, type and modified time of a file or directory in the workspace.", { path: s("Path") }, ["path"]),
  T("read_file", "Read file", "read", "Read a text file. Output is bounded (64 KiB per call); page with offset/length (bytes).",
    { path: s("File path"), offset: n("Byte offset (default 0)"), length: n("Max bytes (default/max 65536)") }, ["path"]),
  T("read_multiple_files", "Read multiple files", "read", "Read up to 20 text files at once (first 32 KiB of each).", { paths: s("One path per line", 8000) }, ["paths"]),
  T("search", "Search", "read", "Search file names (type=files) or file contents (type=content) under a directory. Literal match by default; regex=true for regular expressions. Content search skips .git/node_modules, binaries and files over 1 MiB.",
    { path: s("Directory to search (default: first workspace)"), pattern: s("Text or regex to find", 300), type: s("files (default) or content", 10, ["files", "content"]),
      regex: b("Treat pattern as a regex"), ignoreCase: b("Case-insensitive (default true)"), maxResults: n("Max results (default 100, max 500)") }, ["pattern"], 45_000),
  T("write_file", "Write file", "write", "Write or append UTF-8 text to a file inside the workspace (creates parent folders). Max 250k characters per call; use mode=append for larger files.",
    { path: s("File path"), content: s("Text content", 250_000), mode: s("rewrite (default) or append", 10, ["rewrite", "append"]) }, ["path", "content"]),
  T("create_directory", "Create directory", "write", "Create a directory (and parents) inside the workspace.", { path: s("Directory path") }, ["path"]),
  T("move_file", "Move file", "write", "Move or rename a file/folder inside the workspace. Refuses to overwrite an existing destination.", { source: s("Source path"), destination: s("Destination path") }, ["source", "destination"]),
  T("edit_block", "Edit block", "write", "Replace exact text in a text file. Fails (no change) unless old_string occurs exactly expected_replacements times (default 1).",
    { path: s("File path"), old_string: s("Exact text to replace", 100_000), new_string: s("Replacement text", 100_000), expected_replacements: n("Expected occurrences (default 1)") }, ["path", "old_string", "new_string"]),
];
import { POWER_TOOLS } from "./power.js";
TOOLS.push(...POWER_TOOLS);
export const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

/** Arg validation shared by agent (authoritative) and gateway (early reject). Unknown args are rejected. */
export function validateArgs(tool: string, args: unknown): Record<string, unknown> {
  const def = TOOLS.find((t) => t.name === tool);
  if (!def) throw new ToolError("unknown_tool", `Unknown tool: ${tool}`);
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) throw new ToolError("bad_arguments", "Arguments must be an object");
  const a = args as Record<string, unknown>;
  for (const k of Object.keys(a)) if (!(k in def.properties)) throw new ToolError("bad_arguments", `Unexpected argument: ${k}`);
  for (const r of def.required) if (a[r] === undefined) throw new ToolError("bad_arguments", `Missing argument: ${r}`);
  for (const [k, spec] of Object.entries(def.properties)) {
    const v = a[k];
    if (v === undefined) continue;
    if (typeof v !== spec.type) throw new ToolError("bad_arguments", `Argument ${k} must be a ${spec.type}`);
    if (spec.type === "number" && (!Number.isFinite(v as number) || (v as number) < 0)) throw new ToolError("bad_arguments", `Argument ${k} must be a non-negative number`);
    if (spec.type === "string") {
      if ((v as string).length > (spec.max ?? 4096)) throw new ToolError("bad_arguments", `Argument ${k} is too long`);
      if (spec.enum && !spec.enum.includes(v as string)) throw new ToolError("bad_arguments", `Argument ${k} must be one of: ${spec.enum.join(", ")}`);
    }
  }
  return a;
}
