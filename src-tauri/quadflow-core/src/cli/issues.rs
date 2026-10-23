//! `quadflow issues|labels|epics …` (data-layer.md §6.3, §11). Thin layer over
//! `domains::issues`: parses arguments (status/priority aliases live only
//! here), resolves refs, prints the JSON envelope or human output.

use super::output::Out;
use super::Ctx;
use crate::domains::issues::{
    self as svc, ClaimInput, CriterionInput, Epic, EpicPatch, EpicStatus, Issue, IssuePatch, IssueQuery,
    IssueStatus, Label, NewEpic, NewIssue, Priority,
};
use crate::domains::project_config;
use crate::error::{CoreError, Result};
use crate::ids::Id;
use crate::store::ProjectStore;
use clap::{Args, Subcommand};
use std::io::Write;

// ------------------------------------------------------------------ parsing

/// Status from user input. Accepts canonical values and common aliases.
pub fn parse_status(s: &str) -> std::result::Result<IssueStatus, String> {
    let norm = s.trim().to_ascii_lowercase().replace(['-', ' '], "_");
    Ok(match norm.as_str() {
        "backlog" => IssueStatus::Backlog,
        "todo" | "to_do" | "open" => IssueStatus::Todo,
        "in_progress" | "inprogress" | "doing" | "wip" => IssueStatus::InProgress,
        "qa" | "review" | "in_review" => IssueStatus::Qa,
        "done" | "closed" | "complete" | "completed" => IssueStatus::Done,
        "blocked" => IssueStatus::Blocked,
        "needs_human" | "needshuman" => IssueStatus::NeedsHuman,
        _ => {
            return Err(format!(
                "invalid status {s:?}; expected one of backlog, todo, in_progress, qa, done, blocked, needs_human"
            ))
        }
    })
}

pub fn parse_priority(s: &str) -> std::result::Result<Priority, String> {
    Ok(match s.trim().to_ascii_lowercase().as_str() {
        "low" => Priority::Low,
        "medium" | "med" | "normal" => Priority::Medium,
        "high" => Priority::High,
        "critical" | "urgent" => Priority::Critical,
        _ => return Err(format!("invalid priority {s:?}; expected low, medium, high or critical")),
    })
}

pub fn parse_epic_status(s: &str) -> std::result::Result<EpicStatus, String> {
    let norm = s.trim().to_ascii_lowercase().replace(['-', ' '], "_");
    Ok(match norm.as_str() {
        "open" | "todo" => EpicStatus::Open,
        "in_progress" | "inprogress" => EpicStatus::InProgress,
        "done" | "closed" => EpicStatus::Done,
        _ => return Err(format!("invalid epic status {s:?}; expected open, in_progress or done")),
    })
}

fn parse_id(s: &str) -> std::result::Result<Id, String> {
    Id::parse(s).map_err(|e| e.message)
}

fn split_list(s: &str) -> Vec<String> {
    s.split(',').map(str::trim).filter(|x| !x.is_empty()).map(str::to_string).collect()
}

fn usage(msg: String) -> CoreError {
    CoreError::invalid_input(msg)
}

// --------------------------------------------------------------------- args

#[derive(Subcommand, Debug)]
pub enum IssuesAction {
    /// List issues. Default: everything except `done`, sorted by priority then number.
    List(ListArgs),
    /// Show one issue (ref = id, CODE-n, #n or n).
    Get(RefArg),
    /// Create an issue.
    Create(CreateArgs),
    /// Update fields; anything not passed is unchanged. Pass "" (or "none" for refs) to clear.
    Update(UpdateArgs),
    /// Set the status.
    Status(StatusArgs),
    /// Close an issue: status = done; unblocks issues it was blocking.
    Close(RefArg),
    /// Reopen an issue: status = todo.
    Reopen(RefArg),
    /// Delete an issue (removes it from other issues' blockedBy/dependsOn/parent).
    Delete(RefArg),
    /// Add a label.
    Label(LabelArgs),
    /// Remove a label.
    Unlabel(LabelArgs),
    /// Add a comment.
    Comment(CommentArgs),
    /// List an issue's comments.
    Comments(RefArg),
    /// Delete a comment.
    DeleteComment(DeleteCommentArgs),
    /// Toggle (or set with --checked) an acceptance criterion.
    Criterion(CriterionArgs),
    /// Claim an issue for an agent (conflict if someone else holds a fresh claim).
    Claim(ClaimArgs),
    /// Refresh the claim's heartbeat.
    Heartbeat(RefArg),
    /// Release the claim.
    Release(RefArg),
    /// Sub-issues of an issue.
    Children(RefArg),
    /// Issues blocking an issue.
    Blocking(RefArg),
}

