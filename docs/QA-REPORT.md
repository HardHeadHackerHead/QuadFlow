# Final QA report (pre-launch)

Date: 2026-10-23. Branch: the final-QA worktree branch, based on `oss` at `8d54867`.
Scope: a deliberate click-through of the whole app as a new user, in the dark and the light
theme, in the isolated dev build (`npm run build:dev-exe` + `scripts/ui` harness, fresh data dir
per run, scratch project), plus a static portability review for macOS / Linux.

Screenshots (local, not committed): `%TEMP%\qf-qa-shots\` —
`01…45-*.png` (manual flows), `tour\` (every tool in a pane and a flyout, dark + attribute-light,
**before** the fixes), `tour-light\` (every tool with seeded data after the real Settings →
Light switch, **after** the fixes), `settings\` (every Settings tab, light). Screenshots of the
External Apps window list were deleted: they showed the desktop's private window titles.

## What was checked

| Area | How | Result |
|---|---|---|
| First run | fresh data dir, onboarding not skipped: Welcome → Agents → Project → CLI → Plugins → Done, dark + light | OK (CLI "Install on PATH" not clicked: it edits the real user PATH) |
| Terminals | open, type, long wrapped line, close; tile frame in light | frame was hard-coded dark — **fixed** |
| Workspaces | create blank, switch back/forth + rapid, rename, full app restart on the same data dir | OK — now an e2e test |
| Agent launch dialog | Claude Code + Codex tabs, models / effort / approval modes; closed without launching | OK |
| Settings | every tab (General, Terminal, AI Agents, Integrations, Claude Code, External Apps, Usage Monitor, Plugins, Advanced), light + dark | Escape did not close; stale copy; plugin details squeezed — **fixed** |
| Plugins | Load unpacked (semantic-search, built locally), approve permissions, disable / enable, remove; `semantic-search.test.mjs` 7/7 | OK; new row was off-screen — **fixed** |
| Theme | Dark / Light / System via Settings, accent color (cyan) → `--qf-primary` | OK |
| Every bundled tile, pane + flyout | Ideas, Projects, Issues (list, board, detail, dependency graph), Plans (detail), Scripts (script + sequential group run), Missions (template → mission, no agents), Ship (not configured + templates), Chat, GitHub (no repo), Code Quality, Editor, TUI, Web Preview, Usage Monitor, External Apps (pane only, by design), Claude Config, Core; hello / hello-sandboxed (dev only) | light-theme issues — **fixed**; no page errors |
| Command palette | open / search / Enter / Escape, `Open X` and `Open X in Flyout` rows for every tool | OK |
| CLI | `quadflow --help`, `docs --list`, `init`, `doctor`, `ideas create`, `issues create/list/status/label/update`, invalid enum (exit 2), `plans create/step-add`, `scripts create`, `scripts groups create`, `discovery create`, `plugins list` | OK; usage line said `quadflow-tauri.exe` — **fixed** |
| Remnants | grep for QuadCode / Pro / login / license / support / quadslab.io in UI + plugin sources | none left (GitHub "login" = account name) |
| Portability (static) | `cfg` gates for every `windows` / `winreg` / `windows_sys` use, Unix shell spawning, path handling in TS, keyboard shortcuts | macOS shortcut conflict — **fixed**; rest OK |

## Issues found and fixed

| # | Severity | Issue | Fix |
|---|---|---|---|
| 1 | Medium | Light theme: hundreds of dark-tuned `text-{color}-300/400` classes (status, priority, labels, toolbar items) were low-contrast / unreadable on light surfaces (yellow, amber, lime, green, cyan worst), in the shell and in every plugin. | A light-theme remap at the end of `packages/ui/src/tokens.css` maps them (and their `hover:` variants) to the 700 shade; `:root[data-theme]` keeps it above plugin CSS scoped under `.qf-<plugin>`. Also `text-gray-300/400` → muted, `bg-white/5,10` → dark tint, `bg-gray-800`, `border-gray-600`. Sandboxed frames get it too (runtime imports tokens.css). |
| 2 | Medium | Terminal tiles had a hard-coded `bg-[#1e1e1e]` container: a thick black frame around the white light-theme terminal (shell tile, floating window, minimized bar preview). | Uses `rgb(var(--qf-term-bg))`. |
| 3 | Medium | Plugin-attached terminals (`terminals.attach`, e.g. Scripts run output) used `--qf-bg`/`--qf-text` instead of the terminal palette and never followed a theme switch; Missions member previews likewise. | `terminalAttach.ts` uses the shell's terminal theme and subscribes to theme changes; Missions `TerminalPreview` follows `ui.onThemeChange`. |
| 4 | Medium | CLI flyout: the "Install quadflow for this user" button used the undefined token `vibe-accent` → no background (white text on nothing) in both themes; the "Different build is on PATH" warning used yellow-100/200 text, unreadable in light. | `vibe-primary`; warning uses tokenized/remapped colors. |
| 5 | Medium (macOS) | App shortcuts were `Ctrl+K / Ctrl+B / Ctrl+W / Ctrl+Shift+P/B` on every OS. On macOS those are shell keys (kill line, back char, delete word) that the app swallowed from terminals, and Mac users expect ⌘. | `src/lib/platformKeys.ts` (`isModKey`, `MOD_LABEL`, `shortcut()`): ⌘ on macOS, Ctrl elsewhere — App shortcuts, palette, TerminalView pass-through, `terminals.attach`; key hints and titles show ⌘ on macOS. |
| 6 | Low | Ship: run/check badges and banners were `bg-X-900` / `bg-opacity-30` with `text-X-200` (unreadable on light); the output pane was hard-coded GitHub-dark colors. | Translucent `bg-X-500/10-15` + `text-X-400` (remapped in light); output pane uses the terminal palette tokens. |
| 7 | Low | Dependency graphs (Issues, Plans) drew dark navy nodes in light. | Node fill/stroke/text from `--qf-surface/border-strong/text/text-muted`. |
| 8 | Low | Agent resume overlay used undefined tokens (`vibe-text-primary`, `vibe-text-secondary`, `vibe-bg-hover`, `vibe-accent`). | Mapped to existing tokens. |
| 9 | Low | Selected color swatch (Settings accent, tool color) marked with a white ring — invisible in light. | `vibe-text` ring. |
| 10 | Low | Settings modal did not close on Escape. | Escape closes it (inline editors and nested dialogs keep their own Escape). |
| 11 | Low | Settings → General said "Light theme coverage grows as tools move to the shared UI kit." | Removed. |
| 12 | Low | Settings → Plugins: an expanded plugin's permission list was squeezed into the left column (badges wrapped to two lines); after "Load unpacked…" the new plugin (with its Approve button) was below the fold. | Details span the whole row; the new row scrolls into view. |
| 13 | Low | `quadflow --help` printed `Usage: quadflow-tauri.exe …` (the executable name). | clap `bin_name = "quadflow"`. |
| 14 | Low | Every launch logged a console **error** when the background update check failed (no release published yet / offline). | Background failures log a warning; manual checks still error. |
| 15 | Low | The toolbar's bare "0" window counter had a debug tooltip. | Tooltip says what it counts. |
| 16 | Low | Discovery overview editor: Ctrl+Enter only. | Also ⌘+Enter. |

Regression tests added (in `npm run test:e2e`):
- `scripts/ui/workspaces.test.mjs` — two layouts, back-and-forth + rapid switching, rename,
  both layouts and the new name surviving a full app restart.
- `scripts/ui/theme.test.mjs` — real Settings → Light, Escape closes Settings, the palette
  remap (also inside plugin-scoped CSS), light terminal tile container, a Scripts run terminal
  following a light → dark switch.

## Remaining (not fixed)

| Severity | Item |
|---|---|
| Medium (macOS, unverified) | Terminal copy/paste in `TerminalView` is Ctrl+C (copy if selection) / Ctrl+V. On macOS Cmd+C / Cmd+V rely on the webview default; verify on a Mac that ⌘C/⌘V work in terminals and that Ctrl+C always reaches the shell as SIGINT. |
| Medium (Linux/macOS) | Nothing was run on macOS / Linux. The static review found the `cfg` gates consistent (every `windows`, `winreg`, `windows_sys` use is gated; Unix shells start with `-l`, `$SHELL` default). The GUI harness is CDP/WebView2-only (`scripts/ui/README.md` TODO: WebKitGTK inspector / tauri-driver). |
| Low | Usage Monitor runs the real `claude` CLI (`/usage`) and reads the real `~/.codex` rollouts even in the isolated dev profile; in an untrusted folder it logs "no windows found in /usage output". By design (AP-5), but worth knowing for test isolation. |
| Low | External Apps window list: some windows (another QuadFlow instance's) showed a garbled process name (`.□□□0000…`). Probably `QueryFullProcessImageNameW` output for that process; not reproduced for normal apps. |
| Low | Until the public repo has a release and `catalog/models.json` on its default branch, every launch logs `update endpoint did not respond` and `catalog refresh failed: HTTP 404` (warnings). Expected; resolves at launch. |
| Low | Optional streamer plugins (YouTube Live ~134, YouTube Shorts, OBS Tracker, Discord) were not reviewed visually; the remap in tokens.css covers their 300/400 text classes, but they have more hard-coded dark surfaces. |
| Low | `npm run check` passes with 32 clippy warnings in `quadflow-core` (too_many_arguments, sort_by_key, …); clippy is not `-D warnings`. |
| Low | Settings modal height changes per tab; the 9+ tab strip scrolls horizontally. Cosmetic. |
| Low | `semantic-search.test.mjs` is not part of `test:e2e` (needs the sidecar built: `npm run build:sidecar` in `plugins/semantic-search`); run manually: 7/7. |
| Low | Uninstalling a source-installed plugin (and Rollback) was not exercised in the GUI: there is no published source yet (covered by the Rust install/uninstall tests). |
| Info | In an occluded WebView2 window CSS transitions can stay frozen at their start value, so a screenshot taken right after a theme switch may show mid-transition colors. A harness artifact, not an app bug. |
| Info | The core plugin reports version `0.1.0`, the other bundled plugins `1.0.0`. |

## Verification

- `npm run check`: all checks passed.
- `npm run test:e2e`: **133/133** green (122 before + 6 workspaces + 5 theme).
- `semantic-search.test.mjs` (optional plugin, run separately after `npm run build:sidecar`): 7/7.
