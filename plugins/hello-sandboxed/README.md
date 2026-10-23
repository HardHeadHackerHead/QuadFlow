# Hello (sandboxed)

**The Hello example plugin's bundle, run in a sandboxed iframe.**

*Example plugin (dev builds only).*

This plugin has no sources. It is the [`hello`](../hello/README.md) plugin's build output staged a
second time under its own manifest, so the same tile runs **sandboxed**: in its own iframe, talking
to the host over the RPC host API instead of sharing the host document. It shows that one bundle,
written against `ctx`, works unchanged in both isolation modes. That is the mode every third-party
plugin runs in; see [Getting started](../../docs/plugins/getting-started.md).

## Try it

Dev builds stage it next to `hello` (`npm run tauri dev`, or `npm run build:plugins:dev`). Open the
**Hello (sandboxed)** tile from the Tools menu and run its panels. Its command is
*Hello (sandboxed): Ping*.

## What is different from `hello`

| | `hello` (trusted) | `hello-sandboxed` |
|---|---|---|
| Where the tile runs | The host document | A sandboxed iframe per tile |
| `react`, `zustand`, `@quadflow/ui` | The host's instances | The frame runtime's own copies |
| `ctx` | Direct host API | RPC client over a message channel |
| `activate()` | Runs in the host | Runs in the plugin's background frame |
| Module state ("all Hello tiles" counter) | Shared by every tile | Per frame: counts this tile only |
| `native.*` checks | Run | Skipped: reserved for trusted plugins |
| CLI commands, agent doc, `native:windows` | Declared | Not declared |
| Sandbox isolation panel | Not shown | Shown |

The host-API pass count is therefore the trusted count minus the trusted-only checks.

## Sandbox isolation panel

Shown only when `ctx.plugin.isolation === "sandboxed"`. Each check passes when the frame is
blocked:

| Check | Proves |
|---|---|
| no `window.__TAURI__`, Tauri IPC unreachable | The frame cannot call the app directly |
| `parent.document`, `top.location` | No access to the host DOM or navigation |
| fetch `ipc.localhost` / `ipc://localhost`, fetch the network | No IPC or network from the frame (HTTP goes through `ctx.http` and its permissions) |
| `localStorage` / cookies | No shared browser storage |
| trusted-only methods | `native.*` is refused over RPC |
| message over 4 MiB rejected, 200 requests in flight | RPC limits: oversized messages and requests beyond 200 in flight are refused, and the frame recovers |

## How it is built

Two files:

| File | Purpose |
|---|---|
| `package.json` | `quadflow.bundle: "dev"`, `quadflow.variantOf: "hello"`, `quadflow.isolation: "sandboxed"` |
| `quadflow-plugin.json` | Its own id, name, tile and command titles; the same sidecar, settings and permissions as `hello` minus `native:windows` |

`scripts/bundle-plugins.mjs` stages `hello` first, then copies its `dist/`, assets and sidecar under
this manifest. `quadflow.isolation: "sandboxed"` writes `quadflow-bundle.json` into the staged copy,
which makes the registry run this bundled plugin sandboxed (trust can only be lowered, never
raised). The GUI e2e test `scripts/ui/sandbox.test.mjs` runs both variants.

## License

AGPL-3.0-only, part of QuadFlow.
