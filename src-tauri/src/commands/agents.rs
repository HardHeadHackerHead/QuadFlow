//! Agent framework commands (agent-providers.md §8.1). No logic here: each
//! command calls `crate::agents::AgentsState` / `quadflow_core::agents` off the
//! async runtime.

use crate::agents::{AgentCatalogUpdated, AgentRelaunchOptions, AgentRestoreEntry, AgentsState};
use crate::core_state::{blocking, CoreState};
use crate::terminal::TerminalManager;
use quadflow_core::agents::catalog::AgentCatalogStatus;
use quadflow_core::agents::scaffold::{self, AgentScaffoldReport};
use quadflow_core::agents::{
    one_shot::one_shot, AgentBinding, AgentDetection, AgentLaunchOptions, AgentLaunchResult, AgentModelInfo,
    AgentProviderInfo, AgentSessionInfo,
};
use quadflow_core::context::writer::{self, ContextSyncReport};
use quadflow_core::context::{ContextModuleInfo, ContextRegistry};
use quadflow_core::domains::project_config;
use quadflow_core::{CoreError, ErrorCode};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tauri_specta::Event;

type Agents<'a> = State<'a, Arc<AgentsState>>;
type Terminals<'a> = State<'a, Arc<TerminalManager>>;

#[tauri::command]
#[specta::specta]
pub async fn agents_providers(core: State<'_, CoreState>, agents: Agents<'_>) -> Result<Vec<AgentProviderInfo>, CoreError> {
    let (c, a) = (core.core.clone(), agents.inner().clone());
    blocking(move || Ok(a.providers(&c)?.list().iter().map(|e| e.info()).collect())).await
}