#[derive(Args, Debug)]
pub struct RefArg {
    /// Issue id, CODE-n, #n or n.
    r#ref: String,
}

#[derive(Args, Debug)]
pub struct ListArgs {
    /// Comma-separated statuses (e.g. "todo,in_progress").
    #[arg(long)]
    status: Option<String>,
    /// Comma-separated priorities.
    #[arg(long)]
    priority: Option<String>,
    /// Comma-separated labels (any of).
    #[arg(long)]
    label: Option<String>,
    /// Only issues in this epic (id).
    #[arg(long, value_parser = parse_id)]
    epic: Option<Id>,
    /// Only sub-issues of this issue (ref).
    #[arg(long)]
    parent: Option<String>,
    /// Only issues of this mission (id).
    #[arg(long, value_parser = parse_id)]
    mission: Option<Id>,
    /// Text search over title, body and ref.
    #[arg(long)]
    search: Option<String>,
    /// Include done issues.
    #[arg(long, alias = "all")]
    include_done: bool,
    /// Maximum number of results (0 = unlimited).
    #[arg(long)]
    limit: Option<u32>,
}

#[derive(Args, Debug)]
pub struct CreateArgs {
    /// Title.
    title: String,
    /// Body (markdown).
    #[arg(long)]
    body: Option<String>,
    /// Initial status (default todo).
    #[arg(long, value_parser = parse_status)]
    status: Option<IssueStatus>,
    /// Priority (default medium).
    #[arg(long, value_parser = parse_priority)]
    priority: Option<Priority>,
    /// Comma-separated labels.
    #[arg(long)]
    labels: Option<String>,
    /// Acceptance criterion (repeatable).
    #[arg(long = "criterion")]
    criteria: Vec<String>,
    /// "As a [user], I need [capability] so that [benefit]".
    #[arg(long)]
    user_story: Option<String>,
    /// Comma-separated refs of issues that block this one.
    #[arg(long)]
    blocked_by: Option<String>,
    /// Comma-separated refs of issues this one depends on.
    #[arg(long)]
    depends_on: Option<String>,
    /// Parent issue ref (makes this a sub-issue).
    #[arg(long)]
    parent: Option<String>,
    /// Epic id.
    #[arg(long, value_parser = parse_id)]
    epic: Option<Id>,
    /// Mission id.
    #[arg(long, value_parser = parse_id)]
    mission: Option<Id>,
}

#[derive(Args, Debug)]
pub struct UpdateArgs {
    /// Issue ref.
    r#ref: String,
    #[arg(long)]
    title: Option<String>,
    /// Body; "" clears.
    #[arg(long)]
    body: Option<String>,
    #[arg(long, value_parser = parse_status)]
    status: Option<IssueStatus>,
    #[arg(long, value_parser = parse_priority)]
    priority: Option<Priority>,
    /// Replace labels (comma-separated); "" clears.
    #[arg(long)]
    labels: Option<String>,
    /// Replace acceptance criteria (repeatable).
    #[arg(long = "criterion")]
    criteria: Vec<String>,
    /// User story; "" clears.
    #[arg(long)]
    user_story: Option<String>,
    /// Replace blockers (comma-separated refs); "" clears.
    #[arg(long)]
    blocked_by: Option<String>,
    /// Replace dependencies (comma-separated refs); "" clears.
    #[arg(long)]
    depends_on: Option<String>,
    /// Parent ref; "none" clears.
    #[arg(long)]
    parent: Option<String>,
    /// Epic id; "none" clears.
    #[arg(long)]
    epic: Option<String>,
    /// Mission id; "none" clears.
    #[arg(long)]
    mission: Option<String>,
}

#[derive(Args, Debug)]
pub struct StatusArgs {
    /// Issue ref.
    r#ref: String,
    /// backlog | todo | in_progress | qa | done | blocked | needs_human
    #[arg(value_parser = parse_status)]
    status: IssueStatus,
}

#[derive(Args, Debug)]
pub struct LabelArgs {
    /// Issue ref.
    r#ref: String,
    /// Label name.
    label: String,
}

#[derive(Args, Debug)]
pub struct CommentArgs {
    /// Issue ref.
    r#ref: String,
    /// Comment body (markdown).
    #[arg(long)]
    body: String,
}

