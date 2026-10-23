//! Sidecar of the `{{id}}` QuadFlow plugin: NDJSON JSON-RPC 2.0 over stdin/stdout
//! (QuadFlow docs: docs/plugins/sidecars.md). stdout is the protocol channel — log with
//! `eprintln!` (captured into the plugin log) or `host.log(…)`.

use quadflow_sidecar::{json, RpcError, Server, Value};
use std::sync::atomic::{AtomicU64, Ordering};

static CALLS: AtomicU64 = AtomicU64::new(0);

fn main() -> std::io::Result<()> {
    eprintln!("{{crate}} {} starting (pid {})", env!("CARGO_PKG_VERSION"), std::process::id());
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
            // Host API calls run with the plugin's permissions; storage needs none.
            let calls = CALLS.fetch_add(1, Ordering::SeqCst) + 1;
            host.call("storage.set", json!({ "key": "lastGreeted", "value": name }))?;
            Ok(json!({ "message": format!("Hello, {name}!"), "pid": std::process::id(), "calls": calls }))
        })
        .on_notification("settings/didChange", |host, p| host.log("info", format!("settings changed: {p}")))
        .run()
}
