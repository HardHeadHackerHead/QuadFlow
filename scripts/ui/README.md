# GUI harness

**Drive an isolated dev build of QuadFlow from scripts and AI agents.**

This harness launches a dev build of QuadFlow with its own data, attaches Playwright to its
WebView2 window over the Chrome DevTools Protocol (CDP), and lets you click, type, read the DOM and
xterm buffers, take screenshots, and read console and Rust logs. It works one step at a time across
separate shell calls, and it also powers the e2e test suite.

- [Safety rules](#safety-rules-read-first)
- [One-time build](#one-time-build)
- [Step-by-step CLI](#step-by-step-cli)
- [Library API](#library-api-for-tests)
- [E2E test suite](#e2e-test-suite)
- [Startup performance probe](#startup-performance-probe)
- [Environment variables](#environment-variables)
- [Internals](#internals)

## Safety rules (read first)

1. **Never kill QuadFlow processes by name or wildcard.** The user may be running an installed
   QuadFlow. `cli.mjs close` kills only the PID tree that the harness launched, which is recorded
   in the session file.
2. **Dev builds only.** Remote debugging is turned on only by this harness, through the launch env
   var `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>`. Nothing in
   `tauri.conf.json` or the Rust code turns it on. Do not add it there.
3. **Isolated data.** The harness launches with:
   - `QUADFLOW_PROFILE=dev`
   - a temp `QUADFLOW_DATA_DIR`
   - a temp WebView2 profile, so each run starts with fresh localStorage
   - a scratch project dir under `%TEMP%\quadflow-ui-harness\run-*`
   - any inherited `QUADFLOW_*` variables stripped
   - `QUADFLOW_SKIP_ONBOARDING=1`, so the first-run welcome flow does not cover the workspace
     (`launch --onboarding` / `launch({ onboarding: true })` shows it)

   The dev build uses the identifier `io.quadslab.quadflow.dev` and the title "QuadFlow Dev".
4. **Isolation guard.** The harness refuses to launch a checkout whose Rust code does not honor
   `QUADFLOW_DATA_DIR`. Every app path (core `quadflow.db`, per-feature databases, logs, models)
   resolves under `QUADFLOW_DATA_DIR`, and project data goes to `.quadflow-dev/`.
   `QF_UI_ALLOW_SHARED_DATA=1` bypasses the guard for old checkouts; use it **only on a throwaway
   machine**.
5. **Never point `--project` at a real user project.** Use the default scratch dir, or a fresh
   folder you created for the run.

## One-time build

```bash
npm ci
npm run build:dev-exe      # debug exe with embedded frontend + dev identifier
```

This writes `target/debug/quadflow-tauri.exe`. It needs no Vite server and has a console
subsystem, so the harness captures stdout and stderr. A cold build takes about 10 to 20 minutes, so
run it in the background.

Alternative: `launch --mode dev` runs `npm run tauri dev` (Vite on :5174, plus a Rust compile) under
the same isolated env. `npm run tauri dev` always merges in `src-tauri/tauri.dev.conf.json`.

## Step-by-step CLI

```bash
node scripts/ui/cli.mjs launch                     # prints JSON: pid, port, runDir, logFile ...
node scripts/ui/cli.mjs launch --run-dir <runDir>  # restart test: reuse that run's data + project
node scripts/ui/cli.mjs shot "$TEMP/qf.png"        # then view the PNG with the Read tool
node scripts/ui/cli.mjs text                       # visible text of the whole window
node scripts/ui/cli.mjs click 'button[title^="Terminal"]'   # open a terminal tile
node scripts/ui/cli.mjs term                       # xterm buffer of the last terminal
node scripts/ui/cli.mjs keys "echo hi"             # type into the focused element
node scripts/ui/cli.mjs press Enter
node scripts/ui/cli.mjs term | tail -5
node scripts/ui/cli.mjs js "document.title"        # evaluate JS (alias: eval)
node scripts/ui/cli.mjs console --tail 20          # console + page errors (JSONL)
node scripts/ui/cli.mjs logs --tail 50             # Rust stdout/stderr
node scripts/ui/cli.mjs close                      # kill the launched PID tree
```

`npm run ui -- <command>` does the same thing. `node scripts/ui/cli.mjs` with no command prints the
full usage, including `launch --project <dir>` and `--timeout <sec>`.

### Selectors

Selectors use Playwright syntax:

| Kind | Example |
|---|---|
| CSS | `button[title^="Terminal"]` |
| Text | `text=New Terminal` |
| Role | `role=button[name="Settings"]` |
| Position | `>> nth=-1` picks the last match |

`clicktext <text>` clicks the first element whose text contains `<text>`.

### Useful app landmarks

| What | How |
|---|---|
| New terminal | toolbar `button[title^="Terminal"]`, or `press Control+k`, `keys "New Terminal"`, `click "text=New Terminal >> nth=-1"` |
| Empty state | text "No terminals or tools open" |
| Command palette | `Control+k` (`Control+Shift+P` opens it in command mode) |
| Tile root | `[data-terminal-id]` inside `.mosaic-tile` |
| Terminal DOM | `.xterm`. The rows are a WebGL canvas, so use `term` (buffer API), not `text` |

The default shell on Windows is PowerShell (`powershell.exe -NoLogo`).

### Typical flow: verify a UI change

1. Run `launch`.
2. Run `shot before.png` and view the screenshot.
3. Click or type to reach the feature.
4. Run `shot after.png` and view it. Check `console --tail 20` for errors.
5. Run `close`. Always do this, including after a failure.

Each run's artifacts stay in `runDir`: `app.log`, `console.jsonl`, and screenshots taken without a
path.

## Library API (for tests)

```js
import { launch } from "./scripts/ui/harness.mjs";
import { readTerminalLines, typeInTerminal, copyLineContaining } from "./scripts/ui/xterm.mjs";

const s = await launch();                 // { page, browser, pid, port, runDir, logFile, ... }
await s.click('button[title^="Terminal"]');
await typeInTerminal(s.page, "echo hi\r");
console.log(await readTerminalLines(s.page));
await s.screenshot("shot.png");
s.consoleMessages; s.pageErrors; s.readLogs();
await s.close();                           // kills only the launched PID tree
// launch({ env: { QUADFLOW_V1_DATA_DIR: dir } }) adds test-only env vars (never profile/data-dir vars)
```

Sandboxed plugin tiles live in iframes; `frames.mjs` finds them (each reload replaces the frame,
so always evaluate in the newest one).

## E2E test suite

```bash
npm run test:e2e           # builds the dev exe, then runs every test below
npm run test:e2e:only      # skip the build
npm run test:e2e:semantic  # the Semantic Search test (builds its sidecar first)
```

The tests run with `node:test`, one at a time. There is no hosted CI; run the suite locally before
pushing. To keep screenshots, set `QF_UI_SHOTS_DIR=<dir>`.

| Test | Covers |
|---|---|
| `smoke.test.mjs` | The app launches with no auth or onboarding screen; a terminal opens and `echo qf-smoke` produces output; a long soft-wrapped line reads back, and copies via `getSelection`, as one line; no uncaught page errors |
| `onboarding.test.mjs` | The one test that launches **with** the first-run flow (see below) |
| `import-v1.test.mjs` | The QuadFlow 1.x project-list import against a **fake** 1.x install (`launch({ env: { QUADFLOW_V1_DATA_DIR } })`): first-run offer and preview, "Not now" surviving a restart, Settings → Advanced import, and a dev build only reporting a 1.x `.quadflow/` |
| `sandbox.test.mjs` | The sandboxed plugin runtime (see below) |
| `devmode.test.mjs` | Plugin dev mode and hot reload (see below) |
| `plugin-update.test.mjs` | Live install / update / rollback / uninstall without a restart, from the app's commands and from `quadflow plugins …` in another process, for a trusted (bare id from the built-in source) and a sandboxed plugin, each with an open tile that keeps its state; a broken update offers "Restart QuadFlow". The fixture source is a local `index.json` + zips built from scaffolded plugins (`launch({ env: { QUADFLOW_PLUGIN_INDEX_URL: "file://…" } })`; file URLs work in the dev profile only) |
| `terminal-copy-scroll.test.mjs` | A terminal's scrollback after switching to another project and back, with "Keep terminals alive" off (PTY restarted, saved buffer restored) and on (the same live xterm comes back, also in the alternate screen, with output written while away); the mouse wheel scrolls it. Copy (Ctrl+Shift+C, right-click) joins soft wraps and TUI hard wraps (`● ` / indented paragraphs printed with explicit newlines) but keeps real breaks, lists and code; Settings → Terminal → "Join wrapped lines when copying" off keeps the hard wraps. `navigator.clipboard.writeText` is stubbed in the page, so the system clipboard is never touched |
| `workspaces.test.mjs` | Two layouts, back-and-forth and rapid switching, rename, and both layouts plus the new name surviving a full restart (`launch({ runDir })` on the same data dir) |
| `theme.test.mjs` | Light theme: the Settings theme switch, Escape closing Settings, the light remap of dark-tuned palette classes (`text-green-400`, `bg-white/10`; see the end of `packages/ui/src/tokens.css`), terminal tiles and a plugin's attached run terminal following the terminal palette |
| `ideas.test.mjs` | Ideas and Projects (discovery) tiles (see below) |
| `issues.test.mjs` | Issues and the Kanban board (see below) |
| `plugin-cli.test.mjs`, `plans`, `ship`, `chat`, `missions`, `github`, `code-quality`, `scripts`, `editor`, `tui`, `web-preview`, `external-apps`, `youtube-live`, `obs-tracker`, `discord-bot`, `local-titles`, `usage-monitor` | One test per plugin, following the `ideas.test.mjs` pattern |

**Onboarding.** Walks Welcome → Agents (real `agents_detect_all`) → Project (stubbed folder picker →
`projects_open`) → CLI (real `cli_install_status`; "Install on PATH" goes to
`window.__QF_TEST_CLI_INSTALL__`, so the user's PATH is never modified) → Plugins → Done, in the
dark and the light theme. Checks that the outcome is persisted (`shell.onboarding`), that a restart
does not show it again, and that it re-opens from the palette ("Show Welcome") and the gear menu.

**Sandbox.** Opens the `hello` (trusted) and `hello-sandboxed` (same bundle, sandboxed iframe) tiles
side by side and runs the host-API test panel in both (same pass count minus the trusted-only
`native.*` checks). Then probes the frame from inside with `frame.evaluate`: Tauri IPC globals,
`parent.document`, `top.location`, `fetch` to `ipc.localhost`, raw RPC messages for trusted-only /
prototype methods, the 4 MiB message limit and the 200 in-flight limit. Playwright reaches the
iframe through `page.frames()` (its URL contains `/_frame/hello-sandboxed`).

**Dev mode.** Scaffolds two plugins with `create-quadflow-plugin` (packages linked as junctions, no
network), builds them with `quadflow-plugin build` and loads them through Settings → Plugins → "Load
unpacked…" (the native folder picker is replaced by `window.__QF_TEST_PICK_FOLDER__`). Bumps a
counter in the tile, edits the source while `quadflow-plugin dev` watches, and asserts that the tile
hot-reloads with the new code and the same count; then rebuilds a Node sidecar and asserts that a
new sidecar process answers.

**Ideas.** Tiles in a pane and a flyout, edits made with the built CLI (same isolated data dir and
scratch project) showing up live, a UI edit read back with the CLI, the ideas ↔ discovery link, the
palette provider and `quadflow docs ideas`. It is the template for the e2e test of every tool
plugin ([docs/plugins/migrating-a-tool.md](../../docs/plugins/migrating-a-tool.md) §10).

**Issues.** The same, plus the Kanban board: a CLI `issues close` moves the dependent issue from
Blocked to To Do live (cascade unblock), a mouse drag of a card into another column is read back
with `quadflow issues get`, and the palette provider is hit by title and by `CODE-n` ref. Columns
are found by `data-kanban-column`, cards by `data-issue-id`.

**Usage Monitor.** Never starts a real agent CLI or reads real agent files: an init script sets
`window.__QF_TEST_AGENT_USAGE__` (honoured by `providerUsage` in `src/agents/providerRegistry.ts`),
which answers every provider's `usage` hook with fixture snapshots. Checks the tile, the toolbar
mini widget (all windows, no overflow or overlap, dark and light, each style), its gear opening
Settings → Usage Monitor, hiding a window and the settings surviving a reload.

## Startup performance probe

```bash
RUST_LOG=debug node scripts/ui/startup-perf.mjs --runs 3   # add --json for raw data
```

Launches the isolated app, waits until the toolbar renders, then reads the WebView's resource
timings (on Windows every IPC call is a fetch to `ipc.localhost/<command>`). It prints
spawn-to-navigation time, time to the first IPC response, time to interactive, the slowest startup
commands, and a fresh `core_info` round trip. With `RUST_LOG=debug` the app log (`runDir/app.log`)
also has the `[startup]` timeline and `[ipc]` dispatch times. A sync command that holds the main
thread for 100 ms or more is always logged as a warning: make it `async` and move its work to
`spawn_blocking`.

## Environment variables

| Variable | Meaning |
|---|---|
| `QF_UI_MODE` | `exe` (default if the debug exe exists) or `dev` |
| `QF_UI_EXE` | path to a different exe |
| `QF_UI_TMP` | harness temp root (default `%TEMP%\quadflow-ui-harness`) |
| `QF_UI_SHOTS_DIR` | where the e2e tests save screenshots |
| `QF_UI_ALLOW_SHARED_DATA=1` | bypass the isolation guard (throwaway machines only) |

## Internals

### How terminals are read

The app does not expose xterm `Terminal` objects on `window`. `xterm.mjs` walks the React fiber of
each `.xterm` host element, finds the `terminalRef.current` held by `TerminalView`, and reads its
`buffer.active`. This needs no app code changes, but it depends on `TerminalView` keeping the
terminal in a `useRef`.

### Linux and macOS

The process and CDP plumbing is generic, but WebKitGTK and WKWebView do not speak CDP. A Linux port
would use the WebKitGTK inspector (`WEBKIT_INSPECTOR_SERVER`) or WebDriver (`tauri-driver`)
instead. That is not done yet; the harness is Windows-only today.
