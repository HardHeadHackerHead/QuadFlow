//! Mission, mission-template and agent-definition commands (data-layer.md §10.2
//! `missions.rs`). No logic: each command calls `quadflow_core::domains::missions`
//! (or `domains::app::agent_definitions`) via `blocking`.

use crate::core_state::{blocking, CoreState};
use quadflow_core::domains::app::agent_definitions::{self, AgentDefinition, AgentDefinitionInput};
use quadflow_core::domains::issues::Issue;
use quadflow_core::domains::missions::{
    self as svc, Mission, MissionActivity, MissionMember, MissionMemberAddInput, MissionMemberPatch, MissionMergeEntry,
    MissionMergeEntryPatch, MissionMessage, MissionMessageQuery, MissionPatch, MissionProgress, MissionProposal,
    MissionProposalPatch, MissionProposalStatus, MissionReads, MissionStatus, MissionTemplate, MissionTemplateInput,
    NewMission, NewMissionActivity, NewMissionMergeEntry, NewMissionMessage, NewMissionProposal,
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

// ---- missions ----

#[tauri::command]
#[specta::specta]
pub async fn missions_list(core: State<'_, CoreState>, project_root: String, status: Option<MissionStatus>) -> Result<ListResult<Mission>, CoreError> {
    with_store!(core, project_root, |s, _a| svc::list(s, status))
}

#[tauri::command]
#[specta::specta]
pub async fn missions_get(core: State<'_, CoreState>, project_root: String, mission_id: Id) -> Result<Mission, CoreError> {
    with_store!(core, project_root, |s, _a| svc::get(s, &mission_id))
}

#[tauri::command]
#[specta::specta]
pub async fn missions_create(core: State<'_, CoreState>, project_root: String, mission: NewMission) -> Result<Mission, CoreError> {
    with_store!(core, project_root, |s, a| svc::create(s, &a, mission))
}

#[tauri::command]
#[specta::specta]
pub async fn missions_update(core: State<'_, CoreState>, project_root: String, mission_id: Id, patch: MissionPatch) -> Result<Mission, CoreError> {
    with_store!(core, project_root, |s, a| svc::update(s, &a, &mission_id, patch))
}

#[tauri::command]
#[specta::specta]
pub async fn missions_delete(core: State<'_, CoreState>, project_root: String, mission_id: Id) -> Result<(), CoreError> {
    with_store!(core, project_root, |s, a| svc::delete(s, &a, &mission_id))
}

#[tauri::command]
#[specta::specta]
pub async fn missions_progress(core: State<'_, CoreState>, project_root: String, mission_id: Id) -> Result<MissionProgress, CoreError> {
    with_store!(core, project_root, |s, _a| svc::progress(s, &mission_id))
}

#[tauri::command]
#[specta::specta]
pub async fn missions_issues(core: State<'_, CoreState>, project_root: String, mission_id: Id) -> Result<ListResult<Issue>, CoreError> {
    with_store!(core, project_root, |s, _a| svc::issues(s, &mission_id))
}

#[tauri::command]
#[specta::specta]
pub async fn missions_assign_issues(core: State<'_, CoreState>, project_root: String, mission_id: Id, issue_refs: Vec<String>) -> Result<Vec<Issue>, CoreError> {
    with_store!(core, project_root, |s, a| svc::assign_issues(s, &a, &mission_id, &issue_refs))
}

#[tauri::command]
#[specta::specta]
pub async fn missions_claim_next_issue(core: State<'_, CoreState>, project_root: String, mission_id: Id, member_ref: String) -> Result<Option<Issue>, CoreError> {
    with_store!(core, project_root, |s, a| svc::claim_next_issue(s, &a, &mission_id, &member_ref))
}

// ---- members ----

/// Resolves the agent definition (built-in or custom) and adds the member.
#[tauri::command]
#[specta::specta]
pub async fn missions_member_add(core: State<'_, CoreState>, project_root: String, mission_id: Id, input: MissionMemberAddInput) -> Result<MissionMember, CoreError> {
    let c = core.core.clone();
    let a = core.actor.clone();
    blocking(move || {
        let store = c.project(&PathBuf::from(project_root))?;
        let db = c.app_db()?;
        svc::member_add_from_definition(&store, &db, &a, &mission_id, input)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn missions_member_update(core: State<'_, CoreState>, project_root: String, mission_id: Id, member_ref: String, patch: MissionMemberPatch) -> Result<MissionMember, CoreError> {
    with_store!(core, project_root, |s, a| svc::member_update(s, &a, &mission_id, &member_ref, patch))
}

#[tauri::command]
#[specta::specta]
pub async fn missions_member_remove(core: State<'_, CoreState>, project_root: String, mission_id: Id, member_ref: String) -> Result<(), CoreError> {
    with_store!(core, project_root, |s, a| svc::member_remove(s, &a, &mission_id, &member_ref))
}

#[tauri::command]
#[specta::specta]
pub async fn missions_member_heartbeat(core: State<'_, CoreState>, project_root: String, mission_id: Id, member_ref: String) -> Result<MissionMember, CoreError> {
    with_store!(core, project_root, |s, a| svc::member_heartbeat(s, &a, &mission_id, &member_ref))
}

// ---- messages / activity ----

#[tauri::command]
#[specta::specta]
pub async fn missions_messages(core: State<'_, CoreState>, project_root: String, mission_id: Id, query: MissionMessageQuery) -> Result<ListResult<MissionMessage>, CoreError> {
    with_store!(core, project_root, |s, _a| svc::messages(s, &mission_id, &query))
}

#[tauri::command]
#[specta::specta]
pub async fn missions_send_message(core: State<'_, CoreState>, project_root: String, mission_id: Id, message: NewMissionMessage) -> Result<MissionMessage, CoreError> {
    with_store!(core, project_root, |s, a| svc::send_message(s, &a, &mission_id, message))
}

/// `reader` = member id/name or `"human"`; `upTo` absent = the latest message.
#[tauri::command]
#[specta::specta]
pub async fn missions_mark_read(core: State<'_, CoreState>, project_root: String, mission_id: Id, reader: String, up_to: Option<Id>) -> Result<MissionReads, CoreError> {
    with_store!(core, project_root, |s, a| svc::mark_read(s, &a, &mission_id, &reader, up_to.as_ref()))
}

#[tauri::command]
#[specta::specta]
pub async fn missions_unread_count(core: State<'_, CoreState>, project_root: String, mission_id: Id, reader: String) -> Result<u32, CoreError> {
    with_store!(core, project_root, |s, _a| svc::unread_count(s, &mission_id, &reader))
}

#[tauri::command]
#[specta::specta]
pub async fn missions_activity(core: State<'_, CoreState>, project_root: String, mission_id: Id, since: Option<Id>, limit: Option<u32>) -> Result<ListResult<MissionActivity>, CoreError> {
    with_store!(core, project_root, |s, _a| svc::activity(s, &mission_id, since.as_ref(), limit))
}

#[tauri::command]
#[specta::specta]
pub async fn missions_log_activity(core: State<'_, CoreState>, project_root: String, mission_id: Id, activity: NewMissionActivity) -> Result<MissionActivity, CoreError> {
    with_store!(core, project_root, |s, a| svc::log_activity(s, &a, &mission_id, activity))
}

// ---- proposals ----

#[tauri::command]
#[specta::specta]
pub async fn missions_proposal_create(core: State<'_, CoreState>, project_root: String, mission_id: Id, proposal: NewMissionProposal) -> Result<MissionProposal, CoreError> {
    with_store!(core, project_root, |s, a| svc::proposal_create(s, &a, &mission_id, proposal))
}

#[tauri::command]
#[specta::specta]
pub async fn missions_proposal_update_status(core: State<'_, CoreState>, project_root: String, mission_id: Id, proposal_id: Id, status: MissionProposalStatus) -> Result<MissionProposal, CoreError> {
    with_store!(core, project_root, |s, a| svc::proposal_update_status(s, &a, &mission_id, &proposal_id, status))
}

#[tauri::command]
#[specta::specta]
pub async fn missions_proposal_modify(core: State<'_, CoreState>, project_root: String, mission_id: Id, proposal_id: Id, patch: MissionProposalPatch) -> Result<MissionProposal, CoreError> {
    with_store!(core, project_root, |s, a| svc::proposal_modify(s, &a, &mission_id, &proposal_id, patch))
}

// ---- merge queue ----

#[tauri::command]
#[specta::specta]
pub async fn missions_merge_enqueue(core: State<'_, CoreState>, project_root: String, mission_id: Id, entry: NewMissionMergeEntry) -> Result<MissionMergeEntry, CoreError> {
    with_store!(core, project_root, |s, a| svc::merge_enqueue(s, &a, &mission_id, entry))
}

#[tauri::command]
#[specta::specta]
pub async fn missions_merge_queue(core: State<'_, CoreState>, project_root: String, mission_id: Id) -> Result<Vec<MissionMergeEntry>, CoreError> {
    with_store!(core, project_root, |s, _a| svc::merge_queue(s, &mission_id))
}

#[tauri::command]
#[specta::specta]
pub async fn missions_merge_next(core: State<'_, CoreState>, project_root: String, mission_id: Id) -> Result<Option<MissionMergeEntry>, CoreError> {
    with_store!(core, project_root, |s, a| svc::merge_next(s, &a, &mission_id))
}

#[tauri::command]
#[specta::specta]
pub async fn missions_merge_update(core: State<'_, CoreState>, project_root: String, mission_id: Id, entry_id: Id, patch: MissionMergeEntryPatch) -> Result<MissionMergeEntry, CoreError> {
    with_store!(core, project_root, |s, a| svc::merge_update(s, &a, &mission_id, &entry_id, patch))
}

// ---- templates ----

#[tauri::command]
#[specta::specta]
pub async fn mission_templates_list(core: State<'_, CoreState>, project_root: String) -> Result<ListResult<MissionTemplate>, CoreError> {
    with_store!(core, project_root, |s, _a| svc::templates_list(s))
}

#[tauri::command]
#[specta::specta]
pub async fn mission_templates_upsert(core: State<'_, CoreState>, project_root: String, template: MissionTemplateInput) -> Result<MissionTemplate, CoreError> {
    with_store!(core, project_root, |s, a| svc::template_upsert(s, &a, template))
}

#[tauri::command]
#[specta::specta]
pub async fn mission_templates_delete(core: State<'_, CoreState>, project_root: String, template_id: Id) -> Result<(), CoreError> {
    with_store!(core, project_root, |s, a| svc::template_delete(s, &a, &template_id))
}

// ---- agent definitions (app DB; built-ins merged) ----

#[tauri::command]
#[specta::specta]
pub async fn agent_definitions_list(core: State<'_, CoreState>) -> Result<Vec<AgentDefinition>, CoreError> {
    db_call!(core, |db| svc::agent_definitions_list(db))
}

#[tauri::command]
#[specta::specta]
pub async fn agent_definitions_upsert(core: State<'_, CoreState>, definition: AgentDefinitionInput) -> Result<AgentDefinition, CoreError> {
    db_call!(core, |db| {
        if let Some(m) = definition.model.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
            svc::validate_model(m)?;
        }
        agent_definitions::upsert(db, definition)
    })
}

#[tauri::command]
#[specta::specta]
pub async fn agent_definitions_delete(core: State<'_, CoreState>, id: Id) -> Result<(), CoreError> {
    db_call!(core, |db| agent_definitions::delete(db, &id))
}
