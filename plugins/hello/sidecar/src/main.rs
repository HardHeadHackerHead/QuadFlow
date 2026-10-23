//! Sidecar of the `hello` example plugin (plugin-system.md §9, §10; PL-7, PL-8).
//!
//! As a sidecar (`QUADFLOW_SIDECAR_MODE` = `gui` | `cli`):
//! - `ping`: `{ pong, pid, uptimeMs, calls }`
//! - `hostCall`: bumps a counter in the plugin's own storage through `host/call`
//!   (implicit permission), then tries `clipboard.readText`, which hello does not
//!   hold, and reports the `permission_denied`.
//! - `emit`: `host/emit` topic `tick` (UI: `ctx.events.onPlugin('hello', 'tick', …)`)
//!   plus a `ui/tick` notification (UI: `ctx.sidecar.onNotification('tick', …)`).
//! - `crash`: exits with code 3 (the supervisor restarts it with backoff).
//! - `cli/run` (CLI mode): `quadflow hello <args>` — output via `cli/output`.
//!
//! Without `QUADFLOW_SIDECAR_MODE` the same binary is the `exec` CLI handler of
//! `quadflow hello-exec <args>`: plain stdout/stderr, exit code = process exit code.

use quadflow_sidecar::{json, Host, RpcError, Server, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

static CALLS: AtomicU64 = AtomicU64::new(0);

fn host_call(host: &Host) -> Result<Value, RpcError> {
    let prev = host.call("storage.get", json!({ "key": "sidecarCount" }))?;
    let count = prev.as_u64().unwrap_or(0) + 1;
    host.call("storage.set", json!({ "key": "sidecarCount", "value": count }))?;
    // hello does not declare clipboard:read: the dispatch table must refuse.
    let denied = match host.call("clipboard.readText", json!({})) {
        Ok(_) => json!({ "allowed": true }),
        Err(e) => json!({
            "allowed": false,
            "code": e.kind(),
            "permission": e.details().and_then(|d| d.get("permission")).cloned(),
        }),
    };
    Ok(json!({ "count": count, "clipboardRead": denied }))
}

// ---------------------------------------------------------------------------
// CLI (both handler types)
// ---------------------------------------------------------------------------

/// What one CLI invocation printed and returned.
#[derive(Default)]
struct CliOut {
    stdout: String,
    stderr: String,
    code: i32,
}

const USAGE: &str = "usage: quadflow hello[-exec] <ping [MESSAGE…] [--roundtrip] | fail>\n";

/// Shared CLI behavior. `extra` adds handler-specific fields to `ping`'s data.
fn cli(argv: &[String], json_mode: bool, via: &str, project_root: Value, extra: impl FnOnce(&[String]) -> Result<Value, String>) -> CliOut {
    let ok = |data: Value, human: String| {
        if json_mode {
            CliOut { stdout: format!("{}\n", json!({ "ok": true, "data": data })), ..Default::default() }
        } else {
            CliOut { stdout: human, ..Default::default() }
        }
    };
    let err = |code: &str, message: String, exit: i32| {
        if json_mode {
            CliOut { stdout: format!("{}\n", json!({ "ok": false, "error": { "code": code, "message": message } })), code: exit, ..Default::default() }
        } else {
            CliOut { stderr: format!("quadflow: {message}\n"), code: exit, ..Default::default() }
        }
    };
    match argv.first().map(String::as_str) {
        Some("ping") => {
            let rest = &argv[1..];
            let words: Vec<&str> = rest.iter().map(String::as_str).filter(|a| !a.starts_with("--")).collect();
            let message = if words.is_empty() { "pong".to_string() } else { words.join(" ") };
            let mut data = json!({
                "pong": message,
                "via": via,
                "pluginId": std::env::var("QUADFLOW_PLUGIN_ID").ok(),
                "projectRoot": project_root,
                "pid": std::process::id(),
            });
            match extra(rest) {
                Ok(Value::Object(m)) => {
                    for (k, v) in m {
                        data[k] = v;
                    }
                }
                Ok(_) => {}
                Err(e) => return err("external", e, 1),
            }
            let human = format!("{message} (via {via})\n");
            ok(data, human)
        }
        Some("fail") => err("not_found", "hello: nothing to see here".into(), 3),
        _ => {
            let mut o = err("invalid_input", USAGE.trim_end().to_string(), 2);
            if !json_mode {
                o.stderr = USAGE.to_string();
            }
            o
        }
    }
}

/// `quadflow hello <args>` (sidecar handler, `cli/run`).
fn cli_run(host: &Host, params: Value) -> Result<Value, RpcError> {
    let argv: Vec<String> = params
        .get("argv")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let json_mode = params.get("json").and_then(Value::as_bool).unwrap_or(false);
    let project_root = params.get("projectRoot").cloned().unwrap_or(Value::Null);
    let out = cli(&argv, json_mode, "sidecar", project_root, |_| {
        // Host API in CLI mode: the plugin's own storage, through the dispatch table.
        let prev = host.call("storage.get", json!({ "key": "cliRuns" })).map_err(|e| e.message.clone())?;
        let count = prev.as_u64().unwrap_or(0) + 1;
        host.call("storage.set", json!({ "key": "cliRuns", "value": count })).map_err(|e| e.message.clone())?;
        // Terminal methods need the app: reported as unsupported in CLI mode.
        let terminal = match host.call("terminals.list", json!({})) {
            Ok(_) => Value::from("available"),
            Err(e) => Value::from(e.kind().unwrap_or("error").to_string()),
        };
        Ok(json!({ "count": count, "terminals": terminal, "mode": std::env::var("QUADFLOW_SIDECAR_MODE").ok() }))
    });
    if !out.stdout.is_empty() {
        host.notify("cli/output", json!({ "stream": "stdout", "text": out.stdout }));
    }
    if !out.stderr.is_empty() {
        host.notify("cli/output", json!({ "stream": "stderr", "text": out.stderr }));
    }
    Ok(json!({ "exitCode": out.code }))
}

/// `quadflow hello-exec <args>` (exec handler).
fn exec_main() -> i32 {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let json_mode = std::env::var("QUADFLOW_JSON").as_deref() == Ok("1");
    let project_root = std::env::var("QUADFLOW_PROJECT_DIR").ok().filter(|p| !p.is_empty()).map(Value::from).unwrap_or(Value::Null);
    let out = cli(&argv, json_mode, "exec", project_root, |rest| {
        if !rest.iter().any(|a| a == "--roundtrip") {
            return Ok(json!({}));
        }
        // Data access from an exec binary: call the QuadFlow CLI back with --json.
        let exe = std::env::var("QUADFLOW_CLI").map_err(|_| "QUADFLOW_CLI is not set".to_string())?;
        let o = std::process::Command::new(&exe)
            .args(["--json", "docs", "--list"])
            .output()
            .map_err(|e| format!("run {exe}: {e}"))?;
        let v: Value = String::from_utf8_lossy(&o.stdout).parse::<Value>().map_err(|e| format!("parse docs --list: {e}"))?;
        let modules: Vec<Value> = v["data"].as_array().cloned().unwrap_or_default().iter().map(|m| m["id"].clone()).collect();
        Ok(json!({ "modules": modules }))
    });
    print!("{}", out.stdout);
    eprint!("{}", out.stderr);
    out.code
}

fn main() -> std::io::Result<()> {
    if std::env::var_os("QUADFLOW_SIDECAR_MODE").is_none() {
        std::process::exit(exec_main());
    }
    let started = Instant::now();
    eprintln!("hello-sidecar {} starting (pid {})", env!("CARGO_PKG_VERSION"), std::process::id());
    Server::new()
        .on_initialize(|host, init| {
            let project = init.get("project").and_then(|p| p.get("root")).cloned().unwrap_or(Value::Null);
            let mode = init.get("host").and_then(|h| h.get("mode")).cloned().unwrap_or(Value::Null);
            host.log("info", format!("initialized (mode {mode}); project = {project}"));
            Ok(json!({ "capabilities": { "cli": true } }))
        })
        .on_request("ping", move |_host, params| {
            let calls = CALLS.fetch_add(1, Ordering::SeqCst) + 1;
            Ok(json!({
                "pong": params,
                "pid": std::process::id(),
                "uptimeMs": started.elapsed().as_millis() as u64,
                "calls": calls,
            }))
        })
        .on_request("hostCall", |host, _| host_call(host))
        .on_request("emit", |host, params| {
            let payload = json!({ "at": params.get("at").cloned().unwrap_or(Value::Null), "from": "sidecar" });
            host.emit("tick", payload.clone());
            host.ui("tick", payload);
            Ok(Value::Null)
        })
        .on_request("crash", |host, _| {
            host.log("warn", "crash requested; exiting with code 3");
            eprintln!("hello-sidecar: crashing on purpose");
            std::process::exit(3)
        })
        .on_request("cli/run", cli_run)
        .on_notification("settings/didChange", |host, p| host.log("info", format!("settings/didChange {p}")))
        .on_notification("project/didChange", |host, p| host.log("info", format!("project/didChange {p}")))
        .run()
}
