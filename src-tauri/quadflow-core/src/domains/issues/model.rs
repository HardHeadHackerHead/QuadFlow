//! Issue, epic and label schemas (data-layer.md §6.3).
//!
//! `state` does not exist: an issue is closed iff `status == done`.

use crate::events::Domain;
use crate::ids::Id;
use crate::model::{Actor, Ext, Timestamp};
use crate::store::{Entity, Singleton};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

// ------------------------------------------------------------------ enums

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum IssueStatus {
    Backlog,
    Todo,
    InProgress,
    Qa,
    Done,
    Blocked,
    NeedsHuman,
}

impl IssueStatus {
    pub const ALL: [IssueStatus; 7] = [
        IssueStatus::Backlog,
        IssueStatus::Todo,
        IssueStatus::InProgress,
        IssueStatus::Qa,
        IssueStatus::Done,
        IssueStatus::Blocked,
        IssueStatus::NeedsHuman,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            IssueStatus::Backlog => "backlog",
            IssueStatus::Todo => "todo",
            IssueStatus::InProgress => "in_progress",
            IssueStatus::Qa => "qa",
            IssueStatus::Done => "done",
            IssueStatus::Blocked => "blocked",
            IssueStatus::NeedsHuman => "needs_human",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum Priority {
    Low,
    #[default]
    Medium,
    High,
    Critical,
}

impl Priority {
    pub fn as_str(self) -> &'static str {
        match self {
            Priority::Low => "low",
            Priority::Medium => "medium",
            Priority::High => "high",
            Priority::Critical => "critical",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum EpicStatus {
    #[default]
    Open,
    InProgress,
    Done,
}

impl EpicStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            EpicStatus::Open => "open",
            EpicStatus::InProgress => "in_progress",
            EpicStatus::Done => "done",
        }
    }
}

// ------------------------------------------------------------------ issue

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub id: Id,
    /// Display number (§4.4); immutable. Format refs with `display_ref`.
    pub number: u64,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    pub status: IssueStatus,
    pub priority: Priority,
    /// Label names (`labels.json`), sorted.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epic_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocked_by: Vec<Id>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub depends_on: Vec<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_story: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub acceptance_criteria: Vec<Criterion>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<IssueSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mission_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignment: Option<Assignment>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub comments: Vec<IssueComment>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<StatusChange>,
    pub created_at: Timestamp,
    pub created_by: Actor,
    pub updated_at: Timestamp,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[specta(type = BTreeMap<String, crate::model::JsonValue>)]
    pub ext: Ext,
}

impl Entity for Issue {
    const DOMAIN: Domain = Domain::Issues;
    const DIR: &'static str = "issues";
    fn id(&self) -> &Id {
        &self.id
    }
}

impl Issue {
    pub fn is_closed(&self) -> bool {
        self.status == IssueStatus::Done
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Criterion {
    pub id: Id,
    pub text: String,
    #[serde(default)]
    pub checked: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IssueSource {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idea_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_id: Option<Id>,
}

impl IssueSource {
    pub fn is_empty(&self) -> bool {
        self.idea_id.is_none() && self.plan_id.is_none() && self.step_id.is_none()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Assignment {
    pub agent_label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    /// `^[A-Za-z0-9._:-]{1,128}$` (used in resume argv).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub assigned_at: Timestamp,
    pub last_heartbeat: Timestamp,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IssueComment {
    pub id: Id,
    pub body: String,
    pub created_at: Timestamp,
    pub created_by: Actor,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StatusChange {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<IssueStatus>,
    pub to: IssueStatus,
    pub at: Timestamp,
    pub by: Actor,
}

// ------------------------------------------------------------------ inputs

/// An acceptance criterion as supplied by a caller: keeps `id` when given
/// (edits), otherwise a fresh id is assigned.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CriterionInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<Id>,
    pub text: String,
    #[serde(default)]
    pub checked: bool,
}

impl From<&str> for CriterionInput {
    fn from(text: &str) -> Self {
        Self { id: None, text: text.to_string(), checked: false }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NewIssue {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// Default `todo`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<IssueStatus>,
    /// Default `medium`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epic_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocked_by: Vec<Id>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub depends_on: Vec<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_story: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub acceptance_criteria: Vec<CriterionInput>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<IssueSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mission_id: Option<Id>,
}

/// Patch: absent = unchanged; `null` = clear (clearable fields only).
#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IssuePatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<String>)]
    pub body: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<IssueStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<Id>)]
    pub epic_id: Option<Option<Id>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<Id>)]
    pub parent_id: Option<Option<Id>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_by: Option<Vec<Id>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depends_on: Option<Vec<Id>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<String>)]
    pub user_story: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acceptance_criteria: Option<Vec<CriterionInput>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<IssueSource>)]
    pub source: Option<Option<IssueSource>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<Id>)]
    pub mission_id: Option<Option<Id>>,
    /// Plugin extension data, merged per key: a key set to `null` is removed,
    /// keys not named are kept (e.g. the GitHub integration's `ext.github`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = Option<BTreeMap<String, crate::model::JsonValue>>)]
    pub ext: Option<BTreeMap<String, serde_json::Value>>,
}

/// Claim input (`claim`): who is taking the issue.
#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ClaimInput {
    pub agent_label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// List filter. Empty vectors mean "any". Results are sorted by priority
/// (critical first), then number.
#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IssueQuery {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub statuses: Vec<IssueStatus>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub priorities: Vec<Priority>,
    /// Issues carrying any of these labels.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epic_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mission_id: Option<Id>,
    /// Case-insensitive match on title, body and display ref.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Include `done` issues (ignored when `statuses` is non-empty).
    #[serde(default)]
    pub include_done: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

// ------------------------------------------------------------------ epics

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Epic {
    pub id: Id,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub status: EpicStatus,
    pub priority: Priority,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
    pub created_at: Timestamp,
    pub created_by: Actor,
    pub updated_at: Timestamp,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[specta(type = BTreeMap<String, crate::model::JsonValue>)]
    pub ext: Ext,
}

impl Entity for Epic {
    const DOMAIN: Domain = Domain::Epics;
    const DIR: &'static str = "epics";
    fn id(&self) -> &Id {
        &self.id
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NewEpic {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<EpicStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct EpicPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<String>)]
    pub description: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<EpicStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<String>>,
}

// ------------------------------------------------------------------ labels

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Labels {
    #[serde(default)]
    pub labels: Vec<Label>,
}

impl Singleton for Labels {
    const DOMAIN: Domain = Domain::Labels;
    const FILE: &'static str = "labels.json";
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Label {
    pub name: String,
    /// `#rrggbb`
    pub color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}
