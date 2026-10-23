//! `quadflow plans …` (data-layer.md §6.4, §11). Thin layer over
//! `domains::plans`: parses arguments (status/kind aliases live only here),
//! prints the JSON envelope or human output.

use super::output::Out;
use super::Ctx;
use crate::domains::issues::{self, Issue};
use crate::domains::plans::{
    self as svc, NewPlan, NewPlanStep, Plan, PlanCommentKind, PlanDecision, PlanPatch, PlanPromotion, PlanQuery, PlanSpec,
    PlanSpecKind, PlanStatus, PlanStepEffort, PlanStepKind, PlanStepPatch, PlanStepStatus, PlanStepVerification,
};
use crate::domains::project_config;
use crate::error::{CoreError, Result};
use crate::ids::Id;
use crate::store::ProjectStore;
use clap::{Args, Subcommand};
use std::io::Write;

// ------------------------------------------------------------------ parsing

fn norm(s: &str) -> String {
    s.trim().to_ascii_lowercase().replace(['-', ' '], "_")
}

pub fn parse_plan_status(s: &str) -> std::result::Result<PlanStatus, String> {
    Ok(match norm(s).as_str() {
        "spec_draft" | "draft" => PlanStatus::SpecDraft,
        "spec_review" => PlanStatus::SpecReview,
        "decomposing" => PlanStatus::Decomposing,
        "review_steps" | "ready" | "approved" => PlanStatus::ReviewSteps,
        "promoting" => PlanStatus::Promoting,
        "executing" | "in_progress" => PlanStatus::Executing,
        "completed" | "done" => PlanStatus::Completed,
        _ => {
            return Err(format!(
                "invalid plan status {s:?}; expected spec_draft, spec_review, decomposing, review_steps, promoting, executing or completed"
            ))
        }
    })
}

pub fn parse_step_status(s: &str) -> std::result::Result<PlanStepStatus, String> {
    Ok(match norm(s).as_str() {
        "pending" | "todo" => PlanStepStatus::Pending,
        "in_progress" | "inprogress" | "doing" => PlanStepStatus::InProgress,
        "completed" | "complete" | "done" => PlanStepStatus::Completed,
        "skipped" | "skip" => PlanStepStatus::Skipped,
        _ => return Err(format!("invalid step status {s:?}; expected pending, in_progress, completed or skipped")),
    })
}

pub fn parse_step_kind(s: &str) -> std::result::Result<PlanStepKind, String> {
    Ok(match norm(s).as_str() {
        "research" => PlanStepKind::Research,
        "design" => PlanStepKind::Design,
        "implement" | "implementation" => PlanStepKind::Implement,
        "test" | "testing" => PlanStepKind::Test,
        "verify" | "verification" => PlanStepKind::Verify,
        "document" | "docs" | "documentation" => PlanStepKind::Document,
        _ => return Err(format!("invalid step kind {s:?}; expected research, design, implement, test, verify or document")),
    })
}

pub fn parse_effort(s: &str) -> std::result::Result<PlanStepEffort, String> {
    Ok(match norm(s).as_str() {
        "low" | "small" => PlanStepEffort::Low,
        "medium" | "med" => PlanStepEffort::Medium,
        "high" | "large" => PlanStepEffort::High,
        _ => return Err(format!("invalid effort {s:?}; expected low, medium or high")),
    })
}

pub fn parse_spec_kind(s: &str) -> std::result::Result<PlanSpecKind, String> {
    Ok(match norm(s).as_str() {
        "greenfield" => PlanSpecKind::Greenfield,
        "feature" => PlanSpecKind::Feature,
        "refactor" => PlanSpecKind::Refactor,
        _ => return Err(format!("invalid spec kind {s:?}; expected greenfield, feature or refactor")),
    })
}

pub fn parse_comment_kind(s: &str) -> std::result::Result<PlanCommentKind, String> {
    Ok(match norm(s).as_str() {
        "general" | "note" => PlanCommentKind::General,
        "review" => PlanCommentKind::Review,
        "verification" | "verify" => PlanCommentKind::Verification,
        _ => return Err(format!("invalid comment kind {s:?}; expected general, review or verification")),
    })
}

