//! Plan commands (data-layer.md §10.2 `plans.rs`). No logic: each command calls
//! `quadflow_core::domains::plans` via `spawn_blocking`. The Plans tool binds to
//! a project with `issues_open` (same root key).

use crate::core_state::{blocking, CoreState};
use quadflow_core::domains::plans::{
    self as svc, NewPlan, NewPlanStep, Plan, PlanCommentKind, PlanPatch, PlanPromotion, PlanQuery, PlanStepPatch,
};
use quadflow_core::{CoreError, Id, ListResult};
use std::path::PathBuf;
use tauri::State;

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

#[tauri::command]
#[specta::specta]
pub async fn plans_list(core: State<'_, CoreState>, project_root: String, query: PlanQuery) -> Result<ListResult<Plan>, CoreError> {
    with_store!(core, project_root, |s, _a| svc::list(s, &query))
}

#[tauri::command]
#[specta::specta]
pub async fn plans_get(core: State<'_, CoreState>, project_root: String, plan_id: Id) -> Result<Plan, CoreError> {
    with_store!(core, project_root, |s, _a| svc::get(s, &plan_id))
}

#[tauri::command]
#[specta::specta]
pub async fn plans_create(core: State<'_, CoreState>, project_root: String, plan: NewPlan) -> Result<Plan, CoreError> {
    with_store!(core, project_root, |s, a| svc::create(s, &a, plan))
}

#[tauri::command]
#[specta::specta]
pub async fn plans_update(core: State<'_, CoreState>, project_root: String, plan_id: Id, patch: PlanPatch) -> Result<Plan, CoreError> {
    with_store!(core, project_root, |s, a| svc::update(s, &a, &plan_id, patch))
}

#[tauri::command]
#[specta::specta]
pub async fn plans_delete(core: State<'_, CoreState>, project_root: String, plan_id: Id) -> Result<(), CoreError> {
    with_store!(core, project_root, |s, a| svc::delete(s, &a, &plan_id))
}

#[tauri::command]
#[specta::specta]
pub async fn plans_step_add(core: State<'_, CoreState>, project_root: String, plan_id: Id, step: NewPlanStep) -> Result<Plan, CoreError> {
    with_store!(core, project_root, |s, a| svc::step_add(s, &a, &plan_id, step))
}

#[tauri::command]
#[specta::specta]
pub async fn plans_step_update(
    core: State<'_, CoreState>,
    project_root: String,
    plan_id: Id,
    step_id: Id,
    patch: PlanStepPatch,
) -> Result<Plan, CoreError> {
    with_store!(core, project_root, |s, a| svc::step_update(s, &a, &plan_id, &step_id, patch))
}

#[tauri::command]
#[specta::specta]
pub async fn plans_step_delete(core: State<'_, CoreState>, project_root: String, plan_id: Id, step_id: Id) -> Result<Plan, CoreError> {
    with_store!(core, project_root, |s, a| svc::step_delete(s, &a, &plan_id, &step_id))
}

#[tauri::command]
#[specta::specta]
pub async fn plans_steps_reorder(core: State<'_, CoreState>, project_root: String, plan_id: Id, step_ids: Vec<Id>) -> Result<Plan, CoreError> {
    with_store!(core, project_root, |s, a| svc::steps_reorder(s, &a, &plan_id, &step_ids))
}

#[tauri::command]
#[specta::specta]
pub async fn plans_comment_add(
    core: State<'_, CoreState>,
    project_root: String,
    plan_id: Id,
    body: String,
    kind: PlanCommentKind,
) -> Result<Plan, CoreError> {
    with_store!(core, project_root, |s, a| svc::comment_add(s, &a, &plan_id, &body, kind))
}

#[tauri::command]
#[specta::specta]
pub async fn plans_comment_delete(core: State<'_, CoreState>, project_root: String, plan_id: Id, comment_id: Id) -> Result<Plan, CoreError> {
    with_store!(core, project_root, |s, a| svc::comment_delete(s, &a, &plan_id, &comment_id))
}

#[tauri::command]
#[specta::specta]
pub async fn plans_promote_step(core: State<'_, CoreState>, project_root: String, plan_id: Id, step_id: Id) -> Result<PlanPromotion, CoreError> {
    with_store!(core, project_root, |s, a| svc::promote_step(s, &a, &plan_id, &step_id))
}

#[tauri::command]
#[specta::specta]
pub async fn plans_promote_all(core: State<'_, CoreState>, project_root: String, plan_id: Id) -> Result<PlanPromotion, CoreError> {
    with_store!(core, project_root, |s, a| svc::promote_all(s, &a, &plan_id))
}
