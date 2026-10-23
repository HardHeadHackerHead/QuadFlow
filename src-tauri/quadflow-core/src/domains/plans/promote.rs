//! Promotion of plan steps to issues (data-layer.md §6.4).
//!
//! One transaction per call: issues are created with `issues::create_in_tx`
//! (`source = {planId, stepId}`) before the plan is written, so a failure
//! midway leaves valid state (an issue whose step does not point at it yet; the
//! next promotion of that step creates another one — never a dangling link).
//!
//! Idempotent: a step whose `issueId` (or `epicId`) resolves returns that
//! entity and creates nothing. With `createEpics`, a step that has children
//! becomes an epic and its descendants' issues join it; without it, parent
//! steps become parent issues (`parentId`). With `createBlockers`, step
//! `dependsOn` becomes issue `blockedBy` (open issues only), in both directions:
//! promoting a dependency later adds it to already-promoted dependents.

use super::model::*;
use super::service::epic_status_for_step;
use crate::domains::issues::{
    self, CriterionInput, Epic, Issue, IssuePatch, IssueSource, IssueStatus, NewIssue, Priority,
};
use crate::error::{CoreError, ErrorCode, Result};
use crate::ids::{new_id, Id};
use crate::model::Actor;
use crate::store::{ProjectStore, Tx};
use crate::time::now_ms;

/// Promote one step (and, for structure, its not-yet-promoted ancestors).
pub fn promote_step(s: &ProjectStore, actor: &Actor, plan_id: &Id, step_id: &Id) -> Result<PlanPromotion> {
    s.write(actor, |tx| {
        let plan: Plan = tx.get(plan_id)?;
        if plan.step(step_id).is_none() {
            return Err(CoreError::not_found(format!("step {step_id} not found")));
        }
        promote_in_tx(tx, plan, &[step_id.clone()])
    })
}

/// Promote every non-skipped step, in plan order. Repeating it creates nothing
/// and returns the same issues.
pub fn promote_all(s: &ProjectStore, actor: &Actor, plan_id: &Id) -> Result<PlanPromotion> {
    s.write(actor, |tx| {
        let mut plan: Plan = tx.get(plan_id)?;
        plan.steps.sort_by_key(|st| st.order);
        let ids: Vec<Id> =
            plan.steps.iter().filter(|st| st.status != PlanStepStatus::Skipped).map(|st| st.id.clone()).collect();
        promote_in_tx(tx, plan, &ids)
    })
}

struct Ctx {
    profile: PromotionProfile,
    plan: Plan,
    issues: Vec<Issue>,
    epics: Vec<Epic>,
    created: u32,
    changed: bool,
}

fn promote_in_tx(tx: &mut Tx, plan: Plan, ids: &[Id]) -> Result<PlanPromotion> {
    let mut c = Ctx {
        profile: plan.promotion_profile.clone().unwrap_or_default(),
        plan,
        issues: Vec::new(),
        epics: Vec::new(),
        created: 0,
        changed: false,
    };
    let mut out_issues: Vec<Id> = Vec::new();
    let mut out_epics: Vec<Id> = Vec::new();
    for id in ids {
        match ensure(tx, &mut c, id, 0)? {
            Linked::Issue(i) => {
                if !out_issues.contains(&i) {
                    out_issues.push(i)
                }
            }
            Linked::Epic(e) => {
                if !out_epics.contains(&e) {
                    out_epics.push(e)
                }
            }
        }
    }
    if c.changed {
        c.plan.updated_at = now_ms();
        tx.put(&c.plan)?;
    }
    let pick_issue = |id: &Id| c.issues.iter().rev().find(|i| &i.id == id).cloned();
    let issues = out_issues.iter().filter_map(pick_issue).collect();
    let epics = out_epics.iter().filter_map(|id| c.epics.iter().rev().find(|e| &e.id == id).cloned()).collect();
    Ok(PlanPromotion { plan: c.plan, issues, epics, created: c.created })
}

enum Linked {
    Issue(Id),
    Epic(Id),
}

