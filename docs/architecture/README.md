# Architecture

**The binding design of QuadFlow's core, plugin system and agent integrations.**

[docs/ROADMAP.md](../ROADMAP.md) is the product source of truth; the documents here turn its
decisions and target architecture into implementable specs. Read them before changing the data
layer, the plugin host or the agent framework. For a shorter overview, see
[How it works](../../README.md#how-it-works) in the root README.

| Doc | Covers |
|---|---|
| [data-layer.md](data-layer.md) | The `quadflow-core` storage engine (atomic writes, cross-process locking, project discovery, ids), every domain schema, the app SQLite schema, change events and the file watcher, specta/tauri-specta type generation, the Tauri command surface, the CLI contract, tests |
| [plugin-system.md](plugin-system.md) | Manifest + JSON Schema, plugin locations and registry, the contribution registry, the `@quadflow/plugin-api` host API, trusted vs sandboxed loading, permissions, the sidecar JSON-RPC protocol, CLI contributions, agent context docs, plugin sources/install/update, `@quadflow/ui`, the monorepo build |
| [agent-providers.md](agent-providers.md) | Agents as plugins: declarative provider spec + hooks, launch safety (argv validation + per-shell quoting), the model catalog (`catalog/models.json`), session preassignment and discovery without races, context files (`CLAUDE.md` / `AGENTS.md`), the Claude Code and Codex provider specs |

## Key decisions

### Data

- **Storage split.** Shareable project content lives in `<project>/.quadflow/` (one JSON file per
  entity, camelCase); machine runtime state in `.quadflow/local/` (gitignored); user and app state
  in one SQLite database (`<appData>/quadflow.db`, WAL, `busy_timeout=5000`, `foreign_keys=ON`).
- **A project is a working directory**, nothing else. Big-picture "projects" with goals and
  research are the separate `discovery` domain.
- **Writes.** Unique temp file in the same directory → fsync → rename (with retries on Windows).
  Reads are lock-free; every mutation runs under one per-project advisory lock
  (`std::fs::File::lock` on `.quadflow/.lock`). Display numbers are allocated under the lock as
  `max(counter, max existing) + 1`.
- **No implicit active project in the backend.** The CLI walks up from the current directory to
  `.quadflow/config.json`.
- **Ids.** Lowercase ULIDs, validated before they touch a path. Issue refs are `CODE-n`, with the
  code from the project config.
- **Events.** An in-process bus, a `notify` watcher on `.quadflow/` (with self-write suppression)
  and an `app_changes` single-query cursor for the SQLite database.
- **Types.** `specta` + `tauri-specta` generate `src/generated/bindings.ts` (commands, events,
  types) and `packages/plugin-api/src/generated/types.ts`; `npm run check` fails on drift.

### Plugins

- **Loading.** First-party bundled plugins run trusted in the host document, sharing React through
  an import map and generated shim modules. Everything else runs in a sandboxed iframe
  (`allow-scripts`, no `allow-same-origin`) over postMessage RPC. Assets are served by the
  `qfplugin://` protocol.
- **Permissions.** One Rust dispatch table enforces permissions for UI, sidecars and CLI alike.
- **Sidecars.** JSON-RPC 2.0 over stdio with NDJSON framing; a supervisor restarts them with
  backoff, and they are killed with the app (Job Objects / process groups).

### Agent providers

- **Declarative specs.** A provider is a manifest spec interpreted by core (detect, launch, models,
  sessions, context file) plus optional hooks (usage, context usage, titles, worktree preparation).
- **Launch safety.** Model ids match `^[A-Za-z0-9._:\[\]-]+$`; argv uses a safe character set and
  per-shell quoting; prompts are sent with bracketed paste, one-shot prompts through stdin.
- **Sessions.** Codex session discovery is FIFO-claimed in one registry, so concurrent launches in
  one directory get distinct sessions.

## History

QuadFlow's current architecture was built in a series of work packages, each sized for one agent
session and leaving the type checks and core tests green. All of them are complete; their record
is the progress log in [docs/ROADMAP.md](../ROADMAP.md) §9.
