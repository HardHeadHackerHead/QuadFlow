# OBS Tracker

**Moves your OBS webcam source to follow a QuadFlow tile.**

*Optional — install from Settings → Plugins.* Windows only.

Part of the streamer kit: put an OBS Tracker tile where you want your face cam, and the plugin keeps
the webcam source in your OBS scene at exactly that spot and size, even as you rearrange the layout.
It talks to OBS over OBS WebSocket.

## Features

- Lists your webcams (DirectShow, the same list OBS's *Video Capture Device* shows) and the scenes in
  OBS.
- Enables a webcam in the tile's scene: creates (or shows) an OBS video capture source for it and
  sizes it to the tile.
- Follows the tile: position and size updates are sent whenever the tile moves or resizes, mapped
  from screen coordinates to the OBS canvas.
- Per-tile scene and camera selection (one scene per tracker tile).
- Several cameras per tile: switch with previous / next, or **auto-rotate** between them on an
  interval (default 10 seconds, 3–300).

## Setup

1. In OBS (28 or newer has OBS WebSocket built in) open **Tools → WebSocket Server Settings**, enable
   the server and note the port and password.
2. Open the **OBS Tracker** tile, enter host (default `127.0.0.1`), port (default `4455`) and the
   password, and connect.
3. Pick a scene, enable one or more webcams, then **Enable position tracking**.

Positions are computed from the tile's place on your monitor and scaled to the OBS canvas.

## Usage

Open the **OBS Tracker** tool from the toolbar, as a pane or a flyout. There is one tracker tile at
a time. The webcam sources it creates in OBS are named `QuadFlow_<tracker>_<camera>`. Closing the
tile stops tracking but leaves the sources in OBS.

## Permissions

| Permission | Why |
|---|---|
| `secrets` | Keep the OBS WebSocket password in the OS keychain |

## Data

| What | Where |
|---|---|
| OBS WebSocket password | OS keychain (secret `obs.password`) |
| Host and port | `connection.json` in the plugin data folder |
| Per-tile scene, cameras, rotation | Plugin storage, keyed by tool config |

## Development

```bash
cd plugins/obs-tracker
npm run build       # UI module + release sidecar → bin/
npm run build:ui    # UI module only
npm run pack        # release archive (see docs/plugins/publishing.md)
```

- `src/ObsTrackerTile.tsx` — connection form, scene and device lists, tracking, rotation
- `src/store.ts`, `src/api.ts` — Zustand store, sidecar calls, per-tile settings
- `sidecar/src/obs.rs` — OBS WebSocket client (obws): scenes, sources, transforms
- `sidecar/src/devices.rs` — DirectShow webcam enumeration
- `sidecar/src/settings.rs` — connection settings and the password secret

The OBS connection is made by the sidecar directly. Requests and UI events are listed at the top of
`sidecar/src/main.rs`. The GUI e2e test is `scripts/ui/obs-tracker.test.mjs`. Sidecars:
[docs/plugins/sidecars.md](../../docs/plugins/sidecars.md).

## License

AGPL-3.0-only, part of QuadFlow.
