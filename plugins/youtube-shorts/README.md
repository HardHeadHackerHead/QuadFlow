# YouTube Shorts

**A YouTube Shorts player in a tile, with auto-scroll.**

*Optional — install from Settings → Plugins.*

Part of the streamer kit: keep a Shorts feed running in a corner of your layout while you code on
stream. The tile shows the YouTube mobile site in an embedded web view, so there is no API key and
no account setup.

## Features

- Opens the Shorts feed (`m.youtube.com/shorts`), or YouTube Home.
- **Auto-scroll** to the next short on a timer: 30 seconds by default, adjustable from 5 to 120.
- Skip to the next short, refresh.
- **Search** for shorts by keyword.
- **Volume** slider and mute, re-applied as new videos load.
- A controls panel you can show or hide, plus palette commands to drive the player while the video
  covers the tile.

## Usage

Open the **YouTube Shorts** tool from the toolbar, as a pane or a flyout. There is one player at a
time.

| Command | What it does |
|---|---|
| YouTube Shorts: Next | Skip to the next short |
| YouTube Shorts: Toggle Auto-Scroll | Turn the timer on or off |
| YouTube Shorts: Mute / Unmute | Toggle sound |
| YouTube Shorts: Show / Hide Controls | Toggle the controls panel |

## Permissions

| Permission | Why |
|---|---|
| `native:webview` | Show the YouTube mobile site in a child webview on the tile |

## Data

None of its own. Player state (interval, volume, auto-scroll) is kept in memory.

## Development

```bash
cd plugins/youtube-shorts
npm run build      # quadflow-plugin build --no-sidecar → dist/
npm run dev        # rebuild on change
npm run pack       # release archive (see docs/plugins/publishing.md)
```

- `src/index.tsx` — plugin entry: the `player` tile and the commands
- `src/ShortsTile.tsx` — webview lifecycle, controls panel
- `src/model.ts` — player store, URLs, auto-scroll timer, volume script

No sidecar. Plugin authoring docs: [docs/plugins/](../../docs/plugins/README.md).

## License

AGPL-3.0-only, part of QuadFlow.
