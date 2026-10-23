# Porting a tool into a plugin

Every QuadFlow tool is a plugin under `plugins/<id>/`; the shell (`src/`) only keeps the core
features (terminals, agents, layout, settings) and the built-in `core` plugin (`plugins/core`)
that contributes them. This page is the recipe for turning a piece of UI that lives in the shell
(or a feature someone prototyped there) into its own first-party plugin. Every QuadFlow tool
(Ideas, Discovery, Issues, Plans, Scripts, …) became a plugin this way. The binding design is
`docs/architecture/plugin-system.md` (§5 contributions, §6 host API, §8.3 trusted loading,
§9.3 agent docs, §14 `@quadflow/ui`, §15 build); this page is the recipe.

The rule that drives every step: **the plugin imports nothing from `src/`.** It only uses
`@quadflow/plugin-api` (types + `ctx`), `@quadflow/ui`, `react` and `zustand` (shared
through the import map) and whatever it bundles itself. When the public API cannot do
something the old view did, you add the method to the host API properly (step 9) — you do
not reach back into the shell.

Use `plugins/ideas` as the reference implementation while reading this; `plugins/issues`
is the reference for a tool with several entity kinds, a Kanban board and agent
launches tied to an entity.

---

## 1. Inventory the shell code

Before writing anything, list what the shell view touches:

```bash
grep -n "use[A-Z][a-zA-Z]*Store\|invoke\|commands\.\|terminalApi\|tauri" src/components/<area>/<Tool>View.tsx
grep -rln "<toolStore>\|<Tool>View" src        # who else depends on the store / view
```

When Ideas was ported this gave: its own store (→ plugin state), `useIssueStore().createIssue`
(→ `ctx.data.issues.create`), `terminalApi` + `useTerminalStore` + `useAppSettingsStore` to
start `claude` and type a slash command (→ `ctx.agents.launch`), `useAgentPromptStore`
(→ `ctx.agents.launch` with a prompt), `types/issues` display tables (→ copied into the
plugin), and three outside users of the store: the palette (`commandRegistry.ts`), the
project switch (`projectStore.ts`) and Plans (`PlansToolView.tsx`).

Every outside user needs a new home **before** you delete the store (step 8).

## 2. Create `plugins/<id>/`

```
plugins/<id>/
  quadflow-plugin.json     manifest (step 3)
  package.json             "@quadflow-plugins/<id>", version = manifest version, peer deps only
  tsconfig.json            copy from plugins/ideas
  vite.config.ts           copy from plugins/ideas, change the Tailwind scope (step 6)
  assets/icon.svg          24x24 stroke icon (`currentColor`), like the other plugins'
  docs/agent.md            the domain's agent doc (step 7)
  src/index.tsx            definePlugin({ tiles, commands, paletteProviders })
  src/model.ts             the tool's state + mutations over ctx.data
  src/<Tool>Tile.tsx       the ported view
```

Plugin ids are the official ones from plugin-system.md §2 (`discovery`, not `projects`).
`package.json` needs no `quadflow.bundle` key: first-party tools are `release` by default
(bundled into the app, origin `bundled` ⇒ trusted, permissions auto-granted).

