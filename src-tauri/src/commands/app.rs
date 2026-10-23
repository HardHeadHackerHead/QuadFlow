//! App-domain commands (data-layer.md §10.2 `app.rs`): projects, workspaces,
//! global workspaces, tool configs, settings, stored prompts. No logic here —
//! every command calls `quadflow_core::domains::app` via `blocking`.
//! (Agent-definition commands live with missions, DL-9.) The write-only
//! `secrets_*` commands (DL-8) are at the end of this file.

use crate::core_state::{blocking, CoreState};
use quadflow_core::domains::app::projects::{self, Project, ProjectPatch};
use quadflow_core::domains::app::prompts::{self, StoredPrompt, StoredPromptInput};
use quadflow_core::domains::app::settings::{self, SettingValue};
use quadflow_core::domains::app::tool_configs::{self, ReorderField, ToolConfig, ToolConfigCreate, ToolConfigPatch};
use quadflow_core::domains::app::workspaces::{
    self, GlobalTile, GlobalWorkspace, GlobalWorkspaceInput, GlobalWorkspacesState, SaveResult, Workspace,
    WorkspaceCreate, WorkspacePatch, WorkspaceState,
};
use quadflow_core::plugins::PluginRegistry;
use quadflow_core::{CoreError, Id};
use std::collections::BTreeMap;
use std::path::PathBuf;
use tauri::State;

macro_rules! db_call {
    ($core:expr, |$db:ident| $body:expr) => {{
        let c = $core.core.clone();
        blocking(move || {
            let $db = c.app_db()?;
            let $db = &*$db;
            $body
        })
        .await
    }};
}

// ---- projects ----

#[tauri::command]
#[specta::specta]
pub async fn projects_list(core: State<'_, CoreState>) -> Result<Vec<Project>, CoreError> {
    db_call!(core, |db| projects::list(db))
}

/// Register (idempotent by normalized path) and activate; `init` creates the
/// project folder (`quadflow init`) when missing.
#[tauri::command]
#[specta::specta]
pub async fn projects_open(core: State<'_, CoreState>, path: String, init: bool) -> Result<Project, CoreError> {
    let profile = core.core.profile();
    db_call!(core, |db| projects::open(db, &PathBuf::from(path), profile, init))
}

/// Register without activating.
#[tauri::command]
#[specta::specta]
pub async fn projects_register(core: State<'_, CoreState>, path: String) -> Result<Project, CoreError> {
    db_call!(core, |db| projects::register(db, &PathBuf::from(path)))
}

#[tauri::command]
#[specta::specta]
pub async fn projects_update(core: State<'_, CoreState>, id: Id, patch: ProjectPatch) -> Result<Project, CoreError> {
    db_call!(core, |db| projects::update(db, &id, patch))
}

#[tauri::command]
#[specta::specta]
pub async fn projects_touch(core: State<'_, CoreState>, id: Id) -> Result<(), CoreError> {
    db_call!(core, |db| projects::touch(db, &id))
}

#[tauri::command]
#[specta::specta]
pub async fn projects_remove(core: State<'_, CoreState>, id: Id) -> Result<(), CoreError> {
    db_call!(core, |db| projects::remove(db, &id))
}

#[tauri::command]
#[specta::specta]
pub async fn projects_active(core: State<'_, CoreState>) -> Result<Option<Project>, CoreError> {
    db_call!(core, |db| projects::active(db))
}

/// Live terminal ids → project id → count of those saved in its workspaces.
#[tauri::command]
#[specta::specta]
pub async fn projects_terminal_counts(
    core: State<'_, CoreState>,
    terminal_ids: Vec<String>,
) -> Result<BTreeMap<String, u32>, CoreError> {
    db_call!(core, |db| projects::terminal_counts(db, &terminal_ids))
}

// ---- workspaces ----

#[tauri::command]
#[specta::specta]
pub async fn workspaces_list(core: State<'_, CoreState>, project_id: Option<Id>) -> Result<Vec<Workspace>, CoreError> {
    db_call!(core, |db| workspaces::list(db, project_id.as_ref()))
}

