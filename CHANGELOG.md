# Changelog

All notable changes to QuadFlow.

## v2.0.0 — 2026-10-23

QuadFlow 2.0 is the first open-source release: a rebuild of QuadFlow as a small core plus plugins, under the AGPL-3.0. No account, no license key, no sign-in — download it and go.

### Highlights

- **Open source.** The app, every first-party plugin and the plugin SDKs are in this repository under AGPL-3.0-only.
- **No account required.** Licensing, login and account features are gone. Project data stays in your projects; app state stays on your machine.
- **Everything is a plugin.** Ideas, Issues, Plans, Projects, Scripts, Ship, Missions, Chat, GitHub, Editor, Web Preview, TUI Tool, Code Quality, Usage Monitor and External Apps are now plugins — and so are the agent integrations, Claude Code and Codex.
- **A plugin system for everyone.** Plugins contribute tiles, toolbar items, commands, palette results, settings pages, `quadflow` CLI subcommands, agent context docs, agent providers and optional sidecar processes, behind permissions you approve. Third-party plugins run sandboxed. Start one with `npm create quadflow-plugin` — see [Writing plugins](https://github.com/HardHeadHackerHead/QuadFlow/tree/main/docs/plugins).
- **Plugin sources.** Install plugins from any git repository that publishes a plugin index (Settings → Plugins → Sources). QuadFlow checks sources for updates and verifies every download's checksum.
- **One data layer.** The GUI, the `quadflow` CLI and plugins read and write the same data through one Rust core. When an agent runs `quadflow issues status ORB-3 done`, the board updates live.

### What's new

- **Agents as providers.** Launch, resume, models, effort and approval modes, session history and the context-window meter are declared by each provider plugin, so new agents can be added without changing the app.
- **Optional plugins** you install when you want them: Semantic Search (search past agent sessions, runs locally), Local Titles (local LLM terminal titles), YouTube Live, YouTube Shorts and OBS Tracker (Windows). Discord Bot is included as an experimental preview.
- **First-run onboarding** and guidance for empty workspaces.
- **Light theme** that works across the whole app, plugins included.
- **macOS shortcuts** use ⌘ (palette, sidebar, close), and the on-screen hints follow.
- **`quadflow` CLI**: every command supports `--json` with stable exit codes; `quadflow docs` prints reference docs for agents; `quadflow context` manages the QuadFlow section of `CLAUDE.md` / `AGENTS.md`.

### Fixes

- Copying text from a terminal no longer inserts a line break at every wrap point.
- Many smaller fixes from a full click-through of the app (Settings closes on Escape, flyouts restore correctly, workspace layouts survive restarts, and more).

### Upgrading from QuadFlow 1.x

- The installer upgrades an existing 1.x install in place. If it offers to uninstall the old version, accept — but **leave "Delete the application data" unchecked**: the import below needs it.
- On first start, QuadFlow offers to **bring over your project list** from 1.x (also later from Settings → Advanced, or `quadflow import-v1`).
- Settings start at their defaults.
- Project data from 1.x can't be read by 2.0. When you open such a project, its old `.quadflow/` folder is moved to `.quadflow-v1-backup/` (never deleted) and a fresh one is created.

### Downloads

| Platform | File |
| --- | --- |
| Windows (x64) | `QuadFlow_2.0.0_x64-setup.exe` (code-signed) |

macOS and Linux builds will follow in a later release; until then you can [build from source](https://github.com/HardHeadHackerHead/QuadFlow#build-from-source).

Installed copies update automatically from this release onward.
