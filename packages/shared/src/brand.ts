/** Project name. The name users see for THEIR plugin is configurable (manage script); this is only the project/product. */
export const PRODUCT = "OpenCommander";
/** Used only until the owner picks a name in the manage script. */
export const DEFAULT_PLUGIN_NAME = "Open MCP";
export const CF_DAILY_REQUEST_LIMIT = 100_000;

/** Owner-chosen settings, stored in the gateway KV (key oc:config) and edited from the manage script. */
export interface OcConfig { name?: string; logo?: { name: string; svg: string }; disabledTools?: string[] }

export const NAME_RE = /^[A-Za-z0-9_.\- ]{1,32}$/;
export const cleanPluginName = (s: unknown): string => {
  const n = String(s ?? "").trim().replace(/\s+/g, " ");
  if (!NAME_RE.test(n)) throw new Error("Plugin name must be 1-32 characters: letters, digits, space, _ . -");
  return n;
};
/** Machine-friendly id for the MCP serverInfo name. */
export const slugName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "opencommander";

/** Logos are served from the gateway's own origin, so only plain, script-free SVG is accepted. */
export function cleanSvg(raw: unknown): string {
  const svg = String(raw ?? "").replace(/^﻿/, "").trim();
  if (svg.length < 40 || svg.length > 24_000) throw new Error("SVG must be between 40 bytes and 24 KB.");
  if (!/^(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(svg)) throw new Error("File does not look like an SVG.");
  const bad = /<script|<foreignObject|<iframe|<object|<embed|<!DOCTYPE|<!ENTITY|\son[a-z]+\s*=|javascript:|@import|(?:href|src)\s*=\s*["']\s*(?!#|data:image\/)|url\(\s*["']?\s*(?!#|data:image\/)/i;
  if (bad.test(svg)) throw new Error("SVG contains scripts or external references, which are not allowed.");
  return svg;
}

export const DEFAULT_LOGO_NAME = "01-isometric-command-cube.svg";
export const DEFAULT_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" fill="none">
  <defs>
    <linearGradient id="iso_top" x1="64" y1="40" x2="192" y2="128" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#34D399"/><stop offset="100%" stop-color="#059669"/></linearGradient>
    <linearGradient id="iso_left" x1="56" y1="88" x2="128" y2="216" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#10B981"/><stop offset="100%" stop-color="#047857"/></linearGradient>
    <linearGradient id="iso_right" x1="128" y1="112" x2="200" y2="196" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#6EE7B7"/><stop offset="100%" stop-color="#10B981"/></linearGradient>
  </defs>
  <rect x="20" y="20" width="216" height="216" rx="52" fill="#090D16"/>
  <rect x="21" y="21" width="214" height="214" rx="51" stroke="#1E293B" stroke-width="2"/>
  <polygon points="128,48 196,86 128,124 60,86" fill="url(#iso_top)"/>
  <polygon points="60,86 128,124 128,204 60,166" fill="url(#iso_left)"/>
  <polygon points="128,204 196,166 196,144 128,182" fill="url(#iso_right)"/>
  <path d="M 148 112 L 174 126 L 148 140" stroke="#ECFDF5" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="178" y1="142" x2="194" y2="142" stroke="#34D399" stroke-width="10" stroke-linecap="round"/>
</svg>`;