Run `npm install` once so the new workspace is linked and `package-lock.json` lists it. In a git
worktree without its own `node_modules`, Node resolves `@quadflow/*` from the *main* checkout's
`node_modules` (links into the main checkout's `packages/`), so your plugin would type-check and
bundle against another branch's `plugin-api` / `plugin-kit` — install in the worktree first.

The build is `@quadflow/plugin-build`: `package.json` has `"build": "quadflow-plugin build
--no-sidecar"`, `"dev": "quadflow-plugin dev"` and the dev dependency
`"@quadflow/plugin-build": "*"`, and `vite.config.ts` is
`defineQuadflowPlugin({ root, tailwind: { scope: '.qf-<id>' } })`.

## 3. Manifest

Declare the tile (and, if the tool had a toolbar button, a `toolbarItems` entry); `plugins/ideas`
is a complete example:

```jsonc
{
  "id": "ideas", "name": "Ideas", "version": "1.0.0",
  "apiVersion": "^1.1.0",                 // the minor that has every method you call
  "ui": { "entry": "dist/index.js", "style": "dist/index.css" },
  "activation": ["onTile", "onCommand"],
  "contributes": {
    "tiles": [{
      "id": "board", "title": "Ideas", "modes": ["pane", "flyout"],
      "requiresProject": true, "templateable": true,
      "flyout": { "defaultSize": [640, 560] },
      "defaultToolConfig": { "order": 2, "color": "#ec4899" }
    }],
    "commands": [{ "id": "new-idea", "title": "New Idea", "category": "Ideas", "when": "project" }],
    "paletteProviders": [{ "id": "ideas", "title": "Ideas" }],
    "agentContextDocs": [{ "id": "ideas", "title": "Ideas", "file": "docs/agent.md" }]
  },
  "permissions": ["data:ideas:write", "data:issues:write", "data:discovery:read", "agents:read", "agents:launch"]
}
```

- **Permissions** are enforced in Rust. Declare the least you need: `write` implies `read`;
  `data.onDidChange` needs the read permission of *every* domain you subscribe to (the
  Projects plugin listens to `ideas` and `plans` too, so it declares `data:ideas:write` and
  `data:plans:read`).
- Every "Open <tile>" / "Open <tile> in Flyout" palette entry is automatic; declare only
  real actions as commands. Commands that only exist as toast actions get `"palette": false`.
- Schema check: `npm run build:plugins:dev` validates the manifest (and `quadflow plugins
  validate plugins/<id>` does too).

## 4. State and data access

Replace the zustand store that called `commands.*` with a **model per plugin context**:

```ts
const models = new WeakMap<PluginContext, IdeasModel>()
export function ideasModel(ctx: PluginContext) { /* create once per ctx */ }
```

The pane tile and the flyout tile get the same `ctx`, so they share one model.

`createCollection(ctx, spec)` from **`@quadflow/plugin-kit`** (`packages/plugin-kit`, add `"@quadflow/plugin-kit": "*"` to the plugin's `dependencies`; it is bundled into the plugin) is the reusable live list. Don't copy it — import it, and extend the kit if your tool needs more. It:

- loads `ctx.data.<domain>.list(…, { projectRoot })` for `ctx.project.current()`;
- subscribes to `ctx.data.onDidChange({ domain, projectRoot })` — the project filter runs
  in Rust with canonical root keys, so do **not** compare root keys yourself;
- calls `ctx.data.watchProject(root)`, so CLI / other-process edits produce events even if
  no shell store opened the project;
- coalesces events per animation frame (≤ 20 ids → `get` each, else reload);
- reloads on `ctx.project.onDidChange`;
- is reference-counted: tiles call `useEffect(() => model.items.retain(), [model])`, so a
  closed tool has no subscriptions.

Mutations always pass an explicit `{ projectRoot }` captured *before* the call and merge the
result with `collection.apply(root, item)`, which drops results for a project that is no
longer current. Wrap UI calls so failures become `ctx.notifications.toast({ kind: 'error' })`
instead of silent console errors.

Cross-tool links go through `ctx.data` as well: Ideas reads `ctx.data.discovery.list` for
its project picker and writes `ideas.update({ discoveryId })`; Projects reads
`discovery.linked(id)` and refetches whenever an `ideas` / `plans` event arrives
(`relatedDomains`). Neither imports the other.

Agents: never write into terminals to start a CLI. Use `ctx.agents.launch({ providerId,
prompt, autoSubmit, placement: 'split-active' })`; pick the provider from
`ctx.agents.providers()` (see `agentProviders` / `launchAgent` in `@quadflow/plugin-kit`). Slash-command skills use
`preferred: 'claude-code', autoSubmit: true`; "send to agent" leaves the prompt unsubmitted.
Unattended work (Scripts' auto-fix) passes `approvalMode: 'unattended'` (the provider's `auto`,
else `accept-edits`). Since API 1.2 the terminal a launch creates belongs to your plugin, so you
can follow it with `ctx.terminals.onData` / `onExit` and `kill` it without `terminal:io`. Every
wait on an agent needs a timeout measured from its **start** (output can go on forever) and every
exit path must dispose its listeners.

**Terminals and long-running work** (Scripts): keep PTYs in the model, not in a tile. A tile
unmounts when its flyout closes or the user closes the pane; tying a PTY (or its exit listener) to
a component's lifetime kills work the user still wants (the old Scripts pane killed the other
members of a parallel group this way). Spawn headless (`ctx.terminals.spawn({ placement: 'none' })`),
show the PTY with `ctx.terminals.attach(id, el)` only while the tile is `visible`, and dispose the
attach on unmount. `kill` drops the host's scrollback, so keep your own output tail if a stopped
run should still be readable. Type user-authored commands with `initCommands` (the host waits for
the shell); pass a resolved shell executable as `shellPath`. Close everything in `deactivate()`.

**Commands that show a tile**: `ctx.ui.openTile` resolves when the new tile registers and rejects
after 5 s otherwise (e.g. the flyout is already open) — don't `await` it before doing the actual
work; track your visible tiles in the model and open one only when there is none.

**Other plugins' features**: you cannot import another plugin or open its tile directly. Call one
of its commands instead (`ctx.commands.execute('<pluginId>/<command>', args)`; Scripts opens Web
Preview with `web-preview/open-url { url }`), and add a `palette: false` command to that plugin if none
fits. The shell's own actions are the `core` plugin's commands (`core/new-terminal`,
`core/launch-agent`).

### Several entity kinds, one model

A domain with more than one list (Issues: issues, epics, labels, plus the project code) gets one
collection per kind and a model-level `retain()` that retains all of them (`plugins/issues/src/model.ts`).
APIs that return the whole set after a write (`issues.labels.upsert` / `delete`) merge with
`collection.replaceAll(root, items)`. Values outside any entity list (the project code from
`ctx.data.projectConfig`) refresh on `relatedDomains: ['project_config']` (`relatedVersion`) and on
project switches. Hand the model to deep view trees through a React context (`ModelContext` /
`useModel()`) instead of re-creating the old store's hook — the old components keep their shape and
the diff stays reviewable. Derived lists (the old store's `getFilteredIssues`) become pure functions.

### Side effects that belong to the shell

Some old store code did shell work (Issues: closing an agent terminal once its issue reached
`qa` / `done`). That stays in the shell, keyed off change events rather than off the tool's own
mutations (`src/lib/issueTerminals.ts` — so CLI and agent edits count too); the plugin only passes
what the shell needs through the API (`agents.launch({ issueRef, closeOnIssueDone })`). Informal DOM
contracts with the shell (the `application/quadflow-issue` drag payload that `TerminalView` reads)
carry ready-to-use values (`ref`), so the shell never needs the plugin's state.

## 5. Port the view

`git mv` the old view to `plugins/<id>/src/<Tool>Tile.tsx` and edit it (a scripted
search/replace keeps the diff reviewable):

- component signature → `export function IdeasTile({ ctx, mode }: TileProps)`;
- store hooks → `model.items.use((s) => s.items)` etc.;
- shell types → generated types from `@quadflow/plugin-api` (`Idea_Serialize`,
  `IssueStatus`, `Priority`, …); small display tables (status labels/colors) are copied;
- hand-made `absolute inset-0` overlays → `@quadflow/ui` `Modal` / `DropdownMenu` (they
  portal to `body` and register with the overlay system, so native embeds hide under them);
- a "no project" state: `requiresProject` tiles can still be visible while switching;
- hand-made dropdowns with a `fixed inset-0` click-catcher → `DropdownMenu`; right-click menus →
  `Menu` with `anchor={{ x, y }}` (both register with the overlay system); a drag-and-drop board →
  `@quadflow/ui` `KanbanBoard` (`onMove(id, toColumn)`) instead of a private dnd-kit copy;
- shell-only editors / renderers (Codemirror, `react-markdown` with custom components) →
  `@quadflow/ui` `Markdown` / `MarkdownEditor`, so the plugin bundles neither;
- shared components the old view owned but other shell code still uses stay in the shell
  (or move next to their remaining user); pure ones the plugin needs too are copied;
- `navigator.clipboard` → `ctx.clipboard.writeText` (`clipboard:write`).

Keep behaviour identical unless the old code depended on shell internals; note every
behaviour change in the commit (Ideas: skills now open a new Claude Code session through the
provider instead of typing `claude\r` into a fresh shell; promoting an idea records
`source.ideaId` on the issue).

## 6. Styling

The shell's Tailwind build scans only `src/` and `packages/ui/src`, so a plugin compiles its
own utilities (`vite.config.ts`):

```ts
defineQuadflowPlugin({ root, tailwind: { scope: '.qf-ideas' } })
// = tailwindcss({ presets: [@quadflow/ui/tailwind-preset],   // vibe-* / qf-* colors = theme tokens
//                 content: ['<root>/src/**/*.{ts,tsx,js,jsx}'],
//                 important: '.qf-ideas',                     // every rule scoped
//                 corePlugins: { preflight: false } })        // the shell owns the base styles
```

and `src/styles.css` is `@tailwind components; @tailwind utilities;`. The scope is
mandatory: an unscoped plugin stylesheet loads after the shell's and would re-order
utilities on shell elements (e.g. a later `.p-3` beating the shell's `.px-2`). Consequences:

- wrap each tile in `<div className="qf-<id>">` (done in `index.tsx`), and
- wrap **portal content** (modal bodies/footers) in a `qf-<id>` element too — portals render
  outside the tile.

Only theme colors (`vibe-*`, `qf-*`) follow light/dark; raw palette colors (`teal-600`)
stay as they are. Classes that never existed in the preset (`vibe-accent`,
`vibe-bg-secondary` in the old Projects view) map to `vibe-primary` / `vibe-surface`.

## 7. Palette, commands, agent docs

- **Palette entity search** moves out of `src/lib/commandRegistry.ts` into the plugin:
  declare `contributes.paletteProviders: [{ id, title }]` and export
  `paletteProviders: { [id]: { search(query, ctx) } }`. The shell (`src/plugins/palette.ts`)
  loads declaring plugins on the first entity query (≥ 2 chars), gives each provider 1.5 s
  and groups results under `title`. Query the core directly (`ctx.data.ideas.list({ text })`)
  so results do not depend on an open tile. `run()` usually stores a focus id in the model's
  UI store and calls `ctx.ui.openTile('<tile>')`; the tile reacts to it.
- **Commands** are `commands: { 'new-idea': (ctx, args) => … }`; `ctx.ui.prompt` /
  `ctx.ui.confirm` cover simple dialogs without a tile.
- **Agent context docs**: put the domain's agent doc in `plugins/<id>/docs/agent.md` and
  declare it in `agentContextDocs`. If the core still bundles a doc with that id (`BUNDLED` in
  `quadflow-core/src/context/registry.rs`), `git mv` it into the plugin and delete the entry:
  a plugin doc with the same id replaces a core one; `quadflow docs <id>` then reports
  `source: "<pluginId>"`. Adjust core tests that used your module as "some bundled module".

## 8. Remove the shell code

1. If the shell contributed the tool (a tile or toolbar item of `plugins/core`), delete that entry
   from `plugins/core/quadflow-plugin.json` and its handler in `src/plugins/core/index.tsx`.
2. `git rm` the old view and its store.
3. Re-home every outside user found in step 1, without importing the plugin:
   - palette entries → the plugin's palette provider;
   - project-switch reloads → nothing (the collection reloads on `project.onDidChange`);
   - other shell code that read the store → the plugin's commands, or a small local hook over
     `commands.*` + `onDataChanged` next to that code.
4. `npx tsc --noEmit` must be clean; `grep -rn "<oldStore>\|<OldView>" src` empty.

Functions of the old view that belong to another tool move to that tool's plugin if they fit
there (Issues' GitHub import went to the GitHub plugin's settings) or are listed as deferred in the
changelog. Context tests that used your module as "some core module" (`cli_context.rs`,
`context/writer.rs`, `cli_plugin_commands.rs`) switch to a module that is still core-bundled.

Tool configs pointing at a contribution that no longer exists are simply hidden (contribution
unavailable); the new plugin's `defaultToolConfig` creates its own config on the next sync. No
migration.

## 9. When the API is missing something

Do not hack around it from `src/`. Add the smallest method that fits §6, end to end:

1. Rust: a `ps!(…)` line in `quadflow-core/src/plugins/host/data.rs` (or the right host
   module) with its permission; a test in `host/tests.rs` (permission denied + happy path).
2. TS types: the method in `packages/plugin-api/src/index.ts` (doc comment says the API
   minor it appeared in).
3. Trusted impl: `src/plugins/hostApi/index.ts`.
4. Sandboxed impl: add the name to `RPC_METHODS` in `packages/plugin-api/src/rpc/protocol.ts`.
5. `plugins/hello/src/apiTests.ts`: exercise it (keep the check count stable if you can —
   `sandbox.test.mjs` compares counts between trusted and sandboxed runs).
6. Bump the API minor (`PLUGIN_API_VERSION` in `quadflow-core/src/plugins/mod.rs`,
   `packages/plugin-api/src/version.ts`, its `package.json` + `package-lock.json`) unless a
   sibling already bumped it in the same merge window, and require it in your manifest.
7. Changelog entry in plugin-system.md §17.

Manifest additions follow the same path: schema (`packages/plugin-api/schema/…`),
`plugins/manifest.rs` (struct, validation, duplicate ids, `needs_ui`), the flattened
`Contributions` in `plugins/registry.rs`, a registry test, then regenerate bindings. Name new
Rust types so they cannot collide in the single TS namespace (`PaletteProviderSpec`, not
`PaletteProvider`, which `@quadflow/plugin-api` already exports).

Examples: Ideas added `data.ideas.bulkTag` (API 1.1.0) and `contributes.paletteProviders`;
Scripts added `terminals.spawn({ shellPath })` and launcher-owned agent terminals, Issues
`LaunchAgentOptions.closeOnIssueDone` (both API 1.2.0). A TS-only option handled in the trusted
`hostApi` (stripped before the Rust call) needs no Rust method, permission or RPC allowlist entry
(sandboxed calls run the same host context), but still a minor bump and a changelog entry.
When two branches bump the minor in the same merge window, the merge keeps the higher version
and both changelog entries.

**Two UIs for one tool** (Scripts had a pane view and a separate flyout view): build one tile with
`modes: ["pane", "flyout"]` and switch to a compact layout on `mode === 'flyout'` (smaller paddings,
short tab labels, a fixed-height output panel) instead of porting both.

## 10. Test

- `npx tsc --noEmit`, `npm run build:web`, `npm run build:plugins:dev` (manifest schema,
  plugin `tsc`, Vite build, shared-module shim check, staging).
- `cargo test -p quadflow-core` — CLI contract tests must pass unchanged (the port does not
  change the domain; if they break, you changed the core by accident).
- `cargo test -p quadflow-tauri --test export_bindings` after Rust type changes.
- GUI: `npm run build:dev-exe`, then an e2e test in `scripts/ui/<id>.test.mjs` (see
  `scripts/ui/ideas.test.mjs`) and add it to `test:e2e:only`. It should: open the tile from
  the palette in a pane and in a flyout; edit with the built CLI (`s.exe` with
  `QUADFLOW_PROFILE=dev`, `QUADFLOW_DATA_DIR=<runDir>/data`, `cwd = s.projectDir`) and wait
  for the change in the tile; make an edit in the UI and read it back with the CLI; hit the
  palette provider; check `quadflow docs <id>` reports the plugin as source; assert no page
  errors. A Kanban drag (`scripts/ui/issues.test.mjs`): `mouse.down()` on the card, a small
  `move` (dnd-kit's pointer sensor needs ≥ 4 px), then `move(..., { steps: 12 })` onto the target
  `[data-kanban-column="<id>"]` and `up()`; read the result back with the CLI.
  Look at the screenshots it saves (`QF_UI_SHOTS_DIR`) in both themes if you
  touched styling. A terminal shown with `ctx.terminals.attach` uses xterm's DOM renderer, so its
  text is readable as `<your element> .xterm-rows` (see `scripts/ui/scripts.test.mjs`); make the
  output differ from the typed command line (`echo qf-al^pha-ok` in cmd) so the check proves the
  command ran.
- `npm run check`, then `npm run test:e2e`.
