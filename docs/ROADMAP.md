# QuadFlow — Open-Source Product Plan

**Source of truth.** Created 2026-10-22 from four codebase audits (open-source readiness,
licensing/auth/support removal, tool inventory, bug hunt). Not mirrored into QuadFlow Plans.

This describes **one finished product**. There are no intermediate releases and **no backwards
compatibility**: no data migrations, no legacy env vars, no QuadCode→QuadFlow shims, no old
schemas. Existing local data may be thrown away. Work is listed by area, with a build order at the
end that exists only because some work depends on other work.

---

## 1. Decisions

| Topic | Decision |
|---|---|
| License | **AGPL-3.0**, contributors sign a **CLA** (keeps dual/commercial licensing possible) |
| Repo | **One public repo** for source + releases + updater + model catalog + official plugins. Git history squashed to a fresh initial commit before going public. |
| Platforms | **Windows, macOS, Linux** — all first-class |
| CI/CD | **None hosted.** No GitHub Actions. All checks run locally (`npm run check`, `npm run test:e2e`); releases are built locally (ship pipeline) and pushed/uploaded to GitHub. |
| Data | **One data layer in Rust** (`quadflow-core`). GUI, CLI and plugins all go through it. The TS data layer is deleted. |
| Licensing / login / support | **Removed entirely.** No accounts, no tiers, no feature gates, no phone-home. |
| App identifier | `io.quadslab.quadflow` (release), `io.quadslab.quadflow.dev` (dev builds) — from quadslab.io |
| Public repo | `HardHeadHackerHead/QuadFlow` (created **private** 2026-10-23, empty — nothing pushed; flip to public at launch). `quadflow_core::urls::REPO` |
| Contact email | `quad@quadslab.io` — the single address for all project contacts (conduct, security, CLA, etc.) |
| Auto-updater | **Kept**, pointed at the public repo's releases, new signing key |
| Model catalog | A file in the public repo (e.g. `catalog/models.json` on the default branch), fetched raw |
| Extensibility | **Plugin system.** Every tool — including Ideas/Issues/Plans — is a plugin. Agents (Claude, Codex, …) are **agent-provider plugins**. |
| Official plugins | **Monorepo `/plugins`**; its index is the built-in plugin source and the example for third-party sources |
| Heavy AI | Local title generation (llama_cpp) and semantic search (candle) become **optional plugins** with sidecars; core never compiles them |
| Discord bridge | Becomes a plugin structurally, **on hold** — not required to work for launch |

---

## 2. Target architecture

```
quadflow (one binary: no args → GUI, args → CLI)
├── quadflow-core (Rust lib)         ← the ONLY place data, schemas and business logic live
│   ├── store/      per-project .quadflow/ files + app-level SQLite, atomic writes, locking
│   ├── domains/    ideas, issues, plans, projects, scripts, ship, chat, missions
│   ├── plugins/    manifest parsing, registry, sources, permissions, sidecar host
│   └── cli/        clap tree; plugins can register subcommands
├── src-tauri (shell)                ← windows, PTY, native integrations, thin command layer
└── src (React shell)                ← layout/mosaic, terminals, plugin host, settings, onboarding
    └── @quadflow/plugin-api + @quadflow/ui (published packages plugins build against)

/plugins                             ← official first-party plugins + index.json (plugin source)
/catalog/models.json                 ← model catalog
```

### Data layer (one, in Rust)
- Delete `src/lib/database.ts` (~5.5k lines) and `src/lib/fileStore.ts`. Frontend stores call typed
  Tauri commands; types generated from Rust (`ts-rs` or `specta`) so TS and Rust can't drift.
- Fresh schema, designed once: no `projects` name collision (working-dir projects vs discovery
  projects get distinct names), one `config.json` shape, camelCase JSON on disk everywhere.
- Storage split: project data in per-project `.quadflow/` files (shareable via git); app-level state
  (workspaces, layouts, settings, plugin state) in one SQLite DB with `busy_timeout` + WAL.
- Writes are atomic (unique temp name, fsync, rename with Windows retry); singleton read-modify-write
  never resets a file on parse error; display numbers allocated under a lock; ids validated (no path
  traversal); parse errors surface instead of being skipped.
- Change notifications: core emits events directly (GUI writes) and a file watcher covers external
  writes (CLI/agents/git pull). Replaces `db_watcher.rs` polling and its missed-event race.
- CLI walks up from cwd to find `.quadflow/`; project code (e.g. `QC`) comes from config, not hardcoded.
- Contract tests: every domain round-trips through the core API, CLI JSON, and generated TS types.

