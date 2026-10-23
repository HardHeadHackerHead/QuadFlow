//! The app side of plugin sidecars (plugin-system.md §10): the
//! [`SidecarHost`] the core supervisor talks to.
//!
//! - launch config: resolved from the cached registry (`resolve`), with the
//!   plugin's settings and the active project in `initialize`;
//! - `host/call`: [`super::invoke`], i.e. the same permission-checked dispatch
//!   table as `plugin_invoke` from the plugin's UI;
//! - `ui/*` and `host/emit` notifications: Tauri event [`SIDECAR_EVENT`] to the
//!   main window (the shell routes them to `ctx.sidecar.onNotification` and the
//!   `events` bus); status changes: [`SIDECAR_STATUS_EVENT`];
//! - core bus → sidecars: `settings/didChange` for the plugin's own settings,
//!   `project/didChange` when the active project changes.
//!
//! The processes live in Job Objects / process groups (core `sidecar::process`),
//! so they die with the app even on a crash; a clean exit also stops them
//! gracefully ([`stop_all`], wired as a Tauri plugin `on_event(Exit)`).

use super::PluginHostState;
use crate::core_state::CoreState;
use quadflow_core::domains::app::projects;
use quadflow_core::events::Domain;
use quadflow_core::plugins::host::{self, HostCall};
use quadflow_core::plugins::manifest::SidecarActivation;
use quadflow_core::plugins::sidecar::{
    self, PluginSidecarStatus, ResolveContext, SidecarConfig, SidecarHost, SidecarSupervisor, SupervisorOptions,
};
use quadflow_core::CoreError;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Wry};

/// `{ pluginId, method, params }` for sidecar → UI notifications (`ui/<name>`, `host/emit`).
pub const SIDECAR_EVENT: &str = "plugin-sidecar";
/// [`PluginSidecarStatus`] whenever a sidecar's state changes.
pub const SIDECAR_STATUS_EVENT: &str = "plugin-sidecar-status";

struct AppSidecarHost {
    app: AppHandle<Wry>,
}

fn active_project(core: &quadflow_core::Core) -> Option<(String, String)> {
    let db = core.app_db().ok()?;
    let p = projects::active(&db).ok()??;
    let key = quadflow_core::paths::root_key(std::path::Path::new(&p.root));
    Some((p.root, key))
}

impl SidecarHost for AppSidecarHost {
    fn config(&self, plugin_id: &str) -> Result<SidecarConfig, CoreError> {
        let state = self.app.state::<PluginHostState>();
        let env = state.env(&self.app)?;
        let reg = state.registry(&env.core)?;
        let plugin = reg.require(plugin_id)?;
        let settings = host::dispatch(&env, HostCall { plugin, method: "settings.getAll", params: json!({}) })
            .unwrap_or_else(|_| json!({}));
        let version = self.app.package_info().version.to_string();
        let ctx = ResolveContext {
            paths: &env.core.paths,
            host_version: &version,
            mode: "gui",
            project: active_project(&env.core),
            settings,
            locale: sys_locale(),
        };
        sidecar::resolve(plugin, &ctx)
    }

    fn host_call(&self, plugin_id: &str, method: &str, params: Value) -> Result<Value, CoreError> {
        super::invoke(&self.app, plugin_id, method, params)
    }

    fn notification(&self, plugin_id: &str, method: &str, params: Value) {
        if method.starts_with("ui/") || method == "host/emit" {
            let _ = self.app.emit_to("main", SIDECAR_EVENT, json!({ "pluginId": plugin_id, "method": method, "params": params }));
        } else {
            log::debug!("[sidecar:{plugin_id}] ignoring notification {method}");
        }
    }

    fn state_changed(&self, status: &PluginSidecarStatus) {
        let _ = self.app.emit_to("main", SIDECAR_STATUS_EVENT, status);
    }
}

fn sys_locale() -> String {
    std::env::var("LANG")
        .ok()
        .and_then(|l| l.split('.').next().map(|s| s.replace('_', "-")))
        .filter(|l| !l.is_empty() && l != "C")
        .unwrap_or_else(|| "en-US".into())
}

