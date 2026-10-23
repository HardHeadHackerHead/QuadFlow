//! The Tauri side of `quadflow-core` (data-layer.md §8.4, §10.1): one `Core`
//! per app, the GUI actor, and the bus → `DataChanged` bridge.

use quadflow_core::events::ChangeEvent;
use quadflow_core::{Actor, Core, CoreError};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::AppHandle;
use tauri_specta::Event;

/// Emitted to every window for each core change event (wire name `data-changed`).
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(transparent)]
pub struct DataChanged(pub ChangeEvent);

pub struct CoreState {
    pub core: Arc<Core>,
    /// Actor for GUI-originated changes (`user.displayName` setting overrides in DL-10).
    pub actor: Actor,
}

impl CoreState {
    pub fn from_env() -> Result<Self, CoreError> {
        Ok(Self { core: Arc::new(Core::from_env()?), actor: Actor::os_user() })
    }

    /// Root of the active project (`shell.activeProjectId`), if any.
    pub fn active_project_root(&self) -> Option<std::path::PathBuf> {
        let db = self.core.app_db().ok()?;
        let p = quadflow_core::domains::app::projects::active(&db).ok()??;
        Some(std::path::PathBuf::from(p.root))
    }

    /// Forward every bus event to the frontend as `DataChanged`.
    pub fn bridge_events(&self, app: &AppHandle) {
        let handle = app.clone();
        self.core.bus.subscribe(move |e| {
            if let Err(err) = DataChanged(e.clone()).emit(&handle) {
                log::warn!("[core] failed to emit data-changed: {err}");
            }
        });
    }
}

impl CoreState {
    /// Follow app-DB writes of other processes (data-layer.md §8.3) and prune
    /// `app_changes` rows older than 10 minutes now and hourly.
    pub fn start_app_db_watch(&self) {
        const MAX_AGE_MS: i64 = 10 * 60 * 1000;
        if let Err(e) = self.core.watch_app_db() {
            log::warn!("[core] app-db change watcher not started: {e}");
        }
        let core = Arc::clone(&self.core);
        let _ = std::thread::Builder::new().name("app-changes-prune".into()).spawn(move || loop {
            match core.app_db().and_then(|db| db.prune_changes(MAX_AGE_MS)) {
                Ok(n) if n > 0 => log::debug!("[core] pruned {n} app_changes rows"),
                Ok(_) => {}
                Err(e) => log::warn!("[core] app_changes prune failed: {e}"),
            }
            std::thread::sleep(std::time::Duration::from_secs(3600));
        });
    }
}

/// Run blocking core work off the async runtime (core APIs are synchronous).
pub async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, CoreError> + Send + 'static,
) -> Result<T, CoreError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| CoreError::internal(format!("task failed: {e}")))?
}
