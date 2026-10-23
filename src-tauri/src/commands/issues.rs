//! Issue, label and epic commands (data-layer.md §10.2 `issues.rs`). No logic:
//! each command calls `quadflow_core::domains::issues` via `spawn_blocking`.

use crate::core_state::{blocking, CoreState};
use quadflow_core::domains::issues::{
    self as svc, ClaimInput, Epic, EpicPatch, Issue, IssuePatch, IssueQuery, IssueStatus, Label, NewEpic, NewIssue,
};
use quadflow_core::domains::project_config;
use quadflow_core::{CoreError, Id, ListResult};
use serde::Serialize;
use std::path::PathBuf;
use tauri::State;

/// What a frontend issue store needs to bind to a project.
#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IssuesProject {
    /// Canonical project root.
    pub root: String,
    /// `ChangeScope.project.rootKey` of this project's `data-changed` events.
    pub root_key: String,
    /// Issue ref prefix (`CODE-n`).
    pub code: String,
}

macro_rules! with_store {
    ($core:expr, $root:expr, |$s:ident, $a:ident| $body:expr) => {{
        let c = $core.core.clone();
        let $a = $core.actor.clone();
        let root = PathBuf::from($root);
        blocking(move || {
            let store = c.project(&root)?;
            let $s = &*store;
            let _ = &$a;
            $body
        })
        .await
    }};
}

