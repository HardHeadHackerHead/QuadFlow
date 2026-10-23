# QuadFlow Core

The shell's own contributions: the Terminal and AI Agent toolbar items and the session History flyout.

*Built into QuadFlow — internal, always active, not installable or removable.*

The terminal and agent buttons are not special cases in the shell. They are ordinary plugin
contributions of this built-in `core` plugin, so the toolbar, the Tools menu and the tool-config
modal treat them exactly like every other tool and the shell keeps a single contribution registry.

## Features

- **Terminal** — open a new terminal in the project directory, with a configurable shell and
  working directory. Several Terminal tools can exist side by side (e.g. one per shell).
- **AI Agent** — open the agent launch dialog, optionally with a provider preselected.
- **History** — a flyout of open and past agent sessions.

## Usage

All three are pinned to the toolbar by default.

| Contribution | Kind | What it does |
|---|---|---|
| Terminal | toolbar item → command `core/new-terminal` | Creates a terminal; when invoked on an empty tile, fills that tile instead of splitting the active pane |
| AI Agent | toolbar item → command `core/launch-agent` | Opens the launch dialog with the configured provider preselected |
| History | tile `chat-history` (flyout only, 420 × 520) | Lists open and past agent sessions |

The commands are not shown in the command palette (`"palette": false`); they are invoked by the
toolbar items with the item's tool config as arguments.

## Settings

Each toolbar item has a per-tool config (its `configSchema`), edited in the tool-config modal.

**Terminal**

| Setting | Default | Description |
|---|---|---|
| `shell` | `default` | `default`, `cmd`, `powershell` or `bash` |
| `workingDirectory` | empty | Start directory; empty means the project directory |

**AI Agent**

| Setting | Default | Description |
|---|---|---|
| `provider` | empty | Agent provider id preselected in the launch dialog; empty means the default provider |

## Permissions

None. The plugin's UI module is part of the host bundle and drives the shell's stores directly,
so it needs no host-API permissions.

## Data

The plugin stores nothing of its own. Tool configs (shell, working directory, provider) live in
the app database with every other tool config; agent sessions shown in History are the app's
session records.

## Development

`core` is the one plugin whose UI module does not live in its plugin directory:

```
plugins/core/
  quadflow-plugin.json     manifest: tiles, toolbar items, commands
  assets/*.svg             icons
  assets/internal.js       stub that only satisfies `ui.entry`
src/plugins/core/index.tsx the real UI module (ships in the host bundle)
```

The trusted loader maps the bundled `core` plugin to `src/plugins/core/` through
`INTERNAL_MODULES` in `src/plugins/loader.ts`. This is reserved for code that must reach into the
shell's own stores; every other plugin imports only `@quadflow/plugin-api`, `@quadflow/ui`, `react`
and `zustand`. There is no `package.json` and no build step — the module is compiled with the app.

For a regular plugin to learn from, start with [Ideas](../ideas/README.md) or
[Usage Monitor](../usage-monitor/README.md), and see [docs/plugins/](../../docs/plugins/README.md)
for authoring.

## License

AGPL-3.0-only, part of QuadFlow.
