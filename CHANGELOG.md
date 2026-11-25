# Changelog

## v1.0.0 — first public release

**Core**
- Windows agent ↔ Cloudflare Worker + Durable Object gateway exposing an OAuth 2.1 MCP server (Streamable HTTP); works with ChatGPT, Claude, Gemini, OpenCode.
- Tools for files, shell/processes, HTTP, browser automation, local MCP apps (Blender, Unity), screen capture, images, File Converter, 7-Zip.
- Owner passphrase on new connections, optional TOTP 2FA, rate limiting/lockouts, usage stats, per-connection names.

**Branding (new)**
- Project renamed to **OpenCommander** (env vars `OC_*`, packages `@opencommander/*`, `start-opencommander.bat`).
- Every user can **name their own plugin** (default "Open MCP"); shown in AI apps, consent page, dashboard and manage console.
- **Logo selection:** 10 bundled SVG logos or your own file; served at `/logo.svg` and sent as MCP server icon (default: isometric command cube).

**Tool control (new)**
- Enable/disable individual tools or groups (presets: read-only, no browser/mcp, no shell); disabled tools disappear from AI tool lists and are refused on call.

**manage.bat redesign (new)**
- Framed arrow-key UI with live status header, grouped menus, checklists, confirmations and spinners.

**Live Link**
- Multi-AI rooms with a visible terminal viewer, away/back presence, work status (working/planning/…), no length limits.
- **Context handover (improved):** the giver must send a timeline of the user's prompts with what was done after each; the receiver verifies against real files, asks questions, then both leave.

**Images (new)**
- `image_grid`: combine a folder or list of images into one numbered grid so the AI sees many images for roughly the token cost of one; the AI chooses between grid and `read_image`.

**Housekeeping**
- MIT license, README, `.env.example`, `mcp-servers.example.json`; personal paths/logs removed; tests stabilised (108 passing).