#[derive(Args, Debug)]
pub struct DeleteCommentArgs {
    /// Issue ref.
    r#ref: String,
    /// Comment id.
    #[arg(value_parser = parse_id)]
    comment_id: Id,
}

#[derive(Args, Debug)]
pub struct CriterionArgs {
    /// Issue ref.
    r#ref: String,
    /// Criterion id.
    #[arg(value_parser = parse_id)]
    criterion_id: Id,
    /// Set explicitly instead of toggling.
    #[arg(long)]
    checked: Option<bool>,
}

#[derive(Args, Debug)]
pub struct ClaimArgs {
    /// Issue ref.
    r#ref: String,
    /// Human-readable agent label.
    #[arg(long)]
    agent_label: String,
    #[arg(long)]
    terminal_id: Option<String>,
    /// Defaults to $QUADFLOW_PROVIDER_ID.
    #[arg(long)]
    provider_id: Option<String>,
    /// Defaults to $QUADFLOW_SESSION_ID.
    #[arg(long)]
    session_id: Option<String>,
}

#[derive(Subcommand, Debug)]
pub enum LabelsAction {
    /// List labels.
    List,
    /// Create or update a label.
    Upsert(LabelUpsertArgs),
    /// Delete a label (also removes it from issues and epics).
    Delete {
        /// Label name.
        name: String,
    },
}

#[derive(Args, Debug)]
pub struct LabelUpsertArgs {
    /// Label name.
    name: String,
    /// #rrggbb (default: keep, or a palette color for new labels).
    #[arg(long)]
    color: Option<String>,
    /// Description; "" clears.
    #[arg(long)]
    description: Option<String>,
    /// Rename the label of this name to NAME (issues and epics follow).
    #[arg(long)]
    rename_from: Option<String>,
}

#[derive(Subcommand, Debug)]
pub enum EpicsAction {
    /// List epics.
    List,
    /// Show an epic.
    Get {
        #[arg(value_parser = parse_id)]
        id: Id,
    },
    /// Create an epic.
    Create(EpicCreateArgs),
    /// Update an epic.
    Update(EpicUpdateArgs),
    /// Delete an epic (its issues are unlinked).
    Delete {
        #[arg(value_parser = parse_id)]
        id: Id,
    },
}

#[derive(Args, Debug)]
pub struct EpicCreateArgs {
    title: String,
    #[arg(long)]
    description: Option<String>,
    #[arg(long, value_parser = parse_epic_status)]
    status: Option<EpicStatus>,
    #[arg(long, value_parser = parse_priority)]
    priority: Option<Priority>,
    /// Comma-separated labels.
    #[arg(long)]
    labels: Option<String>,
}

#[derive(Args, Debug)]
pub struct EpicUpdateArgs {
    #[arg(value_parser = parse_id)]
    id: Id,
    #[arg(long)]
    title: Option<String>,
    /// Description; "" clears.
    #[arg(long)]
    description: Option<String>,
    #[arg(long, value_parser = parse_epic_status)]
    status: Option<EpicStatus>,
    #[arg(long, value_parser = parse_priority)]
    priority: Option<Priority>,
    /// Replace labels; "" clears.
    #[arg(long)]
    labels: Option<String>,
}

// ----------------------------------------------------------------- dispatch

