//! Sidecar of the `external-apps` QuadFlow plugin (docs/plugins/sidecars.md).
//!
//! All native work of the tool lives here, out of the QuadFlow process:
//!  - `apps.*`    launch a program, track it per key, focus its window;
//!  - `windows.*` enumerate top-level windows, focus one (Window Link);
//!  - `embed.*`   reparent a foreign window into QuadFlow's main window and keep
//!                it on its tile (bounds / visibility / focus / detach);
//!  - `drag.*`    optional drag-to-embed monitor (WinEvent hook).
//!
//! A hung foreign window can only block a worker thread of this process: every
//! Win32 call that sends a message to another process runs with a timeout
//! (`SendMessageTimeoutW`, `SWP_ASYNCWINDOWPOS`, `ShowWindowAsync`, or a worker
//! thread with a deadline). Embedded windows are restored (detached) on
//! `shutdown`, when stdin closes (QuadFlow exited or crashed) and, after a
//! crash of this process, on the next start (`embeds.json` in the data dir).
//!
//! stdout is the protocol channel: log with `eprintln!` or `host.log`.

use quadflow_sidecar::{json, RpcError, Server, Value};

mod launcher;
#[cfg(windows)]
mod win;

pub(crate) fn hwnd_param(p: &Value, key: &str) -> Result<i64, RpcError> {
    let v = p.get(key).ok_or_else(|| RpcError::invalid_params(format!("{key} is required")))?;
    let n = match v {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => s.trim().parse::<i64>().ok(),
        _ => None,
    };
    n.filter(|n| *n != 0).ok_or_else(|| RpcError::invalid_params(format!("{key} must be a window handle")))
}

pub(crate) fn str_param(p: &Value, key: &str) -> Option<String> {
    p.get(key).and_then(Value::as_str).map(str::to_string).filter(|s| !s.is_empty())
}

#[cfg(not(windows))]
fn unsupported(_h: &quadflow_sidecar::Host, _p: Value) -> quadflow_sidecar::RpcResult {
    Err(RpcError::with_kind("unsupported", "window listing, linking and embedding are only supported on Windows"))
}

fn main() -> std::io::Result<()> {
    eprintln!("external-apps-sidecar {} starting (pid {})", env!("CARGO_PKG_VERSION"), std::process::id());
    let server = Server::new()
        .on_initialize(|host, _init| {
            #[cfg(windows)]
            win::start(host.clone());
            let _ = host;
            Ok(json!({ "capabilities": { "embed": cfg!(windows), "windows": cfg!(windows) } }))
        })
        .on_shutdown(|_host, _| {
            #[cfg(windows)]
            win::detach_all();
            Ok(Value::Null)
        })
        .on_request("apps.launch", |_h, p| launcher::launch(&p))
        .on_request("apps.status", |_h, p| launcher::status(&p))
        .on_request("apps.forget", |_h, p| launcher::forget(&p));

    #[cfg(windows)]
    let server = server
        .on_request("apps.focus", |_h, p| launcher::focus(&p))
        .on_request("apps.findWindow", |_h, p| win::find_window_for_pid(&p))
        .on_request("windows.list", |_h, p| win::list_windows(&p))
        .on_request("windows.focus", |_h, p| win::focus_top_level(&p))
        .on_request("windows.focusMatch", |_h, p| win::focus_match(&p))
        .on_request("embed.attach", |_h, p| win::attach(&p))
        .on_request("embed.detach", |_h, p| win::detach(&p))
        .on_request("embed.detachAll", |_h, _p| {
            win::detach_all();
            Ok(Value::Null)
        })
        .on_request("embed.bounds", |_h, p| win::set_bounds(&p))
        .on_request("embed.focus", |_h, p| win::focus_embedded(&p))
        .on_request("embed.list", |_h, _p| win::list_embedded())
        .on_request("drag.start", |_h, p| win::drag_start(&p))
        .on_request("drag.stop", |_h, _p| win::drag_stop());

    #[cfg(not(windows))]
    let server = {
        let mut s = server;
        for m in [
            "apps.focus", "apps.findWindow", "windows.list", "windows.focus", "windows.focusMatch", "embed.attach",
            "embed.detach", "embed.detachAll", "embed.bounds", "embed.focus", "embed.list", "drag.start", "drag.stop",
        ] {
            s = s.on_request(m, unsupported);
        }
        s
    };

    let r = server.run();
    // stdin closed or `exit`: QuadFlow is going away (or crashed). Never leave a
    // foreign window parented to a window that is about to be destroyed.
    #[cfg(windows)]
    win::detach_all();
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hwnd_params_accept_numbers_and_decimal_strings() {
        assert_eq!(hwnd_param(&json!({ "hwnd": 1234 }), "hwnd").unwrap(), 1234);
        assert_eq!(hwnd_param(&json!({ "main": "5678" }), "main").unwrap(), 5678);
        assert!(hwnd_param(&json!({ "hwnd": 0 }), "hwnd").is_err());
        assert!(hwnd_param(&json!({ "hwnd": "x" }), "hwnd").is_err());
        assert!(hwnd_param(&json!({}), "hwnd").is_err());
    }

    #[test]
    fn launcher_reports_unknown_keys_as_stopped() {
        let r = launcher::status(&json!({ "key": "nothing" })).unwrap();
        assert_eq!(r["running"], json!(false));
        assert!(launcher::launch(&json!({ "key": "k" })).is_err(), "path is required");
    }
}
