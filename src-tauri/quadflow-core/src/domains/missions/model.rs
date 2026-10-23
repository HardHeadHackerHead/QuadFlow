//! Mission, mission-template and message/activity schemas (data-layer.md §6.8, §6.9).
//!
//! Type names carry a `Mission` prefix because specta exports every type into
//! one TypeScript namespace (`AgentRole` → `MissionAgentRole`, …).

use crate::domains::issues::{IssueStatus, Priority};
use crate::events::Domain;
use crate::ids::Id;
use crate::model::{Actor, Ext, JsonValue, Timestamp};
use crate::store::Entity;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

// ------------------------------------------------------------------ enums

macro_rules! str_enum {
    ($name:ident { $($v:ident => $s:literal),+ $(,)? }) => {
        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$v),+];
            pub fn as_str(self) -> &'static str {
                match self { $($name::$v => $s),+ }
            }
            /// Canonical snake_case value (also accepts `-` and spaces).
            pub fn parse(s: &str) -> Option<$name> {
                let norm = s.trim().to_ascii_lowercase().replace(['-', ' '], "_");
                match norm.as_str() { $($s => Some($name::$v),)+ _ => None }
            }
            pub fn expected() -> String {
                [$($s),+].join(", ")
            }
        }
    };
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MissionStatus {
    #[default]
    Preparing,
    Active,
    Paused,
    Completed,
    Cancelled,
}
str_enum!(MissionStatus { Preparing => "preparing", Active => "active", Paused => "paused", Completed => "completed", Cancelled => "cancelled" });

