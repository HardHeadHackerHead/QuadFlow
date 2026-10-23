//! `terminals.*` (plugin-system.md §6.4). `terminal:spawn` creates terminals
//! the plugin owns (read/write/resize/kill/stream its own); `terminal:io`
//! reaches any terminal, including agent sessions. Ownership is enforced
//! here, in Rust.
//!
//! The PTY itself is the shell's `TerminalManager`; a plugin terminal shown in
//! a tile is the same PTY (the tile re-attaches by id).

use super::AppExtension;
use crate::terminal::{CreateTerminalOptions, TerminalManager};
use parking_lot::Mutex;
use quadflow_core::domains::environments;
use quadflow_core::plugins::host::{HostCall, HostEnv, MethodSpec, PermReq, Sink, SubscriptionGuard, TopicSpec};
use quadflow_core::CoreError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use tauri::{AppHandle, Listener, Manager, Wry};

/// Scrollback kept per captured terminal for `readBuffer`.
pub const BUFFER_MAX_BYTES: usize = 256 * 1024;

struct Owned {
    plugin_id: String,
    title: String,
}

#[derive(Default)]
pub struct PluginTerminals {
    owners: Mutex<HashMap<String, Owned>>,
    buffers: Arc<Mutex<HashMap<String, String>>>,
    capture: Mutex<HashMap<String, tauri::EventId>>,
}

impl PluginTerminals {
    fn owner(&self, id: &str) -> Option<String> {
        self.owners.lock().get(id).map(|o| o.plugin_id.clone())
    }

    /// Start keeping a scrollback copy of `id` (idempotent).
    fn capture(&self, app: &AppHandle<Wry>, id: &str) {
        let mut cap = self.capture.lock();
        if cap.contains_key(id) {
            return;
        }
        let buffers = Arc::clone(&self.buffers);
        let key = id.to_string();
        let ev = app.listen(format!("terminal:data:{id}"), move |e| {
            let Ok(chunk) = serde_json::from_str::<String>(e.payload()) else { return };
            let mut b = buffers.lock();
            let buf = b.entry(key.clone()).or_default();
            buf.push_str(&chunk);
            if buf.len() > BUFFER_MAX_BYTES {
                let mut cut = buf.len() - BUFFER_MAX_BYTES;
                while !buf.is_char_boundary(cut) {
                    cut += 1;
                }
                buf.drain(..cut);
            }
        });
        cap.insert(id.to_string(), ev);
    }

    /// Make `id` (created elsewhere for `plugin_id`, e.g. by `agents.launch`)
    /// one of the plugin's own terminals: it may read, write, resize, kill and
    /// stream it without `terminal:io`, and its scrollback is kept.
    pub(super) fn adopt(&self, app: &AppHandle<Wry>, id: &str, plugin_id: &str, title: &str) {
        self.owners
            .lock()
            .entry(id.to_string())
            .or_insert_with(|| Owned { plugin_id: plugin_id.to_string(), title: title.to_string() });
        self.capture(app, id);
    }

    fn forget(&self, app: &AppHandle<Wry>, id: &str) {
        self.owners.lock().remove(id);
        if let Some(ev) = self.capture.lock().remove(id) {
            app.unlisten(ev);
        }
        self.buffers.lock().remove(id);
    }
}

