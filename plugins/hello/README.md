# Hello

**The reference example plugin: a trusted tile, a Rust sidecar, CLI commands and an agent doc.**

*Example plugin (dev builds only).*

`hello` is QuadFlow's plugin-system smoke test and the best place to see every part of a plugin
working together. Its tile runs a live test panel that calls every host-API group and checks the
result, including the calls the host must refuse. The same bundle also ships as
[`hello-sandboxed`](../hello-sandboxed/README.md), which runs it in a sandboxed iframe.

New to plugins? Start with [Getting started](../../docs/plugins/getting-started.md), then read this
plugin's files in the order below.

## Try it

`hello` is staged only by dev builds (`quadflow.bundle: "dev"` in `package.json`):

```bash
npm run tauri dev            # full app; stages the dev plugins first
# or, to stage them for an existing dev build:
npm run build:plugins:dev
```

Then open the **Hello** tile from the Tools menu (pane or flyout) and run its panels.

```bash
quadflow hello ping hi --json        # sidecar CLI handler
quadflow hello-exec ping --roundtrip # exec CLI handler
quadflow docs hello                  # the agent context doc
```

Run these with the built dev binary and `QUADFLOW_PROFILE=dev`, never against your real data.

## What each file does

| File | What it shows |
|---|---|
| `quadflow-plugin.json` | The manifest: a tile, a command, two CLI commands, an agent context doc, a settings schema, a sidecar and eleven permissions |
| `package.json` | `quadflow.bundle: "dev"`; `build` / `dev` scripts from `@quadflow/plugin-build` |
| `vite.config.ts` | The whole build config: `defineQuadflowPlugin({ root })` |
| `src/index.tsx` | `definePlugin({ activate, tiles, commands })`, the tile and its three panels |
| `src/apiTests.ts` | The host-API checks: each names the outcome it expects (`ok` or an error code) |
| `src/hello.css` | Plain CSS, scoped with a `qf-hello` class prefix |
| `sidecar/src/main.rs` | The Rust sidecar (`quadflow-sidecar` crate): requests, host calls, events, CLI |
| `docs/hello.md` | The agent context doc, printed by `quadflow docs hello` |
| `assets/icon.svg` | Plugin and tile icon |

## API features it demonstrates

**Trusted boundary** (`src/index.tsx`). Every import is a shared module the host provides, so the
plugin runs on the host's own instances:

- `useState` / `useEffect` work because the plugin uses the host's React.
- `usePluginContext()` reads a React context provided by the host's tile container.
- `useTheme()` from `@quadflow/ui` follows the app theme.
- A `zustand` store shared between all open Hello tiles ("all Hello tiles: N").
- Tile props: `mode` (pane or flyout), `setTitle()` ("Hello (3)"), and `setState()` /
  `instance.state`, which keep the click count across reloads and restarts.
- `activate(ctx)` runs once per plugin load; the `ping` command returns its timestamp.

**Host API panel** (`src/apiTests.ts`). One or more checks per group, each passing only when the
outcome matches what the host must do:

| Group | Examples |
|---|---|
| `lifecycle`, `api` | `activate()` ran, `api.has()` accuracy, ungranted calls rejected |
| `ui`, `overlay` | `openTile({ state })` → `onTileClosed`, tool configs, `theme()`, `confirm` / `prompt` |
| `project`, `workspace` | Current project and workspace |
| `data` | Ideas create/tag/list/delete (granted), issues read, issues create (refused) |
| `terminals` | Spawn a headless terminal, read and kill it; writing to a foreign terminal is refused |
| `agents` | List providers; launching is refused without `agents:launch` |
| `events`, `commands` | Emit / subscribe round trip, register and execute a command |
| `storage`, `settings`, `secrets` | Plugin storage, settings validated against the schema in Rust, keychain secrets |
| `notifications`, `clipboard` | Toast, system notification, write text; reading is refused |
| `fs`, `shell`, `http` | Project listing, `git --version`, `fetch` of `example.com`; anything ungranted is refused |
| `native` | Tile geometry, main window handle (trusted only) |
| `sidecar` | Start on demand, host calls from the sidecar, events, status |

A refused call must fail in Rust with `permission_denied`: the checks prove that one dispatch table
enforces permissions for UI, sidecars and CLI alike.

**Sidecar panel** (`sidecar/src/main.rs`). Buttons drive the sidecar through `ctx.sidecar`:

| Button | Sidecar side |
|---|---|
| Ping | `ping` → `{ pong, pid, uptimeMs, calls }` (starts the sidecar on demand) |
| Host call | Bumps a counter in plugin storage via `host/call`, then tries `clipboard.readText` and reports the `permission_denied` |
| Emit event | `host/emit` topic `tick` (UI: `ctx.events.onPlugin`) plus a `ui/tick` notification (UI: `ctx.sidecar.onNotification`) |
| Crash | Exits with code 3; the supervisor restarts it with backoff (`restart: "onCrash"`) |
| Restart | `ctx.sidecar.restart()` |

The panel also shows the status stream (`ctx.sidecar.onStatus`) and the last log lines
(`ctx.sidecar.logs()`). The manifest passes `HELLO_GREETING` to the sidecar through `sidecar.env`
as an example of that field.

**CLI commands** ([docs/plugins/cli-commands.md](../../docs/plugins/cli-commands.md)). The same
binary serves both handler types:

| Command | Handler | Runs |
|---|---|---|
| `quadflow hello …` | `sidecar` | The sidecar in CLI mode (`cli/run`); counts runs in plugin storage |
| `quadflow hello-exec …` | `exec` | The binary directly; `--roundtrip` calls `$QUADFLOW_CLI --json docs --list` |

Subcommands: `ping [MESSAGE…]` answers `pong` (with `--json`, one `{"ok":true,"data":{…}}`
envelope); `fail` exits with code 3 and a `not_found` error; anything else prints usage and exits
with code 2.

## Settings

| Setting | Default | Description |
|---|---|---|
| Greeting (`greeting`) | `Hello` | Read back by the settings check |
| API test runs (`runs`) | 0 | Incremented by each settings check; a negative value is refused by the schema |

## Permissions

`data:ideas:write`, `data:issues:read`, `terminal:spawn`, `agents:read`, `fs:read:project`,
`shell:exec:git`, `network:example.com`, `notifications`, `clipboard:write`, `secrets`,
`native:windows`: exactly what the granted checks need, so every other check can prove a refusal.
See [docs/plugins/permissions.md](../../docs/plugins/permissions.md).

## Development

```bash
cd plugins/hello
npm run build                         # UI module → dist/
npm run dev                           # rebuild on change (hot reload when loaded unpacked)
cargo build --release -p hello-sidecar
```

`npm run build:plugins:dev` at the repository root builds both and stages `hello` and
`hello-sandboxed`. The GUI e2e tests `scripts/ui/sandbox.test.mjs` and
`scripts/ui/plugin-cli.test.mjs` drive this plugin.

## License

AGPL-3.0-only, part of QuadFlow.
