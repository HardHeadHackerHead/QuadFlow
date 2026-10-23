# Testing plugins

Three levels, from cheap to thorough.

## 1. Build checks

`npm run build` (= `tsc --noEmit && quadflow-plugin build`) already fails on most mistakes:
type errors, an invalid manifest, a file the manifest references that does not exist, an import of
something the host does not share (e.g. a named export `@quadflow/ui` does not have, or a
dependency you forgot to bundle). `npm run validate` runs the checks without building.

Pure logic (parsers, reducers, formatters) is best kept in plain modules and unit-tested with any
runner — `node --test` needs nothing extra (`plugins/codex/test/rollout.test.ts` is an example).
For sidecars, `packages/sidecar-sdk-node/test/server.test.mjs` shows how to drive a sidecar over
its stdin/stdout without QuadFlow.

## 2. In the app, by hand

Load the plugin unpacked (Settings → Plugins → **Load unpacked…**, or
`quadflow plugins dev add <dir>`), run `npm run dev`, and work on it with hot reload
([getting-started.md](getting-started.md#3-load-it-unpacked-with-hot-reload)). Useful while doing so:

- the browser devtools of the QuadFlow window (sandboxed tiles are separate frames in the frame
  picker); `ctx.log.*` output appears there and in the app log;
- `ctx.sidecar.logs()` or `<app data>/logs/plugins/<id>.log` for the sidecar's stderr;
- `quadflow plugins info <id>` for status, granted permissions and manifest problems.

Use a development build with its own data so experiments never touch your real projects:
`QUADFLOW_PROFILE=dev` and `QUADFLOW_DATA_DIR=<temp dir>` (the CLI honours the same variables).

## 3. Automated, through the GUI harness

QuadFlow's repository ships a harness that launches an **isolated** dev build (own data dir,
own WebView2 profile, scratch project) and drives it with Playwright over the DevTools protocol:
[scripts/ui/README.md](../../scripts/ui/README.md). From a QuadFlow checkout:

```bash
npm run build:dev-exe                    # once: target/debug/quadflow-tauri.exe with dev identifier
node scripts/ui/cli.mjs launch           # start it; prints the session (pid, CDP port, run dir)
node scripts/ui/cli.mjs js "window.__TAURI_INTERNALS__.invoke('plugins_dev_add', { path: 'C:/path/to/my-plugin' })"
node scripts/ui/cli.mjs shot "$TEMP/qf.png"   # look at it
node scripts/ui/cli.mjs close            # always
```

Writing a test (`node:test`) — see `scripts/ui/devmode.test.mjs`, which scaffolds plugins,
builds them, loads them with the real "Load unpacked…" button, edits the source while
`quadflow-plugin dev` runs and asserts the tile hot-reloads with its state, and that a rebuilt
sidecar is restarted:

```js
import { launch } from "./harness.mjs";
import { connectFrame, frameTargets } from "./frames.mjs";

const s = await launch();
// Stub the native folder picker, then use the real button:
await s.eval((dir) => { window.__QF_TEST_PICK_FOLDER__ = () => dir }, pluginDir);
await s.click('button[title="Settings"]'); await s.clickText("Open Settings"); await s.clickText("Plugins");
await s.click('[data-testid="plugins-load-unpacked"]');
await s.waitFor('[data-testid="plugin-row-acme.my-plugin"]');
```

Tiles of third-party plugins are **sandboxed iframes** in another process; Playwright's
`page.frames()` does not see them. `frames.mjs` connects to the frame's own DevTools target:

```js
const [target] = await frameTargets(s.port, "/_frame/acme.my-plugin?role=tile");
const frame = await connectFrame(target);
await frame.evaluate(() => document.querySelector('[data-testid="my-count"]').textContent);
```

A reload replaces the frame (its URL gets a new `v=` cache-buster), so re-resolve the target
after hot reloads. Give elements you assert on a `data-testid`. Trusted plugins render in the main
document: plain `s.page.locator('[data-plugin-id="my-plugin"] …')`.

Safety rules of the harness (it never touches an installed QuadFlow or its data, and kills only
the processes it started) are in its README.