fn parse_id(s: &str) -> std::result::Result<Id, String> {
    Id::parse(s).map_err(|e| e.message)
}

fn split_list(s: &str) -> Vec<String> {
    s.split(',').map(str::trim).filter(|x| !x.is_empty()).map(str::to_string).collect()
}

fn split_ids(s: &str) -> Result<Vec<Id>> {
    split_list(s).iter().map(|x| Id::parse(x)).collect()
}

/// `""` (or `none` / `null`) clears.
fn clearable(v: &str) -> Option<&str> {
    let t = v.trim();
    if t.is_empty() || t.eq_ignore_ascii_case("none") || t.eq_ignore_ascii_case("null") {
        None
    } else {
        Some(t)
    }
}

fn opt_text(v: Option<String>) -> Option<Option<String>> {
    v.map(|s| clearable(&s).map(|_| s.trim().to_string()))
}

fn opt_parse<T>(v: Option<String>, f: fn(&str) -> std::result::Result<T, String>) -> Result<Option<Option<T>>> {
    match v {
        None => Ok(None),
        Some(s) => Ok(Some(clearable(&s).map(f).transpose().map_err(CoreError::invalid_input)?)),
    }
}

/// `"decision: rationale"` (rationale optional).
fn parse_decision(s: &str) -> PlanDecision {
    match s.split_once(':') {
        Some((d, r)) => PlanDecision { decision: d.trim().to_string(), rationale: r.trim().to_string() },
        None => PlanDecision { decision: s.trim().to_string(), rationale: String::new() },
    }
}

// --------------------------------------------------------------------- args

#[derive(Subcommand, Debug)]
pub enum PlansAction {
    /// List plans, newest first.
    List(ListArgs),
    /// Show one plan with its steps.
    Get(PlanIdArg),
    /// Create a plan.
    Create(CreateArgs),
    /// Update fields; anything not passed is unchanged. Pass "" (or "none") to clear.
    Update(UpdateArgs),
    /// Delete a plan (promoted issues are kept).
    Delete(PlanIdArg),
    /// Add a step to a plan.
    StepAdd(StepAddArgs),
    /// Update a step (by step id; --plan is optional). "" clears.
    StepUpdate(StepUpdateArgs),
    /// Delete a step (children move up; dependents drop it).
    StepDelete(StepRefArgs),
    /// Reorder steps: listed ids first, in order.
    StepsReorder(ReorderArgs),
    /// Add a comment to a plan.
    Comment(CommentArgs),
    /// List a plan's comments.
    Comments(PlanIdArg),
    /// Delete a comment.
    CommentDelete(CommentDeleteArgs),
    /// Promote a plan's steps to issues (all non-skipped steps, or one with --step). Idempotent.
    Promote(PromoteArgs),
}

#[derive(Args, Debug)]
pub struct PlanIdArg {
    /// Plan id.
    #[arg(value_parser = parse_id)]
    id: Id,
}

#[derive(Args, Debug)]
pub struct ListArgs {
    /// Comma-separated statuses.
    #[arg(long)]
    status: Option<String>,
    /// Only plans created from this idea.
    #[arg(long, alias = "idea-id", value_parser = parse_id)]
    idea: Option<Id>,
    /// Only plans linked to this discovery project.
    #[arg(long, value_parser = parse_id)]
    discovery: Option<Id>,
    /// Text search over title, description and spec.
    #[arg(long)]
    search: Option<String>,
}

#[derive(Args, Debug)]
pub struct CreateArgs {
    /// Title (or --title).
    title: Option<String>,
    #[arg(long = "title", hide = true)]
    title_flag: Option<String>,
    #[arg(long)]
    description: Option<String>,
    /// Initial status (default spec_draft).
    #[arg(long, value_parser = parse_plan_status)]
    status: Option<PlanStatus>,
    #[arg(long, alias = "idea-id", value_parser = parse_id)]
    idea: Option<Id>,
    #[arg(long, value_parser = parse_id)]
    discovery: Option<Id>,
    #[arg(long)]
    risk_notes: Option<String>,
    #[arg(long)]
    context: Option<String>,
    /// Spec document (markdown).
    #[arg(long, alias = "spec")]
    spec_content: Option<String>,
    /// greenfield | feature | refactor (default feature).
    #[arg(long, alias = "spec-type", value_parser = parse_spec_kind)]
    spec_kind: Option<PlanSpecKind>,
    /// Architectural decision "decision: rationale" (repeatable).
    #[arg(long = "decision")]
    decisions: Vec<String>,
}

