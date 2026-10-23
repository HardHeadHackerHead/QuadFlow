# Sidecars

A sidecar is a background process that belongs to a plugin: a native binary (any language; Rust
has an SDK) or a Node.js script run with the system `node`. Use one for work the UI module cannot
do in a browser context — long-running watchers, native libraries, a bot connection — or to serve
`quadflow <command>` CLI subcommands ([cli-commands.md](cli-commands.md)). Spec:
[plugin-system.md §10](../architecture/plugin-system.md#10-sidecar-protocol).

## Declaring one

Native (one binary per OS/arch you ship; paths are inside the plugin folder):

```json
"sidecar": {
  "binaries": {
    "windows-x86_64": "bin/my-sidecar.exe",
    "macos-aarch64": "bin/my-sidecar",
    "linux-x86_64": "bin/my-sidecar"
  },
  "env": { "MY_FLAG": "1" },
  "activation": "onDemand",
  "restart": "onCrash"
}
```

Node (needs the permission `sidecar:runtime:node`; the user needs `node` on PATH):

```json
"sidecar": { "runtime": "node", "entry": "bin/sidecar.mjs" },
"permissions": ["sidecar:runtime:node"]
```

`activation`: `onDemand` (default — started by the first request) or `onStartup`. `restart`:
`onCrash` (default — backoff 1 s, 2 s, 4 s, …; five crashes in five minutes → `failed` until
`ctx.sidecar.restart()`) or `never`.

`@quadflow/plugin-build` builds both kinds: a Rust crate in `sidecar/` with
`cargo build --release` (the binary is copied to `binaries[<this machine>]`), a Node source
`sidecar/index.{ts,mjs,js}` bundled with its dependencies to `sidecar.entry` (optional native
add-ons a dependency loads in a try/catch — e.g. discord.js's `zlib-sync`, `bufferutil` — go in
`package.json` → `quadflow.sidecarExternal: [...]` so they stay runtime imports). Templates:
`tile-sidecar-rust`, `tile-sidecar-node`, `cli-command`.

## Protocol

JSON-RPC 2.0 over the process's stdin/stdout, one JSON object per line (NDJSON). **stdout is the
protocol channel**: write logs to stderr (captured into `<app data>/logs/plugins/<id>.log`, last
200 lines in `ctx.sidecar.logs()`) or send `host/log`.

Host → sidecar: `initialize` (request: host version/mode, plugin id/dir/dataDir, active project,
settings, locale) → `initialized`; `settings/didChange {key, value}`; `project/didChange`;
`cli/run` (CLI mode); `shutdown` → `exit`; and any method your UI sends with
`ctx.sidecar.request(method, params)` / `notify` (not starting with `$/`, `host/`, `cli/`, `ui/`).

Sidecar → host: `host/call {method, params}` — any host-API method (`storage.get`,
`data.issues.list`, `http.fetch`, …) with the plugin's permissions; `host/log {level, message}`;
`host/emit {topic, payload}` (→ `ctx.events.onPlugin(<id>, topic)`); `ui/<name>` notifications
(→ `ctx.sidecar.onNotification('<name>')` in every tile of the plugin).

The process runs with cwd = its data folder and env `QUADFLOW_PLUGIN_ID`, `QUADFLOW_PLUGIN_DIR`,
`QUADFLOW_PLUGIN_DATA`, `QUADFLOW_SIDECAR_MODE` (`gui` | `cli`) plus the manifest's `env`. It is
killed with the app.

## Rust

```toml
[dependencies]
quadflow-sidecar = { path = "<quadflow checkout>/packages/sidecar-sdk-rust" }
```

```rust
use quadflow_sidecar::{json, RpcError, Server, Value};

fn main() -> std::io::Result<()> {
    Server::new()
        .on_request("greet", |host, params| {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("world");
            host.call("storage.set", json!({ "key": "last", "value": name }))?;
            Ok(json!({ "message": format!("Hello, {name}!") }))
        })
        .on_notification("settings/didChange", |host, p| host.log("info", format!("{p}")))
        .run()
}
```

Each request runs on its own thread, so handlers can `host.call()` freely.

## Node

```js
import { createServer, RpcError } from '@quadflow/sidecar-sdk-node'

createServer()
  .onRequest('greet', async ({ name = 'world' } = {}, host) => {
    await host.call('storage.set', { key: 'last', value: name })
    return { message: `Hello, ${name}!` }
  })
  .run()
```

## From the UI

```ts
const r = await ctx.sidecar.request<{ message: string }>('greet', { name: 'Ada' }, { timeoutMs: 10_000 })
const off = ctx.sidecar.onNotification('progress', (p) => setProgress(p as number))
ctx.sidecar.onStatus((s) => setState(s.state)) // stopped | starting | running | restarting | failed
```

## In dev mode

With the plugin loaded unpacked, `npm run dev` rebuilds the sidecar when its sources change and
QuadFlow restarts a running sidecar when the binary (or Node entry) changes. A dev plugin's native
binary is run from a copy under QuadFlow's cache folder, so the build can overwrite the original
while the old process still runs.
