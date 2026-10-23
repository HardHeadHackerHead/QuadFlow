//! Plan service (data-layer.md §6.4). Every mutation is one locked transaction.
//! Plans, their steps and comments live in one file (`plans/<id>.json`).
//!
//! Cross-domain effects run in the same transaction:
//! - promotion creates issues / epics through `issues::create_in_tx` and links
//!   them back to the step (`promote.rs`);
//! - an issue status change syncs its source step ([`sync_step_from_issue_in_tx`],
//!   called by `issues::apply_status_in_tx`), and a step status change syncs its
//!   issue (through `issues::set_status_in_tx`, which then finds the step
//!   already in sync — no ping-pong);
//! - every step change runs the plan auto-transition ([`auto_transition`]).

use super::model::*;
use crate::domains::issues::{self, Epic, EpicStatus, Issue, IssueStatus};
use crate::error::{CoreError, ErrorCode, Result};
use crate::ids::{new_id, Id};
use crate::model::{Actor, ListResult, Timestamp};
use crate::store::{ProjectStore, Tx};
use crate::time::now_ms;

const MAX_TITLE: usize = 500;

// ------------------------------------------------------------------ reads

/// Filtered, newest first.
pub fn list(s: &ProjectStore, q: &PlanQuery) -> Result<ListResult<Plan>> {
    let all = s.list::<Plan>()?;
    let text = q.text.as_deref().map(str::trim).filter(|t| !t.is_empty()).map(str::to_lowercase);
    let mut items: Vec<Plan> = all
        .items
        .into_iter()
        .filter(|p| q.statuses.is_empty() || q.statuses.contains(&p.status))
        .filter(|p| q.idea_id.as_ref().map_or(true, |i| p.idea_id.as_ref() == Some(i)))
        .filter(|p| q.discovery_id.as_ref().map_or(true, |d| p.discovery_id.as_ref() == Some(d)))
        .filter(|p| {
            text.as_ref().map_or(true, |t| {
                p.title.to_lowercase().contains(t)
                    || p.description.as_deref().is_some_and(|d| d.to_lowercase().contains(t))
                    || p.spec.as_ref().is_some_and(|s| s.content.to_lowercase().contains(t))
            })
        })
        .collect();
    items.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
    Ok(ListResult { items, errors: all.errors })
}

pub fn get(s: &ProjectStore, id: &Id) -> Result<Plan> {
    s.get(id)
}

/// The plan containing step `step_id` (steps are only addressed within a plan,
/// but the CLI accepts a bare step id).
pub fn find_step_plan(s: &ProjectStore, step_id: &Id) -> Result<Plan> {
    let all = s.list::<Plan>()?;
    all.items
        .into_iter()
        .find(|p| p.step(step_id).is_some())
        .ok_or_else(|| CoreError::not_found(format!("step {step_id} not found in any plan")))
}

// ----------------------------------------------------------------- writes

pub fn create(s: &ProjectStore, actor: &Actor, new: NewPlan) -> Result<Plan> {
    let title = clean_title(&new.title)?;
    s.write(actor, |tx| {
        let now = now_ms();
        let status = new.status.unwrap_or(if new.steps.is_empty() { PlanStatus::SpecDraft } else { PlanStatus::Decomposing });
        let mut plan = Plan {
            id: new_id(),
            title,
            description: clean_opt(new.description),
            status,
            idea_id: new.idea_id,
            discovery_id: new.discovery_id,
            spec: clean_spec(new.spec),
            decisions: clean_decisions(new.decisions),
            risk_notes: clean_opt(new.risk_notes),
            context: clean_opt(new.context),
            promotion_profile: new.promotion_profile.map(clean_profile).transpose()?,
            steps: Vec::new(),
            comments: Vec::new(),
            created_at: now,
            created_by: tx.actor().clone(),
            updated_at: now,
            ext: Default::default(),
        };
        for st in new.steps {
            if st.parent_id.is_some() || !st.depends_on.is_empty() {
                return Err(CoreError::invalid_input("initial steps cannot set parentId or dependsOn; add them afterwards"));
            }
            add_step(&mut plan, st, now)?;
        }
        tx.put(&plan)?;
        Ok(plan)
    })
}