### Plugin system
- **Manifest** `quadflow-plugin.json`: id, name, version, icon, `apiVersion`, `platforms`,
  contributions (tile, flyout, settings page, toolbar/quick-access, command-palette commands,
  context menu items, CLI subcommands, agent context docs, agent provider), permissions, sidecar.
- **One registry** derived from manifests replaces the 8 hand-maintained tool registries
  (`ToolType` union, ToolTileContent, ToolFlyoutPanel, toolIcons, toolGroups, seeding, toolFeatures,
  ToolConfigModal). Inconsistent-registration bugs disappear as a class.
- **Host API** `@quadflow/plugin-api` (typed, semver'd): lifecycle; project/workspace context;
  domain data (ideas/issues/plans/scripts/chat/missions) through core; terminals/PTY (spawn, write,
  read, attach); events (data changes, project/workspace switch, inter-plugin); scoped storage;
  settings; notifications; scoped fs + shell; overlay/z-order awareness for native views; launch agents.
- **UI kit** `@quadflow/ui`: theme tokens + shared components so plugins look native and follow
  light/dark/theme changes.
- **Agent surface**: plugins contribute `quadflow <plugin> …` CLI subcommands and context docs, so
  agents can use plugin features the same way they use core ones.
- **Isolation**: first-party plugins load same-context; third-party plugins run in a sandboxed iframe
  with postMessage RPC. Same API both ways.
- **Permissions** declared in the manifest, approved on install, re-approved when an update adds any,
  enforced on the Rust side (not just in JS).
- **Sidecars**: any language, JSON-RPC over stdio, lifecycle managed by core (start, restart on crash,
  stop with app), shipped per-platform inside the plugin — never located via compile-time paths.
- **Platform filtering** from `platforms`: Windows-only plugins don't appear on macOS/Linux.
- **Plugin sources**: a source is any git repo with an `index.json`. The monorepo `/plugins` is the
  built-in source. Settings → Plugins: add/remove sources, browse, install, enable/disable, update
  (with permission diff), uninstall. Update checks on startup + on demand.
- **Authoring**: `create-quadflow-plugin` template, dev mode (load from a folder, hot reload),
  plugin author docs, API reference generated from types.

### Agent providers (plugins)
- Interface: detect installed CLI, launch command, model list (from catalog), model flag (validated
  ids only), session id assignment/discovery, resume, usage/limits, context-file name
  (`CLAUDE.md` / `AGENTS.md` / …) for context modules.
- Ship Claude Code and Codex as first-party providers. Remove all hardcoded Claude/Codex logic from
  core (`launchAgent.ts`, `useAIModels.ts`, `sessionPolling.ts`, usage monitor, `claude.exe` paths).
- Model catalog validates ids (`^[A-Za-z0-9._:\[\]-]+$`) — currently an unquoted id is written into the
  PTY, which allows command injection from a bad catalog.

---

## 3. Core app (the shell that's left when every tool is a plugin)

### Terminals
- **Copy bug:** `TerminalView.tsx:79` hardcodes `windowsPty.buildNumber: 19041`, enabling xterm's
  legacy ConPTY wrap heuristics → hard newlines at every wrap when copying. Use the real OS build,
  set `windowsPty` only on Windows. (Agent TUIs that hard-wrap their own output can't be fixed
  terminal-side.)
- PTY backend (`terminal.rs`): async commands (no main-thread blocking on write/resize/kill); don't
  hold the global lock while writing; per-spawn generation token so exit events from a reused id
  don't kill the new terminal; atomic check+insert on attach; actually kill the process tree (Job
  Object on Windows, process group on Unix); detect exit with `try_wait`/waiter; carry incomplete
  UTF-8 bytes across reads; platform default shell (`$SHELL -l` on Unix) and home dir.
- Terminal theme from settings/theme tokens (currently hardcoded colors).
- Persist lock state; global-scope terminals handled correctly across switches.

### Projects & workspaces
- Fix save races: no stale `activeSession` across awaits, cancel pending debounced save on switch,
  suppress saves during restore, generation counter for overlapping restores/switches,
  transactional layout save, awaited save on exit.
- Startup reads fresh store state after each await (`App.tsx:181-201`).
- Normalized path comparison for project lookup (`C:\Foo`, `c:/foo/` are one project).

### App shell
- No `AuthGate`; app opens straight to the workspace.
- **First-run onboarding:** detect agent CLIs via provider plugins, pick/create a project, install
  the `quadflow` CLI on PATH, choose plugins.
