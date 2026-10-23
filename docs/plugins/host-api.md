# Host API guide

Everything a plugin does goes through `ctx`, the `PluginContext` QuadFlow passes to `activate()`,
to command handlers and to every tile (`props.ctx`, or `usePluginContext()` anywhere below a tile).
The types live in `@quadflow/plugin-api`; the complete generated reference is built with
`npm run docs:api` (TypeDoc, output in `docs/plugins/api/`). The normative spec is
[plugin-system.md §6](../architecture/plugin-system.md#6-host-api--quadflowplugin-api).

## The module

```tsx
import { definePlugin, type TileProps } from '@quadflow/plugin-api'

export default definePlugin({
  async activate(ctx) {            // once per load: on first tile/command, or at startup (activation: onStartup)
    ctx.log.info('ready')
  },
  deactivate() {},                 // before a reload / disable
  tiles: { main: MainTile },       // key = contributes.tiles[].id
  commands: { refresh: (ctx, args) => {} },          // key = contributes.commands[].id
  settingsPages: { advanced: AdvancedPage },          // contributes.settingsPages[] with custom: true
  miniWidgets: { main: MiniWidget },                  // toolbar items with miniWidget: true
  paletteProviders: { search: { search: async (q, ctx) => [] } },
  // contributes.titleGenerators[] (API 1.3): terminal titles; asked before the agent's
  // sessionTitle hook and the chat API. Resolve null to pass.
  titleGenerators: { local: { generate: async ({ text, minWords, maxWords }, ctx) => null } },
  agentProvider: { usage: async (ctx) => null },     // see agent-providers.md
})
```

A tile receives `TileProps`: `ctx`, `instance { id, title, state }`, `config { id, name, settings }`
(the tool config's settings, edited through `configSchema`), `mode` (`pane` | `flyout`), `visible`,
and `setTitle`, `setState` (persisted with the tile instance — use it for anything that must
survive reloads and restarts), `setAttention` (tile glow) and `close`.

## Errors and feature detection

Every rejected call rejects with `HostError` (`code`: `permission_denied`, `not_found`,
`invalid_input`, `unsupported`, …; `err.permission` names the missing permission). Not every host
implements everything — sandboxed plugins have no `native.*` and no `terminals.attach` — so check
first: `ctx.api.has('agents.launch')`.

```ts
try {
  await ctx.clipboard.readText()
} catch (e) {
  if (e instanceof HostError && e.code === 'permission_denied') ctx.log.warn('needs', e.permission)
}
```

## By area

Permissions: see [permissions.md](permissions.md). "—" means no permission needed.

| Area | Methods | Permission |
|---|---|---|
| `ctx.plugin`, `ctx.api`, `ctx.log` | id/version/isolation, `api.has()`, `log.debug/info/warn/error` | — |
| `ctx.project` | `current()`, `list()`, `onDidChange(cb)` | — |
| `ctx.workspace` | `current()`, `onDidChange(cb)` | — |
| `ctx.data.<domain>` | ideas, issues, plans, discovery, scripts, ship, chat, missions — the same operations as the `quadflow` CLI (`list`, `get`, `create`, `update`, …); every method takes an optional trailing `{ projectRoot }` | `data:<domain>:read` / `:write` |
| `ctx.terminals` | `spawn` (`shell` name or absolute `shellPath`, `environmentId`, `initCommands`, `placement`), `list`, `write`, `resize`, `kill`, `onData`, `onExit`, `readBuffer`, `attach` (trusted) | `terminal:spawn` (own) / `terminal:io` (any) |
| `ctx.agents` | `providers`, `detect`, `models`, `launch` (a terminal it creates is the caller's own, like a spawned one), `onSessionLinked` | `agents:read` / `agents:launch` |
| `ctx.events` | `on(topic)` host topics (`project.changed`, `theme.changed`, `terminal.created`, …), `emit(topic)` / `onPlugin(id, topic)` plugin bus | — |
| `ctx.storage` | `get/set/delete/keys`, scope `global` or `project` (1 MiB per value, 50 MiB per plugin) | — |
| `ctx.settings` | `get` (sync), `getAll`, `set`, `onDidChange` — values of `contributes.settings`, validated against its schema | — |
| `ctx.secrets` | `get/set/delete` in the OS keychain, namespaced to the plugin | `secrets` |
| `ctx.notifications` | `toast`, `system` (OS notification), `attention(instanceId, on)` | `notifications` for `system` |
| `ctx.fs` | `readText/readBytes/writeText/writeBytes/list/stat/remove/mkdir/watch` in a scope: `project`, `pluginData`, `projectPluginData`, `projectPluginLocal`, `home`, `absolute` | `fs:read|write:project|home|any`; plugin scopes need none |
| `ctx.shell` | `exec`, `spawn` (program by name, argv, no shell), `openExternal`, `revealInFileManager` | `shell:exec:<program>`, `shell:open-external` |
| `ctx.http` | `fetch(url, init)` (runs in Rust; redirects returned, not followed) | `network:<host>` / `network:*` |
| `ctx.clipboard` | `readText`, `writeText`, `writeImage` | `clipboard:read` / `clipboard:write` |
| `ctx.sidecar` | `request`, `notify`, `onNotification`, `status`, `onStatus`, `restart`, `logs` — the plugin's own sidecar ([sidecars.md](sidecars.md)) | — |
| `ctx.commands` | `register(id, handler)`, `execute('<plugin>/<cmd>' \| 'core/<cmd>', args)` | — |
| `ctx.ui` | `openTile` (with initial `state`), `closeTile`, `focusTile`, `onTileClosed` (1.2), `confirm`, `prompt`, `pickFile`, `theme`, `onThemeChange` | — |
| `ctx.overlay` | `isAnyOpen`, `onChange`, `register` (overlays not built with `@quadflow/ui`) | — |
| `ctx.native` (trusted only) | `mainWindowHandle`, `tileGeometry`, `onTileGeometry`, `createChildWebview` (`anchor` selector, 1.2), `captureRegion` | `native:windows|webview|screen-capture` |

## Examples

Read issues of the current project and open a tile:

```ts
const { items } = await ctx.data.issues.list({ statuses: ['todo', 'in_progress'] }) // needs data:issues:read
const id = await ctx.ui.openTile('details', { state: { issue: items[0]?.id }, placement: 'split-active' })
```

React to settings and theme:

```tsx
useEffect(() => ctx.settings.onDidChange((key, value) => key === 'greeting' && setGreeting(String(value))), [ctx])
const theme = ctx.ui.theme() // { mode, colors, terminal, scalars }
```

Store per-project state:

```ts
await ctx.storage.set('lastRun', Date.now(), 'project')
```

Run a program (needs `"shell:exec:git"` in `permissions`):

```ts
const { code, stdout } = await ctx.shell.exec({ program: 'git', args: ['status', '--porcelain'] })
```

## UI building blocks

`@quadflow/ui` (shared with the host, so it is free to import) has buttons, inputs, selects,
tabs, cards, badges, menus, modals, toasts, markdown, drag-and-drop lists and `FormFromSchema`,
all themed with QuadFlow's tokens. Your own CSS goes into `src/*.css` → `dist/index.css`
(`ui.style`); prefix class names, and use the tokens: `color: rgb(var(--qf-text))`,
`background: rgb(var(--qf-surface))`, `border-color: rgb(var(--qf-border))`. To write Tailwind
classes instead, build with `defineQuadflowPlugin({ root, tailwind: { scope: '.qf-my-plugin' } })`
(the `@quadflow/ui` preset, every rule scoped under that class, no preflight), put
`@tailwind components; @tailwind utilities;` in your CSS and wrap each tile (and portal content
such as modal bodies) in `<div className="qf-my-plugin">` — `plugins/ideas` does this. Menus and modals
you build yourself must call `ctx.overlay.register(id, open)` so native views can hide under them.

## Shared modules

These imports resolve to the host's own instances at runtime and must not be bundled
(`@quadflow/plugin-build` keeps them external and checks every imported name exists):
`react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `zustand`,
`@quadflow/plugin-api`, `@quadflow/ui`. Everything else you import is bundled into your module.
