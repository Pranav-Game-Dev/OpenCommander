import fs from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { MAX_IMAGE_B64, ToolError, type ImageData } from "@opencommander/shared";
import { resolveInWorkspace } from "./paths.js";
import { runBounded } from "./exe.js";
import type { ToolCtx, ToolResult } from "./tools.js";

/** Images are handed to the AI as MCP image content. Anything big is downscaled/re-encoded with Windows' built-in System.Drawing (no extra installs). */
const RAW_OK = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const TARGET_B64 = 850_000; // stay clear of the 1 MB WebSocket frame

const RESIZE = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Drawing
$src=[System.Drawing.Image]::FromFile($env:IMG_IN); $max=[int]$env:IMG_MAX; $w=$src.Width; $h=$src.Height
$s=[Math]::Min(1.0,$max/[Math]::Max($w,$h)); $nw=[int][Math]::Max(1,[Math]::Round($w*$s)); $nh=[int][Math]::Max(1,[Math]::Round($h*$s))
$bmp=New-Object System.Drawing.Bitmap $nw,$nh; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.Clear([System.Drawing.Color]::White)
$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic; $g.DrawImage($src,0,0,$nw,$nh); $g.Dispose()
$enc=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$p=New-Object System.Drawing.Imaging.EncoderParameters 1; $p.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality,[long]$env:IMG_Q)
$bmp.Save($env:IMG_OUT,$enc,$p); $bmp.Dispose(); $src.Dispose(); Write-Output "$w x $h -> $nw x $nh"`;
const CAPTURE = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms,System.Drawing
if ($env:IMG_SCREEN -eq 'all') { $b=[System.Windows.Forms.SystemInformation]::VirtualScreen } else { $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds }
$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size); $g.Dispose(); $bmp.Save($env:IMG_OUT,[System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()`;
const ps = (script: string, env: Record<string, string>) => runBounded("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], 45_000, { env });
const tmp = (ext: string) => path.join(os.tmpdir(), `dcf-img-${crypto.randomBytes(6).toString("hex")}${ext}`);

/** Downscale/re-encode a file to a JPEG that fits the frame budget. */
async function shrink(file: string, maxPx: number): Promise<{ image: ImageData; info: string }> {
  const out = tmp(".jpg");
  try {
    for (const [px, q] of [[maxPx, 82], [Math.min(maxPx, 1200), 70], [Math.min(maxPx, 900), 60], [Math.min(maxPx, 600), 50]] as const) {
      const r = await ps(RESIZE, { IMG_IN: file, IMG_OUT: out, IMG_MAX: String(px), IMG_Q: String(q) });
      if (r.code !== 0) throw new ToolError("upstream", `Could not process the image: ${r.out.trim().slice(-200) || "unsupported or corrupt image"}`);
      const b64 = (await fs.readFile(out)).toString("base64");
      if (b64.length <= TARGET_B64) return { image: { mimeType: "image/jpeg", data: b64 }, info: `${r.out.trim()} (JPEG q${q})` };
    }
    throw new ToolError("too_large", "Image is too large to return even after downscaling");
  } finally { await fs.rm(out, { force: true }); }
}

export async function readImage(ctx: ToolCtx, a: Record<string, unknown>): Promise<ToolResult> {
  const file = await resolveInWorkspace(ctx.roots, String(a.path), ctx.flavor);
  const st = await fs.stat(file).catch(() => null); if (!st) throw new ToolError("not_found", "No such file");
  if (!st.isFile()) throw new ToolError("not_a_file", "Not a file");
  if (st.size > 40 * 1024 * 1024) throw new ToolError("too_large", "Image file is over 40 MB");
  const ext = path.extname(file).toLowerCase(); const maxPx = Math.min(4096, Math.max(64, Math.floor(Number(a.max_px) || 0))) || 0;
  if (![...Object.keys(MIME), ".bmp", ".tif", ".tiff", ".ico"].includes(ext)) throw new ToolError("bad_arguments", `Not a supported image type: ${ext || "(none)"}. Use png, jpg, gif, webp, bmp, tif or ico.`);
  if (RAW_OK.has(ext) && !maxPx && st.size * 4 / 3 <= TARGET_B64 * 0.65) {
    return { truncated: false, text: `${MIME[ext]} · ${st.size} bytes · ${path.basename(file)}`, image: { mimeType: MIME[ext]!, data: (await fs.readFile(file)).toString("base64") } };
  }
  const { image, info } = await shrink(file, maxPx || 1568);
  return { truncated: false, text: `${path.basename(file)}: ${info}`, image };
}

export async function captureScreen(a: Record<string, unknown>): Promise<ToolResult> {
  if (process.platform !== "win32") throw new ToolError("unavailable", "Screen capture is only implemented for Windows");
  const png = tmp(".png");
  try {
    const r = await ps(CAPTURE, { IMG_OUT: png, IMG_SCREEN: String(a.screen ?? "primary") });
    if (r.code !== 0) throw new ToolError("upstream", `Screen capture failed: ${r.out.trim().slice(-200)}. The agent must run in a logged-in desktop session.`);
    const { image, info } = await shrink(png, Math.min(4096, Math.max(64, Math.floor(Number(a.max_px) || 0))) || 1568);
    return { truncated: false, text: `Screen capture (${String(a.screen ?? "primary")}): ${info}`, image };
  } finally { await fs.rm(png, { force: true }); }
}

const GRID = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Drawing
$files=$env:IMG_LIST -split '\\|'; $names=$env:IMG_NAMES -split '\\|'; $cols=[int]$env:IMG_COLS; $cell=[int]$env:IMG_CELL; $lab=$env:IMG_LABELS -eq '1'; $gap=4
$rows=[int][Math]::Ceiling($files.Count/$cols); $W=$cols*$cell+($cols+1)*$gap; $H=$rows*$cell+($rows+1)*$gap
$bmp=New-Object System.Drawing.Bitmap $W,$H; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.Clear([System.Drawing.Color]::FromArgb(32,32,36))
$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic; $g.SmoothingMode='AntiAlias'; $g.TextRenderingHint='AntiAliasGridFit'
$font=New-Object System.Drawing.Font('Segoe UI',[single][Math]::Max(10,$cell/22),[System.Drawing.FontStyle]::Bold); $bg=New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(205,0,0,0)); $fg=[System.Drawing.Brushes]::White
for($i=0;$i -lt $files.Count;$i++){ $cx=$gap+($i % $cols)*($cell+$gap); $cy=$gap+[int][Math]::Floor($i/$cols)*($cell+$gap)
  try { $im=[System.Drawing.Image]::FromFile($files[$i]); $s=[Math]::Min($cell/$im.Width,$cell/$im.Height); $dw=[int][Math]::Max(1,$im.Width*$s); $dh=[int][Math]::Max(1,$im.Height*$s)
    $g.DrawImage($im,$cx+[int](($cell-$dw)/2),$cy+[int](($cell-$dh)/2),$dw,$dh); $im.Dispose() } catch { $g.DrawString('unreadable',$font,$fg,$cx+6,$cy+6) }
  if($lab){ $t=[string]($i+1); if($names[$i]){ $n=$names[$i]; if($n.Length -gt 22){$n=$n.Substring(0,21)+'~'}; $t="$t $n" }; $sz=$g.MeasureString($t,$font); $g.FillRectangle($bg,$cx,$cy,[single]($sz.Width+4),[single]($sz.Height)); $g.DrawString($t,$font,$fg,[single]($cx+2),[single]$cy) } }
