# Data layer — `quadflow-core`

Status: **binding design**. Source of truth for the roadmap's "one data layer in Rust" decision
(`docs/ROADMAP.md` §1, §2). No backwards compatibility: fresh schemas, no migrations from the
current formats, existing `.quadflow/` folders and `quadflow.db` files are discarded. The one
exception is QuadFlow 1.x (§15): its project list can be imported, and a 1.x `.quadflow/` is moved
aside (never converted).

Implementers: read §0 (rules), then your work package in §13. Everything in a fenced block is
normative unless marked *illustrative*.

---

## 0. Rules (apply to every work package)

1. **Rust owns all data.** The GUI (Tauri commands), the CLI, and the plugin host call the same
   domain service functions in `quadflow-core`. No TS code reads or writes `.quadflow/` or SQLite
   directly. `src/lib/database.ts`, `src/lib/fileStore.ts`, `tauri-plugin-sql`,
   `@tauri-apps/plugin-sql`, `db_watcher.rs`, the `db_change_log` table are deleted.
2. **camelCase JSON everywhere** — on disk, over Tauri IPC, in CLI `--json` output. Every
   persisted/serialized struct has `#[serde(rename_all = "camelCase")]`. Enum *values* are
   `snake_case` strings (`"in_progress"`). No per-field `rename` exceptions.
3. **No silent data loss.** A file that fails to parse is reported, never skipped silently, and a
   read-modify-write never replaces a file it could not parse.
4. **Every write is atomic and every read-modify-write is locked** (§4).
5. **No implicit "active project" in the backend.** Every project-scoped call names its project
   root explicitly. The CLI discovers it by walking up from cwd (§3.2).
6. **No hardcoded product strings** in data: no `QC-`, no `"QuadFlow v{version}"` defaults, no
   `qwick`, no `src-tauri/quadcode-core` paths.
7. Timestamps are `i64` epoch **milliseconds** UTC everywhere (fixes the Codex ms-vs-s bug class).

---

## 1. Inventory and storage decision

Two stores:

- **Project store** — files under `<project>/.quadflow/`. Project content that a team would share
  through git. Some machine-local runtime state lives under `.quadflow/local/` (gitignored).
- **App store** — one SQLite DB in the app data dir. Machine/user state: projects registry,
  workspaces/layouts, tool configs, settings, plugin state, chat history.

| Entity (today) | Where today | Decision | New name / location |
|---|---|---|---|
| Working-dir project (`projects` table, database.ts:330) | SQLite | App | table `projects` (the **only** thing called "project") |
| Discovery project (`projects` table, database.ts:1087 / projects.rs:141 — **collides**) | SQLite (broken) | Project | domain **`discovery`**, `.quadflow/discovery/<id>.json`, struct `DiscoveryProject` |
| `project_items` | SQLite | Project | embedded `DiscoveryProject.items` |
| Workspace (`sessions` table) | SQLite | App | table `workspaces` |
| `terminals` (session terminals) | SQLite | App | table `workspace_terminals` |
| `tools` (tool configs) | SQLite | App | table `tool_configs` (references plugin contributions, see plugin-system.md §5) |
| `tool_instances`, `global_tool_instances` | SQLite | App | table `tile_instances` |
| `global_workspaces`, `global_workspace_frame` | SQLite | App | table `global_workspaces` + setting `shell.globalFrame` |
| `floating_windows`, `context_entries` | SQLite, unused | **Dropped** | floating state is part of `tile_instances.state` |
| Ideas (+ suggestions, notes) | FileStore (TS + Rust) | Project | `.quadflow/ideas/<id>.json` |
| Issues (+ comments, history) | FileStore, mixed case | Project | `.quadflow/issues/<id>.json` |
| Epics | FileStore | Project | `.quadflow/epics/<id>.json` |
| Labels | `labels.json` (two shapes) | Project | `.quadflow/labels.json` |
| Issue settings / project code / `next_issue_number` | `config.json` (two incompatible shapes) | Project | `.quadflow/config.json` (`ProjectConfig`) + `.quadflow/local/state.json` (counters) |
| Plans (+ steps, comments) | FileStore | Project | `.quadflow/plans/<id>.json` |
| Scripts, script groups | FileStore (`script-groups/` never created) | Project | `.quadflow/scripts/<id>.json`, `.quadflow/script-groups/<id>.json` |
| `script-settings.json` terminal environments | FileStore | App | table `terminal_environments` (machine-specific: vcvars paths) |
| Ship config | `.quadflow/ship/config.json` (snake_case) | Project | `.quadflow/ship/config.json` (camelCase) |
| Ship runs | `.quadflow/ship/runs/<version>.json` (overwritten by `deploy`) | Project-local | `.quadflow/local/ship/runs/<runId>.json` |
| Missions (+ members, messages, activities, proposals, merge queue) | SQLite (TS) **and** FileStore (Rust) | Project-local | `.quadflow/local/missions/<id>/` (§6.9) |
| Mission templates | SQLite, reseeded every start | Builtins = Rust consts; custom = Project | `.quadflow/mission-templates/<id>.json` |
| Agent definitions | SQLite, reseeded every start (deletes members!) | Builtins = Rust consts; custom = App | table `agent_definitions` |
| Chat settings / conversations / messages | separate `%LOCALAPPDATA%\QuadFlow\chat.db` | App | tables `chat_conversations`, `chat_messages`; settings namespace `chat`; API key in secrets (§7.4) |
| `stored_prompts` | SQLite | App | table `stored_prompts` |
| `checkpoints`, `github_repositories` | SQLite | Plugin-owned | GitHub plugin storage (plugin-system.md §6.6) |
| Teams (`teams`, `team_*`) | SQLite, dead | **Dropped** | (Team Dashboard decision lives in the Missions plugin) |
| `ide_reports`, license/support data | SQLite | **Dropped** | — |
| Legacy SQL `ideas`/`plans`/`issues`/`epics`/`scripts`/`issue_*` tables | SQLite, dead/shadowed | **Dropped** | — |
| `db_change_log` | SQLite | **Dropped** | replaced by event bus + watcher + `app_changes` (§8) |
| App settings (`appSettingsStore`, localStorage `quadflow-app-settings`) | localStorage | App | table `settings` (namespaced) |
| Model catalog cache (localStorage) | localStorage | App cache file | `<appData>/cache/models.json` (agent-providers.md §6) |
| Discord / OBS / YouTube / semantic / usage-monitor / native-embed / web-bookmark state | assorted DBs & JSON files | Plugin-owned | plugin KV / plugin data dir |
| Context-module enabled state (`.claude/quadflow-context/<m>.md` existence) | filesystem | Project | `ProjectConfig.agentContext.modules` |

---

## 2. Crate layout

The crate directory is renamed `src-tauri/quadcode-core/` → `src-tauri/quadflow-core/` (package
`quadflow-core`, lib `quadflow_core`). If wave-1 has not done this yet, DL-1 does it as its first
commit (`git mv` + path fixes in `src-tauri/Cargo.toml`).

```
src-tauri/quadflow-core/
  Cargo.toml
  src/
    lib.rs                  re-exports; no logic
    error.rs                CoreError, ErrorCode
    ids.rs                  Id newtype, new_id(), validate_id()
    time.rs                 now_ms()
    model.rs                Actor, ActorKind, Ext, ListResult<T>, CorruptEntry
    paths.rs                AppPaths, ProjectRoot, root_key(), find_project_root()
    core.rs                 Core facade (owns AppDb, ProjectRegistry, EventBus)
    store/
      mod.rs
      atomic.rs             atomic_write(), read_file()
      lock.rs               ProjectLock (cross-process advisory lock)
      project.rs            ProjectStore: collections, singletons, jsonl, transactions
      app_db.rs             AppDb (rusqlite), migrations runner
      migrations/0001_init.sql
    events/
      mod.rs                EventBus, ChangeEvent, Domain, ChangeKind, Origin
      watcher.rs            ProjectWatcher (notify + debouncer), self-write suppression
      app_changes.rs        app_changes cursor poller
    domains/
      project_config.rs     ProjectConfig, init/read/update
      ideas.rs
      issues/{mod.rs, model.rs, service.rs, labels.rs, epics.rs, refs.rs}
      plans.rs
      discovery.rs
      scripts.rs            scripts + script groups
      environments.rs       terminal environments (app DB) + detection
      ship/{mod.rs, model.rs, service.rs, exec.rs, templates.rs, versions.rs}
      chat/{mod.rs, model.rs, service.rs, client.rs, endpoint_discovery.rs}
      missions/{mod.rs, model.rs, service.rs, builtins.rs}
      app/{projects.rs, workspaces.rs, tool_configs.rs, settings.rs, prompts.rs,
           agent_definitions.rs, secrets.rs}
    context/{mod.rs, registry.rs, writer.rs}   agent context modules (agent-providers.md §7)
    plugins/...             see plugin-system.md §13
    agents/...              see agent-providers.md §4
    cli/
      mod.rs                clap root, run(), Io
      output.rs             JSON envelope, human tables, exit codes
      project.rs            init / doctor
      ideas.rs issues.rs plans.rs discovery.rs scripts.rs ship.rs chat.rs missions.rs
      context.rs docs.rs plugins.rs
  tests/
    common/mod.rs           TempProject, TempApp helpers
    concurrency.rs          cross-process test (§12.2)
    cli_contract.rs         CLI JSON snapshots (§12.3)
    fixtures/               exported JSON samples per type (consumed by TS contract test)
```

Deleted in the crate: `license.rs`, `legacy_mcp.rs`, `ideas.rs` placeholder, `database.rs`
(becomes `domains/ideas.rs`), `file_store.rs`, `path_utils.rs`, `config.rs` (→ `paths.rs`),
`projects.rs` (→ `domains/discovery.rs`), `ship.rs`/`ship_exec.rs` (→ `domains/ship/`),
`chat.rs`, `missions.rs`, `issues.rs`, `plans.rs`, `scripts.rs` (→ `domains/*`), `cli/*.rs` rewritten.

### 2.1 Dependencies (`quadflow-core/Cargo.toml`)

```toml
[package]
name = "quadflow-core"
edition = "2021"
rust-version = "1.89"          # std::fs::File::lock

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
serde_with = "3"               # double_option for patches
specta = { version = "=2.0.0-rc.25", features = ["derive", "serde_json"] }  # see §9, §14
rusqlite = { version = "0.32", features = ["bundled"] }
ulid = "1"
thiserror = "2"
tempfile = "3"                 # atomic writes (NamedTempFile::persist) — runtime dep, not dev
notify = "6"
notify-debouncer-full = "0.3"
dunce = "1"                    # canonicalize without \\?\ on Windows
dirs = "5"
clap = { version = "4", features = ["derive"] }
chrono = "0.4"                 # formatting only
regex = "1"
tracing = "0.1"
reqwest = { version = "0.12", default-features = false, features = ["blocking", "json", "rustls-tls"] }  # chat client, catalog
keyring = "3"                  # secrets (§7.4)
semver = "1"
zip = { version = "2", default-features = false, features = ["deflate"] }  # plugin archives
sha2 = "0.10"                  # plugin archive integrity
parking_lot = "0.12"

[dev-dependencies]
insta = { version = "1", features = ["json", "redactions"] }
```

`tokio` is **not** a core dependency. Core APIs are synchronous; the Tauri layer calls them via
`tauri::async_runtime::spawn_blocking`. (Exact `specta` pin: see §9.)

---

## 3. Paths, ids, project discovery

### 3.1 App paths

```rust
pub struct AppPaths {
    pub data_dir: PathBuf,     // <data>/quadflow   (see below)
    pub db_path: PathBuf,      // data_dir/quadflow.db   (quadflow-dev.db when QUADFLOW_DEV=1)
    pub cache_dir: PathBuf,    // data_dir/cache
    pub logs_dir: PathBuf,     // data_dir/logs
    pub plugins_dir: PathBuf,  // data_dir/plugins          (installed plugins)
    pub plugin_data_dir: PathBuf, // data_dir/plugin-data   (per-plugin private data)
}
impl AppPaths {
    pub fn resolve() -> Result<Self, CoreError>;   // honours QUADFLOW_DATA_DIR override
    pub fn under(root: &Path) -> Self;             // tests
}
```

`data_dir` = `QUADFLOW_DATA_DIR` if set, else `dirs::data_dir()/io.quadslab.quadflow` on all three
OSes (Windows: `%APPDATA%\io.quadslab.quadflow`; macOS: `~/Library/Application Support/io.quadslab.quadflow`;
Linux: `$XDG_DATA_HOME/io.quadslab.quadflow`). This matches the Tauri identifier so Tauri's own
`app_data_dir()` and core agree. No `~/.quadflow` anywhere.

### 3.2 Project root discovery

A directory is a QuadFlow project iff it contains `.quadflow/config.json`.

```rust
pub struct ProjectRoot { pub path: PathBuf /* canonical, dunce */, pub key: String }
pub fn root_key(path: &Path) -> String;
pub fn find_project_root(start: &Path) -> Option<ProjectRoot>;
```

- `root_key`: `dunce::canonicalize`, separators → `/`, strip trailing `/`, lowercase on
  Windows and macOS. Used for every path comparison (fixes `C:\Foo` vs `c:/foo/` duplicates) and as
  `projects.root_key UNIQUE`.
- `find_project_root(start)`: walk `start`, `start.parent()`, … to the filesystem root; first dir
  containing `.quadflow/config.json` wins.
- **CLI resolution order:** `--project <path>` global flag → `QUADFLOW_PROJECT_DIR` env (set by the
  GUI for every PTY it spawns) → `find_project_root(cwd)` → error `project_not_found`
  (exit 5) with hint `run "quadflow init" here or pass --project`. There is **no** SQLite fallback.
- **GUI:** every project-scoped command receives `projectRoot: string`; core resolves it with
  `ProjectRoot::open(path)` which requires `.quadflow/config.json` (else `project_not_found`).

### 3.3 Ids

```rust
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, specta::Type)]
#[serde(transparent)]
pub struct Id(String);        // lowercase ULID, 26 chars Crockford base32
pub fn new_id() -> Id;        // ulid::Ulid::new().to_string().to_lowercase()
impl Id { pub fn parse(s: &str) -> Result<Id, CoreError>; }   // ^[0-9a-hjkmnp-tv-z]{26}$
```

- All entities and sub-entities (comments, steps, criteria, items, members, messages) use `Id`.
- ULIDs sort by creation time — used for message read cursors (§6.9) and stable list order.
- **Every id that reaches a filesystem path goes through `Id::parse`** (no path traversal). Plugin
  ids and file names that are not ULIDs use `validate_segment()`:
  `^[a-z0-9][a-z0-9._-]{0,63}$` and not `.`/`..`.