#[derive(Args, Debug)]
pub struct UpdateArgs {
    #[arg(value_parser = parse_id)]
    id: Id,
    #[arg(long)]
    title: Option<String>,
    #[arg(long)]
    description: Option<String>,
    #[arg(long, value_parser = parse_plan_status)]
    status: Option<PlanStatus>,
    /// Idea id; "none" clears.
    #[arg(long, alias = "idea-id")]
    idea: Option<String>,
    /// Discovery id; "none" clears.
    #[arg(long)]
    discovery: Option<String>,
    #[arg(long)]
    risk_notes: Option<String>,
    #[arg(long)]
    context: Option<String>,
    /// Spec content; "" clears the spec.
    #[arg(long, alias = "spec")]
    spec_content: Option<String>,
    #[arg(long, alias = "spec-type", value_parser = parse_spec_kind)]
    spec_kind: Option<PlanSpecKind>,
    /// Replace decisions ("decision: rationale", repeatable).
    #[arg(long = "decision")]
    decisions: Vec<String>,
    /// Remove all decisions.
    #[arg(long, conflicts_with = "decisions")]
    clear_decisions: bool,
}

#[derive(Args, Debug)]
pub struct StepFields {
    #[arg(long)]
    description: Option<String>,
    /// research | design | implement | test | verify | document
    #[arg(long, alias = "step-type")]
    kind: Option<String>,
    /// low | medium | high
    #[arg(long, alias = "estimated-effort")]
    effort: Option<String>,
    /// Comma-separated target files.
    #[arg(long)]
    target_files: Option<String>,
    #[arg(long)]
    code_context: Option<String>,
    #[arg(long)]
    notes: Option<String>,
    /// Acceptance criterion (repeatable).
    #[arg(long = "criterion")]
    criteria: Vec<String>,
    /// Comma-separated step ids this step depends on.
    #[arg(long)]
    depends_on: Option<String>,
    /// Parent step id (makes this a sub-step).
    #[arg(long, alias = "parent-step-id")]
    parent: Option<String>,
    #[arg(long)]
    estimated_hours: Option<String>,
    /// Verification method (e.g. "cargo test").
    #[arg(long)]
    verify_method: Option<String>,
    /// Verification command.
    #[arg(long)]
    verify_command: Option<String>,
}

#[derive(Args, Debug)]
pub struct StepAddArgs {
    #[arg(value_parser = parse_id)]
    plan_id: Id,
    /// Title (or --title).
    title: Option<String>,
    #[arg(long = "title", hide = true)]
    title_flag: Option<String>,
    #[arg(long, value_parser = parse_step_status)]
    status: Option<PlanStepStatus>,
    #[command(flatten)]
    f: StepFields,
}

#[derive(Args, Debug)]
pub struct StepUpdateArgs {
    #[arg(value_parser = parse_id)]
    step_id: Id,
    /// Plan id (default: the plan containing the step).
    #[arg(long, value_parser = parse_id)]
    plan: Option<Id>,
    #[arg(long)]
    title: Option<String>,
    #[arg(long, value_parser = parse_step_status)]
    status: Option<PlanStepStatus>,
    #[arg(long)]
    actual_hours: Option<String>,
    #[command(flatten)]
    f: StepFields,
}

#[derive(Args, Debug)]
pub struct StepRefArgs {
    #[arg(value_parser = parse_id)]
    step_id: Id,
    #[arg(long, value_parser = parse_id)]
    plan: Option<Id>,
}

#[derive(Args, Debug)]
pub struct ReorderArgs {
    #[arg(value_parser = parse_id)]
    plan_id: Id,
    /// Comma-separated step ids in the new order.
    ids: String,
}