impl MissionStatus {
    pub fn is_finished(self) -> bool {
        matches!(self, MissionStatus::Completed | MissionStatus::Cancelled)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MissionOrchestratorMode {
    #[default]
    Manual,
    OnDemand,
    Persistent,
}
str_enum!(MissionOrchestratorMode { Manual => "manual", OnDemand => "on_demand", Persistent => "persistent" });

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MissionAgentRole {
    ScrumMaster,
    TechLead,
    ProductOwner,
    Frontend,
    Backend,
    #[default]
    Fullstack,
    Devops,
    Database,
    Qa,
    Security,
    Docs,
    Research,
    Custom,
}
str_enum!(MissionAgentRole {
    ScrumMaster => "scrum_master", TechLead => "tech_lead", ProductOwner => "product_owner",
    Frontend => "frontend", Backend => "backend", Fullstack => "fullstack", Devops => "devops",
    Database => "database", Qa => "qa", Security => "security", Docs => "docs",
    Research => "research", Custom => "custom",
});

impl MissionAgentRole {
    /// Coordinating roles (they orchestrate, they do not write code).
    pub fn is_coordinator(self) -> bool {
        matches!(self, MissionAgentRole::ScrumMaster | MissionAgentRole::TechLead)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MissionMemberStatus {
    #[default]
    Pending,
    Spawning,
    Idle,
    Working,
    Stopped,
    Error,
}
str_enum!(MissionMemberStatus { Pending => "pending", Spawning => "spawning", Idle => "idle", Working => "working", Stopped => "stopped", Error => "error" });

impl MissionMemberStatus {
    pub fn is_active(self) -> bool {
        matches!(self, MissionMemberStatus::Spawning | MissionMemberStatus::Idle | MissionMemberStatus::Working)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MissionProposalStatus {
    #[default]
    Pending,
    Approved,
    Rejected,
    Modified,
}
str_enum!(MissionProposalStatus { Pending => "pending", Approved => "approved", Rejected => "rejected", Modified => "modified" });

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MissionMergeStatus {
    #[default]
    Queued,
    Merging,
    Merged,
    Skipped,
    Failed,
}
str_enum!(MissionMergeStatus { Queued => "queued", Merging => "merging", Merged => "merged", Skipped => "skipped", Failed => "failed" });

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MissionMessageKind {
    #[default]
    Chat,
    Status,
    Finding,
    Blocker,
    Completion,
    Assignment,
    HelpRequest,
    Review,
    Question,
    Answer,
    Decision,
    Handoff,
}
str_enum!(MissionMessageKind {
    Chat => "chat", Status => "status", Finding => "finding", Blocker => "blocker",
    Completion => "completion", Assignment => "assignment", HelpRequest => "help_request",
    Review => "review", Question => "question", Answer => "answer", Decision => "decision",
    Handoff => "handoff",
});

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MissionActivityKind {
    MissionStarted,
    MissionPaused,
    MissionCompleted,
    MemberJoined,
    MemberLeft,
    IssueClaimed,
    /// Issues added to the mission (`assign_issues`) or an issue handed to a member.
    IssuesAssigned,
    StatusChanged,
    MessageSent,
    ProposalCreated,
    ProposalUpdated,
    MergeQueued,
    MergeCompleted,
    /// Free-form decision / log entry (`log_activity`).
    #[default]
    Note,
    Error,
}
str_enum!(MissionActivityKind {
    MissionStarted => "mission_started", MissionPaused => "mission_paused",
    MissionCompleted => "mission_completed", MemberJoined => "member_joined",
    MemberLeft => "member_left", IssueClaimed => "issue_claimed", IssuesAssigned => "issues_assigned",
    StatusChanged => "status_changed", MessageSent => "message_sent",
    ProposalCreated => "proposal_created", ProposalUpdated => "proposal_updated",
    MergeQueued => "merge_queued", MergeCompleted => "merge_completed", Note => "note", Error => "error",
});

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MissionTemplateCategory {
    Build,
    Quality,
    Ops,
    Planning,
    #[default]
    General,
}
str_enum!(MissionTemplateCategory { Build => "build", Quality => "quality", Ops => "ops", Planning => "planning", General => "general" });

// ------------------------------------------------------------------ templates

/// One phase of a mission playbook (ordered by position in the list).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MissionWorkflowPhase {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Condition that ends the phase (`all_issues_done`, …); informational.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gate: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<String>,
}

/// `mission-templates/<id>.json` (custom) or a built-in const (`builtin-*` id).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MissionTemplate {
    pub id: Id,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub category: MissionTemplateCategory,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub workflow_phases: Vec<MissionWorkflowPhase>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills_used: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub success_criteria: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchestrator_prompt_extra: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member_prompt_extra: Option<String>,
    #[serde(default)]
    pub built_in: bool,
    pub created_at: Timestamp,
    pub created_by: Actor,
    pub updated_at: Timestamp,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[specta(type = BTreeMap<String, JsonValue>)]
    pub ext: Ext,
}

impl Entity for MissionTemplate {
    const DOMAIN: Domain = Domain::MissionTemplates;
    const DIR: &'static str = "mission-templates";
    fn id(&self) -> &Id {
        &self.id
    }
}

/// Create (no `id`) or replace (existing custom `id`) a template.
#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MissionTemplateInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<Id>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<MissionTemplateCategory>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub workflow_phases: Vec<MissionWorkflowPhase>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills_used: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub success_criteria: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchestrator_prompt_extra: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member_prompt_extra: Option<String>,
}

// ------------------------------------------------------------------ mission

/// Playbook copied from a template at creation (real arrays, not JSON strings).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MissionConfig {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub workflow_phases: Vec<MissionWorkflowPhase>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills_used: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub success_criteria: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchestrator_prompt_extra: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member_prompt_extra: Option<String>,
}

impl MissionConfig {
    pub fn from_template(t: &MissionTemplate) -> Self {
        Self {
            workflow_phases: t.workflow_phases.clone(),
            skills_used: t.skills_used.clone(),
            success_criteria: t.success_criteria.clone(),
            orchestrator_prompt_extra: t.orchestrator_prompt_extra.clone(),
            member_prompt_extra: t.member_prompt_extra.clone(),
        }
    }
}

/// `local/missions/<id>/mission.json`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Mission {
    pub id: Id,
    pub name: String,
    pub status: MissionStatus,
    pub orchestrator_mode: MissionOrchestratorMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchestrator_member_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_id: Option<Id>,
    #[serde(default)]
    pub config: MissionConfig,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub members: Vec<MissionMember>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub proposals: Vec<MissionProposal>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub merge_queue: Vec<MissionMergeEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<Timestamp>,
    pub created_at: Timestamp,
    pub created_by: Actor,
    pub updated_at: Timestamp,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[specta(type = BTreeMap<String, JsonValue>)]
    pub ext: Ext,
}

impl Mission {
    pub fn member(&self, id: &Id) -> Option<&MissionMember> {
        self.members.iter().find(|m| &m.id == id)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MissionMember {
    pub id: Id,
    pub agent_definition_id: String,
    pub name: String,
    pub role: MissionAgentRole,
    pub provider_id: String,
    /// Validated `^[A-Za-z0-9._:\[\]-]+$` (agent-providers.md §6.3).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub status: MissionMemberStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assigned_issue_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_heartbeat: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MissionProposal {
    pub id: Id,
    pub goal: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<MissionProposedAgent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_cost_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_minutes: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
    pub status: MissionProposalStatus,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

/// One agent in a proposal. `agentDefinitionId` / `providerId` are optional:
/// a coordinator usually proposes by role and the approver picks the definition.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MissionProposedAgent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_definition_id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub role: MissionAgentRole,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus: Option<String>,
    /// Issues (ids) this agent would take.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub issue_ids: Vec<Id>,
    /// File scope (project-relative paths) the agent may modify; empty = unrestricted.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_files: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MissionMergeEntry {
    pub id: Id,
    pub member_id: Id,
    pub branch_name: String,
    pub worktree_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_id: Option<Id>,
    pub status: MissionMergeStatus,
    pub position: u32,
    pub priority: Priority,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skip_reason: Option<String>,
    pub created_at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merged_at: Option<Timestamp>,
}

// ------------------------------------------------------------------ logs

/// One line of `messages.jsonl` (append-only).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MissionMessage {
    pub id: Id,
    /// `None` = a human (the GUI or a CLI user without a member id).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_member_id: Option<Id>,
    pub from_name: String,
    /// `None` = broadcast to the whole mission.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_member_id: Option<Id>,
    pub kind: MissionMessageKind,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_id: Option<Id>,
    pub created_at: Timestamp,
}

/// One line of `activity.jsonl` (append-only).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MissionActivity {
    pub id: Id,
    pub kind: MissionActivityKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<JsonValue>)]
    pub metadata: Option<serde_json::Value>,
    pub created_at: Timestamp,
}

