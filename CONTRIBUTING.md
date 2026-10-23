# Contributing to QuadFlow

Thanks for your interest in QuadFlow. This guide covers setting up a development environment, how
the code is organized, and how to get a change merged.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security
issues as described in [SECURITY.md](SECURITY.md), never in public issues.

- [Development setup](#development-setup)
- [Building and running](#building-and-running)
- [Checks and tests](#checks-and-tests)
- [Project structure](#project-structure)
- [Making a change](#making-a-change)
- [Contributor License Agreement](#contributor-license-agreement)
- [Coding conventions](#coding-conventions)
- [Writing a plugin](#writing-a-plugin)

## Development setup

On every platform you need:

- **Rust** (stable) via [rustup](https://rustup.rs)
- **Node.js 20+** and npm
- **Git**

Then the platform-specific prerequisites for Tauri v2.

### Windows

- **Microsoft C++ Build Tools**: install
  [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the
  **Desktop development with C++** workload.
- **WebView2**: preinstalled on Windows 10 (1803+) and Windows 11. Otherwise install the
  [Evergreen Bootstrapper](https://developer.microsoft.com/microsoft-edge/webview2/).
- Use the MSVC Rust toolchain (the rustup default): `rustup default stable-msvc`.

### macOS

- **Xcode Command Line Tools**: `xcode-select --install` (or a full Xcode install).

### Linux

Tauri v2 needs WebKitGTK 4.1 and a few system libraries. QuadFlow also links screen-capture
libraries (PipeWire/X11/Wayland) for the plugin host's screen capture (`native.captureRegion`,
used by Web Preview's screenshot button).

**Debian / Ubuntu (22.04+)**

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
  pkg-config libclang-dev libpipewire-0.3-dev libspa-0.2-dev libdbus-1-dev \
  libxcb1-dev libxcb-randr0-dev libxcb-shm0-dev libwayland-dev \
  libegl1-mesa-dev libgbm-dev
```

**Fedora**

```bash
sudo dnf check-update
sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file \
  libappindicator-gtk3-devel librsvg2-devel libxdo-devel \
  clang-devel pipewire-devel dbus-devel libxcb-devel wayland-devel \
  mesa-libEGL-devel mesa-libgbm-devel
sudo dnf group install "c-development"
```

**Arch Linux**

```bash
sudo pacman -Syu
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl \
  appmenu-gtk-module libappindicator-gtk3 librsvg xdotool \
  clang pipewire dbus libxcb wayland mesa
```

See the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) for other
distributions.

### Agent CLIs (optional)

To run agents in QuadFlow terminals, install the agent CLIs you want (for example Claude Code or
Codex) and make sure they are on your `PATH`. QuadFlow builds and runs without them.

## Building and running

```bash
git clone https://github.com/HardHeadHackerHead/QuadFlow.git quadflow
cd quadflow
npm ci
```

| Command | What it does |
|---|---|
| `npm run tauri dev` | Run the full desktop app in development mode (Vite dev server + Rust backend, frontend hot reload). Stages the plugins first. |
| `npm run dev` | Vite dev server only (frontend in a browser; Tauri APIs unavailable). |
| `npm run build:web` | Typecheck and build the frontend into `dist/`. |
| `npm run build` | Release build of the app and installer for this platform, bundling the first-party plugins. No MSVC Developer Prompt, CUDA or llama.cpp needed. |
| `npm run build:plugins` | Build and stage the bundled plugins into `src-tauri/resources/plugins/` (`build:plugins:dev` adds the example plugins). |
| `npm run build:dev-exe` | Debug exe with a dev identifier, used by the GUI harness. |

The Cargo workspace root is the repository root, so build output goes to `target/` there; the
installer ends up under `target/release/bundle/`. Releases are built locally too: see
[docs/RELEASING.md](docs/RELEASING.md).

### Optional plugins

The app has no heavy Cargo features. Semantic search (Candle) and local title generation
(llama.cpp) are optional plugins with their own sidecar crates (`plugins/semantic-search`,
`plugins/local-titles`), like the streamer kit (`youtube-live`, `youtube-shorts`, `obs-tracker`) and
`discord-bot`. They are not bundled into the installer (`quadflow.bundle: "none"` in their
`package.json`). `npm run check` still type-checks and builds their UIs and tests their sidecars,
except llama.cpp, which is built only by `npm run build:release` in `plugins/local-titles` (GPU
backends are features of that crate: `cuda`, `metal`, `vulkan`). See each plugin's README.

### Faster builds (optional)

The repository does not force any build accelerators, so a fresh clone builds with only the
prerequisites above. To use them, opt in locally. **Do not commit these settings** to
`src-tauri/.cargo/config.toml`.

**sccache** caches compiled crates across branches and worktrees:

```bash
cargo install sccache --locked
# one-off, per shell:
export RUSTC_WRAPPER=sccache           # PowerShell: $env:RUSTC_WRAPPER = "sccache"
```

or permanently in `~/.cargo/config.toml` (`%USERPROFILE%\.cargo\config.toml` on Windows):

```toml
[build]
rustc-wrapper = "sccache"
```

Check that it works with `sccache --show-stats`.

**Faster linkers**, also in `~/.cargo/config.toml`:

```toml
# Windows: LLVM's lld-link (install LLVM and put its bin/ directory on PATH)
[target.x86_64-pc-windows-msvc]
linker = "lld-link"

# Linux: mold (install it from your package manager)
[target.x86_64-unknown-linux-gnu]
linker = "clang"
rustflags = ["-C", "link-arg=-fuse-ld=mold"]
```

## Checks and tests

QuadFlow has **no hosted CI**. Before pushing or opening a pull request, run every check locally:

```bash
npm run check      # agent-literal grep, typecheck, web build, cargo check, core + SDK tests,
                   # bindings drift, plugin builds/tests, plugin docs + index drift,
                   # release config, clippy
npm run test:e2e   # builds the dev exe, then runs the GUI e2e suite against it (scripts/ui/)
```

Faster loops while you work:

| Command | Checks |
|---|---|
| `npx tsc --noEmit` | TypeScript only |
| `cargo check -p quadflow-core --manifest-path src-tauri/Cargo.toml` | The core library and CLI, much faster than the whole app |
| `cargo test -p quadflow-core --manifest-path src-tauri/Cargo.toml` | Core tests |
| `cargo test -p quadflow-tauri --test export_bindings` | Regenerates the TypeScript bindings |

New checks go into `scripts/check.mjs`; never add hosted CI workflows.

**Testing against real data is off-limits.** You may have an installed QuadFlow with real projects.
Never run the `quadflow` on your `PATH` against a real project to test a change. Use the binary you
built, with `QUADFLOW_PROFILE=dev` and a temporary `QUADFLOW_DATA_DIR` (dev project data goes to
`.quadflow-dev/`). Tests set `QUADFLOW_SECRETS_BACKEND=memory`.

**UI changes** are verified in the real app with the GUI harness in `scripts/ui/`: it launches an
isolated dev build, drives it over the Chrome DevTools Protocol and takes screenshots. See
[scripts/ui/README.md](scripts/ui/README.md).

## Project structure

```
src/                        React + TypeScript shell (Vite, Tailwind, Zustand)
  components/               layout/mosaic, terminals, settings, onboarding, generic tool hosts
  plugins/                  plugin host: registry, loader, TileHost, host API; core/ = the `core` plugin's UI
  stores/                   Zustand stores (projects, workspaces, terminals, tools, ...)
  lib/                      typed command helpers and shared utilities
  generated/                tauri-specta bindings (generated, never edited by hand)
src-tauri/                  Tauri v2 shell (Rust, package `quadflow-tauri`)
  src/main.rs               one binary: no args -> GUI, any args -> `quadflow` CLI
  src/lib.rs                app setup; src/commands/ thin typed Tauri commands; src/bindings.rs registry
  src/terminal.rs           PTY backend for terminal tiles
  src/plugin_host/          native side of the plugin host API (terminals, windows, sidecars)
  quadflow-core/            `quadflow-core` crate: data, domain logic and the CLI
    src/store/, src/domains/  storage engine and domains (ideas, issues, plans, discovery, scripts, ship, chat, missions, app)
    src/plugins/, src/agents/ plugin registry/host API/sidecars, agent-provider framework
    src/cli/                clap command tree (`quadflow ideas ...`, `quadflow issues ...`)
  resources/                bundled resources (agent context doc, staged plugins)
packages/                   packages plugins build against: plugin-api, ui, plugin-kit, plugin-build,
                            plugin-runtime, sidecar SDKs, create-quadflow-plugin
plugins/                    first-party plugins (+ index.json, the official plugin source)
docs/                       roadmap, architecture docs, plugin author docs (docs/plugins/)
catalog/                    agent model catalog (`models.json` + schema), fetched by the app
scripts/                    build, check and release scripts; scripts/ui/ = GUI harness + e2e tests
```

The design is described in [docs/ROADMAP.md](docs/ROADMAP.md) and
[docs/architecture/](docs/architecture/README.md). In short: `quadflow-core` is the **only** place
data and business logic live; the GUI, the CLI and plugins all go through it. Every tool, including
Ideas, Issues and Plans and the agent integrations themselves, is a plugin.

## Making a change

1. **Find or open an issue** first for anything non-trivial, so the approach can be discussed
   before you invest time. Small fixes can go straight to a pull request.
2. **Fork** the repository and create a branch from `main`, for example
   `git switch -c fix/terminal-copy-wrap`. Prefixes: `feat/`, `fix/`, `docs/`, `refactor/`,
   `plugin/<name>/`.
3. **Keep the pull request focused**: one logical change. Unrelated cleanups get their own PR.
4. **Write clear commits**: a short imperative subject line
   (`Fix copy adding hard newlines at wrap points`), with a body explaining *why* when it isn't
   obvious.
5. **Run the checks** ([above](#checks-and-tests)) and test on as many platforms as you can.
6. **Open the pull request** against `main` and fill in the template. Say which platforms you tested
   on and that `npm run check` passed.
7. **Sign the CLA** on your first pull request ([below](#contributor-license-agreement)).
8. **Review.** A maintainer reviews the PR. Respond to comments by pushing new commits; PRs are
   squash-merged, so you don't need to tidy the history.

There is no backwards-compatibility requirement for on-disk data or internal APIs before the first
public release: prefer the clean design over migrations and shims.

## Contributor License Agreement

QuadFlow is licensed under the [GNU AGPL-3.0](LICENSE). To keep the option of offering the project
under additional licenses, every contributor signs the [Contributor License Agreement](CLA.md)
once. You keep the copyright to your work; the CLA grants the project a license to use and
relicense it, plus a patent license.

On your first pull request, add this line to the PR description, with your GitHub username:

```
I have read the CLA Document and I hereby sign the CLA — @your-username
```

A maintainer records your signature in `CLA-SIGNATURES.md` before merging.

## Coding conventions

### General

- Text files use **LF** line endings and UTF-8 (enforced by `.gitattributes`); `.ps1`/`.bat`/`.cmd`
  use CRLF. Scripts that write files must write LF too (tests `include_str!` working-tree files).
- No secrets, personal paths or machine-specific config in commits (`gitleaks detect` is a good
  local check if you have it installed).
- Every feature must work on Windows, macOS and Linux, or be declared platform-specific (plugins do
  this with `platforms` in their manifest).
- Core and shell contain no agent-specific literals; agents live in their plugins
  (`scripts/check-agent-literals.mjs` enforces this).

### Rust

- Format with `cargo fmt`; keep `cargo clippy` clean for code you touch.
- Data and business logic belong in `quadflow-core`, not in Tauri commands. Tauri commands are
  thin wrappers.
- Return errors (`Result`) instead of panicking; optional subsystems must fail into a disabled
  state, never crash startup.
- Don't block the main thread: long-running or I/O-heavy Tauri commands are `async`.
- Types shared with TypeScript are generated with `specta` + `tauri-specta` into
  `src/generated/bindings.ts` and `packages/plugin-api/src/generated/types.ts`; `npm run check`
  fails on drift. Everything lands in one TypeScript namespace, so prefix new type names with their
  domain (`PlanStatus`, not `Status`).
- Tests never touch the real user data directory: use temp dirs
  (`quadflow_core::testing::{TempProject, TempApp}`).

### TypeScript / React

- `strict` TypeScript; `npx tsc --noEmit` must pass with no errors (unused variables are errors).
- State lives in Zustand stores under `src/stores/`; components stay presentational where
  practical.
- Call the backend through the typed wrappers in `src/lib/`, not raw `invoke()` calls scattered
  through components. Never edit `src/generated/` by hand.
- Clean up every event listener: `listen()` returns a promise, so use a disposed flag in effects to
  avoid leaking listeners after unmount.
- Style with Tailwind and the shared theme tokens; don't hardcode colors.
- Plugins import nothing from `src/`: only `@quadflow/plugin-api`, `@quadflow/ui`, `react`,
  `zustand` and what they bundle.

### CLI

- Every command supports `--json`, exits non-zero on failure (also in `--json` mode), and rejects
  invalid enum values.

## Writing a plugin

Everything in QuadFlow is a plugin: tools such as Ideas, Issues and Plans, and agent providers such
as Claude Code and Codex. A plugin is a folder with a `quadflow-plugin.json` manifest declaring
what it contributes (tiles, flyouts, settings pages, commands, CLI subcommands, agent context docs,
an agent provider), the permissions it needs, and an optional sidecar process.

Start with the author docs in **[docs/plugins/](docs/plugins/README.md)**:

```bash
npm create quadflow-plugin -- ../my-plugin --template tile --id acme.my-plugin
cd ../my-plugin && npm run dev     # then Settings → Plugins → Load unpacked… (hot reload)
```

- **Templates:** `tile`, `tile-sidecar-rust`, `tile-sidecar-node`, `cli-command`,
  `agent-provider`.
- **Build tool:** `@quadflow/plugin-build` (`quadflow-plugin build | dev | validate | pack`).
- **References:** the [manifest reference](docs/plugins/manifest-reference.md) (generated; run
  `npm run docs:manifest` after changing the manifest schemas, `npm run check` fails when it is
  stale) and the host API reference (TypeDoc: `npm run docs:api`).
- **Design:** [docs/architecture/plugin-system.md](docs/architecture/plugin-system.md).

Official plugins live in [`plugins/`](plugins/), whose `index.json` is the built-in plugin source
and the reference for third-party sources. To move UI that lives in the shell into a plugin, follow
[Porting a tool into a plugin](docs/plugins/migrating-a-tool.md).

New official plugins: open a feature request first describing the plugin, then put it under
`plugins/<plugin-id>/` with its own README.
