# Usage Monitor

See how much of your agent subscriptions you have used — session, weekly and other rate-limit windows.

*Bundled with QuadFlow.*

Usage Monitor shows the account usage of every agent provider that reports it (today
[Claude Code](../claude-code/README.md) and [Codex](../codex/README.md)) in a tile and a toolbar
badge, refreshes in the background if you want, and warns before you hit a limit. It is also a
compact example of a plugin built only on the public plugin API.

## Features

- One card per provider with each usage window: percent used, a progress bar and when it resets.
  Claude Code reports its 5-hour session, the weekly limit for all models and each model-specific
  weekly limit (plus extra usage when shown); Codex its 5-hour and weekly windows.
- A customizable toolbar **mini widget**: every window of every provider at a glance (for example
  `● 5h 11% Wk 82% Fable 0% | ● 5h 99% Wk 16%`), colored by level, in one of four styles. Its
  tooltip lists every window with its reset time; its gear opens the settings.
- Warning glow on open tiles at a configurable threshold, and a one-time toast when a window
  crosses the critical threshold.
- Optional background refresh that also runs while no tile is open.
- Refresh cooldown, so reading usage (which may start the agent CLI) does not run too often.

## Usage

Open **Usage Monitor** from the Tools menu, in a pane or a flyout (one instance at a time). The
tile reads usage when it opens and on refresh; the mini widget only displays what was last
fetched and never triggers a read itself (turn on the background refresh to keep it current
without the tile).

To get the mini widget, right-click the Usage Monitor toolbar button and choose **Display → Mini Dashboard**.
Hover the widget and click its gear (or open Settings → Usage Monitor) to choose:

- **Style**: *Percent* (`5h 11%` per window, the default), *Bars* (a small bar under each
  window), *Percent + reset* (the time until each window resets, e.g. `2h10m`) or *Highest only*
  (the old single number).
- **What it shows**: tick providers and single windows on or off. Everything is shown by default,
  and windows a provider starts reporting later appear automatically.

The settings page shows a live preview of the widget.

How a provider reads its usage is up to the provider's `usage` hook: Claude Code runs `claude`
in a hidden terminal and reads its `/usage` screen; Codex reads its newest session files.
Providers are refreshed one after the other.

## Settings

Settings → Usage Monitor (some are also adjustable in the tile).

| Setting | Default | Description |
|---|---|---|
| `cooldownSeconds` | `300` | A provider's usage is re-read at most this often (60–3600) |
| `backgroundPollSeconds` | `0` | Background refresh interval; `0` = off, otherwise at least 300 |
| `warningThreshold` | `75` | Open tiles glow once any window reaches this percentage |
| `criticalThreshold` | `90` | A toast warns once when a window crosses this percentage |
| `miniStyle` | `"percent"` | Mini widget style: `percent`, `bars`, `countdown` (percent + reset) or `highest` |
| `miniHidden` | `[]` | Left out of the mini widget: provider ids (`"codex"`) or windows (`"claude-code/week-opus"`) |

The host also enforces a minimum cooldown of 60 seconds per provider and caches the last snapshot.

## Permissions

| Permission | Why |
|---|---|
| `agents:read` | List providers that have a `usage` hook and run that hook through the host |

## Data

No files. The settings live with the other plugin settings in the app database; usage snapshots
are cached in memory by the host.

## Development

```bash
cd plugins/usage-monitor
npm run build        # quadflow-plugin build → dist/
npm test             # node --test: thresholds, rows, reset labels, mini widget model
```

```
src/index.tsx            definePlugin: tile, mini widget; binds the store on activation
src/store.ts             shared zustand store: providers, snapshots, refresh, background poll
src/model.ts             pure helpers (levels, rows, reset labels, settings, mini widget groups)
src/UsageMonitorTile.tsx tile; MiniWidget.tsx toolbar widget; SettingsPage.tsx settings page
```

The plugin activates `onStartup` so the background refresh can run without a tile. Everything
goes through `ctx.agents.providers()`, `ctx.agents.usage()`, `ctx.settings` and
`ctx.ui.openSettings()`. The GUI test (`scripts/ui/usage-monitor.test.mjs`) runs on fixture data
only, through the host's `window.__QF_TEST_AGENT_USAGE__` seam. To add usage
reporting to your own provider, implement the `usage` hook described in
[docs/plugins/agent-providers.md](../../docs/plugins/agent-providers.md). General authoring:
[docs/plugins/](../../docs/plugins/README.md).

## License

AGPL-3.0-only, part of QuadFlow.