#[tauri::command]
#[specta::specta]
pub async fn workspaces_create(core: State<'_, CoreState>, input: WorkspaceCreate) -> Result<Workspace, CoreError> {
    db_call!(core, |db| workspaces::create(db, input))
}

#[tauri::command]
#[specta::specta]
pub async fn workspaces_update(core: State<'_, CoreState>, id: Id, patch: WorkspacePatch) -> Result<Workspace, CoreError> {
    db_call!(core, |db| workspaces::update(db, &id, patch))
}

#[tauri::command]
#[specta::specta]
pub async fn workspaces_delete(core: State<'_, CoreState>, id: Id) -> Result<(), CoreError> {
    db_call!(core, |db| workspaces::delete(db, &id))
}

#[tauri::command]
#[specta::specta]
pub async fn workspaces_activate(core: State<'_, CoreState>, id: Id) -> Result<Workspace, CoreError> {
    db_call!(core, |db| workspaces::activate(db, &id))
}

#[tauri::command]
#[specta::specta]
pub async fn workspaces_active(core: State<'_, CoreState>, project_id: Id) -> Result<Option<Workspace>, CoreError> {
    db_call!(core, |db| workspaces::active_for_project(db, &project_id))
}

#[tauri::command]
#[specta::specta]
pub async fn workspaces_load(core: State<'_, CoreState>, id: Id) -> Result<WorkspaceState, CoreError> {
    db_call!(core, |db| workspaces::load(db, &id))
}

/// Layout + terminals + tiles in one transaction.
#[tauri::command]
#[specta::specta]
pub async fn workspaces_save(core: State<'_, CoreState>, id: Id, state: WorkspaceState) -> Result<SaveResult, CoreError> {
    db_call!(core, |db| workspaces::save(db, &id, state))
}

// ---- global workspaces ----

#[tauri::command]
#[specta::specta]
pub async fn global_workspaces_list(core: State<'_, CoreState>) -> Result<GlobalWorkspacesState, CoreError> {
    db_call!(core, |db| workspaces::global_list(db))
}

#[tauri::command]
#[specta::specta]
pub async fn global_workspaces_upsert(
    core: State<'_, CoreState>,
    input: GlobalWorkspaceInput,
) -> Result<GlobalWorkspace, CoreError> {
    db_call!(core, |db| workspaces::global_upsert(db, input))
}

#[tauri::command]
#[specta::specta]
pub async fn global_workspaces_delete(core: State<'_, CoreState>, id: String) -> Result<(), CoreError> {
    db_call!(core, |db| workspaces::global_delete(db, &id))
}

/// Replace all global-workspace tiles in one transaction.
#[tauri::command]
#[specta::specta]
pub async fn global_workspaces_save(core: State<'_, CoreState>, tiles: Vec<GlobalTile>) -> Result<SaveResult, CoreError> {
    db_call!(core, |db| workspaces::global_save_tiles(db, tiles))
}

// ---- tool configs ----