pub fn update(s: &ProjectStore, actor: &Actor, id: &Id, patch: PlanPatch) -> Result<Plan> {
    let title = patch.title.as_deref().map(clean_title).transpose()?;
    let profile = match patch.promotion_profile {
        Some(Some(p)) => Some(Some(clean_profile(p)?)),
        other => other,
    };
    s.write(actor, |tx| {
        let mut plan: Plan = tx.get(id)?;
        if let Some(t) = title {
            plan.title = t;
        }
        if let Some(d) = patch.description {
            plan.description = clean_opt(d);
        }
        if let Some(st) = patch.status {
            plan.status = st;
        }
        if let Some(i) = patch.idea_id {
            plan.idea_id = i;
        }
        if let Some(d) = patch.discovery_id {
            plan.discovery_id = d;
        }
        if let Some(sp) = patch.spec {
            plan.spec = clean_spec(sp);
        }
        if let Some(d) = patch.decisions {
            plan.decisions = clean_decisions(d);
        }
        if let Some(r) = patch.risk_notes {
            plan.risk_notes = clean_opt(r);
        }
        if let Some(c) = patch.context {
            plan.context = clean_opt(c);
        }
        if let Some(p) = profile {
            plan.promotion_profile = p;
        }
        plan.updated_at = now_ms();
        tx.put(&plan)?;
        Ok(plan)
    })
}

/// Delete a plan. Issues promoted from it keep their `source` (it no longer
/// resolves; status sync ignores it).
pub fn delete(s: &ProjectStore, actor: &Actor, id: &Id) -> Result<()> {
    s.write(actor, |tx| tx.delete::<Plan>(id))
}

pub fn step_add(s: &ProjectStore, actor: &Actor, plan_id: &Id, new: NewPlanStep) -> Result<Plan> {
    s.write(actor, |tx| {
        let mut plan: Plan = tx.get(plan_id)?;
        let now = now_ms();
        add_step(&mut plan, new, now)?;
        auto_transition(&mut plan);
        plan.updated_at = now;
        tx.put(&plan)?;
        Ok(plan)
    })
}

pub fn step_update(s: &ProjectStore, actor: &Actor, plan_id: &Id, step_id: &Id, patch: PlanStepPatch) -> Result<Plan> {
    let title = patch.title.as_deref().map(clean_title).transpose()?;
    s.write(actor, |tx| {
        let mut plan: Plan = tx.get(plan_id)?;
        let now = now_ms();
        if !plan.steps.iter().any(|st| &st.id == step_id) {
            return Err(step_not_found(step_id));
        }
        if let Some(Some(p)) = &patch.parent_id {
            check_parent(&plan, step_id, p)?;
        }
        if let Some(d) = &patch.depends_on {
            check_deps(&plan, step_id, d)?;
        }
        let step = plan.step_mut(step_id).expect("checked above");
        if let Some(t) = title {
            step.title = t;
        }
        if let Some(d) = patch.description {
            step.description = clean_opt(d);
        }
        if let Some(p) = patch.parent_id {
            step.parent_id = p;
        }
        if let Some(k) = patch.kind {
            step.kind = k;
        }
        if let Some(n) = patch.notes {
            step.notes = clean_opt(n);
        }
        if let Some(ac) = patch.acceptance_criteria {
            step.acceptance_criteria = clean_list(ac);
        }
        if let Some(tf) = patch.target_files {
            step.target_files = clean_list(tf);
        }
        if let Some(c) = patch.code_context {
            step.code_context = clean_opt(c);
        }
        if let Some(e) = patch.effort {
            step.effort = e;
        }
        if let Some(h) = patch.estimated_hours {
            step.estimated_hours = check_hours(h)?;
        }
        if let Some(h) = patch.actual_hours {
            step.actual_hours = check_hours(h)?;
        }
        if let Some(d) = patch.depends_on {
            step.depends_on = dedup(d);
        }
        if let Some(v) = patch.verification {
            step.verification = clean_verification(v);
        }
        let status_changed = match patch.status {
            Some(st) if st != step.status => {
                set_step_status(step, st, now);
                true
            }
            _ => false,
        };
        step.updated_at = now;
        let linked = (step.issue_id.clone(), step.epic_id.clone(), step.status);
        auto_transition(&mut plan);
        plan.updated_at = now;
        tx.put(&plan)?;
        if status_changed {
            sync_links_from_step_in_tx(tx, linked.0.as_ref(), linked.1.as_ref(), linked.2, now)?;
            // The issue sync may have re-written the plan (it is already in
            // sync, so it does not) — return what is on disk.
            return tx.get(plan_id);
        }
        Ok(plan)
    })
}

