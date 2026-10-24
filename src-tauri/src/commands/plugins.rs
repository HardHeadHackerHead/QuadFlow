//! Plugin commands (plugin-system.md §4.3): registry (PL-1: list, get,
//! contributions, enable, disable, grant) and sources + install/update/
//! rollback/uninstall + update checks (PL-9), host invoke (PL-3). Sidecars
//! (PL-7) are stopped here on disable / uninstall / update / rollback; their
//! own commands live in `plugin_sidecars.rs`. Each load refreshes (and each mutation invalidates) the
//! `qfplugin://` asset index (PL-2).
//!
//! Main window (or shell-owned floating windows) only: plugin frames never reach
//! IPC, and other webviews are rejected here.

use crate::core_state::{blocking, CoreState};
use parking_lot::Mutex;
use quadflow_core::domains::app::secrets::Secrets;
use quadflow_core::plugins::sources::{
    self, PluginAvailable, PluginInstallPlan, PluginSourceInfo, PluginUninstallResult, PluginUpdateInfo, SourceOptions,
};
use quadflow_core::plugins::{Contributions, PluginInfo, PluginRegistry};
use quadflow_core::CoreError;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use crate::plugin_host::{self, PluginHostJson};
use crate::plugin_protocol;
use tauri::ipc::Channel;
use tauri::{Manager, State, Webview};

/// Registry changed: drop the asset index and the host's permission snapshot.
fn invalidate_all<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    plugin_protocol::invalidate(app);
    plugin_host::invalidate(app);
}

/// This command already stopped / started the plugin's sidecar: record the new registry state
/// so the live sync (`plugin_host::live`) does not restart it again.
fn record_live(c: &quadflow_core::Core) {
    if let Ok(reg) = load(c) {
        plugin_host::live::record(&reg);
    }
}

/// Webview labels allowed to call plugin commands.
fn check_caller(webview: &Webview) -> Result<(), CoreError> {
    let label = webview.label();
    if label == "main" || label.starts_with("floating-") {
        Ok(())
    } else {
        Err(CoreError::permission_denied(format!("plugin commands are not available to webview {label:?}")))
    }
}

fn load(core: &quadflow_core::Core) -> Result<PluginRegistry, CoreError> {
    PluginRegistry::load(&core.paths, &*core.app_db()?)
}

