//! Plugin dev-mode commands (plugin-system.md §15.3): Settings → Plugins → "Load unpacked…"
//! adds a folder to `plugins.devPaths`; the dev watcher (`plugin_host::dev`) then hot-reloads
//! the plugin whenever its build output changes. Main window only, like every plugin command.

use crate::core_state::{blocking, CoreState};
use crate::plugin_host;
use quadflow_core::plugins::dev;
use quadflow_core::plugins::{PluginInfo, PluginOrigin, PluginRegistry};
use quadflow_core::CoreError;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager, State, Webview};

fn check_caller(webview: &Webview) -> Result<(), CoreError> {
    let label = webview.label();
    if label == "main" || label.starts_with("floating-") {
        Ok(())
    } else {
        Err(CoreError::permission_denied(format!("plugin commands are not available to webview {label:?}")))
    }
}

fn canon(p: &std::path::Path) -> PathBuf {
    dev::canonical(p)
}

/// Folders in `plugins.devPaths`.
#[tauri::command]
#[specta::specta]
pub async fn plugins_dev_paths(webview: Webview, core: State<'_, CoreState>) -> Result<Vec<String>, CoreError> {
    check_caller(&webview)?;
    let c = Arc::clone(&core.core);
    blocking(move || dev::dev_paths(&*c.app_db()?)).await
}

/// Load an unpacked plugin folder (must contain `quadflow-plugin.json`). Returns the dev copy
/// as the registry sees it (its status may be `failed`, e.g. for an invalid manifest); a dev
/// copy wins over bundled/installed copies of the same id (§4.2).
#[tauri::command]
#[specta::specta]
pub async fn plugins_dev_add(webview: Webview, core: State<'_, CoreState>, path: String) -> Result<PluginInfo, CoreError> {
    check_caller(&webview)?;
    let c = Arc::clone(&core.core);
    let app = webview.app_handle().clone();
    blocking(move || {
        let db = c.app_db()?;
        let dir = dev::add_dev_path(&db, std::path::Path::new(&path))?;
        let reg = PluginRegistry::load(&c.paths, &db)?;
        crate::plugin_protocol::refresh(&app, &reg);
        plugin_host::invalidate(&app);
        plugin_host::dev::sync(&app, &reg);
        let info = reg
            .all()
            .find(|p| p.origin == PluginOrigin::Dev && canon(&p.root) == dir)
            .map(|p| p.info())
            .ok_or_else(|| CoreError::invalid_input(format!("{} was added but its manifest has no readable id", dir.display())));
        info
    })
    .await
}

/// Stop loading an unpacked plugin folder (its bundled/installed copy, if any, takes over).
#[tauri::command]
#[specta::specta]
pub async fn plugins_dev_remove(webview: Webview, core: State<'_, CoreState>, path: String) -> Result<bool, CoreError> {
    check_caller(&webview)?;
    let c = Arc::clone(&core.core);
    let app = webview.app_handle().clone();
    blocking(move || {
        let db = c.app_db()?;
        let dir = canon(std::path::Path::new(&path));
        let before = PluginRegistry::load(&c.paths, &db)?;
        let dev_id = before.all().find(|p| p.origin == PluginOrigin::Dev && canon(&p.root) == dir).map(|p| p.id.clone());
        let removed = dev::remove_dev_path(&db, &dir)?;
        // The dev copy's sidecar ran from the dev folder: stop it.
        if let (true, Some(id)) = (removed, &dev_id) {
            plugin_host::sidecars::stop(&app, id);
        }
        let reg = PluginRegistry::load(&c.paths, &db)?;
        crate::plugin_protocol::refresh(&app, &reg);
        plugin_host::invalidate(&app);
        plugin_host::dev::sync(&app, &reg);
        Ok(removed)
    })
    .await
}