/// `reads.json`: last-read message id per reader (member id or `"human"`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MissionReads {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub last_read: BTreeMap<String, Id>,
}

/// Reader key for humans in `reads.json`.
pub const HUMAN_READER: &str = "human";

// ------------------------------------------------------------------ computed

/// Computed from the issues whose `missionId` is this mission.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MissionProgress {
    pub mission_id: Id,
    pub total: u32,
    /// Issue count per status (every status present, zeros included).
    pub by_status: BTreeMap<IssueStatus, u32>,
    pub active_members: u32,
    pub total_members: u32,
}

// ------------------------------------------------------------------ inputs

#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NewMission {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_id: Option<Id>,
    /// Copies the template's playbook into `config` unless `config` is given.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchestrator_mode: Option<MissionOrchestratorMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<MissionConfig>,
    /// Issue refs to put in the mission (same transaction).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub issue_refs: Vec<String>,
}

/// Patch: absent = unchanged; `null` = clear (clearable fields only).
#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MissionPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<MissionStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchestrator_mode: Option<MissionOrchestratorMode>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<Id>)]
    pub orchestrator_member_id: Option<Option<Id>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<Id>)]
    pub plan_id: Option<Option<Id>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<MissionConfig>,
}

/// A fully resolved member (see `NewMissionMember::from_definition`).
#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NewMissionMember {
    pub agent_definition_id: String,
    pub name: String,
    pub role: MissionAgentRole,
    pub provider_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
}

/// Add a member from an agent definition (commands / CLI resolve the definition).
#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MissionMemberAddInput {
    pub agent_definition_id: String,
    /// Default: the definition's name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Default: the definition's model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MissionMemberPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<MissionMemberStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<String>)]
    pub model: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<String>)]
    pub terminal_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<String>)]
    pub session_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<Id>)]
    pub assigned_issue_id: Option<Option<Id>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<String>)]
    pub system_prompt: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<String>)]
    pub worktree_path: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<String>)]
    pub branch_name: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<String>)]
    pub error: Option<Option<String>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NewMissionMessage {
    /// `None` = human.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_member_id: Option<Id>,
    /// `None` = broadcast.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_member_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<MissionMessageKind>,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_id: Option<Id>,
}

/// `messages` filter. `forMember` = messages to that member plus broadcasts.
#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MissionMessageQuery {
    /// Only messages after this message id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub for_member: Option<Id>,
    /// The newest `limit` messages (0/absent = all).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NewMissionActivity {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<MissionActivityKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<JsonValue>)]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NewMissionProposal {
    pub goal: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<MissionProposedAgent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_cost_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_minutes: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
}

/// `proposal_modify`: replaces the given fields and sets status `modified`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MissionProposalPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agents: Option<Vec<MissionProposedAgent>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<f64>)]
    pub estimated_cost_usd: Option<Option<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<u32>)]
    pub estimated_minutes: Option<Option<u32>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<String>)]
    pub rationale: Option<Option<String>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NewMissionMergeEntry {
    pub member_id: Id,
    pub branch_name: String,
    pub worktree_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MissionMergeEntryPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<MissionMergeStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<String>)]
    pub skip_reason: Option<Option<String>>,
}