/// The app's supervisor (created on first use).
pub fn supervisor(app: &AppHandle<Wry>) -> Result<SidecarSupervisor, CoreError> {
    let state = app.state::<PluginHostState>();
    if let Some(s) = state.sidecars.get() {
        return Ok(s.clone());
    }
    let core = app.try_state::<CoreState>().ok_or_else(|| CoreError::internal("core state missing"))?;
    let opts = SupervisorOptions { logs_dir: Some(core.core.paths.logs_dir.clone()), ..SupervisorOptions::default() };
    let sup = SidecarSupervisor::new(std::sync::Arc::new(AppSidecarHost { app: app.clone() }), opts);
    if state.sidecars.set(sup.clone()).is_ok() {
        bridge_bus(app, &core.core, sup.clone());
    }
    Ok(state.sidecars.get().expect("just set").clone())
}

/// Settings / active-project changes → running sidecars.
fn bridge_bus(app: &AppHandle<Wry>, core: &std::sync::Arc<quadflow_core::Core>, sup: SidecarSupervisor) {
    let app = app.clone();
    let core2 = std::sync::Arc::clone(core);
    core.bus.subscribe(move |e| {
        if e.domain != Domain::Settings {
            return;
        }
        let ids = e.ids.clone();
        let (app, core, sup) = (app.clone(), std::sync::Arc::clone(&core2), sup.clone());
        // Off the publisher's thread (it may hold a transaction).
        std::thread::spawn(move || {
            for id in ids {
                if id == "shell/activeProjectId" {
                    let project = active_project(&core).map(|(root, key)| json!({ "root": root, "rootKey": key }));
                    sup.broadcast("project/didChange", project.unwrap_or(Value::Null));
                } else if let Some((plugin, key)) = id.strip_prefix("plugin:").and_then(|r| r.split_once('/')) {
                    if sup.status(plugin).state != sidecar::PluginSidecarState::Running {
                        continue;
                    }
                    let value = super::invoke(&app, plugin, "settings.getAll", json!({}))
                        .ok()
                        .and_then(|all| all.get(key).cloned())
                        .unwrap_or(Value::Null);
                    sup.notify_if_running(plugin, "settings/didChange", json!({ "key": key, "value": value }));
                }
            }
        });
    });
}

/// Stop a plugin's sidecar (disable, uninstall, update, rollback). No-op if none ran.
pub fn stop<R: tauri::Runtime>(app: &AppHandle<R>, plugin_id: &str) {
    if let Some(s) = app.try_state::<PluginHostState>().and_then(|s| s.sidecars.get().cloned()) {
        s.stop(plugin_id);
    }
}

/// Stop every sidecar (app exit).
pub fn stop_all<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Some(s) = app.try_state::<PluginHostState>().and_then(|s| s.sidecars.get().cloned()) {
        s.stop_all();
    }
}

/// Start the sidecars of active plugins with `activation: onStartup` (background).
pub fn start_startup_sidecars(app: &AppHandle<Wry>) {
    let app = app.clone();
    std::thread::spawn(move || {
        let run = || -> Result<(), CoreError> {
            let state = app.state::<PluginHostState>();
            let env = state.env(&app)?;
            let reg = state.registry(&env.core)?;
            let sup = supervisor(&app)?;
            for p in reg.active() {
                let on_startup = p
                    .manifest
                    .as_ref()
                    .and_then(|m| m.sidecar.as_ref())
                    .is_some_and(|s| s.activation == SidecarActivation::OnStartup);
                if on_startup {
                    sup.ensure_started(&p.id);
                }
            }
            Ok(())
        };
        if let Err(e) = run() {
            log::warn!("[sidecars] startup activation failed: {e}");
        }
    });
}

/// Ensure the plugin is active and declares a sidecar (before creating a slot for it).
pub fn require_sidecar(app: &AppHandle<Wry>, plugin_id: &str) -> Result<(), CoreError> {
    let state = app.state::<PluginHostState>();
    let env = state.env(app)?;
    let reg = state.registry(&env.core)?;
    let plugin = reg.require(plugin_id)?;
    if !sidecar::resolve::has_sidecar(plugin) {
        return Err(CoreError::unsupported(format!("plugin {plugin_id:?} has no sidecar")));
    }
    if !plugin.is_active() {
        return Err(CoreError::permission_denied(format!("plugin {plugin_id:?} is not active ({})", plugin.status.label())));
    }
    Ok(())
}