/// All plugins; `includeUnsupported` adds those not built for this OS.
#[tauri::command]
#[specta::specta]
pub async fn plugins_list(
    webview: Webview,
    core: State<'_, CoreState>,
    include_unsupported: bool,
) -> Result<Vec<PluginInfo>, CoreError> {
    check_caller(&webview)?;
    let c = Arc::clone(&core.core);
    let app = webview.app_handle().clone();
    blocking(move || {
        let reg = load(&c)?;
        plugin_protocol::refresh(&app, &reg);
        plugin_host::invalidate(&app);
        // Dev mode (PL-10): watch the folders of `dev` plugins for rebuilds.
        plugin_host::dev::sync(&app, &reg);
        // Live changes (§12.4), also from the CLI: restart / stop sidecars whose plugin changed.
        plugin_host::live::sync(&app, &reg);
        Ok(reg.list(include_unsupported))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn plugins_get(
    webview: Webview,
    core: State<'_, CoreState>,
    id: String,
) -> Result<PluginInfo, CoreError> {
    check_caller(&webview)?;
    let c = Arc::clone(&core.core);
    blocking(move || Ok(load(&c)?.require(&id)?.info())).await
}

/// Contributions of active plugins.
#[tauri::command]
#[specta::specta]
pub async fn plugins_contributions(
    webview: Webview,
    core: State<'_, CoreState>,
) -> Result<Contributions, CoreError> {
    check_caller(&webview)?;
    let c = Arc::clone(&core.core);
    let app = webview.app_handle().clone();
    blocking(move || {
        let reg = load(&c)?;
        plugin_protocol::refresh(&app, &reg);
        plugin_host::invalidate(&app);
        Ok(reg.contributions())
    })
    .await
}

fn set_enabled(c: &quadflow_core::Core, id: &str, enabled: bool) -> Result<PluginInfo, CoreError> {
    let db = c.app_db()?;
    load(c)?.set_enabled(&db, id, enabled)?;
    Ok(load(c)?.require(id)?.info())
}

#[tauri::command]
#[specta::specta]
pub async fn plugins_enable(
    webview: Webview,
    core: State<'_, CoreState>,
    id: String,
) -> Result<PluginInfo, CoreError> {
    check_caller(&webview)?;
    let c = Arc::clone(&core.core);
    let app = webview.app_handle().clone();
    blocking(move || {
        set_enabled(&c, &id, true).inspect(|_| {
            invalidate_all(&app);
            record_live(&c);
            plugin_host::sidecars::start_startup_sidecars(&app);
        })
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn plugins_disable(
    webview: Webview,
    core: State<'_, CoreState>,
    id: String,
) -> Result<PluginInfo, CoreError> {
    check_caller(&webview)?;
    let c = Arc::clone(&core.core);
    let app = webview.app_handle().clone();
    blocking(move || {
        plugin_host::sidecars::stop(&app, &id);
        set_enabled(&c, &id, false).inspect(|_| {
            invalidate_all(&app);
            record_live(&c);
        })
    })
    .await
}

/// Set the granted permissions of a non-bundled plugin to exactly `permissions`
/// (each must be declared by its manifest).
#[tauri::command]
#[specta::specta]
pub async fn plugins_grant(
    webview: Webview,
    core: State<'_, CoreState>,
    id: String,
    permissions: Vec<String>,
) -> Result<PluginInfo, CoreError> {
    check_caller(&webview)?;
    let c = Arc::clone(&core.core);
    let app = webview.app_handle().clone();
    blocking(move || {
        let db = c.app_db()?;
        load(&c)?.grant(&db, &id, &permissions)?;
        let reg = load(&c)?;
        plugin_protocol::refresh(&app, &reg);
        plugin_host::invalidate(&app);
        // A running sidecar keeps no permission state, but restart it so a revoked
        // `sidecar:runtime:node` (or a plugin now `needsConsent`) takes effect.
        plugin_host::sidecars::stop(&app, &id);
        plugin_host::live::record(&reg);
        plugin_host::sidecars::start_startup_sidecars(&app);
        Ok(reg.require(&id)?.info())
    })
    .await
}

// ---------------------------------------------------------------------------
// Sources, install, update, uninstall (PL-9, §11.2, §12)
// ---------------------------------------------------------------------------

fn source_opts(c: &quadflow_core::Core) -> SourceOptions {
    SourceOptions::from_env(c.profile(), |k| std::env::var(k).ok())
}

/// Plans handed to the UI, awaiting `plugins_install_confirm`.
fn plans() -> &'static Mutex<HashMap<String, PluginInstallPlan>> {
    static PLANS: OnceLock<Mutex<HashMap<String, PluginInstallPlan>>> = OnceLock::new();
    PLANS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn remember(plan: PluginInstallPlan) -> PluginInstallPlan {
    let mut m = plans().lock();
    if m.len() > 64 {
        m.clear();
    }
    m.insert(plan.plan_id.clone(), plan.clone());
    plan
}

/// Plan installing `pluginId` from `sourceId` (or any enabled source). Shows in the consent dialog.
#[tauri::command]
#[specta::specta]
pub async fn plugins_install(
    webview: Webview,
    core: State<'_, CoreState>,
    source_id: Option<String>,
    plugin_id: String,
    version: Option<String>,
) -> Result<PluginInstallPlan, CoreError> {
    check_caller(&webview)?;
    let c = Arc::clone(&core.core);
    blocking(move || {
        let db = c.app_db()?;
        let plan = sources::plan_install(&db, &c.paths, &source_opts(&c), source_id.as_deref(), &plugin_id, version.as_deref())?;
        Ok(remember(plan))
    })
    .await
}

/// Plan updating `id` to the newest compatible version (`not_found` when up to date).
#[tauri::command]
#[specta::specta]
pub async fn plugins_update(webview: Webview, core: State<'_, CoreState>, id: String) -> Result<PluginInstallPlan, CoreError> {
    check_caller(&webview)?;
    let c = Arc::clone(&core.core);
    blocking(move || {
        let db = c.app_db()?;
        Ok(remember(sources::plan_update(&db, &c.paths, &source_opts(&c), &id)?))
    })
    .await
}

/// Apply an approved plan: download, verify sha256 + size, extract, validate, switch.
#[tauri::command]
#[specta::specta]
pub async fn plugins_install_confirm(
    webview: Webview,
    core: State<'_, CoreState>,
    plan_id: String,
    granted_permissions: Vec<String>,
) -> Result<PluginInfo, CoreError> {
    check_caller(&webview)?;
    let c = Arc::clone(&core.core);
    let app = webview.app_handle().clone();
    blocking(move || {
        let plan = plans()
            .lock()
            .get(&plan_id)
            .cloned()
            .ok_or_else(|| CoreError::not_found(format!("install plan {plan_id:?} (expired; start again)")))?;
        let db = c.app_db()?;
        // Install over / update: the old sidecar binary must not keep running (or stay locked on Windows).
        plugin_host::sidecars::stop(&app, &plan.plugin_id);
        let info = sources::confirm(&db, &c.paths, &source_opts(&c), &plan, &granted_permissions);
        invalidate_all(&app);
        record_live(&c);
        plugin_host::sidecars::start_startup_sidecars(&app);
        let info = info?;
        plans().lock().remove(&plan_id);
        Ok(info)
    })
    .await
}

/// Forget a plan the user cancelled.
#[tauri::command]
#[specta::specta]
pub async fn plugins_install_cancel(webview: Webview, plan_id: String) -> Result<(), CoreError> {
    check_caller(&webview)?;
    plans().lock().remove(&plan_id);
    Ok(())
}

/// Switch an installed plugin back to its previous version.
#[tauri::command]
#[specta::specta]
pub async fn plugins_rollback(webview: Webview, core: State<'_, CoreState>, id: String) -> Result<PluginInfo, CoreError> {
    check_caller(&webview)?;
    let c = Arc::clone(&core.core);
    let app = webview.app_handle().clone();
    blocking(move || {
        plugin_host::sidecars::stop(&app, &id);
        let r = sources::rollback(&*c.app_db()?, &c.paths, &source_opts(&c), &id).inspect(|_| invalidate_all(&app));
        record_live(&c);
        plugin_host::sidecars::start_startup_sidecars(&app);
        r
    })
    .await
}

/// Uninstall: files, `plugins` row, kv, `plugin:<id>` settings, keychain entries, tool configs.
#[tauri::command]
#[specta::specta]
pub async fn plugins_uninstall(
    webview: Webview,
    core: State<'_, CoreState>,
    id: String,
    delete_data: bool,
) -> Result<PluginUninstallResult, CoreError> {
    check_caller(&webview)?;
    let c = Arc::clone(&core.core);
    let app = webview.app_handle().clone();
    blocking(move || {
        let secrets = Secrets::from_env(c.profile(), |k| std::env::var(k).ok())?;
        // Stop its sidecar and stop serving its assets before its files are deleted.
        plugin_host::sidecars::stop(&app, &id);
        invalidate_all(&app);
        let r = sources::uninstall(&*c.app_db()?, &c.paths, &secrets, &source_opts(&c), &id, delete_data);
        invalidate_all(&app);
        record_live(&c);
        r
    })
    .await
}

/// Refresh enabled sources, then recompute available updates (on demand).
#[tauri::command]
#[specta::specta]
pub async fn plugins_check_updates(webview: Webview, core: State<'_, CoreState>) -> Result<Vec<PluginUpdateInfo>, CoreError> {
    check_caller(&webview)?;
    let c = Arc::clone(&core.core);
    blocking(move || {
        let db = c.app_db()?;
        let opts = source_opts(&c);
        sources::refresh(&db, &c.paths, &opts, None)?;
        sources::check_updates(&db, &c.paths, &opts)
    })
    .await
}

/// Stored available updates (no network): toolbar badge + Plugins page.
#[tauri::command]
#[specta::specta]
pub async fn plugins_available_updates(webview: Webview, core: State<'_, CoreState>) -> Result<Vec<PluginUpdateInfo>, CoreError> {
    check_caller(&webview)?;
    let c = Arc::clone(&core.core);
    blocking(move || sources::available_updates(&*c.app_db()?)).await
}

#[tauri::command]
#[specta::specta]
pub async fn plugin_sources_list(webview: Webview, core: State<'_, CoreState>) -> Result<Vec<PluginSourceInfo>, CoreError> {
    check_caller(&webview)?;
    let c = Arc::clone(&core.core);
    blocking(move || sources::list(&*c.app_db()?, &c.paths, &source_opts(&c))).await
}

/// Add a source (`github:OWNER/REPO[#REF][:PATH]` or an https index URL) and fetch it once.
#[tauri::command]
#[specta::specta]
pub async fn plugin_sources_add(webview: Webview, core: State<'_, CoreState>, url: String) -> Result<PluginSourceInfo, CoreError> {
    check_caller(&webview)?;
    let c = Arc::clone(&core.core);
    blocking(move || sources::add(&*c.app_db()?, &c.paths, &source_opts(&c), &url)).await
}

#[tauri::command]
#[specta::specta]
pub async fn plugin_sources_remove(webview: Webview, core: State<'_, CoreState>, id: String) -> Result<(), CoreError> {
    check_caller(&webview)?;
    let c = Arc::clone(&core.core);
    blocking(move || sources::remove(&*c.app_db()?, &c.paths, &id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn plugin_sources_set_enabled(
    webview: Webview,
    core: State<'_, CoreState>,
    id: String,
    enabled: bool,
) -> Result<PluginSourceInfo, CoreError> {
    check_caller(&webview)?;
    let c = Arc::clone(&core.core);
    blocking(move || sources::set_enabled(&*c.app_db()?, &c.paths, &source_opts(&c), &id, enabled)).await
}

/// Fetch one source (`id`) or all enabled sources; failures land in `lastError`.
#[tauri::command]
#[specta::specta]
pub async fn plugin_sources_refresh(
    webview: Webview,
    core: State<'_, CoreState>,
    id: Option<String>,
) -> Result<Vec<PluginSourceInfo>, CoreError> {
    check_caller(&webview)?;
    let c = Arc::clone(&core.core);
    blocking(move || sources::refresh(&*c.app_db()?, &c.paths, &source_opts(&c), id.as_deref())).await
}

/// Plugins offered by one source or all enabled sources (cached indexes, no network).
#[tauri::command]
#[specta::specta]
pub async fn plugin_sources_browse(
    webview: Webview,
    core: State<'_, CoreState>,
    id: Option<String>,
) -> Result<Vec<PluginAvailable>, CoreError> {
    check_caller(&webview)?;
    let c = Arc::clone(&core.core);
    blocking(move || sources::browse(&*c.app_db()?, &c.paths, &source_opts(&c), id.as_deref())).await
}

/// Start the background update checker (30 s after startup, then every 24 h).
/// Never blocks startup; a failing source only records `lastError`.
pub fn start_update_checks(core: &Arc<quadflow_core::Core>) {
    let db = match core.app_db() {
        Ok(db) => db,
        Err(e) => {
            log::warn!("[plugins] update checks disabled: {e}");
            return;
        }
    };
    let _ = sources::start_background_checks(
        core.paths.clone(),
        db,
        source_opts(core),
        std::time::Duration::from_secs(30),
        std::time::Duration::from_secs(24 * 3600),
        Arc::new(std::sync::atomic::AtomicBool::new(false)),
    );
}

// ---------------------------------------------------------------------------
// Host API (plugin-system.md §7.1, PL-3)
// ---------------------------------------------------------------------------

/// Call a host-API method on behalf of `pluginId`. Permissions are checked in
/// Rust against the plugin's granted set (`permission_denied` otherwise).
#[tauri::command]
#[specta::specta]
pub async fn plugin_invoke(
    webview: Webview,
    plugin_id: String,
    method: String,
    params: PluginHostJson,
) -> Result<PluginHostJson, CoreError> {
    check_caller(&webview)?;
    let app = webview.app_handle().clone();
    blocking(move || plugin_host::invoke(&app, &plugin_id, &method, params.0).map(PluginHostJson)).await
}

/// Start a host-API stream (`data.onDidChange`, `terminals.onData`, `fs.watch`,
/// `shell.spawn`, `data.ship.run`, `data.chat.send`, …). Items arrive on
/// `channel`; returns the subscription id for `plugin_unsubscribe`.
#[tauri::command]
#[specta::specta]
pub async fn plugin_subscribe(
    webview: Webview,
    plugin_id: String,
    topic: String,
    params: PluginHostJson,
    channel: Channel<PluginHostJson>,
) -> Result<u32, CoreError> {
    check_caller(&webview)?;
    let app = webview.app_handle().clone();
    blocking(move || {
        let sink = plugin_host::channel_sink(&app, channel);
        let id = plugin_host::subscribe(&app, &plugin_id, &topic, params.0, sink.sink.clone())?;
        sink.bind(id);
        Ok(id)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn plugin_unsubscribe(webview: Webview, subscription_id: u32) -> Result<(), CoreError> {
    check_caller(&webview)?;
    let app = webview.app_handle().clone();
    blocking(move || {
        app.state::<plugin_host::PluginHostState>().remove_subscription(subscription_id);
        Ok(())
    })
    .await
}

/// Host methods/topics available in this build (for `ctx.api.has()`). With
/// `reset` (main window only), drops every live subscription first: the shell
/// document was (re)loaded, so no earlier channel has a listener any more.
#[tauri::command]
#[specta::specta]
pub async fn plugin_host_methods(webview: Webview, reset: bool) -> Result<Vec<String>, CoreError> {
    check_caller(&webview)?;
    let app = webview.app_handle().clone();
    let is_main = webview.label() == "main";
    blocking(move || {
        let state = app.state::<plugin_host::PluginHostState>();
        if reset && is_main {
            state.clear_subscriptions();
            // Shell (re)loaded: plugins are being activated — start `onStartup` sidecars.
            plugin_host::sidecars::start_startup_sidecars(&app);
        }
        Ok(state.env(&app)?.available())
    })
    .await
}