/// Delete a step. Its children move up to its parent; other steps drop it
/// from `dependsOn`. A promoted issue is kept (its source no longer resolves).
pub fn step_delete(s: &ProjectStore, actor: &Actor, plan_id: &Id, step_id: &Id) -> Result<Plan> {
    s.write(actor, |tx| {
        let mut plan: Plan = tx.get(plan_id)?;
        let pos = plan.steps.iter().position(|st| &st.id == step_id).ok_or_else(|| step_not_found(step_id))?;
        let removed = plan.steps.remove(pos);
        let now = now_ms();
        for st in &mut plan.steps {
            let mut changed = false;
            if st.parent_id.as_ref() == Some(step_id) {
                st.parent_id = removed.parent_id.clone();
                changed = true;
            }
            if st.depends_on.contains(step_id) {
                st.depends_on.retain(|d| d != step_id);
                changed = true;
            }
            if changed {
                st.updated_at = now;
            }
        }
        renumber(&mut plan);
        auto_transition(&mut plan);
        plan.updated_at = now;
        tx.put(&plan)?;
        Ok(plan)
    })
}

/// Reorder steps: `ids` (unique, existing) come first in the given order; steps
/// not listed keep their relative order after them.
pub fn steps_reorder(s: &ProjectStore, actor: &Actor, plan_id: &Id, ids: &[Id]) -> Result<Plan> {
    s.write(actor, |tx| {
        let mut plan: Plan = tx.get(plan_id)?;
        let mut seen: Vec<&Id> = Vec::new();
        for id in ids {
            if plan.step(id).is_none() {
                return Err(step_not_found(id));
            }
            if seen.contains(&id) {
                return Err(CoreError::invalid_input(format!("step {id} listed twice")));
            }
            seen.push(id);
        }
        let now = now_ms();
        let mut rest = std::mem::take(&mut plan.steps);
        let mut ordered: Vec<PlanStep> = Vec::with_capacity(rest.len());
        for id in ids {
            let pos = rest.iter().position(|st| &st.id == id).expect("checked above");
            ordered.push(rest.remove(pos));
        }
        ordered.extend(rest);
        for (i, st) in ordered.iter_mut().enumerate() {
            if st.order != i as u32 {
                st.order = i as u32;
                st.updated_at = now;
            }
        }
        plan.steps = ordered;
        plan.updated_at = now;
        tx.put(&plan)?;
        Ok(plan)
    })
}

pub fn comment_add(s: &ProjectStore, actor: &Actor, plan_id: &Id, body: &str, kind: PlanCommentKind) -> Result<Plan> {
    let body = body.trim();
    if body.is_empty() {
        return Err(CoreError::invalid_input("comment body must not be empty"));
    }
    s.write(actor, |tx| {
        let mut plan: Plan = tx.get(plan_id)?;
        let now = now_ms();
        plan.comments.push(PlanComment { id: new_id(), body: body.to_string(), kind, created_at: now, created_by: tx.actor().clone() });
        plan.updated_at = now;
        tx.put(&plan)?;
        Ok(plan)
    })
}

pub fn comment_delete(s: &ProjectStore, actor: &Actor, plan_id: &Id, comment_id: &Id) -> Result<Plan> {
    s.write(actor, |tx| {
        let mut plan: Plan = tx.get(plan_id)?;
        let before = plan.comments.len();
        plan.comments.retain(|c| &c.id != comment_id);
        if plan.comments.len() == before {
            return Err(CoreError::not_found(format!("comment {comment_id} not found")));
        }
        plan.updated_at = now_ms();
        tx.put(&plan)?;
        Ok(plan)
    })
}

// ------------------------------------------------------------ status sync

/// Step status for an issue status (§6.3 invariant 3).
pub fn step_status_for_issue(s: IssueStatus) -> PlanStepStatus {
    match s {
        IssueStatus::Done => PlanStepStatus::Completed,
        IssueStatus::InProgress | IssueStatus::Qa => PlanStepStatus::InProgress,
        _ => PlanStepStatus::Pending,
    }
}

/// Issue status for a step status (`skipped` → none: the issue is left alone).
pub fn issue_status_for_step(s: PlanStepStatus) -> Option<IssueStatus> {
    match s {
        PlanStepStatus::Pending => Some(IssueStatus::Todo),
        PlanStepStatus::InProgress => Some(IssueStatus::InProgress),
        PlanStepStatus::Completed => Some(IssueStatus::Done),
        PlanStepStatus::Skipped => None,
    }
}

pub fn epic_status_for_step(s: PlanStepStatus) -> EpicStatus {
    match s {
        PlanStepStatus::InProgress => EpicStatus::InProgress,
        PlanStepStatus::Completed => EpicStatus::Done,
        PlanStepStatus::Pending | PlanStepStatus::Skipped => EpicStatus::Open,
    }
}