#[tauri::command]
#[specta::specta]
pub async fn agents_detect(
    core: State<'_, CoreState>,
    agents: Agents<'_>,
    provider_id: String,
    refresh: bool,
) -> Result<AgentDetection, CoreError> {
    let (c, a) = (core.core.clone(), agents.inner().clone());
    blocking(move || {
        let e = a.provider(&c, &provider_id)?;
        Ok(a.detect(&e, refresh))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn agents_detect_all(
    core: State<'_, CoreState>,
    agents: Agents<'_>,
    refresh: bool,
) -> Result<Vec<AgentDetection>, CoreError> {
    let (c, a) = (core.core.clone(), agents.inner().clone());
    blocking(move || Ok(a.providers(&c)?.list().iter().map(|e| a.detect(e, refresh)).collect())).await
}

/// `system-default` ++ catalog ++ custom models (agent-providers.md §6.4).
#[tauri::command]
#[specta::specta]
pub async fn agents_models(
    core: State<'_, CoreState>,
    agents: Agents<'_>,
    provider_id: String,
) -> Result<Vec<AgentModelInfo>, CoreError> {
    let (c, a) = (core.core.clone(), agents.inner().clone());
    blocking(move || a.models(&c, &provider_id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn agents_catalog_status(core: State<'_, CoreState>, agents: Agents<'_>) -> Result<AgentCatalogStatus, CoreError> {
    let (c, a) = (core.core.clone(), agents.inner().clone());
    blocking(move || Ok(a.catalog_status(&c))).await
}

/// Refresh the model catalog now (ignores the 6 h cache).
#[tauri::command]
#[specta::specta]
pub async fn agents_catalog_refresh(
    app: AppHandle,
    core: State<'_, CoreState>,
    agents: Agents<'_>,
) -> Result<AgentCatalogStatus, CoreError> {
    let (c, a) = (core.core.clone(), agents.inner().clone());
    let (status, changed) = blocking(move || Ok(a.refresh_catalog(&c, true))).await?;
    if changed {
        let _ = AgentCatalogUpdated(status.clone()).emit(&app);
    }
    Ok(status)
}

#[tauri::command]
#[specta::specta]
pub async fn agents_launch(
    app: AppHandle,
    core: State<'_, CoreState>,
    agents: Agents<'_>,
    terminals: Terminals<'_>,
    project_root: String,
    options: AgentLaunchOptions,
) -> Result<AgentLaunchResult, CoreError> {
    let (c, actor, a, t) = (core.core.clone(), core.actor.clone(), agents.inner().clone(), terminals.inner().clone());
    blocking(move || a.launch(&app, &c, &actor, &t, &PathBuf::from(project_root), options)).await
}

/// Exit the agent in a terminal and launch it again (same terminal).
#[tauri::command]
#[specta::specta]
pub async fn agents_relaunch(
    app: AppHandle,
    core: State<'_, CoreState>,
    agents: Agents<'_>,
    terminals: Terminals<'_>,
    project_root: String,
    terminal_id: String,
    binding: AgentBinding,
    options: AgentRelaunchOptions,
) -> Result<AgentBinding, CoreError> {
    let (c, actor, a, t) = (core.core.clone(), core.actor.clone(), agents.inner().clone(), terminals.inner().clone());
    blocking(move || a.relaunch(&app, &c, &actor, &t, &PathBuf::from(project_root), &terminal_id, binding, options)).await
}

#[tauri::command]
#[specta::specta]
pub async fn agents_sessions_list(
    core: State<'_, CoreState>,
    agents: Agents<'_>,
    provider_id: String,
    cwd: String,
) -> Result<Vec<AgentSessionInfo>, CoreError> {
    let (c, a) = (core.core.clone(), agents.inner().clone());
    blocking(move || {
        let e = a.provider(&c, &provider_id)?;
        a.list_sessions(&e, &PathBuf::from(cwd))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn agents_session_exists(
    core: State<'_, CoreState>,
    agents: Agents<'_>,
    provider_id: String,
    cwd: String,
    session_id: String,
) -> Result<bool, CoreError> {
    let (c, a) = (core.core.clone(), agents.inner().clone());
    blocking(move || {
        let e = a.provider(&c, &provider_id)?;
        Ok(a.scanner.exists(&e.spec, &PathBuf::from(cwd), &session_id, &a.env))
    })
    .await
}

/// Manually link a session to a terminal (for `unlinked` bindings).
#[tauri::command]
#[specta::specta]
pub async fn agents_session_link(
    agents: Agents<'_>,
    terminal_id: String,
    provider_id: String,
    session_id: String,
) -> Result<(), CoreError> {
    let a = agents.inner().clone();
    blocking(move || {
        quadflow_core::agents::validate_session_id(&session_id, quadflow_core::agents::spec::IdFormat::Any)?;
        a.claims
            .claim(&provider_id, &session_id, &terminal_id)
            .map_err(|other| CoreError::conflict(format!("session {session_id} is already linked to terminal {other}")))
    })
    .await
}

/// Workspace restore (§8.5): seed claims, resume discovery of pending bindings.
#[tauri::command]
#[specta::specta]
pub async fn agents_restore(
    app: AppHandle,
    core: State<'_, CoreState>,
    agents: Agents<'_>,
    entries: Vec<AgentRestoreEntry>,
) -> Result<(), CoreError> {
    let (c, a) = (core.core.clone(), agents.inner().clone());
    blocking(move || a.restore(&app, &c, entries)).await
}

/// A terminal closed: drop its pending discovery and release its session claim.
#[tauri::command]
#[specta::specta]
pub async fn agents_terminal_closed(agents: Agents<'_>, terminal_id: String) -> Result<(), CoreError> {
    agents.claims.release_terminal(&terminal_id);
    Ok(())
}

/// Non-interactive run; the prompt goes to stdin (§8.7).
#[tauri::command]
#[specta::specta]
pub async fn agents_one_shot(
    core: State<'_, CoreState>,
    agents: Agents<'_>,
    provider_id: String,
    cwd: String,
    prompt: String,
) -> Result<String, CoreError> {
    let (c, a) = (core.core.clone(), agents.inner().clone());
    blocking(move || {
        let e = a.provider(&c, &provider_id)?;
        let det = a.detect(&e, false);
        one_shot(&e.spec, &det, &prompt, &PathBuf::from(cwd), &a.env)
    })
    .await
}

/// Copy a provider plugin's scaffold into the project (§7.3).
#[tauri::command]
#[specta::specta]
pub async fn agents_scaffold(
    core: State<'_, CoreState>,
    agents: Agents<'_>,
    project_root: String,
    provider_id: String,
) -> Result<AgentScaffoldReport, CoreError> {
    let (c, a) = (core.core.clone(), agents.inner().clone());
    blocking(move || {
        let e = a.provider(&c, &provider_id)?;
        let (Some(sc), Some(root)) = (&e.spec.scaffold, &e.root) else {
            return Err(CoreError::unsupported(format!("{} has no project scaffold", e.spec.display_name)));
        };
        scaffold::apply(&PathBuf::from(project_root), root, sc, &e.plugin_version)
    })
    .await
}

// ---- project context (§7) ----

#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentContextModuleState {
    pub module: ContextModuleInfo,
    pub enabled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentContextState {
    pub modules: Vec<AgentContextModuleState>,
    /// Managed context files at the project root, e.g. `["AGENTS.md"]`.
    pub files: Vec<String>,
}

fn open_store(c: &quadflow_core::Core, root: &str) -> Result<Arc<quadflow_core::store::ProjectStore>, CoreError> {
    let path = PathBuf::from(root);
    match c.project(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.code == ErrorCode::ProjectNotFound && path.is_dir() => {
            Ok(c.adopt_project(project_config::open_or_init(&path, c.profile(), c.bus.clone())?))
        }
        Err(e) => Err(e),
    }
}

/// Core context modules + the active plugins' `agentContextDocs` (plugin-system.md §9.3),
/// from the app's cached plugin-registry snapshot (no extra disk scan / DB write).
fn context_registry(app: &AppHandle, c: &quadflow_core::Core) -> ContextRegistry {
    use tauri::Manager;
    let Some(state) = app.try_state::<crate::plugin_host::PluginHostState>() else {
        return ContextRegistry::builtin();
    };
    match state.registry(c) {
        Ok(reg) => ContextRegistry::with_plugins(&reg),
        Err(e) => {
            log::warn!("[agents] plugin context docs unavailable: {e}");
            ContextRegistry::builtin()
        }
    }
}

fn context_state(store: &quadflow_core::store::ProjectStore, reg: &ContextRegistry) -> Result<AgentContextState, CoreError> {
    let ac = project_config::read(store)?.agent_context;
    Ok(AgentContextState {
        modules: reg
            .list()
            .iter()
            .map(|m| AgentContextModuleState { enabled: m.info.implicit || ac.modules.contains(&m.info.id), module: m.info.clone() })
            .collect(),
        files: ac.files,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn agents_context_get(app: AppHandle, core: State<'_, CoreState>, project_root: String) -> Result<AgentContextState, CoreError> {
    let c = core.core.clone();
    blocking(move || context_state(&*open_store(&c, &project_root)?, &context_registry(&app, &c))).await
}

#[tauri::command]
#[specta::specta]
pub async fn agents_context_set_module(
    app: AppHandle,
    core: State<'_, CoreState>,
    project_root: String,
    module: String,
    enabled: bool,
) -> Result<AgentContextState, CoreError> {
    let (c, actor) = (core.core.clone(), core.actor.clone());
    blocking(move || {
        let store = open_store(&c, &project_root)?;
        let reg = context_registry(&app, &c);
        if enabled {
            writer::enable_module(&store, &reg, &actor, &module)?;
        } else {
            writer::disable_module(&store, &reg, &actor, &module)?;
        }
        context_state(&store, &reg)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn agents_context_reset(app: AppHandle, core: State<'_, CoreState>, project_root: String) -> Result<AgentContextState, CoreError> {
    let (c, actor) = (core.core.clone(), core.actor.clone());
    blocking(move || {
        let store = open_store(&c, &project_root)?;
        let reg = context_registry(&app, &c);
        writer::update_config(&store, &reg, &actor, |ac| {
            ac.modules.clear();
            Ok(())
        })?;
        context_state(&store, &reg)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn agents_context_set_files(
    app: AppHandle,
    core: State<'_, CoreState>,
    project_root: String,
    files: Vec<String>,
) -> Result<AgentContextState, CoreError> {
    let (c, actor) = (core.core.clone(), core.actor.clone());
    blocking(move || {
        let store = open_store(&c, &project_root)?;
        let reg = context_registry(&app, &c);
        writer::update_config(&store, &reg, &actor, |ac| {
            ac.files = files;
            Ok(())
        })?;
        context_state(&store, &reg)
    })
    .await
}

/// Rewrite the managed regions (project open). With `initFiles`, a project
/// without configured context files gets the `contextFile` of every provider
/// whose CLI is detected (§7.1).
#[tauri::command]
#[specta::specta]
pub async fn agents_context_sync(
    app: AppHandle,
    core: State<'_, CoreState>,
    agents: Agents<'_>,
    project_root: String,
    init_files: bool,
) -> Result<ContextSyncReport, CoreError> {
    let (c, actor, a) = (core.core.clone(), core.actor.clone(), agents.inner().clone());
    blocking(move || {
        let store = open_store(&c, &project_root)?;
        let reg = context_registry(&app, &c);
        if init_files && project_config::read(&store)?.agent_context.files.is_empty() {
            let mut files: Vec<String> = Vec::new();
            for e in a.providers(&c)?.list() {
                if a.detect(e, false).installed && !files.contains(&e.spec.context_file) {
                    files.push(e.spec.context_file.clone());
                }
            }
            if !files.is_empty() {
                return Ok(writer::update_config(&store, &reg, &actor, |ac| {
                    ac.files = files;
                    Ok(())
                })?
                .1);
            }
        }
        writer::sync(&store, &reg, &actor, false)
    })
    .await
}