#[derive(Args, Debug)]
pub struct CommentArgs {
    #[arg(value_parser = parse_id)]
    plan_id: Id,
    #[arg(long)]
    body: String,
    /// general | review | verification
    #[arg(long, alias = "comment-type", alias = "type", value_parser = parse_comment_kind)]
    kind: Option<PlanCommentKind>,
    /// Override the author name (default: QUADFLOW_ACTOR_NAME / "cli").
    #[arg(long)]
    author: Option<String>,
}

#[derive(Args, Debug)]
pub struct CommentDeleteArgs {
    #[arg(value_parser = parse_id)]
    plan_id: Id,
    #[arg(value_parser = parse_id)]
    comment_id: Id,
}

#[derive(Args, Debug)]
pub struct PromoteArgs {
    #[arg(value_parser = parse_id)]
    plan_id: Id,
    /// Promote only this step (and its unpromoted ancestors).
    #[arg(long, value_parser = parse_id)]
    step: Option<Id>,
}

// ----------------------------------------------------------------- dispatch

pub fn handle(ctx: &Ctx, out: &mut Out, action: PlansAction) -> i32 {
    let store = match ctx.project_store() {
        Ok(s) => s,
        Err(e) => return out.err(&e),
    };
    let code = project_config::read(&store).map(|c| c.code).unwrap_or_default();
    let s = &store;
    let a = &ctx.actor;
    let one = |out: &mut Out, r: Result<Plan>| out.result(r, |w, p| print_plan(w, p));
    match action {
        PlansAction::List(l) => match list_query(l).and_then(|q| svc::list(s, &q)) {
            Ok(res) => out.ok(&res.items, &res.errors, |w| print_list(w, &res.items)),
            Err(e) => out.err(&e),
        },
        PlansAction::Get(p) => one(out, svc::get(s, &p.id)),
        PlansAction::Create(c) => one(out, new_plan(c).and_then(|n| svc::create(s, a, n))),
        PlansAction::Update(u) => {
            let id = u.id.clone();
            one(out, plan_patch(s, u).and_then(|p| svc::update(s, a, &id, p)))
        }
        PlansAction::Delete(p) => {
            out.result(svc::delete(s, a, &p.id).map(|()| serde_json::json!({ "id": p.id })), |w, _| writeln!(w, "Deleted plan {}", p.id))
        }
        PlansAction::StepAdd(x) => one(out, new_step(x).and_then(|(pid, n)| svc::step_add(s, a, &pid, n))),
        PlansAction::StepUpdate(x) => one(
            out,
            plan_of(s, x.plan.clone(), &x.step_id).and_then(|pid| {
                let sid = x.step_id.clone();
                step_patch(x).and_then(|p| svc::step_update(s, a, &pid, &sid, p))
            }),
        ),
        PlansAction::StepDelete(x) => {
            one(out, plan_of(s, x.plan.clone(), &x.step_id).and_then(|pid| svc::step_delete(s, a, &pid, &x.step_id)))
        }
        PlansAction::StepsReorder(x) => one(out, split_ids(&x.ids).and_then(|ids| svc::steps_reorder(s, a, &x.plan_id, &ids))),
        PlansAction::Comment(c) => {
            let mut actor = a.clone();
            if let Some(n) = c.author.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
                actor.name = n.to_string();
            }
            one(out, svc::comment_add(s, &actor, &c.plan_id, &c.body, c.kind.unwrap_or_default()))
        }
        PlansAction::Comments(p) => out.result(svc::get(s, &p.id).map(|p| p.comments), |w, cs| {
            for c in cs {
                writeln!(w, "[{}] {:?} {} ({}):\n{}\n", c.id, c.kind, c.created_by.name, fmt_time(c.created_at), c.body)?;
            }
            if cs.is_empty() {
                writeln!(w, "No comments.")?;
            }
            Ok(())
        }),
        PlansAction::CommentDelete(x) => one(out, svc::comment_delete(s, a, &x.plan_id, &x.comment_id)),
        PlansAction::Promote(x) => {
            let r = match &x.step {
                Some(step) => svc::promote_step(s, a, &x.plan_id, step),
                None => svc::promote_all(s, a, &x.plan_id),
            };
            out.result(r, |w, p| print_promotion(w, &code, p))
        }
    }
}

