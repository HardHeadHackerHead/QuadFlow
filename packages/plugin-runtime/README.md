# @quadflow/plugin-runtime

The runtime QuadFlow serves to sandboxed plugin frames.

**Internal package** (`"private": true`, never published). Plugin authors do not install or import
it: QuadFlow ships it inside the app, and a sandboxed plugin gets it automatically. This README is
for QuadFlow contributors.

## What it is

Plugins that are not bundled with QuadFlow run in a sandboxed iframe and talk to the host over
RPC. Each frame needs the same shared modules a trusted plugin gets from the host document, plus
a bootstrap that connects to the host. This package builds them into `dist/`:

| File | Contents |
|---|---|
| `react.js`, `react-jsx-runtime.js`, `react-dom.js`, `react-dom-client.js`, `zustand.js` | One ES module per shared specifier |
| `plugin-api.js`, `ui.js` | `@quadflow/plugin-api` and `@quadflow/ui` |
| `frame.js` | The frame bootstrap (`src/frame.tsx`) |
| `runtime.css` | `@quadflow/ui` tokens and the Tailwind classes its components use |

Each module is built with every *other* shared specifier external, so a frame has exactly one
React, one zustand, one `@quadflow/ui` and one `@quadflow/plugin-api`. Plugin modules import the
bare specifiers, which the frame's import map resolves to these files. The file names match the
trusted shims in `public/qf-shared/`, so one plugin build works in both isolation modes.

## The frame bootstrap

`src/frame.tsx` runs in every sandboxed frame:

1. connects to the host bridge and builds the RPC `PluginContext` (`@quadflow/plugin-api/rpc`);
2. applies the host theme and follows theme changes; routes `@quadflow/ui` overlays and toasts to
   the host;
3. imports the plugin's `ui.entry`;
4. as a tile frame, renders the requested tile with `TileProps`; as the background frame, runs
   `activate(ctx)` and answers command and deactivate calls;
5. reports `ready` (or the error) to the host.

## Build

```bash
npm run build     # node build.mjs → dist/
```

`npm run build:plugins` at the repository root builds it and stages `dist/` as
`src-tauri/resources/plugin-runtime/`, which the app serves under `qfplugin://…/_runtime/`.
The shared-module list must stay in sync with `scripts/gen-shared-shims.mjs` and
`RUNTIME_MODULES` in `src-tauri/quadflow-core/src/plugins/assets.rs`.

## Documentation

- [Plugin system design](../../docs/architecture/plugin-system.md) — isolation modes and the sandbox
- [Permissions → sandbox limits](../../docs/plugins/permissions.md)
- [Host API → shared modules](../../docs/plugins/host-api.md)

## License

AGPL-3.0-only, part of QuadFlow.
