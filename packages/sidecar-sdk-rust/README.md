# quadflow-sidecar

Write QuadFlow plugin sidecars in Rust.

A sidecar is a background process a plugin ships next to its UI. QuadFlow talks to it with
JSON-RPC 2.0 over stdin/stdout, one JSON object per line (NDJSON). This crate handles the
framing, the `initialize` / `initialized` / `shutdown` / `exit` handshake and request routing;
you register handlers. Its only dependencies are `serde` and `serde_json`.

## Install

The crate is not published to crates.io yet. Depend on it by path from a QuadFlow checkout (the
`tile-sidecar-rust` template of `npm create quadflow-plugin` writes this for you):

```toml
[dependencies]
quadflow-sidecar = { path = "<quadflow checkout>/packages/sidecar-sdk-rust" }
```

The manifest lists one binary per OS and architecture you ship; `@quadflow/plugin-build` builds
the crate in `sidecar/` with `cargo build --release` and copies the binary for the current
machine into place:

```json
"sidecar": {
  "binaries": { "windows-x86_64": "bin/my-sidecar.exe", "macos-aarch64": "bin/my-sidecar", "linux-x86_64": "bin/my-sidecar" },
  "activation": "onDemand",
  "restart": "onCrash"
}
```

## Example

```rust
use quadflow_sidecar::{json, RpcError, Server, Value};

fn main() -> std::io::Result<()> {
    Server::new()
        .on_initialize(|host, init| {
            let project = init.get("project").and_then(|p| p.get("root")).cloned().unwrap_or(Value::Null);
            host.log("info", format!("initialized; project = {project}"));
            Ok(json!({ "capabilities": {} }))
        })
        .on_request("greet", |host, params| {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("world");
            if name.trim().is_empty() {
                return Err(RpcError::invalid_params("name must not be empty"));
            }
            // Any host API method, permission-checked like a call from the UI.
            host.call("storage.set", json!({ "key": "lastGreeted", "value": name }))?;
            Ok(json!({ "message": format!("Hello, {name}!") }))
        })
        .on_notification("settings/didChange", |host, p| host.log("info", format!("settings changed: {p}")))
        .run()
}
```

From the plugin UI: `await ctx.sidecar.request('greet', { name: 'Ada' })`.

Each request runs on its own thread, so a handler can call back into the host while other
requests are served. Never print to stdout yourself: it is the protocol channel. Use
`Host::log` or stderr (both end up in the plugin log).

## API overview

| Item | Description |
|---|---|
| `Server::new()` | A new server; chain the handlers below, then `run()` |
| `on_request(method, Fn(&Host, Value) -> RpcResult)` | Handle a request |
| `on_notification(method, Fn(&Host, Value))` | Handle a notification (`settings/didChange`, `project/didChange`, …) |
| `on_initialize(Fn(&Host, &Value) -> RpcResult)` | Its result is the `initialize` response |
| `on_shutdown(Fn(&Host, Value) -> RpcResult)` | Clean up before exit |
| `run()` / `run_with(input, output)` | Serve on stdin/stdout, or on any `BufRead` / `Write` (for tests) |
| `Host::call(method, params)` / `call_timeout` | Run a host API method (`storage.get`, `data.issues.create`, `http.fetch`, …) with the plugin's permissions (default timeout 60 s) |
| `Host::request_timeout` / `Host::notify` | Raw JSON-RPC to the host |
| `Host::emit(topic, payload)` | Plugin event, received with `ctx.events.onPlugin(<id>, topic, …)` |
| `Host::ui(name, params)` | `ui/<name>` notification to every tile of the plugin |
| `Host::log(level, message)` | Write to the plugin log |
| `Host::init()` | The `initialize` params, once the handshake is done |
| `RpcError` | `new`, `with_kind(kind, msg)`, `invalid_params`; `kind()` and `details()` on errors from the host |
| `RpcResult` | `Result<Value, RpcError>` |
| `json!`, `Value` | Re-exported from `serde_json` |

`Host` is cheap to clone and usable from any thread.

## Development

```bash
cargo test -p quadflow-sidecar     # from the repository root (a Cargo workspace member)
```

## Documentation

- [Sidecars](../../docs/plugins/sidecars.md) — declaring one, the protocol, dev mode
- [CLI commands](../../docs/plugins/cli-commands.md)
- [Node SDK](../sidecar-sdk-node/README.md)

## License

AGPL-3.0-only, part of QuadFlow.
