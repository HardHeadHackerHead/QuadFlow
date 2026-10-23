//! App launcher: start a program for a key (the tool config / tile it belongs
//! to), remember the child so `status` is exact (`try_wait`, not "a process
//! with this pid exists"), and focus its window when it is launched again.
//!
//! The child gets null stdio — this process's stdout is the RPC channel. On
//! Windows it is started with `CREATE_BREAKAWAY_FROM_JOB` so it is not killed
//! with QuadFlow's sidecar job; if the host's job does not allow breakaway the
//! launch falls back to a normal child and reports `boundToQuadflow: true`.

use crate::str_param;
use quadflow_sidecar::{json, RpcError, RpcResult, Value};
use std::collections::HashMap;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};

struct Launched {
    child: Child,
    bound: bool,
}

fn children() -> &'static Mutex<HashMap<String, Launched>> {
    static M: OnceLock<Mutex<HashMap<String, Launched>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

fn key_of(p: &Value) -> Result<String, RpcError> {
    str_param(p, "key").ok_or_else(|| RpcError::invalid_params("key is required"))
}

/// Pid of the live child for `key` (reaps and forgets an exited one).
fn live_pid(map: &mut HashMap<String, Launched>, key: &str) -> Option<(u32, bool)> {
    let alive = match map.get_mut(key) {
        Some(l) => matches!(l.child.try_wait(), Ok(None)),
        None => return None,
    };
    if alive {
        map.get(key).map(|l| (l.child.id(), l.bound))
    } else {
        map.remove(key);
        None
    }
}

fn spawn(path: &str, args: &[String], cwd: Option<&str>) -> std::io::Result<(Child, bool)> {
    let build = || {
        let mut c = Command::new(path);
        c.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        if let Some(d) = cwd {
            c.current_dir(d);
        }
        c
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        match build().creation_flags(CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_PROCESS_GROUP).spawn() {
            Ok(c) => return Ok((c, false)),
            // ERROR_ACCESS_DENIED: the job does not allow breakaway.
            Err(e) if e.raw_os_error() == Some(5) => {
                return build().creation_flags(CREATE_NEW_PROCESS_GROUP).spawn().map(|c| (c, true));
            }
            Err(e) => return Err(e),
        }
    }
    #[cfg(not(windows))]
    {
        build().spawn().map(|c| (c, false))
    }
}

pub fn launch(p: &Value) -> RpcResult {
    let key = key_of(p)?;
    let path = str_param(p, "path").ok_or_else(|| RpcError::invalid_params("path is required"))?;
    let args: Vec<String> = p
        .get("args")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let cwd = str_param(p, "cwd");
    let focus_existing = p.get("focusExisting").and_then(Value::as_bool).unwrap_or(true);

    let mut map = children().lock().unwrap_or_else(|e| e.into_inner());
    if let Some((pid, bound)) = live_pid(&mut map, &key) {
        drop(map);
        #[cfg(windows)]
        if focus_existing {
            let _ = crate::win::focus_pid(pid);
        }
        let _ = focus_existing;
        return Ok(json!({ "pid": pid, "alreadyRunning": true, "boundToQuadflow": bound }));
    }
    let (child, bound) =
        spawn(&path, &args, cwd.as_deref()).map_err(|e| RpcError::with_kind("external", format!("Failed to launch '{path}': {e}")))?;
    let pid = child.id();
    map.insert(key, Launched { child, bound });
    Ok(json!({ "pid": pid, "alreadyRunning": false, "boundToQuadflow": bound }))
}

pub fn status(p: &Value) -> RpcResult {
    let key = key_of(p)?;
    let mut map = children().lock().unwrap_or_else(|e| e.into_inner());
    Ok(match live_pid(&mut map, &key) {
        Some((pid, bound)) => json!({ "running": true, "pid": pid, "boundToQuadflow": bound }),
        None => json!({ "running": false, "pid": null }),
    })
}

/// Stop tracking `key` (the process keeps running).
pub fn forget(p: &Value) -> RpcResult {
    let key = key_of(p)?;
    children().lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
    Ok(Value::Null)
}

#[cfg(windows)]
pub fn focus(p: &Value) -> RpcResult {
    let key = key_of(p)?;
    let pid = {
        let mut map = children().lock().unwrap_or_else(|e| e.into_inner());
        live_pid(&mut map, &key).map(|(pid, _)| pid)
    };
    Ok(json!(match pid {
        Some(pid) => crate::win::focus_pid(pid),
        None => false,
    }))
}