- Optional modules can't crash startup (`lib.rs:1918-1980` `panic!`s become disabled states).
- React listener hygiene: disposed-flag pattern everywhere `listen()` is awaited.
- Real CSP in `tauri.conf.json` (currently `null`); no `devtools`/`unstable` in release builds.
- Split `lib.rs` (2.4k lines) into modules; nothing over ~1.5k lines.
- Local diagnostics (crash logs, diagnostic bundle) kept; no upload.

### CLI
- Same binary, same core. Non-zero exit on failure including `--json`; invalid enum values rejected;
  `issues close` actually closes; no slicing panics; plugin-contributed subcommands.

---

### Dev isolation & agent-driven GUI testing
- **Dev builds never touch real data:** dev builds use identifier `io.quadslab.quadflow.dev`, their own
  app-data dir, and a per-project `.quadflow-dev/` folder, so a dev build can run side by side with an
  installed QuadFlow without reading or writing its data. Agents test against a scratch project.
- **Agent GUI automation (dev builds only):** WebView2/WebKit remote debugging enabled only in dev
  builds; a `scripts/ui` Playwright harness lets an agent launch the isolated dev build, click, type,
  read the DOM, screenshot and collect console/Rust logs. Never enabled in release builds.
- **E2E smoke tests** (`npm run test:e2e`, run locally) built on the same harness (launch → open project → terminal type/copy →
  workspace switch → open each plugin), Windows + Linux.
- Plugin dev mode reuses the harness so plugin authors can test their plugins the same way.

---

## 4. Plugins to ship

Every current tool becomes a plugin and is finished as part of that. Nothing is ported as-is.

| Plugin | Notes / what "finished" means |
|---|---|
| **Claude Code** (agent provider) | Session id pre-assignment, resume, usage, models from catalog |
| **Codex** (agent provider) | Session discovery without double-claim races; iterative polling |
| **Ideas** | Merge, tags, categories via core |
| **Issues** | Kanban, epics, labels, dependency graph; CLI parity verified by contract tests |
| **Plans** | Spec → decompose → promote; step↔issue sync |
| **Projects** (discovery) | Own schema, no collision with working-dir projects |
| **Scripts** | **One** UI (merge `ScriptsToolView` + `ScriptLauncherToolView`), script groups UI, environments; auto-fix without listener leak/hang |
| **Ship** | Generic release pipeline; unknown project type fails loudly (no `echo TODO build command`) |
| **Chat** | |
| **Missions** | **One** UI (merge `MissionControl` + `MissionDashboard`); agent prompts use `quadflow missions …` CLI, not removed MCP tools; decide Team Dashboard (re-wire into Missions or drop) |
| **GitHub** | Repos/branches/PRs/commits/releases/checkpoints |
| **Code Quality** | |
| **Editor** | Pane-only, opened on demand |
| **Web Preview** | Works in pane and flyout; bookmarks; screenshot |
| **Usage Monitor** | Driven by agent-provider usage interface, not hardcoded `cmd /C claude` |
| **App Launcher / Window Link / Native Embed** | Merge into one "External apps" plugin (Windows-first). Embed: hide under overlays, per-instance hwnd, no flyout mode, `SendMessageTimeout`/async Win32, correct owner-vs-parent on detach, detach on exit/update-relaunch, only accept embedded hwnds |
| **TUI tool** | Generic "run a TUI in a tile" |
| **Semantic Search** | Optional plugin, embedding sidecar |
| **Local Titles** | Optional plugin, llama_cpp sidecar (GPU builds per platform); core falls back to API titles |
| **Streamer kit**: YouTube Live (+ Slot Machine), YouTube Shorts, OBS tracker | Optional plugins. Split `youtube_live.rs` (8k lines); fix `peak_concurrent_chatters`, `gen_range(0..0)` panic, password-mask slicing; OBS device listing on macOS/Linux or declare Windows-only |
| **Discord bridge** | Converted to plugin structure, **on hold** — not required to work for launch |

---

## 5. Removed

**Status: done** (verified 2026-10-24 by MIG-Z / cleanup, see §9; the last leftovers —
`GlobalWorkspaceButton/Manager`, `multiagentStore`, root `QuadCode *.png`, the `promo/` video project,
`.claude/.quadcode-version` — were deleted then).

- **Licensing:** `src-tauri/src/license.rs`, `quadcode-core/src/license.rs`, the 8 `require_feature`
  guards in `cli.rs`, `features.ts`, `toolFeatures.ts`, every `ProFeatureOverlay`/`useFeature` branch
  and "upgrade at quadslab.io" string, deps `machine-uid`, `sha2`, `hex`, `hostname`,
  `ed25519-dalek`, `serde_jcs`.