- TS sees `Id` as `string`.

### 3.4 Issue display references

- `ProjectConfig.code`: `^[A-Z][A-Z0-9]{1,7}$`. Set at `quadflow init` from the folder name
  (alphanumerics, uppercased, first 3 chars; if fewer than 2 alnum chars → `"PRJ"`). Editable.
- Display ref = `format!("{code}-{number}")`. Everywhere (CLI human output, GUI, terminal titles)
  formats via `issues::display_ref(&config, &issue)`; nothing else builds the string.
- `issues::refs::resolve(store, input)` accepts: an `Id`; `CODE-n` where CODE matches the project
  code case-insensitively; `#n`; `n`. A different prefix is `not_found` (no more ignoring prefixes).

---

## 4. Storage engine

### 4.1 Atomic write — `store/atomic.rs`

```rust
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), CoreError>;
pub fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), CoreError>;
```

Algorithm:
1. `dir = path.parent()`; `create_dir_all(dir)`.
2. `tmp = tempfile::Builder::new().prefix(".").suffix(".tmp").tempfile_in(dir)` — unique name
   `.<random>.tmp` in the **same directory** (same volume ⇒ rename is atomic).
3. Write bytes (JSON: `serde_json::to_writer_pretty` + trailing `\n`), `tmp.as_file().sync_all()`.
4. `tmp.persist(path)` (Windows: `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`; Unix: `rename(2)`).
   On Windows, if persist fails with `ERROR_ACCESS_DENIED` (5), `ERROR_SHARING_VIOLATION` (32) or
   `ERROR_LOCK_VIOLATION` (33) — typically antivirus, the search indexer, or a reader holding the
   file open — retry with the returned temp file: delays 2, 4, 8, 16, 32, 64, 128, 256 ms (8
   retries, ~510 ms total). After the last failure delete the temp file and return
   `CoreError::Io` naming the path. **Never** remove the target first (current `ship.rs`/`context.rs`
   do; that is a data-loss window).
5. Unix only: open `dir` and `sync_all()` it (durable rename).

Readers: `std::fs::read` then `serde_json::from_slice`. Readers never see a partial file because
writers only rename complete files. On Windows a reader can briefly block a rename; step 4's retry
covers that. Readers retry an open that fails with sharing violation twice (10 ms, 50 ms).

Directory listing ignores names starting with `.` (temp files, `.lock`, `.gitignore`).

### 4.2 Locking — `store/lock.rs`

One advisory lock per project: `<root>/.quadflow/.lock` (empty file, gitignored), using **std
`File::lock` / `File::try_lock`** (stable since Rust 1.89; `LockFileEx` on Windows, `flock` on
Unix). No `fs2`/`fd-lock` dependency.

```rust
pub struct ProjectLock { file: File }        // released on Drop (File::unlock + close)
impl ProjectLock {
    /// Exclusive. Polls try_lock(): 1ms, doubling, capped at 50ms, until `timeout` (default 10s).
    pub fn acquire(root: &ProjectRoot, timeout: Duration) -> Result<ProjectLock, CoreError>; // LockTimeout
}
```

- **Writes take the lock; reads do not.** Atomic rename makes lock-free reads safe.
- The lock covers *every* mutation in the project, including cross-entity operations (close issue
  → cascade unblock; issue status → plan step sync; promote step → create issue + update plan) and
  counter allocation. Operations are milliseconds; one project-wide lock is simpler than per-file
  locks and has no deadlock potential.
- In-process: `ProjectStore` also holds a `parking_lot::Mutex<()>` taken before the file lock, so
  GUI threads queue instead of polling. The transaction closure is **not re-entrant**: domain
  services never call another public service function from inside `write()`; they call internal
  `*_in_tx` helpers that take `&mut Tx`.
- Lock timeout → `CoreError { code: LockTimeout }` → CLI exit 4.

### 4.3 Project store API — `store/project.rs`

```rust
pub struct ProjectStore { root: ProjectRoot, inner: Mutex<()>, bus: EventBus, recent: RecentWrites }

impl ProjectStore {
    pub fn open(root: ProjectRoot, bus: EventBus) -> Result<Self, CoreError>; // requires config.json
    pub fn init(path: &Path, opts: InitOptions, bus: EventBus) -> Result<Self, CoreError>;

    // ---- reads (lock-free)
    pub fn get<T: Entity>(&self, id: &Id) -> Result<T, CoreError>;            // NotFound | Corrupt
    pub fn list<T: Entity>(&self) -> Result<ListResult<T>, CoreError>;        // never skips silently
    pub fn read_singleton<T: Singleton>(&self) -> Result<T, CoreError>;       // missing → T::default()
    pub fn read_jsonl<T: DeserializeOwned>(&self, rel: &RelPath) -> Result<ListResult<T>, CoreError>;

    // ---- writes (locked transaction)
    pub fn write<R>(&self, actor: &Actor, f: impl FnOnce(&mut Tx) -> Result<R, CoreError>)
        -> Result<R, CoreError>;
}

pub struct Tx<'a> { /* holds ProjectLock; buffers ChangeEvents */ }
impl Tx<'_> {
    pub fn get<T: Entity>(&self, id: &Id) -> Result<T, CoreError>;
    pub fn list<T: Entity>(&self) -> Result<ListResult<T>, CoreError>;
    pub fn put<T: Entity>(&mut self, entity: &T) -> Result<(), CoreError>;     // create or replace
    pub fn delete<T: Entity>(&mut self, id: &Id) -> Result<(), CoreError>;
    pub fn update_singleton<T: Singleton>(&mut self, f: impl FnOnce(&mut T)) -> Result<T, CoreError>;
    pub fn append_jsonl<T: Serialize>(&mut self, rel: &RelPath, line: &T) -> Result<(), CoreError>;
    pub fn next_counter(&mut self, name: &str) -> Result<u64, CoreError>;     // §4.4
}

pub trait Entity: Serialize + DeserializeOwned + specta::Type {
    const DOMAIN: Domain;          // events
    const DIR: &'static str;       // "issues"
    fn id(&self) -> &Id;
}
pub trait Singleton: Serialize + DeserializeOwned + Default {
    const DOMAIN: Domain;
    const FILE: &'static str;      // "labels.json", "config.json", "local/state.json"
}
```

- `write()` commits by: run closure → on `Ok`, the writes already happened file-by-file with
  `atomic_write` (each file atomic; a multi-file op that fails midway leaves earlier files written —
  acceptable because every multi-file op is ordered so partial completion is a valid state, e.g.
  create issue before linking it from the plan step) → release lock → publish buffered events.
  On `Err`, publish nothing.
- `update_singleton` on a **corrupt** file returns `CoreError::Corrupt` and leaves the file
  untouched (never resets to default). Missing file → `Default`.
- `put` sets nothing implicitly; services set `updatedAt`.
- `ListResult<T> { items: Vec<T>, errors: Vec<CorruptEntry> }`,
  `CorruptEntry { path: String, message: String }`. Lists are sorted by `Id` (creation order)
  unless the service sorts otherwise.
- Every `put`/`delete`/`append` records `(path, len, mtime)` in `RecentWrites` (2 s TTL) for
  watcher self-suppression (§8.2).

### 4.4 Counters and display numbers

`.quadflow/local/state.json`:

```rust
#[derive(Default, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
pub struct LocalState { pub counters: BTreeMap<String, u64> }   // e.g. {"issue": 42}
```

`Tx::next_counter("issue")` (under the project lock):
`n = max(counters["issue"], max(number of every issue file, including unparseable ones whose
"number" field can be read leniently)) + 1`; store `counters["issue"] = n`; return `n`.
Taking the max with existing files keeps numbers monotonic after a `git pull` brings in issues
created elsewhere. Two clones creating issues concurrently can still produce the same number;
`quadflow doctor` reports duplicate numbers and `quadflow doctor --fix` renumbers the newer ones
(by id order) — this is the only renumbering path.

### 4.5 `.quadflow/` layout

```
.quadflow/
  config.json                 ProjectConfig (shared)
  .gitignore                  written by init: "local/\n.lock\n.*.tmp\n"
  .lock
  ideas/<id>.json
  issues/<id>.json
  epics/<id>.json
  labels.json
  plans/<id>.json
  discovery/<id>.json
  scripts/<id>.json
  script-groups/<id>.json
  ship/config.json
  mission-templates/<id>.json
  plugins/<pluginId>/...      project-scoped plugin data, shared (plugin-system.md §6.6)
  local/
    state.json                LocalState
    ship/runs/<id>.json
    missions/<id>/mission.json
    missions/<id>/messages.jsonl
    missions/<id>/activity.jsonl
    missions/<id>/reads.json
    plugins/<pluginId>/...    project-scoped plugin data, machine-local
```

`ProjectStore::init` creates `config.json`, `.gitignore`, `local/`. Collection dirs are created
lazily by the first `put` (so a missing dir is "empty", never an error — fixes `script-groups/`).

### 4.6 App DB — `store/app_db.rs`

```rust
pub struct AppDb { conn: parking_lot::Mutex<rusqlite::Connection>, bus: EventBus }
impl AppDb {
    pub fn open(paths: &AppPaths, bus: EventBus) -> Result<Self, CoreError>;
    pub fn read<R>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<R>) -> Result<R, CoreError>;
    pub fn write<R>(&self, changes: &[AppChange], f: impl FnOnce(&Transaction) -> rusqlite::Result<R>)
        -> Result<R, CoreError>;   // BEGIN IMMEDIATE; f; INSERT app_changes rows; COMMIT; publish events
}
```

Connection setup, every open (GUI and CLI):

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

Migrations: `const MIGRATIONS: &[&str] = &[include_str!("migrations/0001_init.sql")];` applied in
order inside one transaction each, tracked by `PRAGMA user_version`. A DB whose `user_version` is
greater than `MIGRATIONS.len()` → `CoreError::Incompatible` ("created by a newer QuadFlow").
Pre-release we do **not** write a migration for format changes — edit `0001_init.sql` and delete
your dev DB. After the first public release, schema changes append `0002_*.sql`, etc.

Full schema in §7.

---

## 5. Common model types — `model.rs`

```rust
pub type Timestamp = i64;                       // epoch ms UTC

#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Actor {
    pub kind: ActorKind,
    pub name: String,                           // "David", "claude-code agent", "issues" (plugin id)
    #[serde(default, skip_serializing_if = "Option::is_none")] pub plugin_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub session_id: Option<String>,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, specta::Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActorKind { Human, Agent, Plugin, System }

/// Plugin-owned extension data on any entity, keyed by plugin id. Core never interprets it.
pub type Ext = BTreeMap<String, serde_json::Value>;
```

Actor sources: GUI → `Human` with the OS user name (setting `user.displayName` overrides); CLI →
`QUADFLOW_ACTOR_KIND`/`QUADFLOW_ACTOR_NAME`/`QUADFLOW_PROVIDER_ID`/`QUADFLOW_SESSION_ID` env vars
(the GUI exports these into agent PTYs), default `{kind: agent, name: "cli"}`; plugin host →
`Plugin` with `pluginId`.

Serde conventions for every persisted struct:
- `#[serde(rename_all = "camelCase")]` on structs, `#[serde(rename_all = "snake_case")]` on enums.
- `Option<T>` fields: `#[serde(default, skip_serializing_if = "Option::is_none")]`.
- `Vec`/`BTreeMap` fields: `#[serde(default, skip_serializing_if = "…::is_empty")]`.
- `bool` fields: `#[serde(default)]`.
- Unknown fields are ignored on read (forward-compatible), never `deny_unknown_fields`.
- Map types are `BTreeMap` (deterministic output → clean git diffs).

Patch inputs use `serde_with::rust::double_option` for clearable fields:
`Option<Option<T>>` — absent = unchanged, `null` = clear, value = set. specta export:
`#[specta(optional)] field: Option<Option<T>>` → TS `field?: T | null`.

---

## 6. Project-store schemas

All structs below derive `Clone, Debug, Serialize, Deserialize, specta::Type` and carry the serde
conventions of §5 (omitted for brevity). `Audit` fields appear on every top-level entity:

```rust
pub created_at: Timestamp,
pub created_by: Actor,
pub updated_at: Timestamp,
#[serde(default, skip_serializing_if = "BTreeMap::is_empty")] pub ext: Ext,
```

### 6.1 `ProjectConfig` — `.quadflow/config.json`

```rust
pub struct ProjectConfig {
    pub format_version: u32,                 // = 1. Higher → CoreError::Incompatible
    pub name: String,                        // display name, default = folder name
    pub code: String,                        // ^[A-Z][A-Z0-9]{1,7}$
    pub agent_context: AgentContextConfig,
    pub recommended_plugins: Vec<String>,    // plugin ids suggested to collaborators
    pub plugins: BTreeMap<String, serde_json::Value>, // per-plugin shared project settings
}
pub struct AgentContextConfig {
    pub modules: Vec<String>,                // enabled context module ids, e.g. ["issues","plans"]
    pub files: Vec<String>,                  // context files to manage, e.g. ["CLAUDE.md","AGENTS.md"]
}
```

This is the **only** `config.json` shape. API (`domains/project_config.rs`):
`read(store) -> ProjectConfig`, `update(store, actor, ProjectConfigPatch) -> ProjectConfig`,
`init(path, InitOptions{name?, code?}) -> ProjectStore`.

### 6.2 Ideas — `ideas/<id>.json`

```rust
pub struct Idea {
    pub id: Id,
    pub content: String,
    pub original_content: String,
    pub tags: Vec<String>,                   // lowercase, unique, sorted
    pub archived: bool,
    pub discovery_id: Option<Id>,
    pub suggestions: Vec<IdeaSuggestion>,
    pub notes: Vec<IdeaNote>,
    /* Audit */
}
pub struct IdeaSuggestion { pub id: Id, pub kind: SuggestionKind, pub text: String,
                            pub accepted: Option<bool>, pub created_at: Timestamp, pub created_by: Actor }
pub enum SuggestionKind { Reword, Expand, Clarify, Summarize }
pub struct IdeaNote { pub id: Id, pub body: String, pub created_at: Timestamp, pub created_by: Actor }
```

Service (`domains/ideas.rs`):

