//! Scripts, script groups and terminal environments (data-layer.md §10.2 `scripts.rs`).

use crate::core_state::{blocking, CoreState};
use quadflow_core::domains::environments::{self, EnvironmentInput, TerminalEnvironment};
use quadflow_core::domains::scripts::{
    self, ScriptGroupMemberInput, ScriptResolveOptions, ScriptResolvedCommand, Script, ScriptGroup, ScriptGroupInput, ScriptGroupPatch,
    ScriptInput, ScriptPatch, ScriptQuery,
};
use quadflow_core::{CoreError, Id, ListResult};
use std::path::PathBuf;
use tauri::State;

macro_rules! project_cmd {
    ($core:expr, $root:expr, |$store:ident, $actor:ident| $body:expr) => {{
        let c = $core.core.clone();
        let $actor = $core.actor.clone();
        blocking(move || {
            let $store = c.project(&PathBuf::from($root))?;
            let $store = &*$store;
            let $actor = &$actor;
            $body
        })
        .await
    }};
}

#[tauri::command]
#[specta::specta]
pub async fn scripts_list(core: State<'_, CoreState>, project_root: String, query: ScriptQuery) -> Result<ListResult<Script>, CoreError> {
    project_cmd!(core, project_root, |s, _a| scripts::list(s, &query))
}

#[tauri::command]
#[specta::specta]
pub async fn scripts_get(core: State<'_, CoreState>, project_root: String, id: Id) -> Result<Script, CoreError> {
    project_cmd!(core, project_root, |s, _a| scripts::get(s, &id))
}

#[tauri::command]
#[specta::specta]
pub async fn scripts_create(core: State<'_, CoreState>, project_root: String, input: ScriptInput) -> Result<Script, CoreError> {
    project_cmd!(core, project_root, |s, a| scripts::create(s, a, input))
}

#[tauri::command]
#[specta::specta]
pub async fn scripts_update(
    core: State<'_, CoreState>,
    project_root: String,
    id: Id,
    patch: ScriptPatch,
) -> Result<Script, CoreError> {
    project_cmd!(core, project_root, |s, a| scripts::update(s, a, &id, patch))
}

#[tauri::command]
#[specta::specta]
pub async fn scripts_delete(core: State<'_, CoreState>, project_root: String, id: Id) -> Result<(), CoreError> {
    project_cmd!(core, project_root, |s, a| scripts::delete(s, a, &id))
}

#[tauri::command]
#[specta::specta]
pub async fn scripts_resolve_command(
    core: State<'_, CoreState>,
    project_root: String,
    id: Id,
    options: ScriptResolveOptions,
) -> Result<ScriptResolvedCommand, CoreError> {
    let c = core.core.clone();
    blocking(move || {
        let store = c.project(&PathBuf::from(project_root))?;
        let db = c.app_db()?;
        scripts::resolve_command(&store, Some(&db), &id, &options)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn script_groups_list(core: State<'_, CoreState>, project_root: String) -> Result<ListResult<ScriptGroup>, CoreError> {
    project_cmd!(core, project_root, |s, _a| scripts::groups_list(s))
}

#[tauri::command]
#[specta::specta]
pub async fn script_groups_get(core: State<'_, CoreState>, project_root: String, id: Id) -> Result<ScriptGroup, CoreError> {
    project_cmd!(core, project_root, |s, _a| scripts::group_get(s, &id))
}

#[tauri::command]
#[specta::specta]
pub async fn script_groups_create(
    core: State<'_, CoreState>,
    project_root: String,
    input: ScriptGroupInput,
) -> Result<ScriptGroup, CoreError> {
    project_cmd!(core, project_root, |s, a| scripts::group_create(s, a, input))
}

#[tauri::command]
#[specta::specta]
pub async fn script_groups_update(
    core: State<'_, CoreState>,
    project_root: String,
    id: Id,
    patch: ScriptGroupPatch,
) -> Result<ScriptGroup, CoreError> {
    project_cmd!(core, project_root, |s, a| scripts::group_update(s, a, &id, patch))
}

#[tauri::command]
#[specta::specta]
pub async fn script_groups_delete(core: State<'_, CoreState>, project_root: String, id: Id) -> Result<(), CoreError> {
    project_cmd!(core, project_root, |s, a| scripts::group_delete(s, a, &id))
}

#[tauri::command]
#[specta::specta]
pub async fn script_groups_add_member(
    core: State<'_, CoreState>,
    project_root: String,
    group_id: Id,
    member: ScriptGroupMemberInput,
) -> Result<ScriptGroup, CoreError> {
    project_cmd!(core, project_root, |s, a| scripts::group_add_member(s, a, &group_id, member))
}

#[tauri::command]
#[specta::specta]
pub async fn script_groups_remove_member(
    core: State<'_, CoreState>,
    project_root: String,
    group_id: Id,
    script_id: Id,
) -> Result<ScriptGroup, CoreError> {
    project_cmd!(core, project_root, |s, a| scripts::group_remove_member(s, a, &group_id, &script_id))
}

#[tauri::command]
#[specta::specta]
pub async fn environments_list(core: State<'_, CoreState>) -> Result<Vec<TerminalEnvironment>, CoreError> {
    let c = core.core.clone();
    blocking(move || environments::list(&*c.app_db()?)).await
}

#[tauri::command]
#[specta::specta]
pub async fn environments_upsert(core: State<'_, CoreState>, input: EnvironmentInput) -> Result<TerminalEnvironment, CoreError> {
    let c = core.core.clone();
    blocking(move || environments::upsert(&*c.app_db()?, input)).await
}

#[tauri::command]
#[specta::specta]
pub async fn environments_delete(core: State<'_, CoreState>, id: Id) -> Result<(), CoreError> {
    let c = core.core.clone();
    blocking(move || environments::delete(&*c.app_db()?, &id)).await
}

/// Scan this machine for shells / toolchains, register them, return the full list.
#[tauri::command]
#[specta::specta]
pub async fn environments_detect(core: State<'_, CoreState>) -> Result<Vec<TerminalEnvironment>, CoreError> {
    let c = core.core.clone();
    blocking(move || environments::detect(&*c.app_db()?)).await
}