$bmp.Save($env:IMG_OUT,[System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose(); Write-Output "$($files.Count) images, $cols x $rows grid, cell $cell px"`;
const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".ico"]);

/** Combine many images into ONE contact-sheet image (numbered cells) so the AI sees them all at once for the token cost of one. */
export async function imageGrid(ctx: ToolCtx, a: Record<string, unknown>): Promise<ToolResult> {
  if (process.platform !== "win32") throw new ToolError("unavailable", "image_grid is only implemented for Windows");
  const limit = Math.min(64, Math.max(2, Math.floor(Number(a.limit) || 0) || 24)); let files: string[] = [];
  const listed = String(a.paths ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (const p of listed) files.push(await resolveInWorkspace(ctx.roots, p, ctx.flavor));
  if (a.folder) {
    const dir = await resolveInWorkspace(ctx.roots, String(a.folder), ctx.flavor);
    const ents = await fs.readdir(dir, { withFileTypes: true }).catch(() => { throw new ToolError("not_found", "Folder not found"); });
    const names = ents.filter((e) => e.isFile() && IMG_EXT.has(path.extname(e.name).toLowerCase())).map((e) => e.name).sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
    const every = Math.max(1, Math.floor(Number(a.every) || 1)); files.push(...names.filter((_, i) => i % every === 0).map((n) => path.join(dir, n)));
  }
  files = [...new Set(files)];
  if (files.length < 2) throw new ToolError("bad_arguments", "Give at least 2 images: paths (one per line) and/or folder. For a single image use read_image.");
  let note = ""; if (files.length > limit) { note = ` (${files.length} found; showing the first ${limit}. Raise limit up to 64, or use every=N to sample.)`; files = files.slice(0, limit); }
  for (const f of files) if (!IMG_EXT.has(path.extname(f).toLowerCase())) throw new ToolError("bad_arguments", `Not an image: ${path.basename(f)}`);
  const cols = Math.min(files.length, Math.max(1, Math.floor(Number(a.columns) || 0) || Math.ceil(Math.sqrt(files.length))));
  const maxPx = Math.min(4096, Math.max(256, Math.floor(Number(a.max_px) || 0) || 1568));
  const cell = Math.min(1024, Math.max(64, Math.floor(Number(a.cell_px) || 0) || Math.floor(maxPx / cols) - 4));
  const labels = a.labels === false ? "0" : "1"; const png = tmp(".png");
  try {
    const r = await ps(GRID, { IMG_LIST: files.join("|"), IMG_NAMES: files.map((f) => path.basename(f).replace(/\|/g, "_")).join("|"), IMG_COLS: String(cols), IMG_CELL: String(cell), IMG_LABELS: labels, IMG_OUT: png });
    if (r.code !== 0) throw new ToolError("upstream", `Could not build the grid: ${r.out.trim().slice(-200)}`);
    const { image, info } = await shrink(png, maxPx);
    const legend = files.map((f, i) => `${i + 1}=${path.basename(f)}`).join("  ");
    return { truncated: false, text: `Grid: ${r.out.trim()} -> ${info}${note}\nCells are numbered left-to-right, top-to-bottom: ${legend}\nTip: use read_image on one file for full detail.`, image };
  } finally { await fs.rm(png, { force: true }); }
}

/** For images returned by local MCP apps (Blender/Unity screenshots): fit them to the frame budget or drop with a note. */
export async function fitBase64(data: string, mime: string): Promise<{ image?: ImageData; note?: string }> {
  if (!data) return { note: "empty image" };
  const ok = MIME_SET.has(mime);
  if (ok && data.length <= TARGET_B64) return { image: { mimeType: mime, data } };
  const src = tmp(mime === "image/png" ? ".png" : mime === "image/gif" ? ".gif" : mime === "image/webp" ? ".webp" : ".img");
  try { await fs.writeFile(src, Buffer.from(data, "base64")); return { image: (await shrink(src, 1568)).image }; }
  catch (e: any) { return { note: `image not returned (${String(e?.message ?? e).slice(0, 120)})` }; }
  finally { await fs.rm(src, { force: true }); }
}
const MIME_SET = new Set(Object.values(MIME));
void MAX_IMAGE_B64;
