//! Ideas commands (data-layer.md §10.2 `ideas.rs`). No logic: each command
//! resolves the project store and calls `quadflow_core::domains::ideas`.

use crate::core_state::{blocking, CoreState};
use quadflow_core::domains::ideas::{
    self, ExportFormat, Idea, IdeaPatch, IdeaQuery, IdeaStats, NewIdea, SuggestionKind,
};
use quadflow_core::store::ProjectStore;
use quadflow_core::{Actor, CoreError, Id, ListResult};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

/// Run `f` with the project store and the GUI actor off the async runtime.
async fn with_store<T: Send + 'static>(
    core: &State<'_, CoreState>,
    project_root: String,
    f: impl FnOnce(&ProjectStore, &Actor) -> Result<T, CoreError> + Send + 'static,
) -> Result<T, CoreError> {
    let c = core.core.clone();
    let actor = core.actor.clone();
    blocking(move || {
        let store: Arc<ProjectStore> = c.project(&PathBuf::from(project_root))?;
        f(&store, &actor)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn ideas_list(core: State<'_, CoreState>, project_root: String, query: IdeaQuery) -> Result<ListResult<Idea>, CoreError> {
    with_store(&core, project_root, move |s, _| ideas::list(s, &query)).await
}

#[tauri::command]
#[specta::specta]
pub async fn ideas_get(core: State<'_, CoreState>, project_root: String, id: Id) -> Result<Idea, CoreError> {
    with_store(&core, project_root, move |s, _| ideas::get(s, &id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn ideas_create(core: State<'_, CoreState>, project_root: String, idea: NewIdea) -> Result<Idea, CoreError> {
    with_store(&core, project_root, move |s, a| ideas::create(s, a, idea)).await
}

#[tauri::command]
#[specta::specta]
pub async fn ideas_update(core: State<'_, CoreState>, project_root: String, id: Id, patch: IdeaPatch) -> Result<Idea, CoreError> {
    with_store(&core, project_root, move |s, a| ideas::update(s, a, &id, patch)).await
}

#[tauri::command]
#[specta::specta]
pub async fn ideas_delete(core: State<'_, CoreState>, project_root: String, id: Id) -> Result<(), CoreError> {
    with_store(&core, project_root, move |s, a| ideas::delete(s, a, &id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn ideas_add_tag(core: State<'_, CoreState>, project_root: String, id: Id, tag: String) -> Result<Idea, CoreError> {
    with_store(&core, project_root, move |s, a| ideas::add_tag(s, a, &id, &tag)).await
}

#[tauri::command]
#[specta::specta]
pub async fn ideas_remove_tag(core: State<'_, CoreState>, project_root: String, id: Id, tag: String) -> Result<Idea, CoreError> {
    with_store(&core, project_root, move |s, a| ideas::remove_tag(s, a, &id, &tag)).await
}

#[tauri::command]
#[specta::specta]
pub async fn ideas_bulk_tag(core: State<'_, CoreState>, project_root: String, ids: Vec<Id>, tag: String) -> Result<Vec<Idea>, CoreError> {
    with_store(&core, project_root, move |s, a| ideas::bulk_tag(s, a, &ids, &tag)).await
}

#[tauri::command]
#[specta::specta]
pub async fn ideas_merge(core: State<'_, CoreState>, project_root: String, ids: Vec<Id>, keep: Id) -> Result<Idea, CoreError> {
    with_store(&core, project_root, move |s, a| ideas::merge(s, a, &ids, &keep)).await
}

#[tauri::command]
#[specta::specta]
pub async fn ideas_add_note(core: State<'_, CoreState>, project_root: String, id: Id, body: String) -> Result<Idea, CoreError> {
    with_store(&core, project_root, move |s, a| ideas::add_note(s, a, &id, &body)).await
}

#[tauri::command]
#[specta::specta]
pub async fn ideas_delete_note(core: State<'_, CoreState>, project_root: String, id: Id, note_id: Id) -> Result<Idea, CoreError> {
    with_store(&core, project_root, move |s, a| ideas::delete_note(s, a, &id, &note_id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn ideas_add_suggestion(
    core: State<'_, CoreState>,
    project_root: String,
    id: Id,
    kind: SuggestionKind,
    text: String,
) -> Result<Idea, CoreError> {
    with_store(&core, project_root, move |s, a| ideas::add_suggestion(s, a, &id, kind, &text)).await
}

#[tauri::command]
#[specta::specta]
pub async fn ideas_resolve_suggestion(
    core: State<'_, CoreState>,
    project_root: String,
    id: Id,
    suggestion_id: Id,
    accept: bool,
) -> Result<Idea, CoreError> {
    with_store(&core, project_root, move |s, a| ideas::resolve_suggestion(s, a, &id, &suggestion_id, accept)).await
}

#[tauri::command]
#[specta::specta]
pub async fn ideas_delete_suggestion(
    core: State<'_, CoreState>,
    project_root: String,
    id: Id,
    suggestion_id: Id,
) -> Result<Idea, CoreError> {
    with_store(&core, project_root, move |s, a| ideas::delete_suggestion(s, a, &id, &suggestion_id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn ideas_revert(core: State<'_, CoreState>, project_root: String, id: Id) -> Result<Idea, CoreError> {
    with_store(&core, project_root, move |s, a| ideas::revert(s, a, &id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn ideas_stats(core: State<'_, CoreState>, project_root: String) -> Result<IdeaStats, CoreError> {
    with_store(&core, project_root, move |s, _| ideas::stats(s)).await
}

#[tauri::command]
#[specta::specta]
pub async fn ideas_export(core: State<'_, CoreState>, project_root: String, format: ExportFormat) -> Result<String, CoreError> {
    with_store(&core, project_root, move |s, _| ideas::export(s, format)).await
}
