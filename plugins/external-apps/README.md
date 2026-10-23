# External Apps

**Launch external programs, link toolbar buttons to their windows, and embed any app window in a
tile.**

*Bundled with QuadFlow.* Windows only.

Put the rest of your desktop into the layout: a toolbar button that focuses (or launches) your
browser, database client or design tool, or the app's window itself living inside a QuadFlow tile.

## Features

- **Embed a window**: reparent any open top-level window into a tile. It follows the tile's
  position and size and is hidden while QuadFlow menus and dialogs are open.
- **Launch and embed**: a tile can start a program (executable, arguments, working directory) and
  optionally embed its window as soon as the tile opens.
- **Pop out / release**: detach the window and keep the tile, or detach it and clear the tile.
- **App / Window Link toolbar buttons**: each button focuses a linked window (matched by process
  and title) or launches/focuses a linked program. An unlinked button opens a tile to choose its
  target.
- **Drag to embed** (opt-in): drop a window onto QuadFlow, holding Ctrl+Shift by default, to embed it
  in a new tile.
- Embedded windows are always given back: on reload, disable, app exit, and after a crash of the
  plugin's helper process on its next start.

## Usage

Add an **External App** tile (pane only) and pick a window from the list, or configure a program in
the tool config:

| Setting | Description |
|---|---|
| Executable | Full path to the program (optional: any open window can be embedded) |
| Arguments | Program arguments |
| Working directory | Where the program starts |
| Launch and embed when the tile opens | Default off |

Add **App / Window Link** buttons to the toolbar (one per target) for quick focus or launch.

| Command | What it does |
|---|---|
| Embed a Window… | Opens a tile to pick a window to embed |
| Detach All Embedded Windows | Gives every embedded window back to the desktop |
| Reset Toolbar Links | Clears the targets of all App / Window Link buttons |

## Settings

On the plugin's *External Apps* settings page:

| Setting | Default | Description |
|---|---|---|
| Drag a window onto QuadFlow to embed it (`dropToEmbed`) | off | Watches window drags with a system-wide WinEvent hook in the plugin's sidecar and embeds a window dropped on QuadFlow in a new tile |
| Only while Ctrl+Shift is held (`dropRequiresHotkey`) | on | Ignore drops unless Ctrl and Shift are held when the window is released |

## Permissions

| Permission | Why |
|---|---|
| `native:windows` | Enumerate, focus, launch and embed native windows |

## Data

Toolbar link targets live in the plugin's storage, keyed by tool config (`link:<id>`). The sidecar
keeps `embeds.json` in its plugin data folder so a crash never strands an embedded window.

## Development

```bash
cd plugins/external-apps
npm run build                                       # UI module only → dist/
cargo build --release -p external-apps-sidecar      # the native sidecar (workspace member)
```

`npm run build:plugins` at the repository root builds both and stages the plugin.

- `src/index.tsx` — plugin entry: tile, toolbar link command, drag-to-embed wiring
- `src/ExternalAppTile.tsx` — window picker, launch, embed, pop out, link setup
- `src/model.ts` — sidecar calls, embed state, toolbar link storage
- `sidecar/src/` — Rust sidecar: `apps.*` (launch, track, focus), `windows.*` (enumerate, focus),
  `embed.*` (reparent, bounds, visibility, detach), `drag.*` (drag-to-embed monitor). Every Win32
  call that messages another process runs with a timeout, so a hung app cannot block QuadFlow.

The GUI e2e test is `scripts/ui/external-apps.test.mjs`. Sidecars:
[docs/plugins/sidecars.md](../../docs/plugins/sidecars.md); plugin authoring:
[docs/plugins/](../../docs/plugins/README.md).

## License

AGPL-3.0-only, part of QuadFlow.