fn ensure(tx: &mut Tx, c: &mut Ctx, step_id: &Id, depth: u32) -> Result<Linked> {
    if depth > 100 {
        return Err(CoreError::invalid_input("step hierarchy is too deep"));
    }
    let step = c.plan.step(step_id).cloned().ok_or_else(|| CoreError::not_found(format!("step {step_id} not found")))?;
    if c.profile.create_epics && c.plan.has_children(step_id) {
        return ensure_epic(tx, c, &step).map(Linked::Epic);
    }
    ensure_issue(tx, c, &step, depth).map(Linked::Issue)
}

fn existing<T: crate::store::Entity>(tx: &Tx, id: Option<&Id>) -> Result<Option<T>> {
    match id {
        None => Ok(None),
        Some(id) => match tx.get::<T>(id) {
            Ok(v) => Ok(Some(v)),
            Err(e) if e.code == ErrorCode::NotFound => Ok(None),
            Err(e) => Err(e),
        },
    }
}

fn ensure_epic(tx: &mut Tx, c: &mut Ctx, step: &PlanStep) -> Result<Id> {
    if let Some(e) = existing::<Epic>(tx, step.epic_id.as_ref())? {
        let id = e.id.clone();
        c.epics.push(e);
        return Ok(id);
    }
    let labels = issues::service::clean_labels(&labels_for(&c.profile, step)?)?;
    issues::labels::ensure_labels_in_tx(tx, &labels)?;
    let now = now_ms();
    let epic = Epic {
        id: new_id(),
        title: step.title.clone(),
        description: step.description.clone(),
        status: epic_status_for_step(step.status),
        priority: priority_for(&c.profile, step),
        labels,
        created_at: now,
        created_by: tx.actor().clone(),
        updated_at: now,
        ext: Default::default(),
    };
    tx.put(&epic)?;
    let id = epic.id.clone();
    let st = c.plan.step_mut(&step.id).expect("step exists");
    st.epic_id = Some(id.clone());
    st.updated_at = now;
    c.epics.push(epic);
    c.created += 1;
    c.changed = true;
    Ok(id)
}

fn ensure_issue(tx: &mut Tx, c: &mut Ctx, step: &PlanStep, depth: u32) -> Result<Id> {
    if let Some(i) = existing::<Issue>(tx, step.issue_id.as_ref())? {
        let id = i.id.clone();
        c.issues.push(i);
        return Ok(id);
    }
    // Structure: the nearest ancestor epic (createEpics) or the parent issue.
    let mut epic_id = None;
    let mut parent_issue = None;
    if let Some(parent) = &step.parent_id {
        match ensure(tx, c, parent, depth + 1)? {
            Linked::Epic(e) => epic_id = Some(e),
            Linked::Issue(i) => {
                parent_issue = Some(i.clone());
                epic_id = tx.get::<Issue>(&i)?.epic_id;
            }
        }
    }
    let blocked_by = if c.profile.create_blockers { open_issues_of(tx, &c.plan, &step.depends_on)? } else { Vec::new() };
    let status = match step.status {
        PlanStepStatus::Completed => IssueStatus::Done,
        PlanStepStatus::InProgress => IssueStatus::InProgress,
        PlanStepStatus::Pending | PlanStepStatus::Skipped => IssueStatus::Todo,
    };
    let new = NewIssue {
        title: step.title.clone(),
        body: Some(body_for(&c.plan, &c.profile, step)),
        status: Some(status),
        priority: Some(priority_for(&c.profile, step)),
        labels: labels_for(&c.profile, step)?,
        epic_id,
        parent_id: parent_issue,
        blocked_by,
        depends_on: Vec::new(),
        user_story: None,
        acceptance_criteria: if c.profile.include_acceptance_criteria {
            step.acceptance_criteria.iter().map(|t| CriterionInput::from(t.as_str())).collect()
        } else {
            Vec::new()
        },
        source: Some(IssueSource { idea_id: c.plan.idea_id.clone(), plan_id: Some(c.plan.id.clone()), step_id: Some(step.id.clone()) }),
        mission_id: None,
    };
    let issue = issues::create_in_tx(tx, new)?;
    let id = issue.id.clone();
    let now = now_ms();
    let st = c.plan.step_mut(&step.id).expect("step exists");
    st.issue_id = Some(id.clone());
    st.updated_at = now;
    c.issues.push(issue);
    c.created += 1;
    c.changed = true;

    // Reverse blockers: already-promoted dependents of this step.
    if c.profile.create_blockers && status != IssueStatus::Done {
        let dependents: Vec<Id> = c
            .plan
            .steps
            .iter()
            .filter(|t| t.depends_on.contains(&step.id))
            .filter_map(|t| t.issue_id.clone())
            .collect();
        for dep_issue in dependents {
            let Some(other) = existing::<Issue>(tx, Some(&dep_issue))? else { continue };
            if other.blocked_by.contains(&id) || other.status == IssueStatus::Done {
                continue;
            }
            let mut blocked_by = other.blocked_by.clone();
            blocked_by.push(id.clone());
            let updated = issues::update_in_tx(tx, &dep_issue, IssuePatch { blocked_by: Some(blocked_by), ..Default::default() })?;
            c.issues.push(updated);
        }
    }
    Ok(id)
}

