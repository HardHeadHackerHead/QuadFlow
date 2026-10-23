//! `plugin_sidecar_*` commands (plugin-system.md §7.2, §10.5): a plugin's UI
//! talks only to its **own** sidecar. Main window (and shell floating windows)
//! only, like every plugin command.

use crate::core_state::blocking;
use crate::plugin_host::{sidecars, PluginHostJson};
use quadflow_core::plugins::sidecar::{check_ui_method, PluginSidecarStatus};
use quadflow_core::CoreError;
use std::time::Duration;
use tauri::{Manager, Webview};

fn check_caller(webview: &Webview) -> Result<(), CoreError> {
    let label = webview.label();
    if label == "main" || label.starts_with("floating-") {
        Ok(())
    } else {
        Err(CoreError::permission_denied(format!("plugin commands are not available to webview {label:?}")))
    }
}

/// Request to the plugin's sidecar (started on demand). `timeoutMs` defaults to 30 s.
#[tauri::command]
#[specta::specta]
pub async fn plugin_sidecar_request(
    webview: Webview,
    plugin_id: String,
    method: String,
    params: PluginHostJson,
    timeout_ms: Option<u32>,
) -> Result<PluginHostJson, CoreError> {
    check_caller(&webview)?;
    check_ui_method(&method)?;
    let app = webview.app_handle().clone();
    blocking(move || {
        sidecars::require_sidecar(&app, &plugin_id)?;
        let timeout = timeout_ms.map(|ms| Duration::from_millis(ms.clamp(1, 10 * 60 * 1000) as u64));
        sidecars::supervisor(&app)?.request(&plugin_id, &method, params.0, timeout).map(PluginHostJson)
    })
    .await
}

/// The shell's agent-provider registry → a provider plugin's sidecar hook
/// `agentProvider/<hook>` (agent-providers.md §4.3). Plugin UIs cannot send `agentProvider/*`
/// (reserved by `check_ui_method`), so the shell uses this command; the plugin must declare the
/// hook in `contributes.agentProvider.hooks`. 30 s timeout.
#[tauri::command]
#[specta::specta]
pub async fn plugin_sidecar_agent_hook(
    webview: Webview,
    plugin_id: String,
    hook: quadflow_core::agents::AgentHook,
    params: PluginHostJson,
) -> Result<PluginHostJson, CoreError> {
    check_caller(&webview)?;
    let app = webview.app_handle().clone();
    blocking(move || {
        sidecars::require_sidecar(&app, &plugin_id)?;
        let name = serde_json::to_value(hook)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .ok_or_else(|| CoreError::internal("hook name"))?;
        let state = app.state::<crate::plugin_host::PluginHostState>();
        let reg = state.registry(&state.env(&app)?.core)?;
        let declared = reg
            .require(&plugin_id)?
            .manifest
            .as_ref()
            .and_then(|m| m.contributes.agent_provider.as_ref())
            .and_then(|p| p.get("hooks"))
            .and_then(|h| h.as_array())
            .is_some_and(|h| h.iter().any(|x| x.as_str() == Some(name.as_str())));
        if !declared {
            return Err(CoreError::invalid_input(format!("plugin {plugin_id:?} does not declare the agent-provider hook {name:?}")));
        }
        sidecars::supervisor(&app)?
            .request(&plugin_id, &format!("agentProvider/{name}"), params.0, Some(Duration::from_secs(30)))
            .map(PluginHostJson)
    })
    .await
}

/// Notification to the plugin's sidecar (started on demand).
#[tauri::command]
#[specta::specta]
pub async fn plugin_sidecar_notify(
    webview: Webview,
    plugin_id: String,
    method: String,
    params: PluginHostJson,
) -> Result<(), CoreError> {
    check_caller(&webview)?;
    check_ui_method(&method)?;
    let app = webview.app_handle().clone();
    blocking(move || {
        sidecars::require_sidecar(&app, &plugin_id)?;
        sidecars::supervisor(&app)?.notify(&plugin_id, &method, params.0)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn plugin_sidecar_status(webview: Webview, plugin_id: String) -> Result<PluginSidecarStatus, CoreError> {
    check_caller(&webview)?;
    let app = webview.app_handle().clone();
    blocking(move || Ok(sidecars::supervisor(&app)?.status(&plugin_id))).await
}

/// Statuses of every sidecar started in this session (Settings → Plugins).
#[tauri::command]
#[specta::specta]
pub async fn plugin_sidecar_statuses(webview: Webview) -> Result<Vec<PluginSidecarStatus>, CoreError> {
    check_caller(&webview)?;
    let app = webview.app_handle().clone();
    blocking(move || Ok(sidecars::supervisor(&app)?.statuses())).await
}

/// Stop every sidecar gracefully (shutdown → exit → kill) before the process goes away
/// without a normal exit — the update install on Windows exits from inside the installer
/// call, so the shell calls this first (after `deactivateAllPlugins`).
#[tauri::command]
#[specta::specta]
pub async fn plugin_sidecars_stop_all(webview: Webview) -> Result<(), CoreError> {
    check_caller(&webview)?;
    let app = webview.app_handle().clone();
    blocking(move || {
        sidecars::stop_all(&app);
        Ok(())
    })
    .await
}

/// Stop + start (also leaves `failed`). Returns once the new process is started or failed to start.
#[tauri::command]
#[specta::specta]
pub async fn plugin_sidecar_restart(webview: Webview, plugin_id: String) -> Result<PluginSidecarStatus, CoreError> {
    check_caller(&webview)?;
    let app = webview.app_handle().clone();
    blocking(move || {
        sidecars::require_sidecar(&app, &plugin_id)?;
        let sup = sidecars::supervisor(&app)?;
        sup.restart(&plugin_id);
        // Wait for the handshake (bounded) so the caller sees the outcome.
        let deadline = std::time::Instant::now() + Duration::from_secs(12);
        loop {
            let s = sup.status(&plugin_id);
            use quadflow_core::plugins::sidecar::PluginSidecarState as S;
            if matches!(s.state, S::Running | S::Failed | S::Restarting) || std::time::Instant::now() > deadline {
                return Ok(s);
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn plugin_sidecar_stop(webview: Webview, plugin_id: String) -> Result<PluginSidecarStatus, CoreError> {
    check_caller(&webview)?;
    let app = webview.app_handle().clone();
    blocking(move || {
        sidecars::stop(&app, &plugin_id);
        Ok(sidecars::supervisor(&app)?.status(&plugin_id))
    })
    .await
}

/// The last 200 lines of the sidecar's stderr / `host/log` (full log: `<logs>/plugins/<id>.log`).
#[tauri::command]
#[specta::specta]
pub async fn plugin_sidecar_logs(webview: Webview, plugin_id: String) -> Result<Vec<String>, CoreError> {
    check_caller(&webview)?;
    let app = webview.app_handle().clone();
    blocking(move || Ok(sidecars::supervisor(&app)?.logs(&plugin_id))).await
}