fn plan_of(s: &ProjectStore, plan: Option<Id>, step: &Id) -> Result<Id> {
    match plan {
        Some(p) => Ok(p),
        None => Ok(svc::find_step_plan(s, step)?.id),
    }
}

fn list_query(l: ListArgs) -> Result<PlanQuery> {
    let statuses = match &l.status {
        Some(v) => split_list(v).iter().map(|x| parse_plan_status(x).map_err(CoreError::invalid_input)).collect::<Result<_>>()?,
        None => vec![],
    };
    Ok(PlanQuery { statuses, idea_id: l.idea, discovery_id: l.discovery, text: l.search })
}

fn title_of(pos: Option<String>, flag: Option<String>) -> Result<String> {
    pos.or(flag).ok_or_else(|| CoreError::invalid_input("a title is required"))
}

fn new_plan(c: CreateArgs) -> Result<NewPlan> {
    Ok(NewPlan {
        title: title_of(c.title, c.title_flag)?,
        description: c.description,
        status: c.status,
        idea_id: c.idea,
        discovery_id: c.discovery,
        spec: match (c.spec_content, c.spec_kind) {
            (None, None) => None,
            (content, kind) => Some(PlanSpec { content: content.unwrap_or_default(), kind: kind.unwrap_or_default() }),
        },
        decisions: c.decisions.iter().map(|d| parse_decision(d)).collect(),
        risk_notes: c.risk_notes,
        context: c.context,
        promotion_profile: None,
        steps: Vec::new(),
    })
}

fn plan_patch(s: &ProjectStore, u: UpdateArgs) -> Result<PlanPatch> {
    let spec = match (u.spec_content, u.spec_kind) {
        (None, None) => None,
        (Some(c), kind) => match clearable(&c) {
            None => Some(None),
            Some(_) => {
                let kind = match kind {
                    Some(k) => k,
                    None => svc::get(s, &u.id)?.spec.map(|sp| sp.kind).unwrap_or_default(),
                };
                Some(Some(PlanSpec { content: c, kind }))
            }
        },
        (None, Some(kind)) => {
            let content = svc::get(s, &u.id)?.spec.map(|sp| sp.content).unwrap_or_default();
            Some(Some(PlanSpec { content, kind }))
        }
    };
    Ok(PlanPatch {
        title: u.title,
        description: opt_text(u.description),
        status: u.status,
        idea_id: opt_parse(u.idea, parse_id)?,
        discovery_id: opt_parse(u.discovery, parse_id)?,
        spec,
        decisions: if u.clear_decisions {
            Some(Vec::new())
        } else if u.decisions.is_empty() {
            None
        } else {
            Some(u.decisions.iter().map(|d| parse_decision(d)).collect())
        },
        risk_notes: opt_text(u.risk_notes),
        context: opt_text(u.context),
        promotion_profile: None,
    })
}

fn hours(v: Option<String>) -> Result<Option<Option<f64>>> {
    opt_parse(v, |s| s.parse::<f64>().map_err(|_| format!("invalid hours {s:?}")))
}

fn verification(method: Option<String>, command: Option<String>) -> Option<Option<PlanStepVerification>> {
    match (method, command) {
        (None, None) => None,
        (m, c) => {
            let method = m.unwrap_or_default();
            if clearable(&method).is_none() {
                Some(None)
            } else {
                Some(Some(PlanStepVerification { method, pattern: None, command: c.filter(|c| clearable(c).is_some()) }))
            }
        }
    }
}

fn new_step(x: StepAddArgs) -> Result<(Id, NewPlanStep)> {
    let f = x.f;
    let step = NewPlanStep {
        title: title_of(x.title, x.title_flag)?,
        description: f.description,
        status: x.status,
        parent_id: f.parent.as_deref().map(Id::parse).transpose()?,
        kind: f.kind.as_deref().map(parse_step_kind).transpose().map_err(CoreError::invalid_input)?,
        notes: f.notes,
        acceptance_criteria: f.criteria,
        target_files: f.target_files.as_deref().map(split_list).unwrap_or_default(),
        code_context: f.code_context,
        effort: f.effort.as_deref().map(parse_effort).transpose().map_err(CoreError::invalid_input)?,
        estimated_hours: hours(f.estimated_hours)?.flatten(),
        depends_on: f.depends_on.as_deref().map(split_ids).transpose()?.unwrap_or_default(),
        verification: verification(f.verify_method, f.verify_command).flatten(),
    };
    Ok((x.plan_id, step))
}