/// Called by `issues::apply_status_in_tx` after an issue's status changed:
/// moves the source step (`source.planId` + `source.stepId`) to the matching
/// status and runs the plan auto-transition, in the issue's transaction. A
/// source that no longer resolves (plan or step deleted, step re-promoted to
/// another issue) is ignored.
pub fn sync_step_from_issue_in_tx(tx: &mut Tx, issue: &Issue) -> Result<()> {
    let Some(src) = &issue.source else { return Ok(()) };
    let (Some(plan_id), Some(step_id)) = (&src.plan_id, &src.step_id) else { return Ok(()) };
    let mut plan: Plan = match tx.get(plan_id) {
        Ok(p) => p,
        Err(e) if e.code == ErrorCode::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    let now = now_ms();
    let target = step_status_for_issue(issue.status);
    let Some(step) = plan.step_mut(step_id) else { return Ok(()) };
    if step.issue_id.as_ref().is_some_and(|i| i != &issue.id) || step.status == target {
        return Ok(());
    }
    set_step_status(step, target, now);
    step.updated_at = now;
    if step.issue_id.is_none() {
        step.issue_id = Some(issue.id.clone());
    }
    auto_transition(&mut plan);
    plan.updated_at = now;
    tx.put(&plan)
}

/// Called by `issues::delete`: unlink the deleted issue from its source step so
/// the step can be promoted again.
pub fn unlink_issue_in_tx(tx: &mut Tx, issue: &Issue) -> Result<()> {
    let Some(src) = &issue.source else { return Ok(()) };
    let (Some(plan_id), Some(step_id)) = (&src.plan_id, &src.step_id) else { return Ok(()) };
    let mut plan: Plan = match tx.get(plan_id) {
        Ok(p) => p,
        Err(e) if e.code == ErrorCode::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    let now = now_ms();
    let Some(step) = plan.step_mut(step_id) else { return Ok(()) };
    if step.issue_id.as_ref() != Some(&issue.id) {
        return Ok(());
    }
    step.issue_id = None;
    step.updated_at = now;
    plan.updated_at = now;
    tx.put(&plan)
}

/// Step status changed → move its issue (unless the issue already maps to that
/// step status, e.g. `qa` for `in_progress`) and its epic.
fn sync_links_from_step_in_tx(tx: &mut Tx, issue_id: Option<&Id>, epic_id: Option<&Id>, status: PlanStepStatus, now: Timestamp) -> Result<()> {
    if let (Some(id), Some(to)) = (issue_id, issue_status_for_step(status)) {
        match tx.get::<Issue>(id) {
            Ok(issue) => {
                if step_status_for_issue(issue.status) != status {
                    issues::set_status_in_tx(tx, id, to)?;
                }
            }
            Err(e) if e.code == ErrorCode::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    if let Some(id) = epic_id {
        match tx.get::<Epic>(id) {
            Ok(mut epic) => {
                let to = epic_status_for_step(status);
                if epic.status != to {
                    epic.status = to;
                    epic.updated_at = now;
                    tx.put(&epic)?;
                }
            }
            Err(e) if e.code == ErrorCode::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// Plan auto-transition (§6.4): all non-skipped steps `completed` (and at least
/// one) → `completed`; any step `in_progress` while `review_steps|promoting` →
/// `executing`; a `completed` plan whose steps are no longer all done goes back
/// to `executing`.
pub fn auto_transition(plan: &mut Plan) {
    let active: Vec<&PlanStep> = plan.steps.iter().filter(|s| s.status != PlanStepStatus::Skipped).collect();
    let all_done = !active.is_empty() && active.iter().all(|s| s.status == PlanStepStatus::Completed);
    let any_in_progress = active.iter().any(|s| s.status == PlanStepStatus::InProgress);
    if all_done {
        plan.status = PlanStatus::Completed;
    } else if plan.status == PlanStatus::Completed {
        plan.status = PlanStatus::Executing;
    } else if any_in_progress && matches!(plan.status, PlanStatus::ReviewSteps | PlanStatus::Promoting) {
        plan.status = PlanStatus::Executing;
    }
}

pub(super) fn set_step_status(step: &mut PlanStep, to: PlanStepStatus, now: Timestamp) {
    step.status = to;
    match to {
        PlanStepStatus::InProgress => {
            step.started_at.get_or_insert(now);
            step.completed_at = None;
        }
        PlanStepStatus::Completed => {
            step.started_at.get_or_insert(now);
            step.completed_at = Some(now);
        }
        PlanStepStatus::Pending | PlanStepStatus::Skipped => step.completed_at = None,
    }
}

// ---------------------------------------------------------------- helpers

fn add_step(plan: &mut Plan, new: NewPlanStep, now: Timestamp) -> Result<Id> {
    let title = clean_title(&new.title)?;
    let id = new_id();
    if let Some(p) = &new.parent_id {
        check_parent(plan, &id, p)?;
    }
    check_deps(plan, &id, &new.depends_on)?;
    let mut step = PlanStep {
        id: id.clone(),
        order: plan.steps.iter().map(|s| s.order + 1).max().unwrap_or(0),
        parent_id: new.parent_id,
        title,
        description: clean_opt(new.description),
        status: PlanStepStatus::Pending,
        kind: new.kind,
        notes: clean_opt(new.notes),
        acceptance_criteria: clean_list(new.acceptance_criteria),
        target_files: clean_list(new.target_files),
        code_context: clean_opt(new.code_context),
        effort: new.effort,
        estimated_hours: check_hours(new.estimated_hours)?,
        actual_hours: None,
        depends_on: dedup(new.depends_on),
        verification: clean_verification(new.verification),
        issue_id: None,
        epic_id: None,
        started_at: None,
        completed_at: None,
        created_at: now,
        updated_at: now,
    };
    if let Some(st) = new.status {
        set_step_status(&mut step, st, now);
    }
    plan.steps.push(step);
    Ok(id)
}

fn renumber(plan: &mut Plan) {
    plan.steps.sort_by_key(|s| s.order);
    for (i, s) in plan.steps.iter_mut().enumerate() {
        s.order = i as u32;
    }
}

fn step_not_found(id: &Id) -> CoreError {
    CoreError::not_found(format!("step {id} not found"))
}

fn check_parent(plan: &Plan, self_id: &Id, parent: &Id) -> Result<()> {
    let mut cur = parent.clone();
    for _ in 0..1000 {
        if &cur == self_id {
            return Err(CoreError::invalid_input("a step cannot be its own ancestor"));
        }
        let p = plan.step(&cur).ok_or_else(|| CoreError::invalid_input(format!("parent step {cur} is not in this plan")))?;
        match &p.parent_id {
            Some(next) => cur = next.clone(),
            None => return Ok(()),
        }
    }
    Err(CoreError::invalid_input("parent chain is too deep"))
}

fn check_deps(plan: &Plan, self_id: &Id, deps: &[Id]) -> Result<()> {
    for d in deps {
        if d == self_id {
            return Err(CoreError::invalid_input("a step cannot depend on itself"));
        }
        if plan.step(d).is_none() {
            return Err(CoreError::invalid_input(format!("dependsOn step {d} is not in this plan")));
        }
    }
    Ok(())
}

fn clean_title(t: &str) -> Result<String> {
    let t = t.trim();
    if t.is_empty() {
        return Err(CoreError::invalid_input("title must not be empty"));
    }
    if t.chars().count() > MAX_TITLE {
        return Err(CoreError::invalid_input(format!("title is longer than {MAX_TITLE} characters")));
    }
    Ok(t.to_string())
}

fn clean_opt(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn clean_list(v: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for s in v {
        let s = s.trim().to_string();
        if !s.is_empty() && !out.contains(&s) {
            out.push(s);
        }
    }
    out
}

fn dedup(v: Vec<Id>) -> Vec<Id> {
    let mut out: Vec<Id> = Vec::new();
    for id in v {
        if !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

/// A spec may have empty content (the kind is chosen before the text is written).
fn clean_spec(s: Option<PlanSpec>) -> Option<PlanSpec> {
    s
}

fn clean_decisions(v: Vec<PlanDecision>) -> Vec<PlanDecision> {
    v.into_iter()
        .filter(|d| !d.decision.trim().is_empty())
        .map(|d| PlanDecision { decision: d.decision.trim().to_string(), rationale: d.rationale.trim().to_string() })
        .collect()
}

fn clean_verification(v: Option<PlanStepVerification>) -> Option<PlanStepVerification> {
    v.filter(|v| !v.method.trim().is_empty()).map(|v| PlanStepVerification {
        method: v.method.trim().to_string(),
        pattern: clean_opt(v.pattern),
        command: clean_opt(v.command),
    })
}

fn clean_profile(mut p: PromotionProfile) -> Result<PromotionProfile> {
    p.custom_labels = clean_list(p.custom_labels);
    for l in &p.custom_labels {
        issues::labels::validate_label_name(l)?;
    }
    p.label_prefix = clean_opt(p.label_prefix);
    Ok(p)
}

fn check_hours(h: Option<f64>) -> Result<Option<f64>> {
    match h {
        Some(v) if !v.is_finite() || v < 0.0 => Err(CoreError::invalid_input("hours must be a non-negative number")),
        other => Ok(other),
    }
}
