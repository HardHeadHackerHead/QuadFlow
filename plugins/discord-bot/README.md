# Discord Bot

**Mirror terminal sessions into Discord threads and answer them from Discord.**

*On hold — experimental, not bundled with QuadFlow.*

> This plugin is on hold. It has only been render-tested, not run against a live Discord server
> with a real token. Expect rough edges; it is not part of the supported plugin set.

Each shared terminal gets its own thread in a Discord channel. Members with the qualified role can
reply in the thread (or click the buttons on detected prompts), and their text is typed into the
terminal.

## Features

- Share any terminal to Discord from its ⋯ menu, or auto-mirror every new terminal.
- Output is batched (300 ms), stripped of ANSI codes, redacted for personal data and split into
  Discord-sized code blocks.
- Replies from members with the qualified role are written into the terminal (followed by Enter).
- Buttons on detected prompts.
- Status in the tile: running, connected, bot user and server; *Open thread* per mirrored terminal.

## Setup

1. Create a bot in the Discord developer portal, enable the **Message Content** intent and invite it
   with *Send Messages*, *Create Public Threads*, *Send Messages in Threads* and *Read Message
   History*.
2. Build the plugin (`npm run build` in `plugins/discord-bot`) and load it with Settings → Plugins →
   Load unpacked…. Node.js must be on `PATH`: the sidecar runs with the system `node`.
3. Open the **Discord Bot** tile, enter the bot token, server (guild) ID, channel ID and optionally a
   qualified role ID, save, then **Start Bot**.
4. In a terminal's ⋯ menu choose **Share to / stop sharing on Discord** (or turn on auto-mirror).

## Usage

| Command | What it does |
|---|---|
| Discord: Start bot | Connect the bot |
| Discord: Stop bot | Disconnect it |

The terminal context menu entry *Share to / stop sharing on Discord* toggles mirroring for that
terminal.

## Settings

Edited in the tile.

| Setting | Default | Description |
|---|---|---|
| Server (guild) ID | empty | The Discord server |
| Channel ID | empty | Text channel the threads are created in |
| Qualified role ID | empty | Only members with this role can send input (empty: everyone) |
| Auto-mirror new terminals | off | Share every new terminal automatically |

## Permissions

| Permission | Why |
|---|---|
| `terminal:io` | Read output from and write replies into any terminal |
| `secrets` | Keep the bot token in the OS keychain |
| `sidecar:runtime:node` | Run the sidecar with the system `node` |
| `shell:open-external` | *Open thread* in Discord |

## Data

The bot token is in the OS keychain; the other settings are the plugin's settings. Nothing else is
stored.

## How it works

```
terminal PTY ── ctx.terminals.onData ──> model (300 ms batch) ── notify discord/output ──> sidecar ──> Discord thread
Discord reply ── role check (bot.js) ──> ui/reply ──> model ── ctx.terminals.write(id, text + "\r") ──> terminal
```

Sidecar protocol (JSON-RPC over stdio):

- UI → sidecar requests: `discord/init { token, guildId, channelId, qualifiedRoleId }`,
  `discord/createThread { terminalId, sessionLabel }`, `discord/closeThread { terminalId }`,
  `discord/updateSettings { qualifiedRoleId?, channelId? }`, `discord/stop`, `discord/status`.
  Notification: `discord/output { terminalId, data }`.
- Sidecar → UI (`ui/*` notifications): `status { running, connected, botUsername?, guildName? }`,
  `threadCreated { terminalId, threadId, threadUrl }`, `reply { terminalId, author, content }`,
  `error { message, fatal }`.

## Development

```bash
cd plugins/discord-bot
npm run build      # UI module + the Node sidecar (with discord.js) bundled into bin/sidecar.mjs
npm run dev        # rebuild on change
```

| Part | File | Purpose |
|---|---|---|
| Manifest | `quadflow-plugin.json` | Tile `bot`, commands, terminal context menu, settings, Node sidecar |
| Model | `src/model.ts` | Settings, token, mirroring (`ctx.terminals.onData` / `write`), sidecar calls |
| Tile | `src/DiscordBotTile.tsx` | Status, settings form, mirrored terminals |
| Sidecar entry | `sidecar/index.mjs` | `@quadflow/sidecar-sdk-node` JSON-RPC server |
| Bot | `sidecar/bot.js` | discord.js client: threads, Components V2 messages, role checks, prompt buttons |
| Formatter | `sidecar/formatter.js` | ANSI stripping, PII redaction, Discord-sized code blocks, prompt detection |

See [docs/plugins/sidecars.md](../../docs/plugins/sidecars.md) for Node sidecars.

## Known gaps

- The terminal ⋯ menu shows *Share to Discord* even while the bot is stopped (the command then
  explains that the bot must be started).
- Untested against a live Discord server.

## License

AGPL-3.0-only, part of QuadFlow.