/// Own terminal, or `terminal:io` (checked in Rust).
fn check_access(t: &PluginTerminals, c: &HostCall, id: &str) -> Result<(), CoreError> {
    if t.owner(id).as_deref() == Some(c.plugin.id.as_str()) {
        return Ok(());
    }
    c.require("terminal:io")
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SpawnOptions {
    cwd: Option<String>,
    shell: Option<String>,
    /// Absolute shell executable (API 1.2); overrides `shell` and the environment's shell.
    shell_path: Option<String>,
    environment_id: Option<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    cols: Option<u16>,
    rows: Option<u16>,
    #[serde(default)]
    init_commands: Vec<String>,
    title: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalHandleOut {
    id: String,
    pid: Option<u32>,
    cwd: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalSummaryOut {
    id: String,
    title: String,
    cwd: String,
    owner_plugin_id: Option<String>,
    /// Typed `AgentBinding` once AP-1 lands; `null` until then.
    agent: Option<Value>,
}

const SHELLS: &[&str] = &["default", "cmd", "powershell", "pwsh", "bash", "zsh", "sh"];

/// `shellPath` must name an existing file by absolute path. A plugin with
/// `terminal:spawn` can already run anything inside a shell, so this grants
/// nothing new; it only avoids guessing which `bash` is meant.
fn check_shell_path(p: &str) -> Result<String, CoreError> {
    let path = std::path::Path::new(p);
    if !path.is_absolute() {
        return Err(CoreError::invalid_input(format!("terminals.spawn: shellPath must be absolute, got {p:?}")));
    }
    if !path.is_file() {
        return Err(CoreError::invalid_input(format!("terminals.spawn: shellPath {p:?} is not a file")));
    }
    Ok(p.to_string())
}

fn manager(app: &AppHandle<Wry>) -> Arc<TerminalManager> {
    app.state::<Arc<TerminalManager>>().inner().clone()
}

fn ext_err(e: String) -> CoreError {
    CoreError::external(e)
}

pub(super) fn methods(ext: &AppExtension) -> Vec<MethodSpec> {
    let mut v = Vec::new();

    let (app, t) = (ext.app.clone(), Arc::clone(&ext.terminals));
    v.push(MethodSpec::new("terminals.spawn", PermReq::One("terminal:spawn"), move |env: &HostEnv, c: &HostCall| {
        let o: SpawnOptions = c.arg_or_default("options")?;
        let mut shell = match o.shell.as_deref() {
            None | Some("default") => None,
            Some(s) if SHELLS.contains(&s) => Some(s.to_string()),
            Some(s) => return Err(CoreError::invalid_input(format!("terminals.spawn: unknown shell {s:?}"))),
        };
        let mut init = Vec::new();
        let mut envs: HashMap<String, String> = HashMap::new();
        if let Some(key) = o.environment_id.as_deref().filter(|k| !k.trim().is_empty()) {
            let e = environments::get_by_id_or_name(&*env.core.app_db()?, key)?;
            shell = Some(match e.shell_path {
                Some(p) if !p.trim().is_empty() => p,
                _ => serde_json::to_value(e.shell)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
                    .unwrap_or_default(),
            });
            init.extend(e.init_commands);
            envs.extend(e.env);
        }
        if let Some(p) = o.shell_path.as_deref().filter(|p| !p.trim().is_empty()) {
            shell = Some(check_shell_path(p)?);
        }
        for k in o.env.keys() {
            if k.is_empty() || k.contains('=') || k.contains('\0') {
                return Err(CoreError::invalid_input(format!("terminals.spawn: invalid env var name {k:?}")));
            }
        }
        envs.extend(o.env);
        init.extend(o.init_commands);
        let cwd = match o.cwd.filter(|d| !d.trim().is_empty()) {
            Some(d) => Some(d),
            None => env.project_root(c).ok().map(|p| p.display().to_string()),
        };
        let id = format!("plugin-{}", uuid::Uuid::new_v4());
        let info = manager(&app)
            .create_terminal(
                app.clone(),
                CreateTerminalOptions {
                    cwd,
                    cols: o.cols,
                    rows: o.rows,
                    id: Some(id.clone()),
                    shell,
                    init_commands: (!init.is_empty()).then_some(init),
                    env: (!envs.is_empty()).then_some(envs),
                },
            )
            .map_err(ext_err)?;
        t.owners.lock().insert(
            id.clone(),
            Owned { plugin_id: c.plugin.id.clone(), title: o.title.unwrap_or_else(|| "Terminal".into()) },
        );
        t.capture(&app, &id);
        Ok(json!(TerminalHandleOut { id: info.id, pid: info.pid, cwd: info.cwd }))
    }));

    let (app, t) = (ext.app.clone(), Arc::clone(&ext.terminals));
    v.push(MethodSpec::new("terminals.list", PermReq::None, move |_env: &HostEnv, c: &HostCall| {
        let all_io = c.has("terminal:io");
        let owners = t.owners.lock();
        let out: Vec<TerminalSummaryOut> = manager(&app)
            .list_terminals()
            .into_iter()
            .filter_map(|i| {
                let own = owners.get(&i.id);
                let mine = own.is_some_and(|o| o.plugin_id == c.plugin.id);
                (mine || all_io).then(|| TerminalSummaryOut {
                    title: own.map(|o| o.title.clone()).unwrap_or_else(|| "Terminal".into()),
                    owner_plugin_id: own.map(|o| o.plugin_id.clone()),
                    id: i.id,
                    cwd: i.cwd,
                    agent: None,
                })
            })
            .collect();
        Ok(json!(out))
    }));

    let (app, t) = (ext.app.clone(), Arc::clone(&ext.terminals));
    v.push(MethodSpec::new("terminals.write", PermReq::None, move |_env: &HostEnv, c: &HostCall| {
        let id: String = c.arg("id")?;
        check_access(&t, c, &id)?;
        manager(&app).write_terminal(&id, &c.arg::<String>("data")?).map_err(ext_err)?;
        Ok(Value::Null)
    }));

    let (app, t) = (ext.app.clone(), Arc::clone(&ext.terminals));
    v.push(MethodSpec::new("terminals.resize", PermReq::None, move |_env: &HostEnv, c: &HostCall| {
        let id: String = c.arg("id")?;
        check_access(&t, c, &id)?;
        manager(&app).resize_terminal(&id, c.arg("cols")?, c.arg("rows")?).map_err(ext_err)?;
        Ok(Value::Null)
    }));

    let (app, t) = (ext.app.clone(), Arc::clone(&ext.terminals));
    v.push(MethodSpec::new("terminals.kill", PermReq::None, move |_env: &HostEnv, c: &HostCall| {
        let id: String = c.arg("id")?;
        check_access(&t, c, &id)?;
        manager(&app).kill_terminal(&id).map_err(ext_err)?;
        t.forget(&app, &id);
        Ok(Value::Null)
    }));

    // API 1.4: authorization step of `terminals.focus` (own terminal or `terminal:io`,
    // and it must exist); the frontend host then makes it the active terminal.
    let (app, t) = (ext.app.clone(), Arc::clone(&ext.terminals));
    v.push(MethodSpec::new("terminals.focus", PermReq::None, move |_env: &HostEnv, c: &HostCall| {
        let id: String = c.arg("id")?;
        check_access(&t, c, &id)?;
        manager(&app).get_terminal_info(&id).map_err(CoreError::not_found)?;
        Ok(Value::Null)
    }));

    let (app, t) = (ext.app.clone(), Arc::clone(&ext.terminals));
    v.push(MethodSpec::new("terminals.readBuffer", PermReq::None, move |_env: &HostEnv, c: &HostCall| {
        let id: String = c.arg("id")?;
        check_access(&t, c, &id)?;
        manager(&app).get_terminal_info(&id).map_err(|e| CoreError::not_found(e))?;
        // Terminals the plugin did not spawn are captured from the first read on.
        t.capture(&app, &id);
        let max: usize = c.opt::<usize>("maxBytes")?.unwrap_or(BUFFER_MAX_BYTES).min(BUFFER_MAX_BYTES);
        let b = t.buffers.lock();
        let s = b.get(&id).map(String::as_str).unwrap_or("");
        let mut start = s.len().saturating_sub(max);
        while !s.is_char_boundary(start) {
            start += 1;
        }
        Ok(Value::String(s[start..].to_string()))
    }));

    v
}

#[cfg(test)]
mod tests {
    use super::check_shell_path;

    #[test]
    fn shell_path_must_be_an_absolute_file() {
        assert!(check_shell_path("bash").is_err());
        assert!(check_shell_path("./bash").is_err());
        let missing = std::env::temp_dir().join("qf-no-such-shell-7f3a.exe");
        assert!(check_shell_path(&missing.display().to_string()).is_err());
        let exe = std::env::current_exe().unwrap().display().to_string();
        assert_eq!(check_shell_path(&exe).unwrap(), exe);
    }
}

/// Unlistens when the subscription is dropped.
struct Unlisten(AppHandle<Wry>, tauri::EventId);
impl Drop for Unlisten {
    fn drop(&mut self) {
        self.0.unlisten(self.1);
    }
}

pub(super) fn topics(ext: &AppExtension) -> Vec<TopicSpec> {
    let mut v = Vec::new();

    let (app, t) = (ext.app.clone(), Arc::clone(&ext.terminals));
    v.push(TopicSpec::new("terminals.onData", PermReq::None, move |_env: &HostEnv, c: &HostCall, sink: Sink| {
        let id: String = c.arg("id")?;
        check_access(&t, c, &id)?;
        let ev = app.listen(format!("terminal:data:{id}"), move |e| {
            if let Ok(chunk) = serde_json::from_str::<String>(e.payload()) {
                sink(Value::String(chunk));
            }
        });
        Ok(SubscriptionGuard::new(Unlisten(app.clone(), ev)))
    }));

    let (app, t) = (ext.app.clone(), Arc::clone(&ext.terminals));
    v.push(TopicSpec::new("terminals.onExit", PermReq::None, move |_env: &HostEnv, c: &HostCall, sink: Sink| {
        let id: String = c.arg("id")?;
        check_access(&t, c, &id)?;
        let ev = app.listen(format!("terminal:exit:{id}"), move |e| {
            let code = serde_json::from_str::<Value>(e.payload()).ok().and_then(|v| v.get("exitCode").cloned());
            sink(json!({ "code": code.unwrap_or(Value::Null) }));
        });
        Ok(SubscriptionGuard::new(Unlisten(app.clone(), ev)))
    }));

    v
}
