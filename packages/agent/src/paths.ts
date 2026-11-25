import path from "node:path";
import fs from "node:fs/promises";
import { ToolError } from "@opencommander/shared";

export type Flavor = typeof path.win32 | typeof path.posix;
const WIN_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

const deny = (msg: string) => new ToolError("path_denied", msg);

/** Pure lexical checks. Rejects shapes that are dangerous or ambiguous before touching the disk. */
export function checkRawPath(input: string, f: Flavor): void {
  if (typeof input !== "string" || input.length === 0) throw deny("Path must be a non-empty string");
  if (input.includes("\0")) throw deny("Path contains a null byte");
  if (f === path.win32) {
    if (/^[\\/]{2}/.test(input)) throw deny("UNC, \\\\?\\ and \\\\.\\ paths are not allowed");
    if (/^[a-zA-Z]:(?![\\/])/.test(input)) throw deny("Drive-relative paths (C:foo) are not allowed");
    if (input.slice(2).includes(":") || (input.length >= 2 && input[1] !== ":" && input.includes(":"))) throw deny("Alternate data streams / colons are not allowed");
    for (const seg of input.split(/[\\/]/)) {
      if (seg === "." || seg === ".." || seg === "" || /^[a-zA-Z]:$/.test(seg)) continue;
      if (WIN_DEVICE.test(seg)) throw deny("Reserved Windows device names are not allowed");
      if (/[. ]$/.test(seg)) throw deny("Names ending in a dot or space are not allowed");
      if (/[<>"|?*]/.test(seg)) throw deny("Wildcard or reserved characters are not allowed");
    }
  }
}

const SENSITIVE_DIRS = new Set([".ssh", ".aws", ".gnupg", ".kube", ".azure", ".wrangler", "xdg.config", "appdata", "opencommander", "dc-free", ".docker"]);
const SENSITIVE_FILE = /^(\.env(\..*)?|\.dev\.vars|\.npmrc|\.netrc|\.git-credentials|device\.json|id_(rsa|dsa|ecdsa|ed25519).*|.*\.(pem|key|pfx|p12|kdbx))$/i;
/** Secret-bearing locations are never readable, even inside an allowed workspace. `rel` is relative to the workspace root. */
export function assertNotSensitive(rel: string, f: Flavor): void {
  const segs = rel.split(f.sep).filter(Boolean);
  segs.forEach((s, i) => {
    const l = s.toLowerCase();
    if (SENSITIVE_DIRS.has(l) || (i === segs.length - 1 && SENSITIVE_FILE.test(s)))
      throw deny("Access to credential/secret locations is blocked");
  });
}

/** True when target is root or below it (case-insensitive on win32 via path.relative). */
export function isInside(root: string, target: string, f: Flavor): boolean {
  const rel = f.relative(root, target);
  if (rel === "") return true;
  if (f.isAbsolute(rel)) return false; // different drive
  return rel !== ".." && !rel.startsWith(".." + f.sep);
}

/** Realpath of the deepest existing ancestor + the not-yet-existing remainder. */
async function realpathLoose(p: string, f: Flavor): Promise<string> {
  const rest: string[] = [];
  let cur = p;
  for (;;) {
    try { const real = await fs.realpath(cur); return rest.length ? f.join(real, ...rest.reverse()) : real; }
    catch (e: any) {
      if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR") throw e;
      const parent = f.dirname(cur);
      if (parent === cur) throw deny("Path has no existing ancestor");
      rest.push(f.basename(cur)); cur = parent;
    }
  }
}

/**
 * Resolve user input to a real absolute path guaranteed to be inside one of `roots`
 * (roots must already be realpath'd). Symlinks/junctions that point outside are rejected.
 * Note: a symlink swapped in between this check and the later open is a known TOCTOU gap.
 */
export async function resolveInWorkspace(roots: string[], input: string, f: Flavor = path): Promise<string> {
  checkRawPath(input, f);
  const candidate = f.isAbsolute(input) ? f.resolve(input) : f.resolve(roots[0]!, input);
  if (!roots.some((r) => isInside(r, candidate, f))) throw deny("Path is outside the allowed workspace");
  let real: string;
  try { real = await realpathLoose(candidate, f); }
  catch (e: any) { if (e instanceof ToolError) throw e; if (e?.code === "EACCES" || e?.code === "EPERM") throw deny("Permission denied"); throw e; }
  const root = roots.find((r) => isInside(r, real, f));
  if (!root) throw deny("Path resolves outside the allowed workspace (symlink or junction)");
  assertNotSensitive(f.relative(root, real), f);
  return real;
}
