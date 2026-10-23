//! Plugin dev mode in the app (plugin-system.md §15.3): watches the folders of `dev` plugins
//! (`quadflow_core::plugins::dev::DevWatcher`) and, on a rebuild,
//! - drops the cached registry / asset index (a changed manifest changes contributions),
//! - restarts the plugin's sidecar if it is running and its binary or entry changed,
//! - emits [`DEV_CHANGED_EVENT`] to the main window, whose plugin registry re-imports the UI
//!   module and remounts its tiles (tile instances keep their persisted `state`).
//!
//! The watched set follows the registry: [`sync`] runs whenever the shell lists plugins.

use super::sidecars;
use parking_lot::Mutex;
use quadflow_core::plugins::dev::{dev_targets, DevWatcher, PluginDevChange};
use quadflow_core::plugins::sidecar::PluginSidecarState;
use quadflow_core::plugins::PluginRegistry;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Wry};

/// Tauri event (main window) with a [`PluginDevChange`] payload.
pub const DEV_CHANGED_EVENT: &str = "plugin-dev-changed";

static WATCHER: OnceLock<Mutex<Option<DevWatcher>>> = OnceLock::new();

fn on_change(app: &AppHandle<Wry>, change: PluginDevChange) {
    crate::plugin_protocol::invalidate(app);
    super::invalidate(app);
    if change.sidecar || change.manifest {
        if let Ok(sup) = sidecars::supervisor(app) {
            let state = sup.status(&change.plugin_id).state;
            if matches!(state, PluginSidecarState::Running | PluginSidecarState::Starting | PluginSidecarState::Restarting | PluginSidecarState::Failed) {
                log::info!("[plugins] dev: restarting the sidecar of {} after a rebuild", change.plugin_id);
                sup.restart(&change.plugin_id);
            }
        }
    }
    let _ = app.emit_to("main", DEV_CHANGED_EVENT, &change);
}

/// Watch exactly the dev plugins of `reg` (cheap when nothing changed).
pub fn sync(app: &AppHandle<Wry>, reg: &PluginRegistry) {
    let targets = dev_targets(reg);
    let cell = WATCHER.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock();
    if guard.is_none() {
        if targets.is_empty() {
            return;
        }
        let app2 = app.clone();
        match DevWatcher::new(move |change| {
            let app = app2.clone();
            // Off the watcher thread: restarting a sidecar waits for the old process.
            std::thread::spawn(move || on_change(&app, change));
        }) {
            Ok(w) => *guard = Some(w),
            Err(e) => {
                log::warn!("[plugins] dev watcher could not start: {e}");
                return;
            }
        }
    }
    if let Some(w) = guard.as_mut() {
        w.set_targets(targets);
    }
}
