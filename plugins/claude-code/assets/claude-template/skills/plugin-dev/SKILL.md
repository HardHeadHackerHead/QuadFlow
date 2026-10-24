---
name: plugin-dev
description: Create a new QuadFlow plugin or change an existing one with the fast loop — scaffold, build only the plugin, load it unpacked into the running QuadFlow with hot reload, run only the tests that cover the change, bump the version. Use for "make a plugin", "add a tool/tile to QuadFlow", "change the <x> plugin", "fix the <x> tool".
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
user-invocable: true
argument-hint: "[new <name> | <plugin folder or id>]"
---

# QuadFlow plugin development

A plugin is a folder with a `quadflow-plugin.json` manifest, a UI module (`src/` → `dist/`) and
optionally a sidecar process. It builds on its own in seconds — **never rebuild QuadFlow itself to
work on a plugin**, and never run the whole app test suite for a plugin-only change.

Reference docs (in a QuadFlow checkout, or on GitHub under `HardHeadHackerHead/QuadFlow`):
`docs/plugins/getting-started.md`, `manifest-reference.md`, `host-api.md`, `permissions.md`,
`sidecars.md`, `testing.md`, `publishing.md`. `quadflow plugins --help` lists the CLI.

## 1. Find or create the plugin

- **Existing plugin**: the argument is a folder, or an id. First-party plugins live in
  `plugins/<id>/` of the QuadFlow repository. Read its `quadflow-plugin.json`, `package.json`,
  `README.md` and `src/` before changing anything.
- **New plugin**: pick a template — `tile` (a React tile, no permissions), `tile-sidecar-rust`,
  `tile-sidecar-node`, `cli-command` (a `quadflow <command>` subcommand), `agent-provider` (a
  coding-agent CLI in the launch toolbar). Ids are `publisher.name` (bare ids are reserved for the
  official source). From a QuadFlow checkout:

  ```bash
  node <quadflow-checkout>/packages/create-quadflow-plugin/index.mjs <dir> --template tile --id acme.my-tool --name "My Tool" -y
  ```

  Ask the user for the id/name/template if they didn't say; don't guess a publisher.

## 2. Build only the plugin

```bash
cd <plugin dir>
npm run build          # UI module → dist/ (seconds)
quadflow plugins validate .
```

Rust sidecar: `cargo build --release -p <crate>` (workspace member) or the plugin's own
`npm run build:sidecar` when its README says so. Rebuild the QuadFlow app only if you changed the
app itself (`src-tauri/`, `src/`, shared `packages/`).

## 3. Try it live in the running QuadFlow (with the user's OK)

Loading a dev copy changes the plugin list of the QuadFlow the user is working in, so ask first.

```bash
quadflow plugins dev add <plugin dir>     # = Settings → Plugins → Load unpacked…
npm run dev                               # in the plugin dir; run in the background — rebuilds on save
```

- The dev copy shadows a bundled or installed plugin with the same id and shows a `dev` badge;
  QuadFlow reloads it about a second after each rebuild (tiles remount and get their saved
  `instance.state` back). No app restart.
- Dev plugins run **sandboxed** like third-party plugins, even when the bundled copy is trusted.
  `native:*` permissions are refused there; if the plugin needs one, say so instead of working
  around it.
- Permissions: the user approves them in Settings → Plugins (**Approve**). Only run
  `quadflow plugins grant <id> --yes` if the user explicitly asks you to approve for them.
- Done: `quadflow plugins dev remove <plugin dir>` (the bundled/installed copy comes back) and stop
  the `npm run dev` process you started (by its PID — never kill QuadFlow).

## 4. Test only what the change touches

| Change | Run |
| --- | --- |
| Plugin UI / logic | `npm test` and `npm run build` in the plugin dir; `npx tsc --noEmit -p <plugin dir>` if it has a tsconfig |
| Plugin sidecar (Rust) | `cargo test -p <crate>` |
| Plugin sidecar (Node) | the plugin's `npm test` |
| Plugin with GUI tests (QuadFlow repo) | `node --test scripts/ui/<plugin>.test.mjs` against the existing dev exe (`target/debug/quadflow-tauri.exe`); `npm run build:dev-exe` only if Rust changed |
| Shared packages (`packages/*`) | their `npm test`, then the plugins that use them |
| App core (`src-tauri/`, `src/`) | `npm run check`, then the affected `scripts/ui/*.test.mjs` |

Don't run the full `npm run test:e2e` for plugin changes; releases run `npm run check`, and the
full GUI suite is only for broad app-core changes.

## 5. Finish

- Bump `version` in **both** `quadflow-plugin.json` and `package.json` (semver: fix → patch,
  feature → minor). Published versions are immutable.
- Update the plugin's `README.md` (features, settings, permissions) and `docs/agent.md` if its CLI
  or data changed.
- Show the user what changed and how they tried it live. Publishing (archives, plugin source
  index) is described in `docs/plugins/publishing.md`; don't upload or push unless asked.