- **Auth:** `components/auth/`, `authStore.ts`, account sections of `SettingsMenu.tsx`.
- **Support:** `support.rs`, `supportStore.ts`, `SupportTicketFlyout.tsx`, `supportApi`, ticket types,
  `ide_reports`.
- **All backwards-compat code:** `migrate_from_quadcode`, `.quadcode` → `.quadflow` dir migration,
  `QUADCODE_*` env fallbacks, `.quadcode.legacy*/`, `legacy_mcp.rs` + `legacy-mcp-reference`,
  `.mcp.json` cleanup on project open, retired-tool-type deletion code, all TS schema migrations.
- **Dead code:** ~~`TeamDashboardView`/`teamStore`/`types/teams`/`get_native_*`~~ (deleted in DL-11),
  `multiagent/` + `taskStore` + `multiagentStore`, `GlobalWorkspaceButton/Manager`,
  `AccountMenu.tsx`, `workspaces`/`custom` tool types, `quadcode-core/src/ideas.rs` placeholder,
  `tools/tui/`, the duplicate Scripts and Missions UIs (after merge).
- **Owner-specific release tooling:** `scripts/build-release.ps1/.sh`, `release.mjs`, `release.bat`,
  `sign-quadflow.ps1`, `build.bat`, `launch.bat`, `.quadflow/ship/*` for this repo, qwick/qwickcert
  references in the claude template.
- **Private/internal files:** `youtube-key.json` (**rotate the key**), `quadcode.db`,
  `C:tempfirst100lines.jsonl`, `.claude/settings.local.json`, `.mcp.json`, personal `.quadflow/` data,
  `docs/licensing-*`, `docs/quadcode-*`, `docs/quadslab-*`, `docs/security-posture-and-crackability.md`,
  `docs/website-agent-briefing.md`, `WEBSITE_AUDIT.md`, `PLAN.md`, `scripts/*rebrand*`/`migrate_skills`.
- **Naming leftovers:** rename `src-tauri/quadcode-core/` → `quadflow-core/`, asset files, every
  remaining `quadcode` identifier.

---

## 6. Repo, build, release

