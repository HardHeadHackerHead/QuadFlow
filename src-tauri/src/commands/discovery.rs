//! Discovery commands (data-layer.md §10.2 `discovery.rs`). No logic: each
//! command resolves the project store and calls `quadflow_core::domains::discovery`.

use crate::core_state::{blocking, CoreState};
use quadflow_core::domains::discovery::{
    self, DiscoveryItemPatch, DiscoveryLinks, DiscoveryPatch, DiscoveryProject, DiscoveryQuery, NewDiscoveryItem,
    NewDiscoveryProject,
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
pub async fn discovery_list(core: State<'_, CoreState>, project_root: String, query: DiscoveryQuery) -> Result<ListResult<DiscoveryProject>, CoreError> {
    with_store(&core, project_root, move |s, _| discovery::list(s, &query)).await
}

#[tauri::command]
#[specta::specta]
pub async fn discovery_get(core: State<'_, CoreState>, project_root: String, id: Id) -> Result<DiscoveryProject, CoreError> {
    with_store(&core, project_root, move |s, _| discovery::get(s, &id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn discovery_create(core: State<'_, CoreState>, project_root: String, project: NewDiscoveryProject) -> Result<DiscoveryProject, CoreError> {
    with_store(&core, project_root, move |s, a| discovery::create(s, a, project)).await
}

#[tauri::command]
#[specta::specta]
pub async fn discovery_update(core: State<'_, CoreState>, project_root: String, id: Id, patch: DiscoveryPatch) -> Result<DiscoveryProject, CoreError> {
    with_store(&core, project_root, move |s, a| discovery::update(s, a, &id, patch)).await
}

#[tauri::command]
#[specta::specta]
pub async fn discovery_delete(core: State<'_, CoreState>, project_root: String, id: Id) -> Result<(), CoreError> {
    with_store(&core, project_root, move |s, a| discovery::delete(s, a, &id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn discovery_item_add(core: State<'_, CoreState>, project_root: String, id: Id, item: NewDiscoveryItem) -> Result<DiscoveryProject, CoreError> {
    with_store(&core, project_root, move |s, a| discovery::item_add(s, a, &id, item)).await
}

#[tauri::command]
#[specta::specta]
pub async fn discovery_item_update(core: State<'_, CoreState>, project_root: String, id: Id, item_id: Id, patch: DiscoveryItemPatch) -> Result<DiscoveryProject, CoreError> {
    with_store(&core, project_root, move |s, a| discovery::item_update(s, a, &id, &item_id, patch)).await
}

#[tauri::command]
#[specta::specta]
pub async fn discovery_item_delete(core: State<'_, CoreState>, project_root: String, id: Id, item_id: Id) -> Result<DiscoveryProject, CoreError> {
    with_store(&core, project_root, move |s, a| discovery::item_delete(s, a, &id, &item_id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn discovery_items_reorder(core: State<'_, CoreState>, project_root: String, id: Id, item_ids: Vec<Id>) -> Result<DiscoveryProject, CoreError> {
    with_store(&core, project_root, move |s, a| discovery::items_reorder(s, a, &id, &item_ids)).await
}

#[tauri::command]
#[specta::specta]
pub async fn discovery_linked(core: State<'_, CoreState>, project_root: String, id: Id) -> Result<DiscoveryLinks, CoreError> {
    with_store(&core, project_root, move |s, _| discovery::linked(s, &id)).await
}