```rust
pub fn list(s: &ProjectStore, q: &IdeaQuery) -> Result<ListResult<Idea>>;
// IdeaQuery { text: Option<String>, tags: Vec<String>, include_archived: bool,
//             from: Option<Timestamp>, to: Option<Timestamp>, discovery_id: Option<Id> }
pub fn get(s, id) -> Result<Idea>;
pub fn create(s, actor, NewIdea { content, tags, discovery_id }) -> Result<Idea>;
pub fn update(s, actor, id, IdeaPatch { content?, tags?, archived?, discovery_id?? }) -> Result<Idea>;
pub fn delete(s, actor, id) -> Result<()>;
pub fn add_tag / remove_tag(s, actor, id, tag) -> Result<Idea>;
pub fn bulk_tag(s, actor, ids: &[Id], tag) -> Result<Vec<Idea>>;
pub fn merge(s, actor, ids: &[Id], keep: &Id) -> Result<Idea>;   // concatenates content, unions tags/notes, deletes others
pub fn add_note(s, actor, id, body) -> Result<Idea>;  pub fn delete_note(s, actor, id, note_id) -> Result<Idea>;
pub fn add_suggestion(s, actor, id, kind, text) -> Result<Idea>;
pub fn resolve_suggestion(s, actor, id, suggestion_id, accept: bool) -> Result<Idea>; // accept → content = text
pub fn revert(s, actor, id) -> Result<Idea>;          // content = original_content
pub fn stats(s) -> Result<IdeaStats>;                 // { total, active, archived, byTag: BTreeMap<String,u32> }
pub fn export(s, format: ExportFormat /* json|markdown|csv */) -> Result<String>;
```

### 6.3 Issues — `issues/<id>.json`, `epics/<id>.json`, `labels.json`

`state` is removed: an issue is closed iff `status == Done`. (Removes the open/closed vs status
inconsistency; `issues close` means `status = done`.)

```rust
pub struct Issue {
    pub id: Id,
    pub number: u64,                         // display number (§4.4); immutable
    pub title: String,
    pub body: Option<String>,
    pub status: IssueStatus,
    pub priority: Priority,
    pub labels: Vec<String>,                 // label names (labels.json), sorted
    pub epic_id: Option<Id>,
    pub parent_id: Option<Id>,
    pub blocked_by: Vec<Id>,
    pub depends_on: Vec<Id>,
    pub user_story: Option<String>,
    pub acceptance_criteria: Vec<Criterion>,
    pub source: Option<IssueSource>,
    pub mission_id: Option<Id>,
    pub assignment: Option<Assignment>,
    pub comments: Vec<IssueComment>,
    pub history: Vec<StatusChange>,
    /* Audit */
}
pub enum IssueStatus { Backlog, Todo, InProgress, Qa, Done, Blocked, NeedsHuman }
pub enum Priority { Low, Medium, High, Critical }
pub struct Criterion { pub id: Id, pub text: String, pub checked: bool }
pub struct IssueSource { pub idea_id: Option<Id>, pub plan_id: Option<Id>, pub step_id: Option<Id> }
pub struct Assignment {
    pub agent_label: String,
    pub terminal_id: Option<String>,
    pub provider_id: Option<String>,
    pub session_id: Option<String>,          // validated ^[A-Za-z0-9._:-]{1,128}$ (used in resume argv)
    pub assigned_at: Timestamp,
    pub last_heartbeat: Timestamp,
}
pub struct IssueComment { pub id: Id, pub body: String, pub created_at: Timestamp, pub created_by: Actor }
pub struct StatusChange { pub from: Option<IssueStatus>, pub to: IssueStatus, pub at: Timestamp, pub by: Actor }

pub struct Epic { pub id: Id, pub title: String, pub description: Option<String>,
                  pub status: EpicStatus, pub priority: Priority, pub labels: Vec<String>, /* Audit */ }
pub enum EpicStatus { Open, InProgress, Done }

pub struct Labels { pub labels: Vec<Label> }          // Singleton, FILE = "labels.json"
pub struct Label { pub name: String, pub color: String /* #rrggbb */, pub description: Option<String> }
```

Parsing rules: CLI/commands accept status aliases (`in-progress`, `review`→`qa`, …) **only** in
the CLI argument parser (`cli/issues.rs`), mapping to the enum; invalid values are rejected with
exit 2. On disk only canonical values exist.

Service (`domains/issues/service.rs`):

```rust
pub fn list(s, q: &IssueQuery) -> Result<ListResult<Issue>>;
// IssueQuery { statuses: Vec<IssueStatus>, priorities: Vec<Priority>, labels: Vec<String>,
//   epic_id: Option<Id>, parent_id: Option<Id>, mission_id: Option<Id>, text: Option<String>,
//   include_done: bool, limit: Option<u32> }   sorted by priority desc, number asc
pub fn get(s, r: &str) -> Result<Issue>;                       // r = id | CODE-n | #n | n
pub fn create(s, actor, NewIssue) -> Result<Issue>;            // allocates number
pub fn update(s, actor, r, IssuePatch) -> Result<Issue>;       // status change → set_status_in_tx
pub fn set_status(s, actor, r, IssueStatus) -> Result<Issue>;
pub fn close(s, actor, r) -> Result<Issue>;                    // = set_status(Done)
pub fn reopen(s, actor, r) -> Result<Issue>;                   // = set_status(Todo)
pub fn delete(s, actor, r) -> Result<()>;                      // removes id from others' blockedBy/dependsOn/parentId
pub fn add_comment(s, actor, r, body) -> Result<Issue>;  pub fn delete_comment(s, actor, r, comment_id) -> Result<Issue>;
pub fn toggle_criterion(s, actor, r, criterion_id) -> Result<Issue>;
pub fn claim(s, actor, r, Assignment) -> Result<Issue>;        // fails Conflict if assigned & heartbeat < 10 min old
pub fn heartbeat(s, actor, r) -> Result<Issue>;
pub fn release(s, actor, r) -> Result<Issue>;
pub fn children(s, r) -> Result<Vec<Issue>>;
pub fn blocking(s, r) -> Result<Vec<Issue>>;
pub fn display_ref(config: &ProjectConfig, issue: &Issue) -> String;

// labels.rs
pub fn labels_list(s) -> Result<Vec<Label>>;
pub fn label_upsert(s, actor, Label) -> Result<Vec<Label>>;
pub fn label_delete(s, actor, name) -> Result<Vec<Label>>;    // also strips from issues/epics
// epics.rs
pub fn epics_list / epic_get / epic_create / epic_update / epic_delete (unlinks issues)
```

`set_status_in_tx` invariants (one locked transaction):
1. Append `StatusChange`; set `updatedAt`.
2. If new status is `Done`: for every issue whose `blockedBy` contains this id, remove it; if that
   issue's `blockedBy` becomes empty and its status is `Blocked`, set it to `Todo`
   (cascade unblock — today never runs on close).
3. If `source.stepId` is set: update the plan step status (`Done`→`completed`,
   `InProgress|Qa`→`in_progress`, else `pending`) and run plan auto-transition (§6.4).
4. If `missionId` is set: append a `status_changed` activity line to the mission (§6.9).

### 6.4 Plans — `plans/<id>.json`

```rust
pub struct Plan {
    pub id: Id,
    pub title: String,
    pub description: Option<String>,
    pub status: PlanStatus,
    pub idea_id: Option<Id>,
    pub discovery_id: Option<Id>,
    pub spec: Option<PlanSpec>,
    pub decisions: Vec<Decision>,
    pub risk_notes: Option<String>,
    pub context: Option<String>,
    pub promotion_profile: Option<PromotionProfile>,
    pub steps: Vec<PlanStep>,
    pub comments: Vec<PlanComment>,
    /* Audit */
}
pub enum PlanStatus { SpecDraft, SpecReview, Decomposing, ReviewSteps, Promoting, Executing, Completed }
pub struct PlanSpec { pub content: String, pub kind: SpecKind }
pub enum SpecKind { Greenfield, Feature, Refactor }
pub struct Decision { pub decision: String, pub rationale: String }
pub struct PromotionProfile {
    pub create_epics: bool, pub label_strategy: LabelStrategy /* auto|none|custom */,
    pub custom_labels: Vec<String>, pub label_prefix: Option<String>, pub create_blockers: bool,
    pub default_priority: Priority, pub priority_strategy: PriorityStrategy /* uniform|auto */,
    pub include_acceptance_criteria: bool, pub include_verification: bool,
}
pub struct PlanStep {
    pub id: Id,
    pub order: u32,
    pub parent_id: Option<Id>,
    pub title: String,
    pub description: Option<String>,
    pub status: StepStatus,                  // pending|in_progress|completed|skipped
    pub kind: Option<StepKind>,              // research|design|implement|test|verify|document
    pub notes: Option<String>,
    pub acceptance_criteria: Vec<String>,
    pub target_files: Vec<String>,
    pub code_context: Option<String>,
    pub effort: Option<Effort>,              // low|medium|high
    pub estimated_hours: Option<f64>,
    pub actual_hours: Option<f64>,
    pub depends_on: Vec<Id>,                 // step ids
    pub verification: Option<Verification>,  // { method: String, pattern: Option<String>, command: Option<String> }
    pub issue_id: Option<Id>,                // promoted issue
    pub started_at: Option<Timestamp>,
    pub completed_at: Option<Timestamp>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}
pub struct PlanComment { pub id: Id, pub body: String, pub kind: CommentKind /* general|review|verification */,
                         pub created_at: Timestamp, pub created_by: Actor }
```

Service: `list, get, create, update, delete, step_add, step_update, step_delete, steps_reorder
(ids in order), comment_add, comment_delete, promote_step(s, actor, plan_id, step_id) -> Issue,
promote_all(s, actor, plan_id) -> Vec<Issue>`. Promotion creates issues with
`source = {planId, stepId}`, maps step `depends_on` → issue `blocked_by` when
`createBlockers`, writes `issue_id` back to the step, and is idempotent (an already-promoted step
returns its issue). Auto-transition: when all non-skipped steps are `completed` →
`Completed`; when any step is `in_progress` and status is `ReviewSteps|Promoting` → `Executing`.
Patch fields are clearable (`description: null` clears — fixes today's "can't clear").

### 6.5 Discovery — `discovery/<id>.json`

```rust
pub struct DiscoveryProject {
    pub id: Id,
    pub title: String,
    pub overview: Option<String>,
    pub goals: Vec<String>,
    pub success_criteria: Vec<String>,
    pub status: DiscoveryStatus,             // discovery|planning|in_progress|completed|archived
    pub items: Vec<DiscoveryItem>,
    /* Audit */
}
pub struct DiscoveryItem {
    pub id: Id, pub kind: DiscoveryItemKind, // research|requirement|question|reference|decision|note
    pub title: String, pub content: Option<String>, pub status: Option<String>,
    pub metadata: Option<serde_json::Value>, pub order: u32,
    pub created_at: Timestamp, pub updated_at: Timestamp,
}
```

Service: `list, get, create, update, delete (clears discoveryId on ideas/plans), item_add,
item_update, item_delete, items_reorder, linked(s, id) -> { ideas: Vec<Idea>, plans: Vec<Plan> }`.
Linking is done by setting `discoveryId` on the idea/plan (`ideas::update`, `plans::update`).
UI label for this domain may still be "Projects"; code, CLI (`quadflow discovery …`) and storage
never use the word "project" for it.

### 6.6 Scripts — `scripts/<id>.json`, `script-groups/<id>.json`

```rust
pub struct Script {
    pub id: Id,
    pub name: String,
    pub description: Option<String>,
    pub command: String,
    pub setup_commands: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub platforms: Vec<Platform>,            // windows|macos|linux; empty = all
    pub shell: Option<ShellKind>,            // cmd|powershell|pwsh|bash|zsh|sh ; None = environment/default
    pub working_directory: Option<String>,   // relative to project root; validated no ".." escape
    pub environment: Option<String>,         // terminal environment NAME (machine-resolved, §7)
    pub kind: ScriptKind,                    // command|server|build
    pub preview_url: Option<String>,
    pub auto_open_preview: bool,
    pub tags: Vec<String>,
    pub pinned: bool,
    pub archived: bool,
    /* Audit */
}
pub struct ScriptGroup {
    pub id: Id, pub name: String, pub description: Option<String>,
    pub members: Vec<GroupMember>, pub mode: GroupMode, /* parallel|sequential */ /* Audit */
}
pub struct GroupMember { pub script_id: Id, pub order: u32, pub delay_ms: u32, pub auto_open_preview: bool }
```

Service: `list(ScriptQuery{text, tag, pinned, include_archived, platform}), get, create, update,
delete (removes from groups), groups_list, group_get, group_create, group_update, group_delete,
group_add_member, group_remove_member, resolve_command(s, id, platform) -> ResolvedCommand
{ shell, environment: Option<TerminalEnvironment>, cwd: PathBuf, setup: Vec<String>, command: String, env }`.

### 6.7 Ship — `ship/config.json`, `local/ship/runs/<id>.json`

`domains/ship/` keeps today's typed pipeline (phase handlers in `exec.rs`, templates in
`templates.rs`, version file editors in `versions.rs`) with these mandatory changes:

- All structs camelCase; `ShipPhase` stays `#[serde(tag = "type", rename_all = "snake_case")]`
  for the tag value and `rename_all_fields = "camelCase"` for variant fields.
- `ShipConfig { formatVersion: 1, versionFiles: Vec<VersionFile{path, kind: json|toml, key}>,
  phases: Vec<ShipPhase>, changelog: ChangelogConfig{source: git_log, since: last_tag},
  productName: String }`. Defaults that mention a product use `{productName}` substitution
  (e.g. gh_release `title` default `"{productName} v{version}"`). `sign_authenticode.tool` has **no
  default** (was `qwick sign --verify`) — validation error if missing.
- `ShipRun.id` is a fresh `Id` (runs never overwrite each other); `ShipRun.version` is a field.
  `get_run_by_version` returns the newest run for that version.
- No path constants referring to this repo (`src-tauri/quadcode-core/Cargo.toml` at
  ship.rs:1714/3067) — templates take paths from detection.
- `detect_project_kind` returning unknown is an error (`CoreError::Unsupported`), never a
  `echo TODO build command` phase.
- Streaming: `run(s, actor, RunOpts, sink: &dyn ShipSink)` where
  `trait ShipSink { fn phase(&self, ShipPhaseEvent); fn line(&self, ShipLineEvent); fn external(&self, ExternalRequest) -> ExternalOutcome; }`.
  The Tauri layer implements it with a `tauri::ipc::Channel`; the CLI prints.
- `--json` failures exit non-zero (§11).
- `ship run --config <file>` / `ship config validate --file <file>` use a config file instead of
  `ship/config.json` (`run_with_config`; records still go to the project). QuadFlow's own release
  config is tracked at `scripts/release/ship.config.json` (docs/RELEASING.md). `gh_release.notesFile`
  → `--notes-file`; `build_latest_json` reads the existing manifest with `gh release download`
  first (drafts, private repos), then the public URL. `quadflow-core` has a `quadflow-cli` bin (the
  CLI without the GUI) for repo tooling.