/// Issues of `deps` that exist and are not done.
fn open_issues_of(tx: &Tx, plan: &Plan, deps: &[Id]) -> Result<Vec<Id>> {
    let mut out = Vec::new();
    for d in deps {
        let Some(step) = plan.step(d) else { continue };
        if let Some(i) = existing::<Issue>(tx, step.issue_id.as_ref())? {
            if i.status != IssueStatus::Done && !out.contains(&i.id) {
                out.push(i.id);
            }
        }
    }
    Ok(out)
}

fn labels_for(p: &PromotionProfile, step: &PlanStep) -> Result<Vec<String>> {
    let base: Vec<String> = match p.label_strategy {
        PlanLabelStrategy::None => Vec::new(),
        PlanLabelStrategy::Custom => p.custom_labels.clone(),
        PlanLabelStrategy::Auto => {
            let mut v = vec!["plan".to_string()];
            if let Some(k) = step.kind {
                v.push(k.as_str().to_string());
            }
            v
        }
    };
    let prefix = p.label_prefix.as_deref().unwrap_or("");
    base.into_iter()
        .map(|l| issues::labels::validate_label_name(&format!("{prefix}{l}")))
        .collect()
}

fn priority_for(p: &PromotionProfile, step: &PlanStep) -> Priority {
    match (p.priority_strategy, step.effort) {
        (PlanPriorityStrategy::Auto, Some(PlanStepEffort::High)) => Priority::High,
        (PlanPriorityStrategy::Auto, Some(PlanStepEffort::Medium)) => Priority::Medium,
        (PlanPriorityStrategy::Auto, Some(PlanStepEffort::Low)) => Priority::Low,
        _ => p.default_priority,
    }
}

/// Markdown issue body with the step's context. Acceptance criteria go into the
/// issue's structured criteria, not the body.
fn body_for(plan: &Plan, p: &PromotionProfile, step: &PlanStep) -> String {
    let mut b = format!("**Source:** Plan: {}, Step #{}: {}\n\n", plan.title, step.order + 1, step.title);
    if let Some(d) = &step.description {
        b.push_str(&format!("## Description\n{d}\n\n"));
    }
    if !step.target_files.is_empty() {
        b.push_str("## Target Files\n");
        for f in &step.target_files {
            b.push_str(&format!("- `{f}`\n"));
        }
        b.push('\n');
    }
    if let Some(cc) = &step.code_context {
        b.push_str(&format!("## Code Context\n```\n{cc}\n```\n\n"));
    }
    if !plan.decisions.is_empty() {
        b.push_str("## Architectural Decisions\n");
        for d in &plan.decisions {
            b.push_str(&format!("- **{}**: {}\n", d.decision, d.rationale));
        }
        b.push('\n');
    }
    if p.include_verification {
        if let Some(v) = &step.verification {
            b.push_str(&format!("## Verification\n- Method: {}\n", v.method));
            if let Some(pat) = &v.pattern {
                b.push_str(&format!("- Pattern: `{pat}`\n"));
            }
            if let Some(cmd) = &v.command {
                b.push_str(&format!("- Command: `{cmd}`\n"));
            }
            b.push('\n');
        }
    }
    b.trim_end().to_string()
}
