# @quadflow/sidecar-sdk-node

Write QuadFlow plugin sidecars in Node.js.

A sidecar is a background process a plugin ships next to its UI. QuadFlow talks to it with
JSON-RPC 2.0 over stdin/stdout, one JSON object per line (NDJSON). This package handles the
framing, the `initialize` / `shutdown` / `exit` handshake, request routing and calls back into
the host. It is a single file with no dependencies.

## Install

The package is not published to npm yet (`"private": true`). The `tile-sidecar-node`,
`cli-command` and `agent-provider` templates of `npm create quadflow-plugin` add it as a `file:`
dev dependency from your QuadFlow checkout; `@quadflow/plugin-build` bundles it into
`bin/sidecar.mjs`. Because it is one dependency-free file (`index.mjs`), you can also copy it
next to your sidecar.

The manifest declares a Node sidecar like this (the user needs `node` on PATH):

```json
"sidecar": { "runtime": "node", "entry": "bin/sidecar.mjs" },
"permissions": ["sidecar:runtime:node"]
```

## Example

```js
// sidecar/index.mjs
import { createServer, RpcError } from '@quadflow/sidecar-sdk-node'

createServer()
  .onInitialize((init, host) => {
    host.log('info', `project = ${init.project?.root ?? 'none'}`)
    return { capabilities: {} }
  })
  .onRequest('greet', async ({ name = 'world' } = {}, host) => {
    if (!String(name).trim()) throw new RpcError(-32602, 'name must not be empty')
    // Any host API method, permission-checked like a call from the UI.
    await host.call('storage.set', { key: 'lastGreeted', value: name })
    return { message: `Hello, ${name}!` }
  })
  .onNotification('settings/didChange', (p, host) => host.log('info', `settings changed: ${JSON.stringify(p)}`))
  .run()
```

From the plugin UI: `await ctx.sidecar.request('greet', { name: 'Ada' })`.

Never write to stdout yourself: it is the protocol channel. Use `host.log()` or `console.error`
(both end up in the plugin log).

## API overview

| Export | Description |
|---|---|
| `createServer({ input?, output? })` | A `Server` on stdin/stdout (or the given streams) |
| `server.onRequest(method, fn)` | Handle a request; `fn(params, host)` may be async, its return value is the result |
| `server.onNotification(method, fn)` | Handle a notification (`settings/didChange`, `project/didChange`, …) |
| `server.onInitialize(fn)` | `fn(initParams, host)`; its return value is the `initialize` result |
| `server.onShutdown(fn)` | Clean up before the process exits |
| `server.run({ exit? })` | Serve until `exit` or stdin closes, then exit the process (unless `exit: false`) |
| `host.call(method, params?, { timeoutMs? })` | Run a host API method (`storage.get`, `data.issues.list`, `http.fetch`, …) with the plugin's permissions |
| `host.request` / `host.notify` | Raw JSON-RPC to the host |
| `host.emit(topic, payload?)` | Plugin event, received with `ctx.events.onPlugin(<id>, topic, …)` |
| `host.ui(name, params?)` | `ui/<name>` notification to every tile of the plugin (`ctx.sidecar.onNotification(name, …)`) |
| `host.log(level, message)` | Write to the plugin log (`debug`, `info`, `warn`, `error`) |
| `host.init` | The `initialize` params (host, plugin, project, settings, locale), `null` before the handshake |
| `RpcError(code, message, data?)` | Throw it from a handler; host errors arrive as `RpcError` with `kind` set to the QuadFlow error code |

Types are in `index.d.ts`.

## Development

```bash
npm test          # node --test test/server.test.mjs
```

## Documentation

- [Sidecars](../../docs/plugins/sidecars.md) — declaring one, the protocol, dev mode
- [CLI commands](../../docs/plugins/cli-commands.md) — serving `quadflow <command>` from a sidecar
- [Rust SDK](../sidecar-sdk-rust/README.md)

## License

AGPL-3.0-only, part of QuadFlow.
