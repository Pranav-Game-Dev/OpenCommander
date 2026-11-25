<img width="256" height="256" alt="01-isometric-command-cube" src="https://github.com/user-attachments/assets/7773e813-a0fb-43a7-83df-b77a140bd924" /><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" fill="none">
  <defs>
    <linearGradient id="iso_top" x1="64" y1="40" x2="192" y2="128" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#34D399"/>
      <stop offset="100%" stop-color="#059669"/>
    </linearGradient>
    <linearGradient id="iso_left" x1="56" y1="88" x2="128" y2="216" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#10B981"/>
      <stop offset="100%" stop-color="#047857"/>
    </linearGradient>
    <linearGradient id="iso_right" x1="128" y1="112" x2="200" y2="196" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#6EE7B7"/>
      <stop offset="100%" stop-color="#10B981"/>
    </linearGradient>
  </defs>

  <!-- Dark Neutral Backdrop -->
  <rect x="20" y="20" width="216" height="216" rx="52" fill="#090D16"/>
  <rect x="21" y="21" width="214" height="214" rx="51" stroke="#1E293B" stroke-width="2"/>

  <!-- Isometric Open-Front Cube (Top & Left Planes Forming Structural C) -->
  <!-- Top Plane -->
  <polygon points="128,48 196,86 128,124 60,86" fill="url(#iso_top)"/>
  <!-- Left Vertical Plane -->
  <polygon points="60,86 128,124 128,204 60,166" fill="url(#iso_left)"/>
  <!-- Bottom Base Rim -->
  <polygon points="128,204 196,166 196,144 128,182" fill="url(#iso_right)"/>

  <!-- Floating Command Prompt > Inside the Open Isometric Cavity -->
  <path d="M 148 112 L 174 126 L 148 140" stroke="#ECFDF5" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="178" y1="142" x2="194" y2="142" stroke="#34D399" stroke-width="10" stroke-linecap="round"/>
</svg>
isometric-command-cube.svg…]()


# OpenCommander

**Free, self-hosted, quota-free remote control of your Windows PC for any AI app.**
Open source and inspired by [Desktop Commander](https://github.com/wonderwhy-er/DesktopCommanderMCP). Your PC runs a small agent; a Cloudflare Worker you own exposes it as an OAuth-protected **MCP server** (Streamable HTTP) that ChatGPT, Claude, Gemini, OpenCode and other MCP-capable apps can connect to.

```
AI app  ──OAuth + MCP──▶  Your Cloudflare Worker (gateway)  ◀──WebSocket──  Agent on your PC
```

- **Free:** runs on Cloudflare's free tier; no hosted-service quota.
- **Yours:** the gateway lives in your own Cloudflare account; nothing is shared with third parties.
- **Safe by default:** owner passphrase on every new AI connection, optional authenticator (2FA), workspace-folder sandbox, blocked dangerous commands, per-tool on/off switches.
- **Custom:** name your own plugin and pick its logo (10 included); both appear in the AI apps.

## Features

| Area | Tools |
|---|---|
| Files | `list_directory`, `read_file`, `read_multiple_files`, `write_file`, `edit_block`, `create_directory`, `move_file`, `copy_file`, `delete_path`, `get_file_info`, `search` |
| Shell | `start_process`, `read_process_output`, `interact_with_process`, `force_terminate`, `list_sessions`, `list_processes`, `kill_process` |
| Images | `read_image`, **`image_grid`** (many images → one numbered picture, saves tokens), `capture_screen` |
| Convert / archive | `convert_file` (File Converter), `archive` (7-Zip) |
| Browser | `browser` (agent-browser CLI) |
| Local MCP apps | `mcp_servers`, `mcp_list_tools`, `mcp_call` (Blender, Unity, …) |
| Multi-AI | `live_link`: shared room where several AIs collaborate, with presence/status and a guided **context handover** |
| Misc | `http_request`, `system_info`, `get_config`, `set_config_value`, usage stats, recent calls |

### Live Link and context handover
Only used when you tell the AIs to. Rooms are visible in a terminal window on your PC. For a handover, the giving AI sends a **timeline** (each of your prompts, then what it did after each), plus goal, status, files, tech, logic, issues and next steps; the receiving AI verifies against the real files and asks questions before both leave.

### `image_grid`
Combine a folder (or a list of paths) into a single numbered contact sheet. The AI decides between `image_grid` (survey/compare screenshots, video frames, renders) and `read_image` (full detail of one image).

## Requirements
- Windows 10/11 (the agent), Node.js ≥ 22.12
- A free [Cloudflare](https://dash.cloudflare.com/sign-up) account
- Optional: [agent-browser](https://www.npmjs.com/package/agent-browser) (browser tool), File Converter, 7-Zip

## Quick start

```bat
git clone https://github.com/Pranav-Game-Dev/OpenCommander.git
cd OpenCommander
npm install
copy .env.example .env
```

1. Edit `.env`: set `OC_WORKSPACES` to the folder(s) AIs may use and `OC_DEVICE_NAME`.
2. Run **`manage.bat`** → *Link Cloudflare account / gateway*. It signs in to Cloudflare, deploys the gateway, sets secrets, and pairs this PC. It prints your **connector URL** (`https://<name>.workers.dev/mcp`) and **owner passphrase**. Save both.
3. Run **`start-opencommander.bat`** and keep that window open (the agent).
4. In your AI app, add a custom MCP connector with the connector URL. When asked, enter the owner passphrase.

Run tests with `npm test`; type-check with `npm run typecheck`.

## manage.bat
Arrow-key console: status & usage, **rename plugin**, **choose logo** (or your own SVG), **enable/disable tools** (with presets such as read-only or no-shell), connections, owner passphrase, 2FA, device pairing, gateway deploy, lockouts, link/unlink.

## Local apps (Blender, Unity, …)
Copy `mcp-servers.example.json` to `mcp-servers.json` (git-ignored) and list your local MCP servers. AIs then use `mcp_servers` / `mcp_list_tools` / `mcp_call`.

## Layout
```
packages/shared   protocol, tool definitions, brand/config helpers
packages/gateway  Cloudflare Worker + Durable Object (OAuth, MCP, device hub)
packages/agent    Windows agent, manage console, Live Link
test/             vitest suite
OpenCommander Logo/  selectable SVG logos
```

## Security notes
- The gateway only forwards to a device you paired; AI apps must pass the owner passphrase (+ 2FA if enabled).
- File and process tools are limited to your workspace folders; credentials and system roots are protected.
- Turn off anything you don't want AIs to use in *manage → Enable / disable tools*.
- Cloudflare's free plan allows 100,000 requests/day; the dashboard shows your usage.

## License
MIT. See [LICENSE](LICENSE). Changes: [CHANGELOG.md](CHANGELOG.md).