pub fn handle_issues(ctx: &Ctx, out: &mut Out, action: IssuesAction) -> i32 {
    let store = match ctx.project_store() {
        Ok(s) => s,
        Err(e) => return out.err(&e),
    };
    let code = match project_config::read(&store) {
        Ok(c) => c.code,
        Err(e) => return out.err(&e),
    };
    let a = &ctx.actor;
    let s = &store;
    let one = |out: &mut Out, r: Result<Issue>| out.result(r, |w, i| print_issue(w, &code, i));
    let many = |out: &mut Out, r: Result<Vec<Issue>>| out.result(r, |w, v| print_table(w, &code, v));
    match action {
        IssuesAction::List(l) => match query(s, l) {
            Ok(q) => match svc::list(s, &q) {
                Ok(res) => out.ok(&res.items, &res.errors, |w| print_table(w, &code, &res.items)),
                Err(e) => out.err(&e),
            },
            Err(e) => out.err(&e),
        },
        IssuesAction::Get(r) => one(out, svc::get(s, &r.r#ref)),
        IssuesAction::Create(c) => one(out, new_issue(s, c).and_then(|n| svc::create(s, a, n))),
        IssuesAction::Update(u) => {
            let r = u.r#ref.clone();
            one(out, patch(s, u).and_then(|p| svc::update(s, a, &r, p)))
        }
        IssuesAction::Status(x) => one(out, svc::set_status(s, a, &x.r#ref, x.status)),
        IssuesAction::Close(r) => one(out, svc::close(s, a, &r.r#ref)),
        IssuesAction::Reopen(r) => one(out, svc::reopen(s, a, &r.r#ref)),
        IssuesAction::Delete(r) => {
            let res = svc::get(s, &r.r#ref).and_then(|i| svc::delete(s, a, i.id.as_str()).map(|()| i));
            out.result(res.map(|i| serde_json::json!({ "id": i.id, "number": i.number })), |w, v| {
                writeln!(w, "Deleted {}-{}", code, v["number"])
            })
        }
        IssuesAction::Label(l) => one(
            out,
            svc::get(s, &l.r#ref).and_then(|i| {
                let mut labels = i.labels.clone();
                labels.push(l.label.clone());
                svc::update(s, a, i.id.as_str(), IssuePatch { labels: Some(labels), ..Default::default() })
            }),
        ),
        IssuesAction::Unlabel(l) => one(
            out,
            svc::get(s, &l.r#ref).and_then(|i| {
                if !i.labels.contains(&l.label) {
                    return Err(CoreError::not_found(format!("issue has no label {:?}", l.label)));
                }
                let labels = i.labels.iter().filter(|x| **x != l.label).cloned().collect();
                svc::update(s, a, i.id.as_str(), IssuePatch { labels: Some(labels), ..Default::default() })
            }),
        ),
        IssuesAction::Comment(c) => one(out, svc::add_comment(s, a, &c.r#ref, &c.body)),
        IssuesAction::Comments(r) => out.result(svc::get(s, &r.r#ref).map(|i| i.comments), |w, cs| {
            for c in cs {
                writeln!(w, "[{}] {} ({}):\n{}\n", c.id, c.created_by.name, fmt_time(c.created_at), c.body)?;
            }
            if cs.is_empty() {
                writeln!(w, "No comments.")?;
            }
            Ok(())
        }),
        IssuesAction::DeleteComment(d) => one(out, svc::delete_comment(s, a, &d.r#ref, &d.comment_id)),
        IssuesAction::Criterion(c) => one(out, svc::toggle_criterion(s, a, &c.r#ref, &c.criterion_id, c.checked)),
        IssuesAction::Claim(c) => {
            let input = ClaimInput {
                agent_label: c.agent_label,
                terminal_id: c.terminal_id,
                provider_id: c.provider_id.or_else(|| a.provider_id.clone()),
                session_id: c.session_id.or_else(|| a.session_id.clone()),
            };
            one(out, svc::claim(s, a, &c.r#ref, input))
        }
        IssuesAction::Heartbeat(r) => one(out, svc::heartbeat(s, a, &r.r#ref)),
        IssuesAction::Release(r) => one(out, svc::release(s, a, &r.r#ref)),
        IssuesAction::Children(r) => many(out, svc::children(s, &r.r#ref)),
        IssuesAction::Blocking(r) => many(out, svc::blocking(s, &r.r#ref)),
    }
}

pub fn handle_labels(ctx: &Ctx, out: &mut Out, action: LabelsAction) -> i32 {
    let store = match ctx.project_store() {
        Ok(s) => s,
        Err(e) => return out.err(&e),
    };
    let print = |w: &mut dyn Write, ls: &Vec<Label>| -> std::io::Result<()> {
        for l in ls {
            writeln!(w, "{}  {}{}", l.color, l.name, l.description.as_deref().map(|d| format!(" — {d}")).unwrap_or_default())?;
        }
        if ls.is_empty() {
            writeln!(w, "No labels.")?;
        }
        Ok(())
    };
    match action {
        LabelsAction::List => out.result(svc::labels_list(&store), print),
        LabelsAction::Upsert(u) => {
            let res = svc::labels_list(&store).and_then(|existing| {
                let lookup = u.rename_from.as_deref().unwrap_or(&u.name);
                let prev = existing.iter().find(|l| l.name == lookup);
                let color = match (&u.color, prev) {
                    (Some(c), _) => c.clone(),
                    (None, Some(p)) => p.color.clone(),
                    (None, None) => svc::labels::default_color(u.name.trim()).to_string(),
                };
                let description = match (&u.description, prev) {
                    (Some(d), _) => Some(d.clone()),
                    (None, Some(p)) => p.description.clone(),
                    (None, None) => None,
                };
                svc::label_upsert(&store, &ctx.actor, Label { name: u.name.clone(), color, description }, u.rename_from.clone())
            });
            out.result(res, print)
        }
        LabelsAction::Delete { name } => out.result(svc::label_delete(&store, &ctx.actor, &name), print),
    }
}

pub fn handle_epics(ctx: &Ctx, out: &mut Out, action: EpicsAction) -> i32 {
    let store = match ctx.project_store() {
        Ok(s) => s,
        Err(e) => return out.err(&e),
    };
    let s = &store;
    let a = &ctx.actor;
    let one = |out: &mut Out, r: Result<Epic>| out.result(r, |w, e| print_epic(w, e));
    match action {
        EpicsAction::List => match svc::epics_list(s) {
            Ok(res) => out.ok(&res.items, &res.errors, |w| {
                for e in &res.items {
                    writeln!(w, "{}  {:<12} {:<8} {}", e.id, e.status.as_str(), e.priority.as_str(), e.title)?;
                }
                if res.items.is_empty() {
                    writeln!(w, "No epics.")?;
                }
                Ok(())
            }),
            Err(e) => out.err(&e),
        },
        EpicsAction::Get { id } => one(out, svc::epic_get(s, &id)),
        EpicsAction::Create(c) => one(
            out,
            svc::epic_create(s, a, NewEpic {
                title: c.title,
                description: c.description,
                status: c.status,
                priority: c.priority,
                labels: c.labels.as_deref().map(split_list).unwrap_or_default(),
            }),
        ),
        EpicsAction::Update(u) => one(
            out,
            svc::epic_update(s, a, &u.id, EpicPatch {
                title: u.title,
                description: u.description.map(|d| Some(d).filter(|d| !d.trim().is_empty())),
                status: u.status,
                priority: u.priority,
                labels: u.labels.as_deref().map(split_list),
            }),
        ),
        EpicsAction::Delete { id } => out.result(svc::epic_delete(s, a, &id).map(|()| serde_json::json!({ "id": id })), |w, _| {
            writeln!(w, "Deleted epic {id}")
        }),
    }
}

// ------------------------------------------------------------------ helpers

fn resolve_refs(s: &ProjectStore, list: &str) -> Result<Vec<Id>> {
    split_list(list).iter().map(|r| svc::refs::resolve(s, r)).collect()
}

/// `none` / `""` → clear; otherwise a value.
fn clearable(v: &str) -> Option<&str> {
    let t = v.trim();
    if t.is_empty() || t.eq_ignore_ascii_case("none") || t.eq_ignore_ascii_case("null") {
        None
    } else {
        Some(t)
    }
}

fn query(s: &ProjectStore, l: ListArgs) -> Result<IssueQuery> {
    let statuses = match &l.status {
        Some(v) => split_list(v).iter().map(|x| parse_status(x).map_err(usage)).collect::<Result<_>>()?,
        None => vec![],
    };
    let priorities = match &l.priority {
        Some(v) => split_list(v).iter().map(|x| parse_priority(x).map_err(usage)).collect::<Result<_>>()?,
        None => vec![],
    };
    let parent_id = l.parent.as_deref().map(|p| svc::refs::resolve(s, p)).transpose()?;
    Ok(IssueQuery {
        statuses,
        priorities,
        labels: l.label.as_deref().map(split_list).unwrap_or_default(),
        epic_id: l.epic,
        parent_id,
        mission_id: l.mission,
        text: l.search,
        include_done: l.include_done,
        limit: l.limit,
    })
}

fn new_issue(s: &ProjectStore, c: CreateArgs) -> Result<NewIssue> {
    Ok(NewIssue {
        title: c.title,
        body: c.body,
        status: c.status,
        priority: c.priority,
        labels: c.labels.as_deref().map(split_list).unwrap_or_default(),
        epic_id: c.epic,
        parent_id: c.parent.as_deref().map(|p| svc::refs::resolve(s, p)).transpose()?,
        blocked_by: c.blocked_by.as_deref().map(|b| resolve_refs(s, b)).transpose()?.unwrap_or_default(),
        depends_on: c.depends_on.as_deref().map(|b| resolve_refs(s, b)).transpose()?.unwrap_or_default(),
        user_story: c.user_story,
        acceptance_criteria: c.criteria.iter().map(|t| CriterionInput::from(t.as_str())).collect(),
        source: None,
        mission_id: c.mission,
    })
}

fn patch(s: &ProjectStore, u: UpdateArgs) -> Result<IssuePatch> {
    let id_opt = |v: &Option<String>| -> Result<Option<Option<Id>>> {
        match v {
            None => Ok(None),
            Some(v) => Ok(Some(clearable(v).map(Id::parse).transpose()?)),
        }
    };
    Ok(IssuePatch {
        title: u.title,
        body: u.body.map(|b| Some(b).filter(|b| !b.trim().is_empty())),
        status: u.status,
        priority: u.priority,
        labels: u.labels.as_deref().map(split_list),
        epic_id: id_opt(&u.epic)?,
        parent_id: match &u.parent {
            None => None,
            Some(v) => Some(clearable(v).map(|r| svc::refs::resolve(s, r)).transpose()?),
        },
        blocked_by: u.blocked_by.as_deref().map(|b| resolve_refs(s, b)).transpose()?,
        depends_on: u.depends_on.as_deref().map(|b| resolve_refs(s, b)).transpose()?,
        user_story: u.user_story.map(|b| Some(b).filter(|b| !b.trim().is_empty())),
        acceptance_criteria: if u.criteria.is_empty() {
            None
        } else {
            Some(u.criteria.iter().map(|t| CriterionInput::from(t.as_str())).collect())
        },
        source: None,
        mission_id: id_opt(&u.mission)?,
        ext: None,
    })
}

fn fmt_time(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| d.format("%Y-%m-%d %H:%M UTC").to_string())
        .unwrap_or_default()
}

fn print_table(w: &mut dyn Write, code: &str, items: &[Issue]) -> std::io::Result<()> {
    if items.is_empty() {
        return writeln!(w, "No issues.");
    }
    for i in items {
        let r = svc::format_ref(code, i.number);
        let labels = if i.labels.is_empty() { String::new() } else { format!("  [{}]", i.labels.join(", ")) };
        writeln!(w, "{r:<10} {:<12} {:<9} {}{labels}", i.status.as_str(), i.priority.as_str(), i.title)?;
    }
    Ok(())
}

fn print_issue(w: &mut dyn Write, code: &str, i: &Issue) -> std::io::Result<()> {
    writeln!(w, "{}  {}", svc::format_ref(code, i.number), i.title)?;
    writeln!(w, "  id:       {}", i.id)?;
    writeln!(w, "  status:   {}", i.status.as_str())?;
    writeln!(w, "  priority: {}", i.priority.as_str())?;
    if !i.labels.is_empty() {
        writeln!(w, "  labels:   {}", i.labels.join(", "))?;
    }
    if let Some(a) = &i.assignment {
        writeln!(w, "  assigned: {} (heartbeat {})", a.agent_label, fmt_time(a.last_heartbeat))?;
    }
    if !i.blocked_by.is_empty() {
        writeln!(w, "  blocked by: {}", i.blocked_by.iter().map(Id::as_str).collect::<Vec<_>>().join(", "))?;
    }
    if let Some(u) = &i.user_story {
        writeln!(w, "\n  {u}")?;
    }
    if let Some(b) = &i.body {
        writeln!(w, "\n{b}")?;
    }
    if !i.acceptance_criteria.is_empty() {
        writeln!(w, "\nAcceptance criteria:")?;
        for c in &i.acceptance_criteria {
            writeln!(w, "  [{}] {}  ({})", if c.checked { "x" } else { " " }, c.text, c.id)?;
        }
    }
    if !i.comments.is_empty() {
        writeln!(w, "\n{} comment(s)", i.comments.len())?;
    }
    Ok(())
}

fn print_epic(w: &mut dyn Write, e: &Epic) -> std::io::Result<()> {
    writeln!(w, "{}  {}", e.id, e.title)?;
    writeln!(w, "  status:   {}", e.status.as_str())?;
    writeln!(w, "  priority: {}", e.priority.as_str())?;
    if !e.labels.is_empty() {
        writeln!(w, "  labels:   {}", e.labels.join(", "))?;
    }
    if let Some(d) = &e.description {
        writeln!(w, "\n{d}")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_aliases() {
        assert_eq!(parse_status("in-progress").unwrap(), IssueStatus::InProgress);
        assert_eq!(parse_status("Review").unwrap(), IssueStatus::Qa);
        assert_eq!(parse_status("needs human").unwrap(), IssueStatus::NeedsHuman);
        assert!(parse_status("bogus").is_err());
        assert_eq!(parse_priority("URGENT").unwrap(), Priority::Critical);
    }
}