/// Lists tool configs after syncing them with the plugin registry
/// (`tool_configs_sync_with_plugins`, plugin-system.md §5.3): manifest
/// defaults are created, configs of uninstalled plugins removed. The shell
/// calls this at startup and after enabling/disabling a plugin.
#[tauri::command]
#[specta::specta]
pub async fn tool_configs_list(core: State<'_, CoreState>) -> Result<Vec<ToolConfig>, CoreError> {
    let c = core.core.clone();
    blocking(move || {
        let db = c.app_db()?;
        let registry = PluginRegistry::load(&c.paths, &db)?;
        tool_configs::sync_with_plugins(&db, &registry)?;
        tool_configs::list(&db)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tool_configs_create(core: State<'_, CoreState>, input: ToolConfigCreate) -> Result<ToolConfig, CoreError> {
    db_call!(core, |db| tool_configs::create(db, input))
}

#[tauri::command]
#[specta::specta]
pub async fn tool_configs_update(core: State<'_, CoreState>, id: Id, patch: ToolConfigPatch) -> Result<ToolConfig, CoreError> {
    db_call!(core, |db| tool_configs::update(db, &id, patch))
}

#[tauri::command]
#[specta::specta]
pub async fn tool_configs_delete(core: State<'_, CoreState>, id: Id) -> Result<(), CoreError> {
    db_call!(core, |db| tool_configs::delete(db, &id))
}

#[tauri::command]
#[specta::specta]
pub async fn tool_configs_reorder(core: State<'_, CoreState>, ids: Vec<Id>, field: ReorderField) -> Result<(), CoreError> {
    db_call!(core, |db| tool_configs::reorder(db, &ids, field))
}

/// Reset the auto-created (manifest default) configs to their plugin's
/// `defaultToolConfig` and re-create missing ones.
#[tauri::command]
#[specta::specta]
pub async fn tool_configs_reset_builtins(core: State<'_, CoreState>) -> Result<Vec<ToolConfig>, CoreError> {
    let c = core.core.clone();
    blocking(move || {
        let db = c.app_db()?;
        let registry = PluginRegistry::load(&c.paths, &db)?;
        tool_configs::reset_defaults(&db, &registry)?;
        tool_configs::list(&db)
    })
    .await
}

// ---- settings ----

#[tauri::command]
#[specta::specta]
pub async fn settings_get(
    core: State<'_, CoreState>,
    namespace: String,
) -> Result<BTreeMap<String, SettingValue>, CoreError> {
    db_call!(core, |db| settings::get(db, &namespace).map(|m| m.into_iter().map(|(k, v)| (k, SettingValue(v))).collect()))
}

#[tauri::command]
#[specta::specta]
pub async fn settings_set(
    core: State<'_, CoreState>,
    namespace: String,
    key: String,
    value: SettingValue,
) -> Result<(), CoreError> {
    db_call!(core, |db| settings::set(db, &namespace, &key, value.0))
}

/// Several keys of one namespace in one transaction; `null` deletes a key.
#[tauri::command]
#[specta::specta]
pub async fn settings_set_many(
    core: State<'_, CoreState>,
    namespace: String,
    entries: BTreeMap<String, SettingValue>,
) -> Result<(), CoreError> {
    db_call!(core, |db| settings::set_many(db, &namespace, entries.into_iter().map(|(k, v)| (k, v.0)).collect()))
}

#[tauri::command]
#[specta::specta]
pub async fn settings_delete(core: State<'_, CoreState>, namespace: String, key: String) -> Result<(), CoreError> {
    db_call!(core, |db| settings::delete(db, &namespace, &key))
}

// ---- stored prompts ----

#[tauri::command]
#[specta::specta]
pub async fn stored_prompts_list(core: State<'_, CoreState>) -> Result<Vec<StoredPrompt>, CoreError> {
    db_call!(core, |db| prompts::list(db))
}

#[tauri::command]
#[specta::specta]
pub async fn stored_prompts_upsert(core: State<'_, CoreState>, input: StoredPromptInput) -> Result<StoredPrompt, CoreError> {
    db_call!(core, |db| prompts::upsert(db, input))
}

#[tauri::command]
#[specta::specta]
pub async fn stored_prompts_delete(core: State<'_, CoreState>, id: Id) -> Result<(), CoreError> {
    db_call!(core, |db| prompts::delete(db, &id))
}

// ---- secrets (data-layer.md §7.4; DL-8) ----
// Write-only from the frontend: there is deliberately no command that returns
// a secret's value.

#[tauri::command]
#[specta::specta]
pub async fn secrets_set(core: State<'_, CoreState>, key: String, value: String) -> Result<(), CoreError> {
    let s = crate::commands::chat::secrets(&core)?;
    blocking(move || s.set(&key, &value)).await
}

#[tauri::command]
#[specta::specta]
pub async fn secrets_delete(core: State<'_, CoreState>, key: String) -> Result<(), CoreError> {
    let s = crate::commands::chat::secrets(&core)?;
    blocking(move || s.delete(&key).map(|_| ())).await
}

#[tauri::command]
#[specta::specta]
pub async fn secrets_exists(core: State<'_, CoreState>, key: String) -> Result<bool, CoreError> {
    let s = crate::commands::chat::secrets(&core)?;
    blocking(move || s.exists(&key)).await
}