### 6.8 Mission templates — `mission-templates/<id>.json`

```rust
pub struct MissionTemplate {
    pub id: Id, pub name: String, pub description: Option<String>,
    pub category: TemplateCategory,          // build|quality|ops|planning|general
    pub workflow_phases: Vec<String>, pub skills_used: Vec<String>, pub success_criteria: Vec<String>,
    pub orchestrator_prompt_extra: Option<String>, pub member_prompt_extra: Option<String>,
    pub built_in: bool, /* Audit */
}
```

Built-in templates are `const`/`fn builtin_templates() -> Vec<MissionTemplate>` in
`missions/builtins.rs` with stable ids `builtin-feature-build`, … (non-ULID ids allowed for
builtins only; `Id::builtin("feature-build")`). They are **merged at read time**, never written.

### 6.9 Missions — `local/missions/<id>/`

```rust
// mission.json
pub struct Mission {
    pub id: Id, pub name: String, pub status: MissionStatus, // preparing|active|paused|completed|cancelled
    pub orchestrator_mode: OrchestratorMode,                 // manual|on_demand|persistent
    pub orchestrator_member_id: Option<Id>,
    pub plan_id: Option<Id>, pub template_id: Option<Id>,
    pub config: MissionConfig,
    pub members: Vec<MissionMember>,
    pub proposals: Vec<MissionProposal>,
    pub merge_queue: Vec<MergeQueueEntry>,
    pub started_at: Option<Timestamp>, pub completed_at: Option<Timestamp>,
    /* Audit */
}
pub struct MissionConfig { pub workflow_phases: Vec<String>, pub skills_used: Vec<String>,
    pub success_criteria: Vec<String>, pub orchestrator_prompt_extra: Option<String>,
    pub member_prompt_extra: Option<String> }        // real arrays, not JSON strings
pub struct MissionMember {
    pub id: Id, pub agent_definition_id: String, pub name: String, pub role: AgentRole,
    pub provider_id: String, pub model: Option<String>,      // model validated (agent-providers.md §6.3)
    pub status: MemberStatus,                                 // pending|spawning|idle|working|stopped|error
    pub terminal_id: Option<String>, pub session_id: Option<String>,
    pub assigned_issue_id: Option<Id>, pub system_prompt: Option<String>,
    pub worktree_path: Option<String>, pub branch_name: Option<String>,
    pub last_heartbeat: Option<Timestamp>, pub error: Option<String>,
    pub created_at: Timestamp, pub updated_at: Timestamp,
}
pub struct MissionProposal { pub id: Id, pub goal: String, pub agents: Vec<ProposedAgent>,
    pub estimated_cost_usd: Option<f64>, pub estimated_minutes: Option<u32>, pub rationale: Option<String>,
    pub status: ProposalStatus /* pending|approved|rejected|modified */, pub created_at: Timestamp, pub updated_at: Timestamp }
pub struct ProposedAgent { pub agent_definition_id: String, pub name: String, pub role: AgentRole,
    pub provider_id: String, pub model: Option<String>, pub focus: Option<String> }
pub struct MergeQueueEntry { pub id: Id, pub member_id: Id, pub branch_name: String, pub worktree_path: String,
    pub issue_id: Option<Id>, pub status: MergeStatus /* queued|merging|merged|skipped|failed */,
    pub position: u32, pub priority: Priority, pub skip_reason: Option<String>,
    pub created_at: Timestamp, pub merged_at: Option<Timestamp> }

// messages.jsonl — one MissionMessage per line, append-only
pub struct MissionMessage { pub id: Id, pub from_member_id: Option<Id> /* None = human */, pub from_name: String,
    pub to_member_id: Option<Id> /* None = broadcast */, pub kind: MessageKind, pub content: String,
    pub issue_id: Option<Id>, pub created_at: Timestamp }
pub enum MessageKind { Chat, Status, Finding, Blocker, Completion, Assignment, HelpRequest, Review, Question, Answer, Decision, Handoff }

// activity.jsonl — one MissionActivity per line, append-only
pub struct MissionActivity { pub id: Id, pub kind: ActivityKind, pub member_id: Option<Id>,
    pub member_name: Option<String>, pub issue_id: Option<Id>, pub detail: Option<String>,
    pub metadata: Option<serde_json::Value>, pub created_at: Timestamp }
pub enum ActivityKind { MissionStarted, MissionPaused, MissionCompleted, MemberJoined, MemberLeft,
    IssueClaimed, StatusChanged, MessageSent, MergeQueued, MergeCompleted, Error }

// reads.json — Singleton-like file in the mission dir: last-read message id per member
pub struct MissionReads { pub last_read: BTreeMap<String /* member id | "human" */, Id> }
```

`AgentRole` (13 values): `scrum_master, tech_lead, product_owner, frontend, backend, fullstack,
devops, database, qa, security, docs, research, custom`.

