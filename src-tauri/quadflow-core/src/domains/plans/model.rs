//! Plan schemas (data-layer.md §6.4). Type names carry a `Plan` prefix where the
//! doc's name is generic (specta exports everything into one TS namespace).

use crate::domains::issues::{Epic, Issue, Priority};
use crate::events::Domain;
use crate::ids::Id;
use crate::model::{Actor, Ext, Timestamp};
use crate::store::Entity;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

// ------------------------------------------------------------------ enums

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum PlanStatus {
    #[default]
    SpecDraft,
    SpecReview,
    Decomposing,
    ReviewSteps,
    Promoting,
    Executing,
    Completed,
}

impl PlanStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            PlanStatus::SpecDraft => "spec_draft",
            PlanStatus::SpecReview => "spec_review",
            PlanStatus::Decomposing => "decomposing",
            PlanStatus::ReviewSteps => "review_steps",
            PlanStatus::Promoting => "promoting",
            PlanStatus::Executing => "executing",
            PlanStatus::Completed => "completed",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum PlanSpecKind {
    Greenfield,
    #[default]
    Feature,
    Refactor,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum PlanStepStatus {
    #[default]
    Pending,
    InProgress,
    Completed,
    Skipped,
}

impl PlanStepStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            PlanStepStatus::Pending => "pending",
            PlanStepStatus::InProgress => "in_progress",
            PlanStepStatus::Completed => "completed",
            PlanStepStatus::Skipped => "skipped",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum PlanStepKind {
    Research,
    Design,
    Implement,
    Test,
    Verify,
    Document,
}

impl PlanStepKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PlanStepKind::Research => "research",
            PlanStepKind::Design => "design",
            PlanStepKind::Implement => "implement",
            PlanStepKind::Test => "test",
            PlanStepKind::Verify => "verify",
            PlanStepKind::Document => "document",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum PlanStepEffort {
    Low,
    Medium,
    High,
}

impl PlanStepEffort {
    pub fn as_str(self) -> &'static str {
        match self {
            PlanStepEffort::Low => "low",
            PlanStepEffort::Medium => "medium",
            PlanStepEffort::High => "high",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum PlanCommentKind {
    #[default]
    General,
    Review,
    Verification,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum PlanLabelStrategy {
    #[default]
    Auto,
    None,
    Custom,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum PlanPriorityStrategy {
    Uniform,
    #[default]
    Auto,
}

// ------------------------------------------------------------------ plan

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: Id,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub status: PlanStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idea_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discovery_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec: Option<PlanSpec>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub decisions: Vec<PlanDecision>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub risk_notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub promotion_profile: Option<PromotionProfile>,
    /// Sorted by `order`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub steps: Vec<PlanStep>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub comments: Vec<PlanComment>,
    pub created_at: Timestamp,
    pub created_by: Actor,
    pub updated_at: Timestamp,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[specta(type = BTreeMap<String, crate::model::JsonValue>)]
    pub ext: Ext,
}

impl Entity for Plan {
    const DOMAIN: Domain = Domain::Plans;
    const DIR: &'static str = "plans";
    fn id(&self) -> &Id {
        &self.id
    }
}

impl Plan {
    pub fn step(&self, id: &Id) -> Option<&PlanStep> {
        self.steps.iter().find(|s| &s.id == id)
    }

    pub fn step_mut(&mut self, id: &Id) -> Option<&mut PlanStep> {
        self.steps.iter_mut().find(|s| &s.id == id)
    }

    /// Whether `id` has child steps (an epic step).
    pub fn has_children(&self, id: &Id) -> bool {
        self.steps.iter().any(|s| s.parent_id.as_ref() == Some(id))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PlanSpec {
    pub content: String,
    #[serde(default)]
    pub kind: PlanSpecKind,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PlanDecision {
    pub decision: String,
    #[serde(default)]
    pub rationale: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PromotionProfile {
    /// Parent steps (steps with children) become epics; their children's
    /// issues join the epic.
    #[serde(default)]
    pub create_epics: bool,
    #[serde(default)]
    pub label_strategy: PlanLabelStrategy,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub custom_labels: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_prefix: Option<String>,
    /// Step `dependsOn` → issue `blockedBy`.
    #[serde(default)]
    pub create_blockers: bool,
    #[serde(default)]
    pub default_priority: Priority,
    #[serde(default)]
    pub priority_strategy: PlanPriorityStrategy,
    #[serde(default)]
    pub include_acceptance_criteria: bool,
    #[serde(default)]
    pub include_verification: bool,
}

impl Default for PromotionProfile {
    /// The defaults the Plans tool shows for a plan without a profile.
    fn default() -> Self {
        Self {
            create_epics: true,
            label_strategy: PlanLabelStrategy::Auto,
            custom_labels: Vec::new(),
            label_prefix: None,
            create_blockers: true,
            default_priority: Priority::Medium,
            priority_strategy: PlanPriorityStrategy::Auto,
            include_acceptance_criteria: true,
            include_verification: true,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub id: Id,
    pub order: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<Id>,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub status: PlanStepStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<PlanStepKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub acceptance_criteria: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub target_files: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code_context: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<PlanStepEffort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_hours: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual_hours: Option<f64>,
    /// Step ids of the same plan.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub depends_on: Vec<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification: Option<PlanStepVerification>,
    /// The issue this step was promoted to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_id: Option<Id>,
    /// The epic this (parent) step was promoted to (`createEpics`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epic_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<Timestamp>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PlanStepVerification {
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PlanComment {
    pub id: Id,
    pub body: String,
    #[serde(default)]
    pub kind: PlanCommentKind,
    pub created_at: Timestamp,
    pub created_by: Actor,
}

// ------------------------------------------------------------------ inputs

#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NewPlanStep {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Default `pending`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<PlanStepStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<PlanStepKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub acceptance_criteria: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub target_files: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code_context: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<PlanStepEffort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_hours: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub depends_on: Vec<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification: Option<PlanStepVerification>,
}

/// Patch: absent = unchanged; `null` = clear (clearable fields only).
#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PlanStepPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<String>)]
    pub description: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<PlanStepStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<Id>)]
    pub parent_id: Option<Option<Id>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<PlanStepKind>)]
    pub kind: Option<Option<PlanStepKind>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<String>)]
    pub notes: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acceptance_criteria: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_files: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<String>)]
    pub code_context: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<PlanStepEffort>)]
    pub effort: Option<Option<PlanStepEffort>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<f64>)]
    pub estimated_hours: Option<Option<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<f64>)]
    pub actual_hours: Option<Option<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depends_on: Option<Vec<Id>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<PlanStepVerification>)]
    pub verification: Option<Option<PlanStepVerification>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NewPlan {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Default: `decomposing` when `steps` is non-empty, else `spec_draft`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<PlanStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idea_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discovery_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec: Option<PlanSpec>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub decisions: Vec<PlanDecision>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub risk_notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub promotion_profile: Option<PromotionProfile>,
    /// Initial steps, in order (`parentId` / `dependsOn` cannot refer to them).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub steps: Vec<NewPlanStep>,
}

/// Patch: absent = unchanged; `null` = clear (clearable fields only).
#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PlanPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<String>)]
    pub description: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<PlanStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<Id>)]
    pub idea_id: Option<Option<Id>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<Id>)]
    pub discovery_id: Option<Option<Id>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<PlanSpec>)]
    pub spec: Option<Option<PlanSpec>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decisions: Option<Vec<PlanDecision>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<String>)]
    pub risk_notes: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<String>)]
    pub context: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<PromotionProfile>)]
    pub promotion_profile: Option<Option<PromotionProfile>>,
}

/// List filter. Empty / absent means "any". Sorted newest first.
#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PlanQuery {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub statuses: Vec<PlanStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idea_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discovery_id: Option<Id>,
    /// Case-insensitive match on title, description and spec content.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// Result of promoting steps: the updated plan plus every issue / epic the
/// promoted steps are linked to (already-promoted steps return their existing
/// issue, so a repeated promotion returns the same ids and creates nothing).
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PlanPromotion {
    pub plan: Plan,
    pub issues: Vec<Issue>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub epics: Vec<Epic>,
    /// How many issues and epics this call created.
    pub created: u32,
}