fn step_patch(x: StepUpdateArgs) -> Result<PlanStepPatch> {
    let f = x.f;
    Ok(PlanStepPatch {
        title: x.title,
        description: opt_text(f.description),
        status: x.status,
        parent_id: opt_parse(f.parent, parse_id)?,
        kind: opt_parse(f.kind, parse_step_kind)?,
        notes: opt_text(f.notes),
        acceptance_criteria: if f.criteria.is_empty() { None } else { Some(f.criteria) },
        target_files: f.target_files.as_deref().map(split_list),
        code_context: opt_text(f.code_context),
        effort: opt_parse(f.effort, parse_effort)?,
        estimated_hours: hours(f.estimated_hours)?,
        actual_hours: hours(x.actual_hours)?,
        depends_on: f.depends_on.as_deref().map(split_ids).transpose()?,
        verification: verification(f.verify_method, f.verify_command),
    })
}

// ------------------------------------------------------------------ output

fn fmt_time(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).map(|d| d.format("%Y-%m-%d %H:%M UTC").to_string()).unwrap_or_default()
}

fn progress(p: &Plan) -> String {
    let done = p.steps.iter().filter(|s| s.status == PlanStepStatus::Completed).count();
    format!("{done}/{}", p.steps.len())
}

fn print_list(w: &mut dyn Write, items: &[Plan]) -> std::io::Result<()> {
    if items.is_empty() {
        return writeln!(w, "No plans.");
    }
    for p in items {
        writeln!(w, "{}  {:<13} {:>7}  {}", p.id, p.status.as_str(), progress(p), p.title)?;
    }
    Ok(())
}

fn print_plan(w: &mut dyn Write, p: &Plan) -> std::io::Result<()> {
    writeln!(w, "{}  {}", p.id, p.title)?;
    writeln!(w, "  status:   {}", p.status.as_str())?;
    writeln!(w, "  steps:    {}", progress(p))?;
    if let Some(d) = &p.description {
        writeln!(w, "\n{d}")?;
    }
    if !p.steps.is_empty() {
        writeln!(w, "\nSteps:")?;
        let mut steps: Vec<_> = p.steps.iter().collect();
        steps.sort_by_key(|s| s.order);
        for s in steps {
            let indent = if s.parent_id.is_some() { "    " } else { "  " };
            let link = match (&s.issue_id, &s.epic_id) {
                (Some(i), _) => format!("  → issue {i}"),
                (None, Some(e)) => format!("  → epic {e}"),
                _ => String::new(),
            };
            writeln!(w, "{indent}{:>2}. [{}] {}  ({}){link}", s.order + 1, s.status.as_str(), s.title, s.id)?;
        }
    }
    if !p.comments.is_empty() {
        writeln!(w, "\n{} comment(s)", p.comments.len())?;
    }
    Ok(())
}

fn print_promotion(w: &mut dyn Write, code: &str, p: &PlanPromotion) -> std::io::Result<()> {
    writeln!(w, "Created {} item(s).", p.created)?;
    for e in &p.epics {
        writeln!(w, "  epic   {}  {}", e.id, e.title)?;
    }
    for i in &p.issues {
        writeln!(w, "  {}  {}", issue_ref(code, i), i.title)?;
    }
    Ok(())
}

fn issue_ref(code: &str, i: &Issue) -> String {
    issues::format_ref(code, i.number)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aliases() {
        assert_eq!(parse_plan_status("ready").unwrap(), PlanStatus::ReviewSteps);
        assert_eq!(parse_plan_status("in-progress").unwrap(), PlanStatus::Executing);
        assert_eq!(parse_step_status("done").unwrap(), PlanStepStatus::Completed);
        assert_eq!(parse_step_kind("docs").unwrap(), PlanStepKind::Document);
        assert!(parse_effort("huge").is_err());
        assert_eq!(parse_decision("JWT: stateless").rationale, "stateless");
    }
}