Service (`domains/missions/service.rs`): `list(status?), get, create(NewMission{name, plan_id?,
template_id?, orchestrator_mode, config?}), update, delete, progress(id) -> MissionProgress`
(computed from issues with `missionId`: `{total, byStatus: BTreeMap<IssueStatus,u32>, activeMembers,
totalMembers}`), `member_add, member_update, member_remove, member_heartbeat, messages(id,
MessageQuery{since: Option<Id>, to_member: Option<Id>, limit}), send_message, mark_read(id,
reader, up_to: Id), unread_count(id, reader), activity(id, since, limit), log_activity,
proposal_create, proposal_update_status, proposal_modify, merge_enqueue, merge_queue,
merge_next, merge_update, assign_issues(id, issue_ids)` (sets `missionId`; the real
implementation of today's no-op `inject_mission_work`), `claim_next_issue(id, member_id) ->
Option<Issue>` (real: highest-priority `Todo` issue in the mission with empty `blockedBy` and no
live assignment; claims it in the same transaction).

---

## 7. App DB schema — `store/migrations/0001_init.sql`

```sql
CREATE TABLE projects (
  id              TEXT PRIMARY KEY,               -- ULID
  name            TEXT NOT NULL,
  root            TEXT NOT NULL,                  -- canonical path as displayed
  root_key        TEXT NOT NULL UNIQUE,           -- paths::root_key()
  default_workspace_template TEXT,                -- JSON DefaultWorkspaceTemplate | NULL
  last_opened_at  INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
-- Active project = setting ('shell','activeProjectId'). No is_active column.

CREATE TABLE workspaces (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  layout_tree   TEXT,                             -- JSON MosaicNode<string> | NULL
  pinned        INTEGER NOT NULL DEFAULT 0,
  pin_order     INTEGER,
  pin_section   TEXT NOT NULL DEFAULT 'right',    -- left|center|right
  sort_order    INTEGER NOT NULL DEFAULT 0,
  last_active_at INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_workspaces_project ON workspaces(project_id);
-- Active workspace per project = setting ('shell', 'activeWorkspace:<projectId>').

CREATE TABLE workspace_terminals (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,                    -- terminal id (layout leaf "term:<id>", plugin-system.md §5.2)
  title         TEXT NOT NULL,
  title_source  TEXT NOT NULL DEFAULT 'default',  -- default|auto|manual
  cwd           TEXT NOT NULL,
  environment_id TEXT,
  agent         TEXT,                             -- JSON AgentBinding | NULL (agent-providers.md §5.4)
  locked        INTEGER NOT NULL DEFAULT 0,
  minimized     INTEGER NOT NULL DEFAULT 0,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE tool_configs (
  id              TEXT PRIMARY KEY,
  plugin_id       TEXT NOT NULL,
  contribution_id TEXT NOT NULL,                  -- tile/toolbar contribution id in the manifest
  name            TEXT NOT NULL,
  icon            TEXT,                           -- override; NULL = manifest icon
  color           TEXT,
  settings        TEXT NOT NULL DEFAULT '{}',     -- JSON, validated against contribution configSchema
  enabled         INTEGER NOT NULL DEFAULT 1,
  pinned          INTEGER NOT NULL DEFAULT 0,
  pin_order       INTEGER,
  pin_section     TEXT NOT NULL DEFAULT 'right',
  pin_display     TEXT NOT NULL DEFAULT 'icon-and-name',  -- icon|icon-and-name|mini
  quick_launch    INTEGER NOT NULL DEFAULT 0,
  open_mode       TEXT NOT NULL DEFAULT 'pane',   -- pane|flyout
  flyout_width    INTEGER,
  flyout_height   INTEGER,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  auto_created    INTEGER NOT NULL DEFAULT 0,     -- created from manifest defaultToolConfig
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_tool_configs_plugin ON tool_configs(plugin_id);

CREATE TABLE tile_instances (
  id              TEXT PRIMARY KEY,               -- ULID; layout leaf id = "tool:" || id
  workspace_id    TEXT REFERENCES workspaces(id) ON DELETE CASCADE,       -- NULL when global
  global_workspace_id TEXT REFERENCES global_workspaces(id) ON DELETE CASCADE,
  tool_config_id  TEXT NOT NULL REFERENCES tool_configs(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT '{}',     -- JSON: plugin instance state (e.g. editor file path)
  locked          INTEGER NOT NULL DEFAULT 0,
  minimized       INTEGER NOT NULL DEFAULT 0,
  floating        TEXT,                           -- JSON {x,y,width,height} | NULL
  created_at      INTEGER NOT NULL,
  CHECK ((workspace_id IS NULL) <> (global_workspace_id IS NULL))
);
CREATE INDEX idx_tile_instances_ws ON tile_instances(workspace_id);

CREATE TABLE global_workspaces (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  minimized     INTEGER NOT NULL DEFAULT 0,
  layout_tree   TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE settings (
  namespace   TEXT NOT NULL,                      -- "shell", "terminal", "agents", "chat", "plugin:<id>", ...
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,                      -- JSON
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (namespace, key)
);

CREATE TABLE stored_prompts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, content TEXT NOT NULL, category TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE agent_definitions (                  -- custom only; builtins are Rust consts
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, role TEXT NOT NULL,
  provider_id TEXT NOT NULL, model TEXT, system_prompt TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE terminal_environments (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT,
  kind TEXT NOT NULL,                             -- system_shell|vs_dev|custom
  shell TEXT NOT NULL,                            -- cmd|powershell|pwsh|bash|zsh|sh
  init_commands TEXT NOT NULL DEFAULT '[]', env TEXT NOT NULL DEFAULT '{}',
  vs TEXT,                                        -- JSON {version, edition, arch, vcvarsPath} | NULL
  built_in INTEGER NOT NULL DEFAULT 0, available INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE chat_conversations (
  id TEXT PRIMARY KEY, project_root_key TEXT, title TEXT NOT NULL, model TEXT,
  system_prompt TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                             -- system|user|assistant
  content TEXT NOT NULL, token_count INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX idx_chat_messages_conv ON chat_messages(conversation_id, created_at);

CREATE TABLE plugin_sources (
  id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
  etag TEXT, last_checked_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE plugins (                            -- installed (non-bundled) + state for bundled
  id TEXT PRIMARY KEY, source_id TEXT REFERENCES plugin_sources(id) ON DELETE SET NULL,
  origin TEXT NOT NULL,                           -- bundled|installed|dev
  version TEXT NOT NULL, install_path TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,                           -- active|disabled|needs_consent|incompatible|failed
  status_detail TEXT,
  granted_permissions TEXT NOT NULL DEFAULT '[]', -- JSON string[]
  available_update TEXT,                          -- JSON {version, url, sha256, permissions} | NULL
  installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE plugin_kv (
  plugin_id TEXT NOT NULL, scope TEXT NOT NULL,   -- "global" | "project:<root_key>"
  key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, scope, key)
);

CREATE TABLE app_changes (                        -- cross-process change cursor (§8.3)
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL, entity_id TEXT, op TEXT NOT NULL, at INTEGER NOT NULL, pid INTEGER NOT NULL
);
```

### 7.1 App domain services (`domains/app/*`)

```rust
// projects.rs
pub fn projects_list(db) -> Result<Vec<Project>>;
pub fn project_open(db, path: &Path, init_if_missing: bool) -> Result<Project>;  // registers + sets active
pub fn project_update(db, id, ProjectPatch{name?, default_workspace_template??}) -> Result<Project>;
pub fn project_remove(db, id) -> Result<()>;                                      // registry only; files untouched
pub fn project_active(db) -> Result<Option<Project>>;
// workspaces.rs
pub fn workspaces_list(db, project_id) -> Result<Vec<Workspace>>;
pub fn workspace_create / workspace_update / workspace_delete / workspace_activate;
pub fn workspace_load(db, id) -> Result<WorkspaceState>;
pub fn workspace_save(db, id, WorkspaceState) -> Result<()>;   // ONE transaction: layout + terminals + tiles
pub struct WorkspaceState { pub layout_tree: Option<serde_json::Value>,
    pub terminals: Vec<WorkspaceTerminal>, pub tiles: Vec<TileInstance> }
// tool_configs.rs
pub fn tool_configs_list / tool_config_create / tool_config_update / tool_config_delete / tool_configs_reorder;
pub fn tool_configs_sync_with_plugins(db, registry: &PluginRegistry) -> Result<()>; // plugin-system.md §5.3
// settings.rs
pub fn settings_get(db, ns) -> Result<BTreeMap<String, serde_json::Value>>;
pub fn settings_set(db, ns, key, value: serde_json::Value) -> Result<()>;
pub fn settings_delete(db, ns, key) -> Result<()>;
// prompts.rs, agent_definitions.rs (list merges builtins), environments (domains/environments.rs)
```

Workspace save is **one SQLite transaction** replacing the workspace's terminals and tiles (fixes
partial layout saves). The shell's debounce/generation logic (roadmap §3) sits on top.

### 7.2 Settings namespaces

`appSettingsStore` (localStorage) is replaced by `settings`. Namespaces: `shell` (toolbar, layout
defaults, active ids, global frame), `appearance` (theme mode, accent, ui scale, radius, gap,
glow), `terminal` (font, scrollback, default environment id, default shell), `agents`
(startupDelayMs, autoSubmitPrompt, defaults per provider), `notifications`, `chat` (endpoint,
default model, temperature, maxTokens, timeoutSeconds, systemPrompt), `plugin:<id>` (plugin
settings, plugin-system.md §6.5). Values are JSON; the TS side gets typed wrappers per namespace
via generated `ShellSettings`, `AppearanceSettings`, … structs that core (de)serializes from the
key/value rows (`settings::typed::<AppearanceSettings>(db, "appearance")`).

### 7.3 Chat

`domains/chat`: `conversations_list(project_root_key?), conversation_create, get, rename, delete,
messages_list, send(db, secrets, conv_id, content, sink: &dyn ChatSink)` (streaming via sink;
Tauri channel), `discover_endpoints(port, timeout_ms)`, `check_endpoint(url, timeout_ms)`.

### 7.4 Secrets — `domains/app/secrets.rs`

`secret_get(key) / secret_set(key, value) / secret_delete(key)` via the `keyring` crate, service
name `io.quadslab.quadflow`, account = key (`chat.apiKey`, `plugin:<id>:<name>`). If the platform
keystore is unavailable (headless Linux without Secret Service) → `CoreError::Unsupported` with a
clear message; there is no plaintext fallback. Never returned to the frontend in settings reads.

---

## 8. Change events

### 8.1 Event bus — `events/mod.rs`

```rust
#[derive(Clone, Debug, Serialize, specta::Type)] #[serde(rename_all = "camelCase")]
pub struct ChangeEvent {
    pub seq: u64,                    // per-process monotonic
    pub scope: ChangeScope,
    pub domain: Domain,
    pub kind: ChangeKind,
    pub ids: Vec<String>,            // empty with kind=Invalidated
    pub origin: Origin,
}
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChangeScope { Project { root_key: String }, App }
#[serde(rename_all = "snake_case")]
pub enum Domain { ProjectConfig, Ideas, Issues, Epics, Labels, Plans, Discovery, Scripts, ScriptGroups,
    Ship, ShipRuns, MissionTemplates, Missions, MissionMessages, MissionActivity,
    Projects, Workspaces, ToolConfigs, Settings, StoredPrompts, AgentDefinitions, Environments,
    Chat, Plugins, PluginData }
#[serde(rename_all = "snake_case")]
pub enum ChangeKind { Created, Updated, Deleted, Invalidated }
#[serde(rename_all = "snake_case")]
pub enum Origin { Local, External }   // Local = this process; External = watcher / other process

pub struct EventBus { /* Arc<RwLock<Vec<Box<dyn Fn(&ChangeEvent) + Send + Sync>>>> */ }
impl EventBus { pub fn new() -> Self; pub fn subscribe(&self, f: impl Fn(&ChangeEvent)+Send+Sync+'static) -> SubscriptionId;
                pub fn unsubscribe(&self, id: SubscriptionId); pub fn publish(&self, e: ChangeEvent); }
```

Services publish exactly one event per affected domain per transaction (ids batched). Cascades
publish for every domain they touched (e.g. close issue → `issues` with all modified ids, plus
`plans` if a step changed).

### 8.2 File watcher — `events/watcher.rs` (GUI only)

- `ProjectWatcher::start(root, bus, recent: RecentWrites)` using
  `notify_debouncer_full::new_debouncer(Duration::from_millis(150), None, …)` watching
  `<root>/.quadflow/` recursively. One watcher per project that has at least one subscriber
  (the active project always; plugins can hold others open via `ctx.data.watchProject`).
- Path → event mapping: `<dir>/<id>.json` → `(Domain for dir, Updated|Deleted, [id])`
  (Created vs Updated is not distinguished externally: use `Updated`); `labels.json` → `Labels`;
  `config.json` → `ProjectConfig`; `local/missions/<id>/messages.jsonl` → `MissionMessages [id]`;
  `local/missions/<id>/activity.jsonl` → `MissionActivity [id]`; `plugins/<pid>/…` and
  `local/plugins/<pid>/…` → `PluginData [pid]`. Ignore dotfiles, `.lock`, temp files.
- Self-suppression: drop an event if `RecentWrites` contains the path with the same `len` and
  `mtime` (written by this process within 2 s) — the in-process event was already published.
- Debouncer error / `notify` rescan / overflow → publish `Invalidated` for every project domain
  (consumers refetch everything). Never silently miss.
- External events carry `origin: External`.

This replaces `db_watcher.rs` (2 s polling with the cursor race) completely.

### 8.3 App DB cross-process changes

The CLI writes the app DB rarely (chat, plugins install). `AppDb::write` inserts `app_changes`
rows **in the same transaction** as the data. The GUI watches `quadflow.db-wal` and `quadflow.db`
with `notify` (debounced 200 ms) and on change runs one query:

```sql
SELECT seq, domain, entity_id, op, pid FROM app_changes WHERE seq > ?1 ORDER BY seq
```

It advances the cursor to the max `seq` **of the returned rows** (no second query → no race),
skips rows whose `pid` is its own, and publishes `ChangeEvent { scope: App, origin: External }`.
Rows older than 10 minutes are deleted by the GUI on startup and hourly.

### 8.4 Tauri bridge

`src-tauri/src/core_state.rs` subscribes to the bus and emits a single typed event
**`DataChanged`** (tauri-specta event, wire name `data-changed`) with the `ChangeEvent` payload
to all windows. Frontend helper (`src/lib/core/events.ts`):

```ts
export function onDataChanged(
  filter: { domain: Domain | Domain[]; projectRootKey?: string },
  handler: (e: ChangeEvent) => void,
): () => void   // returns unsubscribe; implements the disposed-flag pattern around listen()
```

Coalescing on the frontend: stores batch refetches per animation frame per domain.

---

## 9. TypeScript type generation

**Decision: `specta` + `tauri-specta` (v2).**

Why not `ts-rs`: ts-rs only generates types; we would still hand-write ~200 `invoke()` wrappers
whose names, argument names and return types can drift — the exact failure class we are removing
(`tauri-api.ts` is 1.8k lines of such wrappers today). tauri-specta generates the command
functions, their argument/return types, typed `Result` handling, typed events (`DataChanged`) and
typed `Channel<T>` payloads from the Rust signatures, in one file. specta's derive is
framework-agnostic, so `quadflow-core` depends only on `specta`, not on Tauri.

Pinning: `specta`, `tauri-specta` and `specta-typescript` are pinned with `=` to one mutually
compatible set (latest `2.0.0-rc.x` of specta/tauri-specta, or `2.x` if stable at implementation
time) chosen by DL-1 and recorded in this doc's §14 changelog. Upgrades are a deliberate PR.

Rules:
- Every type crossing IPC derives `specta::Type`. `i64`/`u64` export as `number`
  (`BigIntExportBehavior::Number`; all our integers are < 2^53: ms timestamps, counters).
- `serde_json::Value` exports as `JsonValue`.
- Output: **`src/generated/bindings.ts`** (committed). Additionally the domain types (no commands)
  are exported to **`packages/plugin-api/src/generated/types.ts`** for plugin authors (§10.3).
- Generation: `src-tauri/src/bindings.rs` exposes `pub fn builder() -> tauri_specta::Builder<tauri::Wry>`
  listing all commands (`collect_commands![…]`) and events (`collect_events![DataChanged, …]`).
  `lib.rs` uses `builder().invoke_handler()` and `builder().mount_events(app)`. A test
  The integration test `src-tauri/tests/export_bindings.rs` writes both files; debug builds
  also export on startup. CI runs `cargo test -p quadflow-tauri --test export_bindings` then
  `git diff --exit-code src/generated packages/plugin-api/src/generated` (drift = CI failure).
- Generated header: `// @generated by tauri-specta. Do not edit.`

---

## 10. Tauri command surface

### 10.1 Conventions

- Rust fn name `<domain>_<verb>[_<noun>]`, snake_case; generated TS name camelCase
  (`issues_set_status` → `commands.issuesSetStatus`).
- Files: `src-tauri/src/commands/<domain>.rs`, one per domain. Each command is
  `#[tauri::command] #[specta::specta] async fn …(core: State<'_, CoreState>, …) -> Result<T, CoreError>`,
  body = `spawn_blocking(move || quadflow_core::domains::<d>::<fn>(…))`. No logic in commands.
- Project-scoped commands take `project_root: String` as the first argument.
- Actor for GUI commands is built in `CoreState` (`Actor::human(display_name)`); plugin calls go
  through the plugin host (plugin-system.md §7), which supplies `Actor::plugin(id)`.
- Error type: `CoreError { code: ErrorCode, message: String, details: Option<JsonValue> }` with
  `ErrorCode = not_found | invalid_input | conflict | lock_timeout | corrupt | io | incompatible |
  unsupported | permission_denied | project_not_found | external | internal`.
  tauri-specta renders `Result<T, CoreError>` as `{ status: "ok"; data: T } | { status: "error"; error: CoreError }`.
- Streaming uses `tauri::ipc::Channel<T>` arguments (`chat_send`, `ship_run`).

### 10.2 Commands per domain

| File | Commands |
|---|---|
| `project.rs` | `project_init`, `project_config_get`, `project_config_update`, `project_doctor` |
| `ideas.rs` | `ideas_list`, `ideas_get`, `ideas_create`, `ideas_update`, `ideas_delete`, `ideas_add_tag`, `ideas_remove_tag`, `ideas_bulk_tag`, `ideas_merge`, `ideas_add_note`, `ideas_delete_note`, `ideas_add_suggestion`, `ideas_resolve_suggestion`, `ideas_revert`, `ideas_stats`, `ideas_export` |
| `issues.rs` | `issues_list`, `issues_get`, `issues_create`, `issues_update`, `issues_set_status`, `issues_close`, `issues_reopen`, `issues_delete`, `issues_add_comment`, `issues_delete_comment`, `issues_toggle_criterion`, `issues_claim`, `issues_heartbeat`, `issues_release`, `labels_list`, `labels_upsert`, `labels_delete`, `epics_list`, `epics_get`, `epics_create`, `epics_update`, `epics_delete` |
| `plans.rs` | `plans_list`, `plans_get`, `plans_create`, `plans_update`, `plans_delete`, `plans_step_add`, `plans_step_update`, `plans_step_delete`, `plans_steps_reorder`, `plans_comment_add`, `plans_comment_delete`, `plans_promote_step`, `plans_promote_all` |
| `discovery.rs` | `discovery_list`, `discovery_get`, `discovery_create`, `discovery_update`, `discovery_delete`, `discovery_item_add`, `discovery_item_update`, `discovery_item_delete`, `discovery_items_reorder`, `discovery_linked` |
| `scripts.rs` | `scripts_list`, `scripts_get`, `scripts_create`, `scripts_update`, `scripts_delete`, `scripts_resolve_command`, `script_groups_list`, `script_groups_get`, `script_groups_create`, `script_groups_update`, `script_groups_delete`, `script_groups_add_member`, `script_groups_remove_member`, `environments_list`, `environments_upsert`, `environments_delete`, `environments_detect` |
| `ship.rs` | `ship_config_get`, `ship_config_save`, `ship_config_validate`, `ship_config_delete`, `ship_init`, `ship_templates`, `ship_detect`, `ship_status`, `ship_readiness`, `ship_readiness_one`, `ship_run_fix`, `ship_bump`, `ship_run` (Channel), `ship_abort`, `ship_external_complete`, `ship_runs_list`, `ship_runs_get`, `ship_restore_backups`, `ship_diagnostics` |
| `chat.rs` | `chat_conversations_list`, `chat_conversations_create`, `chat_conversations_get`, `chat_conversations_rename`, `chat_conversations_delete`, `chat_messages_list`, `chat_send` (Channel), `chat_discover_endpoints`, `chat_check_endpoint` |
| `missions.rs` | `missions_list`, `missions_get`, `missions_create`, `missions_update`, `missions_delete`, `missions_progress`, `missions_member_add`, `missions_member_update`, `missions_member_remove`, `missions_member_heartbeat`, `missions_messages`, `missions_send_message`, `missions_mark_read`, `missions_unread_count`, `missions_activity`, `missions_log_activity`, `missions_proposal_create`, `missions_proposal_update_status`, `missions_proposal_modify`, `missions_merge_enqueue`, `missions_merge_queue`, `missions_merge_update`, `missions_assign_issues`, `missions_claim_next_issue`, `mission_templates_list`, `mission_templates_upsert`, `mission_templates_delete`, `agent_definitions_list`, `agent_definitions_upsert`, `agent_definitions_delete` |
| `app.rs` | `projects_list`, `projects_open`, `projects_update`, `projects_remove`, `projects_active`, `workspaces_list`, `workspaces_create`, `workspaces_update`, `workspaces_delete`, `workspaces_activate`, `workspaces_load`, `workspaces_save`, `global_workspaces_list`, `global_workspaces_save`, `tool_configs_list`, `tool_configs_create`, `tool_configs_update`, `tool_configs_delete`, `tool_configs_reorder`, `settings_get`, `settings_set`, `settings_delete`, `stored_prompts_list`, `stored_prompts_upsert`, `stored_prompts_delete`, `secrets_set`, `secrets_delete`, `secrets_exists` |
| `context.rs` | `context_modules_list`, `context_modules_set` (agent-providers.md §7) |

Plugin, agent and terminal commands are specified in plugin-system.md §7 and agent-providers.md §8.

### 10.3 Frontend consumption

- `src/lib/core/index.ts`:

```ts
import { commands, events, type CoreError } from '../../generated/bindings'
export class CoreCallError extends Error { constructor(public error: CoreError) { super(error.message) } }
export async function call<T>(p: Promise<{ status: 'ok'; data: T } | { status: 'error'; error: CoreError }>): Promise<T> {
  const r = await p
  if (r.status === 'error') throw new CoreCallError(r.error)
  return r.data
}
export { commands }
export * from './events'
```

- Stores use `call(commands.issuesList(root, query))`. They hold the `projectRoot` they loaded
  for and ignore results/events for a different root (no stale-project writes).
- Each domain store subscribes once with `onDataChanged({ domain: 'issues', projectRootKey })`:
  `Updated|Created` with ids → `issuesGet` each id (≤ 20 ids) else full `issuesList`;
  `Deleted` → remove ids; `Invalidated` → full reload.
- `ListResult.errors` non-empty → store exposes `corrupt: CorruptEntry[]`; tool views show a
  dismissible banner "N files could not be read" with paths.
- No store imports `@tauri-apps/plugin-fs` or `@tauri-apps/plugin-sql` for data.

---

## 11. CLI

- Entry: `quadflow_core::cli::run(args: Vec<OsString>, io: &mut Io, env: &CliEnv) -> i32`
  where `Io { stdout: Box<dyn Write>, stderr: Box<dyn Write> }` and `CliEnv { cwd, vars }` —
  injectable for in-process tests. `main.rs` passes real stdio/env.
- Global flags: `--json`, `--project <path>`.
- `--json` output is always one JSON document on stdout:
  `{"ok":true,"data":<T>}` or `{"ok":false,"error":{"code":"not_found","message":"…"}}`.
  `data` uses exactly the generated types (camelCase). Warnings (corrupt files) go to stderr and,
  in JSON mode, also to `"warnings": [CorruptEntry…]` next to `data`.
- Exit codes: `0` ok; `1` domain/internal error; `2` usage/invalid argument (clap or enum
  parse); `3` not found; `4` conflict or lock timeout; `5` project not found. Applies in JSON mode
  too (fixes `ship run --json` returning 0 on failure).
- Every subcommand honours `--json` (fixes deletes/bulk-tag/etc. that ignored it). Human output
  uses `display_ref` for issues; ids are never sliced by byte index.
- Commands mirror §10.2 one-to-one: `quadflow init`, `quadflow doctor [--fix]`,
  `quadflow ideas|issues|labels|epics|plans|discovery|scripts|ship|chat|missions <verb>`,
  `quadflow context …`, `quadflow docs …`, `quadflow plugins …`, plus plugin-contributed
  subcommands (plugin-system.md §9). Per-domain CLI files are owned by the domain work package.

---

## 12. Testing

### 12.1 Unit tests (per domain, in-file `#[cfg(test)]`)

- Helpers in `tests/common/mod.rs` (also `pub mod testing` behind `cfg(any(test, feature="testing"))`):
  `TempProject::new()` → `tempfile::TempDir` + `ProjectStore::init`; `TempApp::new()` →
  `AppPaths::under(tmp)` + `AppDb::open`. **No test touches the real user data dir**; `AppPaths::resolve`
  panics in tests unless `QUADFLOW_DATA_DIR` is set (guard: `cfg(test)`).
- Required cases per domain: create/get/list round-trip; patch set/clear; delete cascades;
  corrupt file → listed in `errors`, RMW refuses; invalid id → `invalid_input`; events published
  with correct domain/ids.

### 12.2 Cross-process concurrency — `tests/concurrency.rs`

- The test re-executes its own binary (`std::env::current_exe()`) with env
  `QF_CONC_CHILD=1 QF_CONC_ROOT=<tmp>`; a `#[test] fn child_entry()` that returns immediately unless
  `QF_CONC_CHILD` is set performs the child workload.
- Workload: 8 child processes × 50 `issues::create` + 50 `issues::add_comment` on a shared issue +
  10 `labels_upsert`, concurrently with the parent doing `issues::list` in a loop.
- Assertions: 400 issues exist; numbers are exactly `1..=400` with no duplicates; the shared issue
  has 400 comments; `labels.json` parses and contains all labels; no `.tmp` files remain; parent
  never observed a parse error.
- Same test for app DB: 4 processes × 100 `settings_set` + `chat_messages` inserts; no
  `SQLITE_BUSY` surfaces.

### 12.3 CLI JSON contract tests — `tests/cli_contract.rs`

- For every subcommand: run `cli::run` in-process against a `TempProject`, parse stdout, assert
  envelope + exit code, and snapshot `data` with `insta::assert_json_snapshot!` using redactions
  for `.id`, `.**.createdAt`, `.**.updatedAt`, `.**.at`.
- A test `export_fixtures()` writes one representative JSON value per exported type to
  `tests/fixtures/<Type>.json`. The TS side has `src/generated/contract.test.ts` (vitest +
  `tsc --noEmit` via `resolveJsonModule`) doing `const x: Issue = issueFixture` for each fixture —
  a Rust/TS shape drift fails type-checking.
- Error contract: `issues get QX-999` → exit 3, `{"ok":false,"error":{"code":"not_found",…}}`;
  invalid status → exit 2; `issues close` → `status: "done"` and cascade unblock observed.

### 12.4 Frontend

Vitest for `src/lib/core` (`call` unwrap, `onDataChanged` filter/dispose). Stores are tested with
a mocked `commands` object (generated types make mocks type-checked).

---

## 13. Implementation sequence and ownership

Work packages are also listed in `docs/architecture/README.md` with acceptance criteria. Rule:
**a package only edits files it owns**, except append-only lines in the shared registration points
listed below (merge conflicts there are trivial).

Shared registration points (append one line per domain, keep alphabetical):
- `src-tauri/quadflow-core/src/domains/mod.rs` — `pub mod <domain>;`
- `src-tauri/quadflow-core/src/cli/mod.rs` — one enum variant + one dispatch arm
- `src-tauri/src/commands/mod.rs` — `pub mod <domain>;`
- `src-tauri/src/bindings.rs` — command names inside `collect_commands![]`

### DL-1 Foundation (blocks everything)
Creates: `quadflow-core/src/{error,ids,time,model,paths,core}.rs`, `store/*`, `events/*`,
`domains/mod.rs`, `domains/project_config.rs`, `cli/{mod,output,project}.rs`,
`tests/common/mod.rs`, `tests/concurrency.rs` (with a dummy `TestEntity` workload),
`src-tauri/src/{core_state.rs,bindings.rs,commands/mod.rs,commands/project.rs}`,
`src/lib/core/{index.ts,events.ts}`, `src/generated/bindings.ts`.
Deletes: `file_store.rs`, `path_utils.rs`, `config.rs`, `database.rs` usage of change log,
`src-tauri/src/db_watcher.rs` (and its spawn in lib.rs), `tauri-plugin-sql` from Cargo.toml +
`lib.rs` + capabilities, `@tauri-apps/plugin-sql` from package.json **only after DL-11** (keep
until then so the old TS layer still compiles).
Also: crate dir rename if not done; Cargo deps (§2.1); `main.rs` calls `cli::run` with `Io`.

### DL-2 … DL-9 Domains (parallel after DL-1)
Each creates `domains/<d>…`, `cli/<d>.rs`, `src-tauri/src/commands/<d>.rs`, snapshot tests,
fixtures, and **rewires the existing frontend store(s)** for that domain to `src/lib/core`
(stores move into plugins later; see plugin-system.md §15). Each deletes the old core module and
the corresponding functions in `database.ts`/`tauri-api.ts` it replaced (leave the file).

| WP | Domain | Old files removed | Frontend stores rewired |
|---|---|---|---|
| DL-2 | ideas | `database.rs` | `ideaStore.ts` |
| DL-3 | issues, epics, labels | `issues.rs`, `cli/issues.rs` | `issueStore.ts`; fix `TerminalView.tsx:535` `QC-`, `IssueCard/IssueFormView/KanbanBoard` `'QC'` defaults, `commandRegistry.ts:399` |
| DL-4 | plans | `plans.rs`, `cli/plans.rs` | `planStore.ts` |
| DL-5 | discovery | `projects.rs`, `cli/projects.rs` | `discoveryProjectStore.ts` |
| DL-6 | scripts, groups, environments | `scripts.rs`, `cli/scripts.rs` | `flyoutScriptStore.ts`, scripts hooks in `components/tools/scripts/*` |
| DL-7 | ship | `ship.rs`, `ship_exec.rs`, `cli/ship.rs`, `src-tauri/src/ship_tauri.rs` | `shipStore.ts` |
| DL-8 | chat | `chat.rs` (core), `cli/chat.rs`, `src-tauri/src/chat.rs` | `chatStore.ts` |
| DL-9 | missions, templates, agent definitions | `missions.rs`, `cli/missions.rs` | `missionStore.ts` |

DL-3 depends on DL-1 only; DL-4 needs DL-3's `issues::create_in_tx` for promotion — DL-4 may
start in parallel and stub promotion until DL-3 merges. DL-9 progress/claim depends on DL-3.

### DL-10 App domain (parallel after DL-1)
Creates `domains/app/*` and `commands/app.rs` (`domains/environments.rs` belongs to DL-6). Rewires `projectStore.ts`, `sessionStore.ts`, `toolStore.ts` (configs/instances
persistence only — the registry change is PL-4), `globalWorkspaceStore.ts`,
`storedPromptStore.ts`, `appSettingsStore.ts` (persistence from localStorage → settings),
`workspaceSave.ts`, `useSwitchProject.ts`. Removes `seedBuiltInTools` (tool configs come from
manifests in PL-4; until then DL-10 seeds tool_configs with `plugin_id = "builtin"` and
`contribution_id = <old ToolType>` so the app keeps working).

### DL-11 Cutover & deletion (after DL-2…DL-10)
Deletes `src/lib/database.ts`, `src/lib/fileStore.ts`, `@tauri-apps/plugin-sql`, remaining
`dbChangeApi`/domain wrappers in `tauri-api.ts`, `capabilities` sql/fs-wide permissions no longer
needed; greps the tree for `getDatabase(`, `getFileStore(`, `db:`-events and removes them.
Acceptance: `npx tsc --noEmit`, `cargo test -p quadflow-core`, contract tests green; app launches,
open project, create idea/issue/plan from GUI and CLI concurrently and both views update.

---

## 14. Changelog

- 2026-10-22 — initial version.
- 2026-10-22 — DL-1 implemented. Recorded decisions and deviations:
  - **Pins (§9):** `specta =2.0.0-rc.25` (features `derive`, `serde_json`), `tauri-specta
    =2.0.0-rc.25` (`derive`, `typescript`), `specta-typescript =0.0.12`. The `serde` feature named
    in §2.1 no longer exists in rc.25 (serde handling lives in `specta-serde`).
  - **Serde phases stay on.** Types whose shape differs by direction (any `skip_serializing_if` /
    `default`) export as `Foo_Serialize` + `Foo_Deserialize` plus a `Foo` union; commands use the
    phased names (`ProjectConfig_Serialize` out, `ProjectConfigPatch_Deserialize` in).
    `disable_serde_phases()` is rejected by specta-serde for `skip_serializing_if`.
  - **`JsonValue`:** rc.25 exports `serde_json::Value` as an inline recursive type that
    specta-typescript refuses. `quadflow_core::model::JsonValue` is a type-only named enum; every
    `serde_json::Value` field crossing IPC carries `#[specta(type = JsonValue)]` (or
    `Option<…>` / `BTreeMap<String, …>`).
  - **Export test location:** the bindings test is an integration test
    (`src-tauri/tests/export_bindings.rs`; `bindings`, `commands`, `core_state` are `pub`). On
    Windows test executables need the Common Controls v6 manifest (tauri-build only embeds it into
    bins; without it the exe fails with `STATUS_ENTRYPOINT_NOT_FOUND`): `src-tauri/build.rs` embeds
    `src-tauri/windows-test-manifest.xml` via `rustc-link-arg-tests` (MSVC only).
  - **Plugin-API types export** (`packages/plugin-api/src/generated/types.ts`) is deferred to the
    plugin work package; only `src/generated/bindings.ts` is generated and drift-checked today.
  - **Invoke handler:** typed commands are routed by name to `builder().invoke_handler()`, all
    other names to the legacy `generate_handler!` table, until each domain moves (DL-2…DL-10).
  - **Extra project commands:** `core_info` (profile, app identifier, project dir name, data /
    db / logs paths, `defaultWorkingDir`), `project_watch`, `project_unwatch`.
  - **Dev profile (supersedes §3.1's `QUADFLOW_DEV=1` / `com.quadflow.app`):** `Profile {Release,
    Dev}` (debug builds or `QUADFLOW_PROFILE=dev`). Release uses identifier
    `io.quadslab.quadflow` and `.quadflow/`; dev uses `io.quadslab.quadflow.dev` and
    `.quadflow-dev/`. `QUADFLOW_DATA_DIR` overrides the data dir. Dev's default working dir is
    `QUADFLOW_PROJECT_DIR` or `<data>/scratch-project`, never the home folder; the frontend reads
    it (and `projectDirName`) via `commands.coreInfo()` (`src/lib/core` `getCoreInfo`,
    `resolveDefaultWorkingDir`). All other app data (ai-provider/discord/obs/youtube DBs, chat.db,
    semantic index + models, usage-monitor settings, logs, audio AUMID) routes through
    `quadflow_core::paths`.
  - **DL-1 shims (removed by DL-2…DL-11):** `quadflow-core/src/legacy.rs` replaces the deleted
    `file_store.rs` / `config.rs` / `path_utils.rs` for the old domain modules and CLI handlers
    (profile-aware; old issue settings `config.json` → `legacy-config.json`, since `config.json`
    is now `ProjectConfig`); `src/lib/fileStore.ts` mirrors that redirect and uses
    `coreInfo.projectDirName`. `tauri-plugin-sql` stays until DL-11 (§13).
- 2026-10-22 — DL-2 (ideas) implemented. Recorded decisions and deviations:
  - **Extra service + command `delete_suggestion` / `ideas_delete_suggestion`** (CLI
    `ideas delete-suggestion`): the Ideas tool lets users delete suggestions; §6.2 had no way to.
  - **`list` returns newest first** (descending id). The GUI loads with `includeArchived: true`
    and filters archived ideas in the view (toggle "Archived (n)").
  - **Tags:** trimmed + lowercased; empty tags and tags containing `,` are `invalid_input`.
    `resolve_suggestion` on an already-resolved suggestion is `conflict`. `bulk_tag` and `merge`
    validate every id before writing (a missing id writes nothing). `merge` keeps the survivor's
    `originalContent` and suggestions; its `discoveryId` falls back to the first merged idea's.
  - **`stats` / `export`** keep the §6.2 signatures; `stats_report` / `export_report` also return
    the unreadable files so the CLI can emit `warnings`.
  - **CLI** keeps the old shapes used by the bundled skills as aliases: `tag`/`untag`, `search`
    (`--query`), `archive`/`unarchive`, `merge <ids,csv> <keep>`, `bulk-tag <ids,csv> <tag>`,
    `update <id> <content>`.
  - **Contract tests** live in `tests/cli_ideas.rs` (snapshots `tests/snapshots/cli_ideas__*.snap`)
    instead of `tests/cli_contract.rs`, so parallel domain packages don't conflict. `insta` added
    as a dev-dependency. Fixture export + `contract.test.ts` (§12.3) not done (no vitest yet).
  - **Frontend project open (stopgap until DL-10 `projects_open`):** `src/lib/core/project.ts`
    `ensureProject(root)` inits the project if needed (the old FileStore created folders lazily),
    starts `project_watch`, and derives the root key from the canonical root returned by
    `project_init` / `project_doctor`.
  - `database.ts` `linkIdeaToProject` (used by the not-yet-rewired discovery store) now calls
    `ideas_update { discoveryId }`.
- 2026-10-22 — DL-3 implemented (issues, epics, labels). Recorded decisions and deviations:
  - **Extra command `issues_open(projectRoot) -> IssuesProject { root, rootKey, code }`:** opens the
    project (`open_or_init`, so the GUI initializes `.quadflow/` on first use), starts its watcher
    and returns the `rootKey` the store filters `data-changed` by. Other domain stores can reuse it.
  - **Inputs:** `claim` takes `ClaimInput` (`Assignment` without timestamps). Re-claiming from the
    same terminal/session refreshes the claim; claim moves `backlog|todo` → `in_progress`, release
    moves `in_progress` → `todo`. `toggle_criterion` has an optional `checked` (null toggles).
    `label_upsert` has an optional `rename_from` (renames on every issue and epic). Patch
    criteria are `CriterionInput { id?, text, checked }`.
  - **Labels:** a label name used on an issue/epic that is not in `labels.json` is added with a
    palette color (by name hash), so the catalog always covers every used name.
  - **§6.3 invariants 3–4** (plan step sync, mission activity) are hook points in
    `apply_status_in_tx` for DL-4 / DL-9. Until DL-4 lands, `issueStore` still syncs the step
    status through the legacy `db.updatePlanStep`.
  - **Concurrency test:** the shared comment thread is a real issue (#1), so the assertion is
    401 issues numbered exactly `1..=401`.
  - **CLI:** besides the §10.2 mirror there are `issues status|label|unlabel|comments|children|
    blocking|delete-comment|criterion`. Status aliases (CLI only) include `open`→`todo`,
    `closed`→`done`, `review`→`qa`. `""` / `none` clears a field in `update`.
  - **Frontend:** `src/lib/core/issues.ts` maps core entities to the view models in
    `types/issues.ts` (no `state`, no `sortOrder`; GitHub fields read from `ext.github`).
    `formatIssueRef(code, n)` is the TS mirror of `display_ref` and the only place the GUI builds
    a ref. Kanban columns order by priority then number (manual within-column ordering went with
    `sortOrder`). Issue filters are a per-viewer convenience in `localStorage` (per rootKey).
    `database.ts` keeps thin shims (`getAllIssues`, `getIssueById`, `createIssue`, `updateIssue`,
    `getAllIssueLabels`, `createIssueLabel`, `getIssueComments`, `getMissionIssues`,
    `getOpenIssues`) for callers owned by other packages (GitHub, plans, missions); DL-11 removes them.
- 2026-10-23 — DL-10 implemented (`domains/app/{projects,workspaces,tool_configs,settings,prompts,agent_definitions}.rs`,
  `src-tauri/src/commands/app.rs`, `src/lib/appData.ts`, workspace controller in `src/lib/workspaceSave.ts`).
  Recorded decisions and deviations:
  - **Schema:** `workspace_terminals` gained `state TEXT NOT NULL DEFAULT '{}'` (shell runtime state:
    scrollback snapshot, status, original prompt), mirroring `tile_instances.state`. `agent` holds the
    shell's agent fields as opaque JSON until AP-1 types `AgentBinding`.
  - **`AppDb::transact`** (closure gets the tx + a change list; `Err` rolls back and records nothing)
    is used by every app-domain write; `workspace_save` is one such transaction.
  - **Commands beyond §10.2:** `projects_register` (register without activating), `projects_touch`,
    `projects_terminal_counts`, `workspaces_active`, `global_workspaces_upsert` / `_delete`,
    `settings_set_many` (one transaction per namespace, `null` deletes), `tool_configs_reset_builtins`.
    `tool_configs_reorder(ids, field: sort|pin)`. `global_workspaces_save(tiles)` replaces all
    global tiles; the global frame is the setting `shell.globalFrame`.
  - **Built-in tools (until PL-4):** `tool_configs::BUILTIN_TOOLS` are seeded idempotently by
    `tool_configs_list` with `pluginId: "builtin"`, `contributionId: <old ToolType>`,
    `autoCreated: true`; the shell's `seedBuiltInTools` is gone. Config fields without a column
    (`executablePath`, `args`, `workingDirectory`) ride in `settings._legacy`.
    `tool_configs_sync_with_plugins` arrives with PL-4. *(PL-4: replaced by `tool_configs::sync_with_plugins`; see plugin-system.md §17.)*
  - **Ids:** terminal, tile and global-workspace ids stay shell-generated strings (validated: 1–200
    chars, no control chars or path separators) until PL-4 changes the leaf ids. A tile whose tool
    config no longer exists is skipped and reported in `SaveResult.skippedTiles`.
  - **Settings:** key/value JSON rows; the typed per-namespace structs of §7.2 are not generated yet.
    `appSettingsStore` maps its sections to rows (`terminal`, `terminal/environments.*` — interim
    until DL-6's `terminal_environments` —, `appearance`, `editor`, `agents`, `agents/models.*`,
    `shell/{session,toolbar,layoutPresets,defaultWorkspace}.*`, `cache/modelCatalog*` — until
    AP-1's cache file). Also in `shell`: `activeProjectId`, `activeWorkspace:<projectId>`,
    `globalFrame`, `globalTerminals` (terminals pinned to a global workspace), `workspaceTemplates`,
    and `store:<name>` for zustand-persisted UI stores. Change-event ids are `"<namespace>/<key>"`.
  - **Agent definitions:** the core service (custom rows; `list` merges builtins passed in) lives
    here; its commands and the mission-store rewire are DL-9's (§10.2 `missions.rs`). Secrets: DL-8.
  - **Release DB path collision fixed:** the legacy TS DB and the Rust shim
    (`legacy::get_database_path`) both use `<app data dir>/legacy-quadflow.db` in both profiles; the
    core owns `quadflow.db`. `legacy::resolve_active_project_dir` reads the core DB's
    `shell.activeProjectId` (read-only) instead of the old `projects.is_active` row.
- 2026-10-23 — DL-7 implemented (ship: `domains/ship/{model,service,exec,templates,versions,checks,sys}.rs`,
  `cli/ship.rs`, `src-tauri/src/commands/ship.rs`, `src/lib/core/ship.ts`, `shipStore` + `ShipToolView`).
  Recorded decisions and deviations:
  - **Run modes:** `ShipRunOptions { mode: patch|minor|major|deploy, dryRun, skipBuild, reuseBuild, draft }`
    (`deploy` = the old `--no-bump`; the CLI keeps `--no-bump` as an alias of `deploy`). A config without
    `versionFiles` versions runs by the short git commit hash (deploy mode only); `version_bump` then is a
    validation error. Dry runs are returned, never persisted.
  - **Run records:** `ShipRun { id, version, previousVersion, mode, status, dryRun, startedAt, completedAt,
    startedBy: Actor, phases, artifacts, releaseUrl, changelog }`; `ShipPhaseResult` gained `url` (release
    page, hoisted to `releaseUrl`) and `children` (parallel/sequence results). `get_run_by_version` is
    `run_by_version`; the CLI `ship get` takes a run id or a version.
  - **Abort is real:** a run in this process is cancelled (the running command's process tree is killed, a
    pending external-terminal phase is released); a run in another process stops before its next phase
    (the executor re-reads its record under the lock before each write); a stale record is marked
    `aborted`. A second live run in the same project and process is `conflict`.
  - **Sink:** `ShipSink::external(req, cancel)` takes the run's `ShipCancel`; `restored_backups(files)` was
    added. `ship::external_roundtrip` / `external_complete` hold the pending-request registry in core.
    Phases whose env is non-empty (e.g. a key from `load_env_from_file`) never go to a terminal tile — a
    tile cannot receive env vars without echoing them — and run embedded instead.
  - **Channel payload:** one tagged enum `ShipRunEvent` (`started | phase | line | external_request |
    restored_backups`). `ship_run_fix(projectRoot, checkId, Channel<ShipLineEvent>)` runs the check's own
    `fixCommand` only (the frontend can no longer pass an arbitrary command).
  - **Templates:** `ShipInitOptions { template, params: map, force }`; unknown params, bad booleans and missing
    required params are `invalid_input` (no `OWNER/REPO` placeholders). Version files come from
    `detect_version_files` (package.json, tauri.conf.json, Cargo `[package]`/`[workspace.package]` at the
    root, `src-tauri/`, one level of crates, pyproject). `tauri-windows` signs only with an explicit
    `sign_command` (→ new `patch_tauri_conf.windowsSignCommand` = Tauri `bundle.windows.signCommand`) and
    builds updater artifacts only with `signing_key`. `qwick_authenticated` is gone; unknown check ids are
    validation errors. Extra command `ship_template_preview`; `ship_detect` returns `ShipEnvDetection`.
  - **Exit codes:** a failed/aborted `ship run` → `external` (exit 1) with the record in
    `error.details.run`; an invalid config from `ship config validate` → `invalid_input` (exit 2) with
    `error.details.errors`. Orphan `.ship-bak` files are restored at the start of `ship run` and by
    `ship restore-backups` (no longer by every `ship` subcommand).
  - **Contract tests** live in `tests/cli_ship.rs` (snapshots `tests/snapshots/cli_ship__*.snap`).
- 2026-10-23 — DL-8 implemented (chat + secrets: `domains/chat/*`, `domains/app/secrets.rs`,
  `cli/chat.rs`, `src-tauri/src/commands/chat.rs`, `src/lib/core/chat.ts`). Recorded decisions and
  deviations:
  - **Secrets service name is the profile's app identifier** (`io.quadslab.quadflow` /
    `io.quadslab.quadflow.dev`), so dev builds never read or overwrite the installed app's keys.
    `Secrets` wraps a `SecretBackend` trait: `keyring` (OS keystore; `windows-native`,
    `apple-native`, `sync-secret-service`+`crypto-rust`) or an in-process **memory** backend
    selected by `QUADFLOW_SECRETS_BACKEND=memory` (tests/CI; never persisted — still no plaintext
    fallback). Keystore unavailable → `unsupported`; `get_optional` treats that as "no secret" so a
    local endpoint without a key keeps working. Keys: `chat.apiKey`, `openai.apiKey`,
    `plugin:<id>:<name>` (`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$`); values ≤ 2048 bytes, trimmed.
  - **Commands beyond §10.2:** `chat_settings_get` / `chat_settings_update` (typed
    `ChatSettings` over the `chat` namespace keys `endpoint`, `defaultModel`, `temperature`,
    `maxTokens`, `timeoutSeconds`, `systemPrompt`; `hasApiKey: bool` is computed, never the key),
    `chat_models` (`GET {endpoint}/models`, then Ollama `/api/tags`). `secrets_set|delete|exists`
    are in `commands/app.rs`; there is no command that returns a secret.
  - **Streaming:** `chat_send(conversationId, content, onEvent: Channel<ChatStreamEvent>)` emits
    `started {userMessage}` → `delta {text}`* → `done {result}` | `failed {error}` and resolves with
    `ChatSendResult` (or rejects with the same `CoreError`). Core reads the SSE body with blocking
    `reqwest`; servers that ignore `stream: true` (plain JSON) work too. On failure the user message
    stays stored and no assistant message is written. Errors are `external` with actionable text
    (connect / timeout / `HTTP 401 … Check the API key`); the key never appears in messages or `Debug`.
  - **Model:** `ChatConversation.model: null` = the `defaultModel` setting at send time; a new
    conversation copies the `systemPrompt` setting. Messages order by `(created_at, rowid)`.
    Change events: `chat` domain with conversation ids (create/rename/delete/message added).
  - **`ai_provider.rs`** no longer has its own DB (`ai_provider.db` is gone): the OpenAI key is the
    secret `openai.apiKey`, TTS voice/model are settings `tts.voice` / `tts.model`, and the old
    "Ollama endpoint/key" is the chat endpoint/key. `ai_get_settings` returns `has_openai_api_key`
    only (masked keys are no longer sent). The legacy `ai_*` TTS commands stay untyped (streamer
    plugin territory); title generation and YouTube AI polls use `chat::request_config` /
    `chat::complete`.
  - **CLI:** `chat list|get|create|rename|delete|messages (history)|send|settings|key
    set|clear|status|models|discover (discover-endpoints)|check (check-endpoint)`; `--this-project`
    scopes list/create by root key; `key set` reads `--stdin` or `--from-env VAR` (never argv).
    Snapshots in `tests/cli_chat.rs` / `tests/snapshots/cli_chat__*.snap`.
  - Endpoint discovery dropped the Windows `nbtstat` hostname fallback (spawned a process per
    host); reverse DNS only. `check_endpoint` uses the URL's real default port (443 for https).
- 2026-10-23 — DL-9 implemented (`domains/missions/{model,service,builtins,tests}.rs`, `cli/missions.rs`,
  `src-tauri/src/commands/missions.rs`, `src/lib/core/missions.ts`, `missionStore` rewire). Recorded
  decisions and deviations:
  - **Type names** carry a `Mission` prefix (one specta namespace): `MissionAgentRole`,
    `MissionMessageKind`, `MissionActivityKind`, `MissionMergeStatus`, `MissionProposalStatus`,
    `MissionOrchestratorMode`, `MissionMergeEntry` (§6.9 `MergeQueueEntry`), `MissionProposedAgent`
    (`ProposedAgent`), `NewMissionMember`, …
  - **Workflow phases are structured** (`MissionWorkflowPhase { name, description?, gate?, skills[] }`,
    order = position) instead of `Vec<String>`: the built-in playbooks and the UI use gates and skills.
  - **`MissionProposedAgent`** gains `issueIds`, `allowedFiles`, `rationale`; `agentDefinitionId` and
    `providerId` are optional (coordinators propose by role; the approver picks the definition).
  - **`MissionActivityKind`** adds `issues_assigned`, `proposal_created`, `proposal_updated`, `note`.
    The core logs activity itself: member join/stop/error, issue assignment, claims, proposals,
    merges, mission status transitions, and (at DL-3's hook in `apply_status_in_tx`) every status
    change of a mission issue. On `done` the member working the issue goes `idle` and its branch is
    queued in the merge queue once (same transaction).
  - **Service extras:** `issues(id)`, `unread(id, reader)` (CLI `inbox`), `merge_next`,
    `member_add_from_definition`, `agent_definitions_list/get` (built-ins merged), `templates_*`;
    `NewMission.issueRefs` assigns issues in the create transaction (all refs validated before any
    write); `mark_read(up_to?)` defaults to the latest message and never moves a cursor backwards;
    `member_heartbeat` also refreshes the heartbeat of the member's claimed issue. Members are
    addressed by id or unique name (CLI and services).
  - **`claim_next_issue`** uses the new `issues::claim_in_tx` (DL-3's `claim` now delegates to it).
  - **Commands beyond §10.2:** `missions_issues`, `missions_merge_next`. `missions_member_add` takes
    `MissionMemberAddInput { agentDefinitionId, name?, model? }` and resolves the definition (built-in
    const or app DB). The GUI binds via `issues_open` (root + rootKey).
  - **Built-ins:** 12 agent definitions (`builtin-<role-name>`, provider `claude-code`, `model: None`)
    and 8 templates (`builtin-feature-build`, …) are consts; nothing is seeded on startup.
    `database.ts` no longer creates or seeds any mission/agent tables.
  - **Agent prompts** (`types/missions.ts` builders, `agentOverlay.ts`, watchdog/nudge texts) use
    `quadflow --project "<root>" missions …` / `issues …`; the worktree hook settings allow
    `Bash(quadflow:*)`. Issue refs in prompts are plain numbers (`#n` is a shell comment).
  - **Contract tests** in `tests/cli_missions.rs`; the concurrency test adds 4 processes × 50
    `send_message` (all 200 messages + 200 activity lines present, per-process order kept).
- 2026-10-23 — DL-5 implemented (discovery). Recorded decisions and deviations:
  - **Model additions to §6.5:** `DiscoveryProject` carries the usual audit (`createdAt`,
    `createdBy`, `updatedAt`) and `ext`; items are kept sorted by `order` (renumbered 0..n on
    delete / reorder). Item `status` stays free text (`pending`, `answered`, `must_have`, …).
  - **`linked` returns `DiscoveryLinks { ideas: Vec<Idea>, plans: Vec<DiscoveryLinkedPlan>,
    errors }`** where `DiscoveryLinkedPlan = { id, title, status, stepsTotal, stepsCompleted }`
    instead of full `Plan`s: the plans domain is DL-4's and was not merged yet. Plans are read
    from `plans/<id>.json` as raw JSON (`id`, `title`, `status`, `steps[].status`,
    `discoveryId`); `delete` clears `discoveryId` on those files with a field-preserving rewrite
    (publishes `plans` events). Once DL-4 lands this can switch to `plans::list`.
  - **Queries:** `DiscoveryQuery { text?, status? }`; `list` returns newest first, archived
    included (the GUI filters).
  - **CLI** `quadflow discovery list|get|create|update|delete|item-add|item-update|item-delete|
    items-reorder|linked`. Item commands take the discovery id and the item id
    (`item-update <id> <item-id>`); `--item-type` is an alias of `--kind`; `--goal` /
    `--criterion` are repeatable and replace the list (`--no-goals` / `--no-criteria` clear);
    `""` clears overview / content / status / metadata. Ideas are linked with
    `ideas update --discovery` (no separate link verb). Contract tests: `tests/cli_discovery.rs`.
  - **Agent context module renamed** `projects` → `discovery` (`quadflow docs discovery`,
    `resources/quadflow-context/discovery.md`). Skills `kickoff-project`, `organize-projects`,
    `project-summary` keep their names, use the new CLI and are now also in the template.
  - **Removed:** `quadflow-core/src/projects.rs`, `cli/projects.rs`, the discovery `projects` /
    `project_items` tables and CRUD in `database.ts` (incl. the DL-2 `linkIdeaToProject` shim and
    `linkPlanToProject` / `getProjectPlans`), `dbChangeApi.onProjectsChanged`, and the TS
    `DiscoveryProject` / `ProjectItem` / `ProjectStatus` / `ProjectItemType` types (the store
    re-exports the generated ones).
- 2026-10-23 — DL-6 implemented (`domains/{scripts,environments}.rs`, `cli/scripts.rs`,
  `src-tauri/src/commands/scripts.rs`, `src/lib/scriptsData.ts`, `src/lib/environmentUtils.tsx`).
  Recorded decisions and deviations:
  - **Type names** are domain-prefixed for the single specta namespace: `TargetPlatform` (§6.6
    `Platform` clashes with `plugins::Platform`), `ScriptGroupMember`, `ScriptGroupMode`,
    `ScriptGroupMemberInput`, `ScriptResolveOptions`, `ScriptResolvedCommand`.
  - **`terminal_environments.shell_path`** (nullable) added: detected absolute executable
    (e.g. Git Bash's `bash.exe` found next to `git.exe` on `PATH` or under the `%ProgramFiles*%` install dirs — never a
    hardcoded path). The PTY accepts an absolute shell path and `pwsh` / `sh`.
  - **Detection** (`environments_detect`): Windows cmd, Windows PowerShell, pwsh, Git Bash,
    Visual Studio via `vswhere` (fallback: scan of the install dirs; one `vs_dev` env per install, `vcvarsall.bat` path in `vs`);
    macOS/Linux zsh, bash, sh, pwsh (`PATH`, `/etc/shells`). Re-detect upserts built-ins, marks vanished ones
    `available = false`, never touches custom rows, and writes nothing when unchanged.
  - **Resolve** (`scripts_resolve_command(root, id, {platform, defaultEnvironment})`): script
    environment name → this machine's env (missing → `not_found`), else the default environment
    name, else the platform shell; script `shell` overrides; env = environment env + script env
    (script wins); `cwd` validated inside the project. `fullCommand` composes per shell
    (PowerShell 5.1 uses `; `). For `cmd` with env vars the `set`s come first on their own line
    (cmd expands `%VAR%` at parse time); the GUI submits each line.
  - **Settings:** the environment list is no longer a `terminal/environments.*` settings row;
    only `terminal/environments.defaultEnvironmentId` stays. Scripts name environments by name, so
    the default id is mapped to its name before resolving.
  - **CLI:** `quadflow scripts list|get|create|update|delete|tag|untag|pin|unpin|archive|unarchive|
    get-command`, `scripts groups list|get|create|update|delete|add|remove`,
    `scripts env-list|env-get|env-add|env-delete|env-detect`; contract snapshots in
    `tests/cli_scripts.rs`.
  - **GUI:** both Scripts UIs (merge is MIG-scripts) use `scriptsData.ts`; groups run parallel
    (per-member `delayMs`) or sequential (wait for each terminal to exit). Auto-fix: the
    `terminalApi.onData` listener is removed on every exit path and `MAX_WAIT` counts from the
    start of waiting, not from the last output.
- 2026-10-23 — DL-4 implemented (plans). Recorded decisions and deviations:
  - **Layout:** `domains/plans/{model,service,promote}.rs` (+ `tests.rs`) instead of one `plans.rs`.
    Types with generic §6.4 names are prefixed (`PlanSpecKind`, `PlanDecision`, `PlanStepStatus`,
    `PlanStepKind`, `PlanStepEffort`, `PlanStepVerification`, `PlanCommentKind`,
    `PlanLabelStrategy`, `PlanPriorityStrategy`); inputs are `NewPlan`, `PlanPatch`, `NewPlanStep`,
    `PlanStepPatch`, `PlanQuery`. A spec may have empty `content` (the kind is picked first).
  - **`PlanStep.epicId`** (new): with `promotionProfile.createEpics`, a step that has children is
    promoted to an **epic** (issues domain) instead of an issue; descendants' issues get its
    `epicId`. Without `createEpics`, parent steps become parent issues (`parentId`). Promoting a
    step first promotes its unpromoted ancestors. A plan without a profile uses the Plans tool's
    defaults (`createEpics`, `createBlockers`, auto labels/priority, criteria + verification on).
  - **Promotion result:** `promote_step` / `promote_all` return `PlanPromotion { plan, issues, epics,
    created }` (the GUI needs the updated plan; `created == 0` on a repeat — idempotent). An issue
    or epic id on the step that no longer resolves is promoted again. `promote_all` skips
    `skipped` steps. Issue status from step (`completed`→`done`, `in_progress`→`in_progress`,
    else `todo`); labels `auto` = `plan` + step kind, each with `labelPrefix`; priority `auto`
    from step effort; step criteria → structured issue criteria; body = source line,
    description, target files, code context, decisions, verification. `createBlockers` also adds
    a later-promoted dependency to already-promoted dependents' `blockedBy` (open issues only).
  - **Sync:** §6.3 invariant 3 is `plans::sync_step_from_issue_in_tx`, called from
    `issues::apply_status_in_tx`. The reverse also holds: a step status change moves its issue via
    `issues::set_status_in_tx` (skipped when the issue already maps to that step status, e.g.
    `qa` for `in_progress`; `skipped` leaves the issue alone) and its epic's status. A source plan
    or step that no longer exists is ignored. `issues::delete` clears the step's `issueId`.
  - **Auto-transition** additionally moves a `completed` plan back to `executing` when its steps
    are no longer all done. Started/completed timestamps follow step status.
  - **Steps:** `step_delete` re-parents children to the deleted step's parent and removes it from
    `dependsOn`; `steps_reorder` puts the listed ids first, unlisted steps keep their order.
    `list` is newest first and filters by `PlanQuery { statuses, ideaId, discoveryId, text }`.
  - **CLI:** `quadflow plans list|get|create|update|delete|step-add|step-update|step-delete|
    steps-reorder|comment|comments|comment-delete|promote [--step]`. `step-update`/`step-delete`
    take a bare step id (`--plan` optional). Kept skill-era aliases: `create --title`,
    `--idea-id`, `--step-type`, `--estimated-effort`, `--parent-step-id`, `--spec-type`,
    `--comment-type`; `comment --author` overrides the actor name. `""`/`none` clears.
    Contract snapshots in `tests/cli_plans.rs`.
  - **Frontend:** `src/lib/core/plans.ts` maps core plans to the existing view models in
    `types/index.ts` (`Plan.projectId` → `discoveryId`, `Plan.issueId` dropped,
    `PlanStep.promotedEpicId` added); `planStore` binds with `issues_open` and refetches changed
    plans on `data-changed` (`plans`), which is how a Kanban move shows up on the step. The
    legacy `db.updatePlanStep` sync in `issueStore` is gone, as is every plan function in
    `database.ts`. Discovery (DL-5) links plans through `Plan.discoveryId`
    (`plans update --discovery <id|none>`, `PlanPatch.discoveryId`); its raw-JSON plan reads
    match this schema and can move to `plans::list`.
- 2026-10-23 — DL-11 implemented (cutover). Recorded decisions and deviations:
  - **Deleted:** `src/lib/database.ts`, `src/lib/fileStore.ts`, `@tauri-apps/plugin-sql`,
    `tauri-plugin-sql` (Cargo, `lib.rs`, `sql:*` capabilities), `quadflow-core/src/legacy.rs`
    and every DL-1 shim (`PROJECT_OVERRIDE`, the old CLI helpers, the project init inside
    `scaffold_claude_config` — `projects_open(init_if_missing)` does it), `dbChangeApi`, and the
    `legacy-quadflow.db` file. `diagnostics`/`native_embed` use `AppPaths`;
    `youtube_promote_to_issue` and the diagnostic bundle use `CoreState::active_project_root()`;
    `web_bookmarks` wrote `.quadflow/web_bookmarks.json` itself (deleted with the commands in
    API 1.4; the Web Preview plugin keeps bookmarks in its plugin storage since MIG-web-preview).
  - **`IssuePatch.ext`** (new): plugin extension data merged per key; a key set to `null` is
    removed (`issues::update_in_tx`). The GitHub integration (now `plugins/github`) keeps issue linkage in
    `ext.github` (`repoId`, `id` — GitHub's node id, a string —, `number`, `url`, `syncStatus`,
    `lastSyncedAt`, `importedCommentIds`). Imported GitHub comments become ordinary issue
    comments, deduped through `importedCommentIds`; closed GitHub issues import as `done`.
  - **GitHub repos and checkpoints** lived in core settings (namespace `github`, key
    `repositories`; namespace `github.checkpoints`) at DL-11. Since MIG-github they are the GitHub
    plugin's kv (`plugin_kv`, plugin-system.md §6.6): key `repositories` (global scope) and
    `checkpoint:<id>` (project scope); nothing reads the `github*` settings namespaces any more.
  - **Team Dashboard dropped** (ROADMAP §8): `TeamDashboardView`, `teamStore`, `types/teams`,
    `get_native_teams`/`get_native_tasks` deleted. It was unreachable; the team badges in
    Kanban / issue detail / Plans read `teamLaunches`, which only the dashboard filled.
  - **Kept:** the name-routed invoke split (typed tauri-specta handler vs. `generate_handler!`).
    Every data domain is typed; the untyped table holds only shell/native commands (terminals,
    windows, diagnostics, streamer/discord/obs, semantic search) until MIG-*. The `fs:*`
    capabilities stay (file explorer, editor, `.claude` config editing use plugin-fs); narrowing
    them belongs to PL-3 (scoped plugin fs).
  - **Contract snapshots:** `".**.blockedBy[]"` / `".**.dependsOn[]"` matched every top-level
    array element (insta's deep-wildcard matcher only compares the selector's tail), so list
    snapshots in `cli_issues` / `cli_plans` were `["[id]", …]`. They now use a dynamic redaction
    on `.**.blockedBy` / `.**.dependsOn`; snapshots updated.
  - **Auto-save:** DL-10's `workspaceSave` controller (signature-gated `scheduleSave`) already
    fixed the ~1/s `debouncedSave` retrigger: with Ideas/Issues/Plans/GitHub tiles open, no
    `workspaces` change event fires while idle (checked in the dev app).

---

## 15. QuadFlow 1.x (the one compatibility exception)

`quadflow-core/src/import_v1/` is the only code that knows the 1.x formats. It does two things:

- **Project list import** (`import_v1::run`). Reads the 1.x app DB
  (`<platform data dir>/com.quadflow.app/quadflow.db`, table `projects`) from a temporary copy and
  registers every project folder (1.x name kept) in `projects`. Missing folders are skipped. The
  project that was active in 1.x becomes active when none is. Nothing else is imported: app
  settings, workspaces/layouts, tool configs, prompts and plugin data start at the defaults.
  State: setting `importV1/state` = `{status: completed|dismissed, at}` (the GUI offers the import
  on first run until it is set). Dry run lists what would happen. `QUADFLOW_V1_DATA_DIR` overrides
  the 1.x location; the dev profile reads **only** that override, never the real installation.
- **1.x project folders** (`import_v1::legacy`). A `.quadflow/` is 1.x when its `config.json` is a
  JSON object without `formatVersion`, or, with no `config.json`, `labels.json` is an array or a
  collection dir holds a non-ULID `*.json` (an unparseable `config.json` is never treated as 1.x).
  When the GUI opens such a project (`import_v1_check_project`, called before `projects_open` and
  the domain stores' project open), when a CLI command runs in it (the folder itself or
  `--project` / `QUADFLOW_PROJECT_DIR`; a 1.x folder found further up the walk is only pointed out),
  or when it is imported, release builds rename it to `.quadflow-v1-backup/` (`-2`, `-3`, … if
  taken; never deleted or overwritten) and create a fresh `.quadflow/`; the user is told where the
  backup is (GUI toast, CLI stderr warning + `warnings[]` in `--json`). The 1.x content is not
  converted. Dev builds write only `.quadflow-dev/`, so they report a 1.x `.quadflow/` and leave it.

Surfaces: CLI `quadflow import-v1 [DIR]... [--all] [--dry-run] [--json]`; Tauri commands
`import_v1_detect`, `import_v1_run`, `import_v1_dismiss`, `import_v1_check_project`; GUI first-run
dialog and Settings → Advanced → "Import from QuadFlow 1.x…".