/// Open (initializing `.quadflow/` if needed) and start watching a project for
/// the issues tool; returns the root key to filter `data-changed` events by.
#[tauri::command]
#[specta::specta]
pub async fn issues_open(core: State<'_, CoreState>, project_root: String) -> Result<IssuesProject, CoreError> {
    let c = core.core.clone();
    blocking(move || {
        let path = PathBuf::from(&project_root);
        let store = match c.project(&path) {
            Ok(s) => s,
            Err(e) if e.code == quadflow_core::ErrorCode::ProjectNotFound && path.is_dir() => {
                c.adopt_project(project_config::open_or_init(&path, c.profile(), c.bus.clone())?)
            }
            Err(e) => return Err(e),
        };
        c.watch_project(&store.root().path)?;
        Ok(IssuesProject {
            root: store.root().path.display().to_string(),
            root_key: store.root().key.clone(),
            code: project_config::read(&store)?.code,
        })
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn issues_list(core: State<'_, CoreState>, project_root: String, query: IssueQuery) -> Result<ListResult<Issue>, CoreError> {
    with_store!(core, project_root, |s, _a| svc::list(s, &query))
}

#[tauri::command]
#[specta::specta]
pub async fn issues_get(core: State<'_, CoreState>, project_root: String, issue_ref: String) -> Result<Issue, CoreError> {
    with_store!(core, project_root, |s, _a| svc::get(s, &issue_ref))
}

#[tauri::command]
#[specta::specta]
pub async fn issues_create(core: State<'_, CoreState>, project_root: String, issue: NewIssue) -> Result<Issue, CoreError> {
    with_store!(core, project_root, |s, a| svc::create(s, &a, issue))
}

#[tauri::command]
#[specta::specta]
pub async fn issues_update(core: State<'_, CoreState>, project_root: String, issue_ref: String, patch: IssuePatch) -> Result<Issue, CoreError> {
    with_store!(core, project_root, |s, a| svc::update(s, &a, &issue_ref, patch))
}

#[tauri::command]
#[specta::specta]
pub async fn issues_set_status(core: State<'_, CoreState>, project_root: String, issue_ref: String, status: IssueStatus) -> Result<Issue, CoreError> {
    with_store!(core, project_root, |s, a| svc::set_status(s, &a, &issue_ref, status))
}

#[tauri::command]
#[specta::specta]
pub async fn issues_close(core: State<'_, CoreState>, project_root: String, issue_ref: String) -> Result<Issue, CoreError> {
    with_store!(core, project_root, |s, a| svc::close(s, &a, &issue_ref))
}

#[tauri::command]
#[specta::specta]
pub async fn issues_reopen(core: State<'_, CoreState>, project_root: String, issue_ref: String) -> Result<Issue, CoreError> {
    with_store!(core, project_root, |s, a| svc::reopen(s, &a, &issue_ref))
}

#[tauri::command]
#[specta::specta]
pub async fn issues_delete(core: State<'_, CoreState>, project_root: String, issue_ref: String) -> Result<(), CoreError> {
    with_store!(core, project_root, |s, a| svc::delete(s, &a, &issue_ref))
}

#[tauri::command]
#[specta::specta]
pub async fn issues_add_comment(core: State<'_, CoreState>, project_root: String, issue_ref: String, body: String) -> Result<Issue, CoreError> {
    with_store!(core, project_root, |s, a| svc::add_comment(s, &a, &issue_ref, &body))
}

#[tauri::command]
#[specta::specta]
pub async fn issues_delete_comment(core: State<'_, CoreState>, project_root: String, issue_ref: String, comment_id: Id) -> Result<Issue, CoreError> {
    with_store!(core, project_root, |s, a| svc::delete_comment(s, &a, &issue_ref, &comment_id))
}

/// `checked = null` toggles.
#[tauri::command]
#[specta::specta]
pub async fn issues_toggle_criterion(
    core: State<'_, CoreState>,
    project_root: String,
    issue_ref: String,
    criterion_id: Id,
    checked: Option<bool>,
) -> Result<Issue, CoreError> {
    with_store!(core, project_root, |s, a| svc::toggle_criterion(s, &a, &issue_ref, &criterion_id, checked))
}

#[tauri::command]
#[specta::specta]
pub async fn issues_claim(core: State<'_, CoreState>, project_root: String, issue_ref: String, claim: ClaimInput) -> Result<Issue, CoreError> {
    with_store!(core, project_root, |s, a| svc::claim(s, &a, &issue_ref, claim))
}

#[tauri::command]
#[specta::specta]
pub async fn issues_heartbeat(core: State<'_, CoreState>, project_root: String, issue_ref: String) -> Result<Issue, CoreError> {
    with_store!(core, project_root, |s, a| svc::heartbeat(s, &a, &issue_ref))
}

#[tauri::command]
#[specta::specta]
pub async fn issues_release(core: State<'_, CoreState>, project_root: String, issue_ref: String) -> Result<Issue, CoreError> {
    with_store!(core, project_root, |s, a| svc::release(s, &a, &issue_ref))
}

#[tauri::command]
#[specta::specta]
pub async fn labels_list(core: State<'_, CoreState>, project_root: String) -> Result<Vec<Label>, CoreError> {
    with_store!(core, project_root, |s, _a| svc::labels_list(s))
}

/// Create or update; with `renameFrom`, renames that label everywhere.
#[tauri::command]
#[specta::specta]
pub async fn labels_upsert(
    core: State<'_, CoreState>,
    project_root: String,
    label: Label,
    rename_from: Option<String>,
) -> Result<Vec<Label>, CoreError> {
    with_store!(core, project_root, |s, a| svc::label_upsert(s, &a, label, rename_from))
}

#[tauri::command]
#[specta::specta]
pub async fn labels_delete(core: State<'_, CoreState>, project_root: String, name: String) -> Result<Vec<Label>, CoreError> {
    with_store!(core, project_root, |s, a| svc::label_delete(s, &a, &name))
}

#[tauri::command]
#[specta::specta]
pub async fn epics_list(core: State<'_, CoreState>, project_root: String) -> Result<ListResult<Epic>, CoreError> {
    with_store!(core, project_root, |s, _a| svc::epics_list(s))
}

#[tauri::command]
#[specta::specta]
pub async fn epics_get(core: State<'_, CoreState>, project_root: String, id: Id) -> Result<Epic, CoreError> {
    with_store!(core, project_root, |s, _a| svc::epic_get(s, &id))
}

#[tauri::command]
#[specta::specta]
pub async fn epics_create(core: State<'_, CoreState>, project_root: String, epic: NewEpic) -> Result<Epic, CoreError> {
    with_store!(core, project_root, |s, a| svc::epic_create(s, &a, epic))
}

#[tauri::command]
#[specta::specta]
pub async fn epics_update(core: State<'_, CoreState>, project_root: String, id: Id, patch: EpicPatch) -> Result<Epic, CoreError> {
    with_store!(core, project_root, |s, a| svc::epic_update(s, &a, &id, patch))
}

#[tauri::command]
#[specta::specta]
pub async fn epics_delete(core: State<'_, CoreState>, project_root: String, id: Id) -> Result<(), CoreError> {
    with_store!(core, project_root, |s, a| svc::epic_delete(s, &a, &id))
}
