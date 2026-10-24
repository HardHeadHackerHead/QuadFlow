# Getting started

This walks through creating a plugin, running it in QuadFlow with hot reload, and shipping it.
The binding design is [plugin-system.md](../architecture/plugin-system.md); these pages are the
author's view of it.

## What a plugin is

A folder with a `quadflow-plugin.json` manifest plus whatever the manifest points at:

```
my-plugin/
  quadflow-plugin.json   id, version, permissions, contributions (tiles, commands, settings, …)
  src/index.tsx          UI module source → dist/index.js (+ dist/index.css)
  sidecar/               optional background process (Rust crate or Node script) → bin/
  assets/icon.svg        icons
  docs/                  agent context docs, CLI docs
```

QuadFlow loads the UI module (an ES module whose default export is `definePlugin({...})`) and
renders its tiles in mosaic panes or toolbar flyouts. Everything the plugin can do goes through
the host API object `ctx` (see [Host API](host-api.md)); privileged calls are checked against the
permissions the user granted ([Permissions](permissions.md)).

Third-party plugins run **sandboxed**: each tile in its own iframe with no network and no access
to the app, talking to the host over a message channel. The same bundle works unchanged when a
first-party plugin runs **trusted** in the host document. You never choose the mode; write
against `ctx` and it works in both.

## 1. Create a plugin

From a QuadFlow checkout (until the packages are published to npm):

```bash
npm create quadflow-plugin -- ../my-plugin --template tile --id acme.my-plugin
# or, equivalently:
node packages/create-quadflow-plugin/index.mjs ../my-plugin --template tile --id acme.my-plugin
```

Without arguments it asks for the folder, template, id and name. Templates:

| Template | What you get |
|---|---|
| `tile` | A React tile with a counter persisted in the tile state, a setting and a command. No permissions. |
| `tile-sidecar-rust` | A tile that calls a Rust sidecar (`quadflow-sidecar` crate) with `ctx.sidecar.request()`. |
| `tile-sidecar-node` | The same with a Node.js sidecar (`@quadflow/sidecar-sdk-node`, bundled to `bin/sidecar.mjs`). |
| `cli-command` | A `quadflow <command>` subcommand served by a Node sidecar, and an agent context doc. |
| `agent-provider` | A coding-agent CLI as an agent provider (declarative launch spec + a `usage` hook). |

Plugin ids are `publisher.name` (lowercase, digits, dashes). Ids without a dot are reserved for
official plugins.

Run from a checkout, the generated `package.json` links `@quadflow/plugin-api`,
`@quadflow/plugin-build`, `@quadflow/ui` and `@quadflow/sidecar-sdk-node` from that checkout with
`file:` specs, and a Rust sidecar depends on `packages/sidecar-sdk-rust` by path. `--registry`
writes published version ranges instead; `--local <checkout>` picks another checkout;
`--no-install` skips `npm install`.

## 2. Build

```bash
cd ../my-plugin
npm run build      # tsc --noEmit && quadflow-plugin build
```

`quadflow-plugin build` (from [`@quadflow/plugin-build`](../../packages/plugin-build)) builds the
UI module with Vite in library mode, keeps the host's shared modules external (`react`,
`react-dom`, `zustand`, `@quadflow/plugin-api`, `@quadflow/ui` — they come from the host at
runtime, so do not bundle your own copies), builds the sidecar for this machine, and checks the
result:

- the manifest against the JSON Schema,
- every file the manifest references exists,
- every import of a shared module names something the host really exports,
- writes `dist/.integrity.json` (sha256 of every build output file).

Other commands: `quadflow-plugin dev` (watch), `validate`, `pack`, `check-shared <file.js…>`.
`vite.config.ts` is one line, `defineQuadflowPlugin({ root })`; pass `vite: {…}` to merge your own
Vite options, `entry` for a different source entry, `react: false` for a UI-less module.

## 3. Load it unpacked, with hot reload

1. Start QuadFlow (any build; for working on QuadFlow itself see [Testing](testing.md)).
2. **Settings → Plugins → Load unpacked…** and pick the plugin folder (the one with
   `quadflow-plugin.json`). It is listed with the `dev` badge; a plugin that declares permissions
   shows **Approve** first. CLI equivalent: `quadflow plugins dev add <dir>` and
   `quadflow plugins grant <id>`.
3. Open its tile from the toolbar's Tools menu, the empty-tile menu or the command palette
   (`Open <tile>`).
4. In the plugin folder run `npm run dev`.

Now every save rebuilds `dist/`, and QuadFlow reloads the plugin within a second: the module is
re-imported, its tiles remount, and each tile gets back the `instance.state` it last stored with
`setState()`. The same happens to your users' open tiles when they install an update of your
plugin (no restart either, [publishing.md](publishing.md#4-updates)). Keep anything that should
survive a reload, an update (and an app restart) there:

```tsx
function Counter({ instance, setState }: TileProps) {
  const [count, setCount] = useState(() => (instance.state as { count?: number } | null)?.count ?? 0)
  const bump = () => {
    setCount(count + 1)
    setState({ count: count + 1 }) // persisted with the tile instance
  }
  …
}
```

What triggers what:

| Changed file | Effect |
|---|---|
| `dist/**`, `ui.entry`, `ui.style` | UI module re-imported, tiles remounted with their state |
| `quadflow-plugin.json` | registry refreshed (new tiles, commands, settings, permissions), then the same |
| the sidecar binary / Node entry | the running sidecar is restarted (QuadFlow runs a copy of a dev binary, so rebuilding never hits a locked file) |
| `src/**`, `sidecar/src/**`, `node_modules/**` | nothing directly — `npm run dev` turns them into build output |

The **Reload** button on the plugin's row does the same by hand; **Remove** stops loading the
folder (a bundled or installed copy of the same id takes over again). A dev copy always wins over
other copies of its id.

Dev plugins outside a QuadFlow checkout are always sandboxed. Logs: `ctx.log.*` goes to the app
log and the browser console; a sidecar's stderr goes to `<app data>/logs/plugins/<id>.log` and the
last 200 lines are available through `ctx.sidecar.logs()`.

## 4. Release

```bash
npm run build
npm run pack       # release/<id>-<version>.zip (+ .sha256); -<os>-<arch> when it ships binaries
```

Plugins with a native sidecar need one zip per platform: run `npm run build && npm run pack` on
each OS/arch you support. Then publish the zips and an `index.json` — see
[Publishing](publishing.md).

## Next

- [Manifest reference](manifest-reference.md) — every field, generated from the schema.
- [Host API](host-api.md) — `ctx.*` by area, with examples; full reference via `npm run docs:api`.
- [Permissions](permissions.md), [Sidecars](sidecars.md), [CLI commands](cli-commands.md),
  [Agent providers](agent-providers.md), [Testing](testing.md), [Publishing](publishing.md).