- `LICENSE` (AGPL-3.0), license fields in all manifests, CLA (signed in the PR description, recorded in `CLA-SIGNATURES.md`), `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue/PR templates, `CHANGELOG.md`.
- README: what it is, screenshots/GIF, install, build per OS (prereqs: Rust, Node, WebView2 /
  webkit2gtk), architecture overview, plugin authoring link.
- Docs: user docs per plugin, plugin author guide, API reference. Split CLAUDE.md into contributor
  guide + agent guide.
- Fresh clone builds with zero setup beyond prereqs: sccache/lld-link opt-in (not forced in
  `.cargo/config.toml`), no MSVC/CUDA needed for core, no `full` feature in core.
- **Local checks, no hosted CI:** `npm run check` (typecheck, web build, cargo check, core tests,
  bindings drift, clippy; plugin builds + index drift once PL-11 lands) and `npm run test:e2e`.
- **Releases built locally** with the ship pipeline (`quadflow ship`) on the maintainer's machine:
  NSIS (Windows) now; dmg / AppImage + deb when built on those OSes. Updater `latest.json` +
  signatures generated by the pipeline and uploaded to the repo's GitHub Releases; release notes
  from the changelog. Signing (Authenticode, notarization) is an optional local pipeline phase.
- Fix the `Cargo.toml` mojibake (caused by the old PowerShell bump script); version bumps done by the
  ship pipeline (preserves UTF-8).
- Rewrite the 43 template skills that contain mangled `mcp__quadcode__*` text; the claude template
  allows only `Bash(quadflow:*)` and generic commands; repo `.claude/skills` and template in sync.
- Tests: vitest for frontend stores/lib; Rust tests for core domains, store, PTY; tests never touch
  the real user DB (temp dirs); a smoke E2E (tauri-driver) for launch → open project → terminal.

---

## 7. Build order (dependencies only — no stopping points)

1. Commit current WIP on a branch; strip private files; rotate the YouTube key.
2. Remove licensing/auth/support and all backcompat code (simplifies everything after).
3. Rust data layer + generated types; delete TS data layer.
4. Plugin runtime: manifest, registry, host API, UI kit, permissions, sidecar host, sources.
5. Core shell fixes (terminals, workspaces, onboarding, CSP) — can run alongside 3–4.
6. Agent-provider plugins (Claude, Codex), then the rest of the plugins in Section 4.
7. Repo/release/docs (Section 6) — local release pipeline last.
8. Squash history, publish the single public repo, first release.

---

## 8. Open questions

- ~~Team Dashboard: fold into Missions or drop?~~ Dropped in DL-11: unreachable, and nothing live
  depended on it (`TeamDashboardView`, `teamStore`, `types/teams`, `get_native_*` deleted).
- Is "QuadFlow" the final public name (trademark/domain check before launch)?

---

## 9. Progress log

Work happens on the `oss` branch (`main` is untouched as a fallback). Agents work in isolated
worktrees and are merged into `oss`.

- 2026-10-22 — `oss` branch created; WIP committed (21778fd). Private/personal/stale files stripped
  (3d3f575) — personal `.quadflow/` data, local settings and `youtube-key.json` untracked but kept on
  disk. **User action: rotate the YouTube API key.**
- 2026-10-22 — Wave 1 dispatched: (a) remove licensing/auth/support + backcompat, (b) repo
  scaffolding (LICENSE, CLA, README, CI, fresh-clone build), (c) architecture specs
  (`docs/architecture/`), (d) terminal copy bug + PTY backend.
- 2026-10-22 — Wave 1 merged into `oss`: repo scaffolding (AGPL LICENSE, CLA, README, CI,
  fresh-clone build), terminal fixes (copy-wrap bug, PTY backend rewrite), licensing/auth/support +
  backcompat removal (~14.7k lines), architecture specs (`docs/architecture/`, work packages
  DL-*/PL-*/AP-*/MIG-*). Worktrees removed after merge.
- 2026-10-22 — Wave 2 dispatched: DL-1 (data-layer foundation + dev-profile isolation), PL-5
  (`@quadflow/ui`), QA-1 (agent GUI automation harness + smoke E2E).
- 2026-10-22 — Merged into `oss`: QA-1 GUI harness (`scripts/ui/`, not yet run against the real app —
  blocked on DL-1 isolation), PL-5 `@quadflow/ui` (light/dark/system themes). Identifiers set to
  `io.quadslab.quadflow` / `.dev`; contact `quad@quadslab.io`.
- **Resume point (session restart):** DL-1 is in progress on branch `worktree-agent-a92e229f893b23e92`
  (worktree `.claude/worktrees/agent-a92e229f893b23e92`), checkpointed as a `DL-1 WIP:` commit whose
  body lists remaining work. To resume: finish DL-1 from that branch (incl. routing every data path in
  the Tauri crate through the core Profile, honoring `QUADFLOW_PROJECT_DIR` in dev, identifiers
  `io.quadslab.quadflow[.dev]`), merge into `oss`, remove the worktree, run the QA-1 smoke test
  against the real dev app, then dispatch Wave 3: DL-2…DL-10 + PL-1 (see docs/architecture/README.md).
  An empty leftover dir `.claude/worktrees/agent-a8024aee9d65b6787` can be deleted.
- 2026-10-23 — DL-1 merged (data-layer foundation, dev-profile isolation verified end-to-end, typed
  specta bindings in `src/generated/bindings.ts`). First real GUI smoke test passed 4/4 against the
  isolated dev exe. Window title fixed (QuadCode → QuadFlow).
- 2026-10-23 — Wave 3a dispatched: DL-3 Issues, DL-10 App domain, PL-1 Manifest + registry, DL-2
  Ideas, DL-6 Scripts. (Wave 3b next: DL-4, DL-5, DL-7, DL-8, DL-9.) Batched to limit disk/CPU from
  parallel cargo builds.
- 2026-10-23 — Merged PL-1 (plugin manifest/schema/registry/CLI) and DL-2 (Ideas on core).
- **Resume point (usage limit):** DL-3 Issues, DL-10 App domain and DL-6 Scripts were told to commit
  `WIP:` checkpoints on their worktree branches (`git worktree list`) and stop. Resume each from its
  branch (commit body lists remaining work), merge into `oss` (registration-point conflicts: keep both
  lines; regenerate bindings via the export test; take either Cargo.lock then cargo rebuilds it), remove
  merged worktrees. Then Wave 3b: DL-4, DL-5, DL-7, DL-8, DL-9; then PL-2. Agent preamble template:
  common rules in the session scratchpad `preamble.md` (recreate from this roadmap if lost).
  Note: run `npm run build:dev-exe` before `npm run test:e2e` (export test overwrites the debug exe).
- DL-10 (App domain) is FINISHED on branch `worktree-agent-a47271d60c71059b3` (6730d0c, all checks +
  GUI workspace test passed) but NOT merged: merge with oss conflicts in data-layer.md §14 (keep both
  changelog entries), bindings.rs / commands/mod.rs (keep both), generated bindings.ts (regenerate),
  and src/lib/database.ts (both DL-2 and DL-10 deleted different functions — keep both deletions).
  Its workspace regression script `ws.test.mjs` is in the session scratchpad — add to scripts/ui.
- DL-3 (Issues) is FINISHED on branch `worktree-agent-adcec427e0cd3cf77` (638c975, all checks + GUI
  Kanban/live-CLI test passed) but NOT merged — same conflict pattern as DL-10. Known bug it found:
  `App.tsx` `debouncedSave` depends on `activeSession` and re-triggers every ~1s (DL-10 may fix; verify).
- DL-6 (Scripts) was told to checkpoint `DL-6 WIP:` on `worktree-agent-a85c56d29d0a0ab87`.
- 2026-10-23 — Merged DL-3 (Issues) and DL-10 (App domain incl. workspace save/switch race fixes)
  into `oss`. Fixed specta type-name collisions (app-domain `ToolOpenMode`/`ToolPinDisplay`/
  `AppPinSection`) and a flaky ms-timestamp test.
- 2026-10-23 — Wave 3b dispatched: DL-6 Scripts (resumed), DL-4 Plans, DL-5 Discovery, DL-7 Ship,
  DL-8 Chat, DL-9 Missions (incl. rewriting mission agent prompts off the removed MCP tools).
  Next: DL-11 cutover (delete database.ts/fileStore.ts/tauri-plugin-sql), then PL-2 / AP-1.
- 2026-10-23 — All data domains merged into `oss`: DL-4 Plans, DL-5 Discovery, DL-6 Scripts,
  DL-7 Ship, DL-8 Chat (OS-keyring secrets), DL-9 Missions (agent prompts now use the `quadflow`
  CLI — no `mcp__quadcode` strings left in `src/`). 180 core unit tests + all integration suites,
  tsc and web build green on `oss`.
- 2026-10-23 — Wave 4 dispatched: DL-11 cutover (delete database.ts / fileStore.ts / plugin-sql /
  legacy.rs), PL-2 plugin protocol + trusted loader + hello plugin, AP-1 agent-provider framework
  (catalog at `catalog/models.json`, launch quoting, session claims, context files).
- 2026-10-23 — Merged DL-11 (old TS data layer, plugin-sql, legacy.rs, Team Dashboard deleted) and
  PL-2 (qfplugin:// protocol, real CSP without unsafe-eval, shared-module import map, trusted loader,
  `plugins/hello`). Running: AP-1 agent framework, PL-9 plugin sources/install UI, PL-3 host API +
  permissions, PL-4 one tool registry (`legacy` plugin wraps all current tools), PL-11 monorepo wiring.
- 2026-10-23 — Merged AP-1 (agent-provider framework: catalog at `catalog/models.json`, per-shell
  launch quoting, FIFO session claims, context writer). Fixed terminal `initCommands` being silently
  dropped (camelCase serde). Repo URLs → `HardHeadHackerHead/QuadFlow`; repo created private & empty.
  TODO (release work): new updater signing keypair — tauri.conf.json still has the old pubkey.
- 2026-10-23 — User decision: **no hosted CI/CD**. Deleted `.github/workflows/` (ci.yml, cla.yml);
  added `npm run check` (scripts/check.mjs); CLA is signed in the PR description and recorded in
  `CLA-SIGNATURES.md`. Releases are built locally and pushed.
- 2026-10-23 — Merged PL-11 (root Cargo + npm workspaces, `/target`, plugin bundler, generated
  `plugins/index.json`) and PL-9 (plugin sources, sha256-verified install/update/rollback/uninstall
  with consent + permission diff, Settings → Plugins). `npm run check` green on `oss`. Disk filled to
  100% — deleted orphaned build dirs; max 2–3 parallel agents from now on. Dispatched a startup-perf
  fix (first IPC call took ~15 s). Running: PL-3 host API, PL-4 one tool registry.
- 2026-10-23 — Merged PL-3 (host API + Rust-enforced permissions). **Resume point (login switch):**
  in flight on worktree branches (see `git worktree list`; each has a `<WP> WIP:` commit listing
  remaining work): PL-4 one tool registry, startup-perf fix (first IPC ~15 s), PL-7 sidecars. Resume
  each from its branch, merge, remove worktree. Next: AP-2 Claude Code + AP-3 Codex provider plugins,
  PL-6 sandbox, then PL-8/PL-10/AP-4/AP-5, then MIG-* tool conversions (max 3 agents at once — disk).
- 2026-10-24 — Merged startup-perf fix (first IPC 8–22 s → 2–4 ms), PL-4 (one tool registry from
  plugin manifests; `plugins/legacy` + `legacy-windows` wrap not-yet-migrated tools; `ToolType`
  deleted) and PL-7 (plugin sidecars + Rust/Node SDKs). Dev exe no longer rewrites generated
  bindings unless `QUADFLOW_EXPORT_BINDINGS` is set. `npm run check` + e2e 4/4 green.
  Running: AP-2 Claude Code plugin (resumed), AP-3 Codex plugin (resumed), PL-6 sandbox runtime.
  Then: PL-8 CLI contributions, PL-10 authoring, AP-4 remove hardcoded agents, AP-5 Usage Monitor,
  MIG-* tool conversions, MIG-Z, polish.
- 2026-10-24 — Merged AP-3 Codex plugin, AP-2 Claude Code plugin (50 skills rewritten, no MCP
  leftovers; plugin settings pages), PL-6 sandboxed runtime. Interim provider specs now empty.
  Known: sandbox e2e suite fails on merged oss (timeout opening hello) — PL-6 agent fixing, plus the
  CommandPalette Enter/Escape bug. Security note (PL-6): WebView2 injects inert Tauri internals into
  sandboxed frames; IPC is blocked by CSP + `Origin: null` rejection; e2e side-effect test guards it.
  Running: PL-8, AP-4, PL-6 fix, AP-5 Usage Monitor plugin, PL-10 authoring kit.
- 2026-10-24 — Merged PL-6 fix (palette refresh + Enter/Escape), PL-8 (plugin CLI commands + context
  docs), AP-5 (Usage Monitor plugin, `ctx.agents.usage`), AP-4 (every launch via providers; no
  hardcoded agent code in core/shell — enforced by `scripts/check-agent-literals.mjs` in `npm run
  check`). Toast stack mounts at startup. Running: PL-10 authoring kit, MIG pilot (ideas +
  discovery, writes docs/plugins/migrating-a-tool.md), local release pipeline. Next: MIG-* wave
  using the pilot pattern (lightweight worktrees + Load unpacked once PL-10 lands).
- 2026-10-24 — Merged the MIG pilot: Ideas + Discovery are first-party plugins (public API only),
  removed from `legacy`; plugin API 1.1.0 (`data.ideas.bulkTag`, `contributes.paletteProviders`);
  recipe in `docs/plugins/migrating-a-tool.md`. Extracted `@quadflow/plugin-kit` (shared live
  collections + agent launch). MIG wave started (disk-limited to 2 at a time): MIG-issues,
  MIG-scripts (one UI). Still running: PL-10 authoring kit, local release pipeline.
- 2026-10-24 — Merged PL-10 (`@quadflow/plugin-build`, `create-quadflow-plugin` with 5 templates,
  Load unpacked + hot reload, `docs/plugins/` author guide). Platform phase complete.
  Conversion wave switched to **lightweight mode** (`scratchpad/mig-lite.md`): agents build no Rust,
  test their plugin as a dev plugin against one frozen dev exe built from oss, and report host-API
  gaps for a single batched core pass. Running: MIG-issues, MIG-scripts (full mode); MIG-plans,
  MIG-missions (one UI), MIG-ship + chat, MIG-github + code-quality, MIG-editor + tui + web-preview
  (lite); local release pipeline. Remaining after: external-apps, semantic-search, local-titles,
  streamer kit, discord (structure, on hold), API-gap batch, MIG-Z, polish.
- 2026-10-24 — Merged MIG-plans, local release pipeline (`npm run release`, `release:key`,
  docs/RELEASING.md), MIG-ship + chat, MIG-missions (one UI), MIG-github + code-quality, MIG-scripts
  (one UI; API 1.2.0). Disk hit 100% once — freed by deleting finished agents' build output.
  Running: MIG-issues (full), MIG-editor + tui + web-preview (lite), host-API gap batch (full; list
  in scratchpad api-gaps.md → API 1.3.0), MIG-external-apps (lite + sidecar), MIG-streamer kit
  (lite + sidecars). Remaining: semantic-search, local-titles, discord structure, MIG-Z, polish.
- 2026-10-24 — Merged MIG-editor + tui + web-preview and MIG-issues; core no longer bundles any
  domain agent docs (all live in plugins). `npm run check` green; e2e 83/84 (one editor check
  flaky only in the full-suite run — passes alone; for final QA). Running: host-API gap batch,
  MIG-external-apps, MIG-streamer kit, MIG-semantic-search (optional plugin; removes candle from
  core), MIG-local-titles + discord structure (removes llama_cpp + discord_bridge from core).
  Remaining after these: MIG-Z (delete `legacy` wrappers + leftover shell tool code), polish.
- 2026-10-24 — Merged MIG-external-apps (one Windows plugin + Win32 sidecar; found/fixed missing
  WS_CLIPSIBLINGS so embedded windows actually draw) and MIG-streamer (YouTube Live / Shorts / OBS
  as optional unbundled plugins with sidecars; `legacy-windows` gone; obws out of core).
  `npm run check` + e2e 107/107 green. Running: host-API gap batch, MIG-semantic-search,
  MIG-local-titles + discord, first-run onboarding. Then: MIG-Z, cleanup/rename, final QA.
- 2026-10-24 — All tool conversions merged: MIG-local-titles + discord (structure, on hold) and
  MIG-semantic-search. Core default features are now `[]` — no candle, llama.cpp, obws or YouTube
  code in the app; workspace compiles with zero warnings. `npm run check` green; e2e 110/114 (4
  failures in optional-plugin tests — local-titles, youtube-live — fix agent running).
  Running: host-API gap batch (→ API 1.4.0), onboarding, e2e fix. Then: MIG-Z, cleanup/rename,
  final QA.
- 2026-10-24 — Merged the host-API gap batch: plugin API 1.4.0 (~35 methods: ship/chat/missions
  data, agents.oneShot/prepareWorktree/sessionRoots, terminals.focus, tool-config access,
  native.openWindow/monitorOf/allowSetForeground, child-webview anchor + userAgent), cross-process
  CLI→GUI change events actually started, chat plugin key, sidecar Job breakaway + shutdown order,
  WS_CLIPSIBLINGS on the host. Plugin fallbacks removed. Running: onboarding, e2e fix (optional
  plugins), MIG-Z (`legacy` → built-in `core` plugin) + cleanup/rename/docs. Then: final QA.
- 2026-10-24 — MIG-Z + cleanup/rename/docs. The `legacy` wrapper is gone: it is now the built-in
  `core` plugin (`plugins/core`, "QuadFlow Core": Terminal / AI Agent toolbar items, History flyout,
  `core/new-terminal` + `core/launch-agent`, still an internal host-bundle module); `core/*` commands
  are just that plugin's commands; dead tile-lifecycle hooks removed; workspace templates fixed
  (`issues/board`, `github/git`). §5 checked off: unreferenced shell files deleted
  (`GlobalWorkspaceButton/Manager`, `MinimizedWorkspaceStrip`, `SessionManager`,
  `DefaultWorkspaceConfigEditor`, `WorkspaceQuickStart`, `multiagentStore`, `codemirrorTheme`,
  `lib/core/issues.ts`, `types/issues.ts`, `App.css`), uncalled commands `webview_eval` /
  `set_webview_visible`, `tauri-plugin-shell` + `shell:allow-*`, unused deps (npm: `@codemirror/*`,
  `react-markdown`, `remark-gfm`, `nanoid`, `@tauri-apps/plugin-log`/`-shell` at the root; cargo:
  `futures-util`, `rusqlite` in src-tauri, `schemars` in core), `promo/`, the QuadCode PNGs and
  version markers. README / CONTRIBUTING / CLAUDE.md rewritten for the core + plugins architecture;
  `docs/plugins/migrating-a-tool.md` is now "Porting a tool into a plugin". Then: final QA.
- 2026-10-24 — Merged onboarding (6-step first run + empty-workspace guidance), MIG-Z (`legacy` →
  built-in `core` plugin; no legacy concept left) + cleanup (promo/, QuadCode assets, dead files,
  12 npm + 3 cargo deps, tauri-plugin-shell removed; README/CONTRIBUTING/CLAUDE.md rewritten), and
  the e2e fixes (flyout restore, project publish order, chat send race, stale plugin pruning).
  **`npm run check` green, `npm run test:e2e` 122/122.** Final QA click-through running
  (light-theme pass, portability review, docs/QA-REPORT.md).
- 2026-10-24 — Merged final QA: light-theme remap in `@quadflow/ui` tokens (shell, plugins, sandboxed
  frames), terminal palette everywhere, undefined `vibe-*` tokens fixed, macOS ⌘ shortcuts
  (`src/lib/platformKeys.ts`), small Settings/Plugins/CLI fixes, new `workspaces` + `theme` e2e
  tests. **`npm run check` green, `npm run test:e2e` 133/133.** Remaining items in
  `docs/QA-REPORT.md` (macOS/Linux untested on hardware, clippy warnings, minor cosmetics).
  Build work complete; launch steps are the owner's (release key, squash, push, publish).
