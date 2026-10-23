# CLI commands and agent context docs

Plugins can add top-level subcommands to the `quadflow` CLI (`quadflow <name> …`) and markdown
docs that coding agents get through `quadflow docs` and the project's agent context files. Spec:
[plugin-system.md §9](../architecture/plugin-system.md#9-cli-contributions-and-agent-context-docs);
template: `cli-command`.

## CLI commands

```json
"activation": ["onCli"],
"contributes": {
  "cliCommands": [
    { "name": "word-count", "summary": "Count words in project files", "docs": "docs/cli.md", "handler": { "type": "sidecar" } }
  ]
},
"sidecar": { "runtime": "node", "entry": "bin/sidecar.mjs" },
"permissions": ["sidecar:runtime:node"]
```

- `name`: `^[a-z][a-z0-9-]{1,31}$`, unique across active plugins, and not one of the core
  commands (`gui init doctor docs context plugins ideas issues labels epics plans discovery
  scripts ship chat missions help version`).
- `summary` shows in `quadflow --help` and `quadflow docs --list`; `docs` is a markdown file in the
  plugin.

For `quadflow word-count a b --json` the CLI finds the active plugin owning `word-count`, then runs
the handler with argv `["a", "b"]` and env `QUADFLOW_CLI` (path of the `quadflow` executable),
`QUADFLOW_PROJECT_DIR` (empty when no project is found), `QUADFLOW_PLUGIN_ID`,
`QUADFLOW_PLUGIN_DIR`, `QUADFLOW_PLUGIN_DATA`, `QUADFLOW_JSON` (`0`/`1`), `QUADFLOW_PROFILE`. The
global flags `--json` and `--project <p>` are consumed wherever they appear before a `--` and passed
on through that env; everything after `--` reaches the handler verbatim. The exit code is the
handler's. An unknown command exits 2 with a "did you mean" hint and the list of plugin commands.

### `sidecar` handlers (any plugin)

The CLI starts a private instance of the plugin's sidecar with `QUADFLOW_SIDECAR_MODE=cli`,
initializes it and sends `cli/run { argv, cwd, json, projectRoot }`. The sidecar prints by sending
`cli/output { stream: 'stdout' | 'stderr', text }` notifications (written in arrival order) and
returns `{ exitCode }` (no `exitCode` means 0); then the CLI stops the sidecar. A CLI-mode sidecar is
never restarted. `host/call` works with the plugin's granted permissions but reaches only the core
methods (`data.*`, `storage`, `settings`, `secrets`, `fs`, `shell`, `http`, `log`); terminal, agent,
native, notification, clipboard and UI methods answer `unsupported` in CLI mode.

```js
createServer()
  .onInitialize(() => ({ capabilities: { cli: true } }))
  .onRequest('cli/run', async ({ argv, json }, host) => {
    const words = argv.length
    host.notify('cli/output', { stream: 'stdout', text: json ? JSON.stringify({ ok: true, data: { words } }) + '\n' : `${words}\n` })
    return { exitCode: 0 }
  })
  .run()
```

### `exec` handlers (trusted plugins only)

```json
{ "name": "fmt", "summary": "…", "handler": { "type": "exec", "binaries": { "windows-x86_64": "bin/fmt.exe" } } }
```

The binary is spawned directly (argv, no shell) and runs with the user's privileges, so only
trusted (first-party) plugins may use `exec` (a sandboxed plugin's `exec` handler fails with
`permission_denied`). stdin is inherited; stdout/stderr are forwarded through pipes, so the binary
does not see a TTY. It reaches QuadFlow data by calling `$QUADFLOW_CLI … --json` itself. A binary
that is both sidecar and exec handler tells the modes apart by `QUADFLOW_SIDECAR_MODE` (set only for
sidecars) — `plugins/hello` does this.

Conventions: support `--json` and print one object `{ "ok": true, "data": … }` (or
`{ "ok": false, "error": { "code", "message" } }`); keep human output short; exit `2` for usage
errors.

## Agent context docs

```json
"contributes": {
  "agentContextDocs": [{ "id": "word-count", "title": "Word count", "file": "docs/agent.md", "default": false }]
}
```

Each doc becomes a context module: id `<pluginId>` when the doc id equals the plugin id, else
`<pluginId>.<docId>`. `quadflow docs --list` lists it, `quadflow docs <module>` prints it, and
`quadflow context enable <module>` adds it to the project's agent context files (`CLAUDE.md`,
`AGENTS.md`, … — one per installed agent provider). `default: true` makes Settings → Plugins
suggest enabling it for the active project when the plugin is enabled (never silently). A plugin
doc whose module id equals a bundled core doc replaces it (the base `quadflow` module cannot be
replaced). Write these for agents: which commands exist, the `--json` shapes, when to use them.

## Trying it

```bash
quadflow plugins dev add ./my-plugin     # or Settings → Plugins → Load unpacked…
quadflow plugins grant acme.my-plugin --yes   # approve its permissions (sidecar:runtime:node)
quadflow my-command hello --json
quadflow docs --list
```

With an isolated development build of QuadFlow, set `QUADFLOW_PROFILE=dev` and
`QUADFLOW_DATA_DIR=<temp dir>` so you never touch your real data (see [testing.md](testing.md)).
