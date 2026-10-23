//! Issue service (data-layer.md §6.3). Every mutation is one locked
//! transaction; cross-issue effects (cascade unblock, delete unlinking) run in
//! the same transaction through the `*_in_tx` helpers, which other domains
//! (plans promotion, missions) call from inside their own transactions.

use super::labels::ensure_labels_in_tx;
use super::model::*;
use super::refs::{self, RefInput};
use crate::domains::project_config;
use crate::error::{CoreError, Result};
use crate::ids::{new_id, Id};
use crate::model::{Actor, ListResult, Timestamp};
use crate::store::{Entity, ProjectStore, Tx};
use crate::time::now_ms;
use regex::Regex;
use std::collections::BTreeSet;
use std::sync::OnceLock;

/// A claim whose heartbeat is younger than this blocks other claimants.
pub const CLAIM_TTL_MS: Timestamp = 10 * 60 * 1000;

const MAX_TITLE: usize = 500;

// ------------------------------------------------------------------ reads

/// Filtered, sorted by priority (critical first) then number.
pub fn list(s: &ProjectStore, q: &IssueQuery) -> Result<ListResult<Issue>> {
    let code = project_config::read(s)?.code;
    let all = s.list::<Issue>()?;
    let text = q.text.as_deref().map(str::trim).filter(|t| !t.is_empty()).map(str::to_lowercase);
    let mut items: Vec<Issue> = all
        .items
        .into_iter()
        .filter(|i| {
            if q.statuses.is_empty() {
                q.include_done || i.status != IssueStatus::Done
            } else {
                q.statuses.contains(&i.status)
            }
        })
        .filter(|i| q.priorities.is_empty() || q.priorities.contains(&i.priority))
        .filter(|i| q.labels.is_empty() || q.labels.iter().any(|l| i.labels.contains(l)))
        .filter(|i| q.epic_id.as_ref().map_or(true, |e| i.epic_id.as_ref() == Some(e)))
        .filter(|i| q.parent_id.as_ref().map_or(true, |p| i.parent_id.as_ref() == Some(p)))
        .filter(|i| q.mission_id.as_ref().map_or(true, |m| i.mission_id.as_ref() == Some(m)))
        .filter(|i| {
            text.as_ref().map_or(true, |t| {
                i.title.to_lowercase().contains(t)
                    || i.body.as_deref().is_some_and(|b| b.to_lowercase().contains(t))
                    || refs::format_ref(&code, i.number).to_lowercase().contains(t)
            })
        })
        .collect();
    sort_issues(&mut items);
    if let Some(limit) = q.limit {
        if limit > 0 {
            items.truncate(limit as usize);
        }
    }
    Ok(ListResult { items, errors: all.errors })
}

pub fn sort_issues(items: &mut [Issue]) {
    items.sort_by(|a, b| b.priority.cmp(&a.priority).then(a.number.cmp(&b.number)).then(a.id.cmp(&b.id)));
}

/// `r` = id | `CODE-n` | `#n` | `n`.
pub fn get(s: &ProjectStore, r: &str) -> Result<Issue> {
    let id = refs::resolve(s, r)?;
    s.get(&id)
}

/// Sub-issues of `r` (by `parentId`), sorted by number.
pub fn children(s: &ProjectStore, r: &str) -> Result<Vec<Issue>> {
    let id = refs::resolve(s, r)?;
    let mut v: Vec<Issue> = s.list::<Issue>()?.items.into_iter().filter(|i| i.parent_id.as_ref() == Some(&id)).collect();
    v.sort_by_key(|i| i.number);
    Ok(v)
}

/// The issues `r` is blocked by.
pub fn blocking(s: &ProjectStore, r: &str) -> Result<Vec<Issue>> {
    let issue = get(s, r)?;
    let mut v: Vec<Issue> =
        s.list::<Issue>()?.items.into_iter().filter(|i| issue.blocked_by.contains(&i.id)).collect();
    v.sort_by_key(|i| i.number);
    Ok(v)
}

pub use super::refs::display_ref;

// ----------------------------------------------------------------- writes

pub fn create(s: &ProjectStore, actor: &Actor, new: NewIssue) -> Result<Issue> {
    s.write(actor, |tx| create_in_tx(tx, new))
}

/// Create an issue inside an existing transaction (allocates the display
/// number under the transaction's lock). Public for plans promotion (DL-4) and
/// missions (DL-9).
pub fn create_in_tx(tx: &mut Tx, new: NewIssue) -> Result<Issue> {
    let title = clean_title(&new.title)?;
    let now = now_ms();
    let id = new_id();
    let status = new.status.unwrap_or(IssueStatus::Todo);
    let labels = clean_labels(&new.labels)?;
    if let Some(e) = &new.epic_id {
        tx.get::<Epic>(e)?;
    }
    if let Some(p) = &new.parent_id {
        tx.get::<Issue>(p)?;
    }
    let blocked_by = existing_ids(tx, &id, &new.blocked_by, "blockedBy")?;
    let depends_on = existing_ids(tx, &id, &new.depends_on, "dependsOn")?;
    let number = tx.next_counter("issue", Some(<Issue as Entity>::DIR))?;
    ensure_labels_in_tx(tx, &labels)?;
    let issue = Issue {
        id,
        number,
        title,
        body: clean_opt(new.body),
        status,
        priority: new.priority.unwrap_or_default(),
        labels,
        epic_id: new.epic_id,
        parent_id: new.parent_id,
        blocked_by,
        depends_on,
        user_story: clean_opt(new.user_story),
        acceptance_criteria: criteria(new.acceptance_criteria),
        source: new.source.filter(|s| !s.is_empty()),
        mission_id: new.mission_id,
        assignment: None,
        comments: Vec::new(),
        history: vec![StatusChange { from: None, to: status, at: now, by: tx.actor().clone() }],
        created_at: now,
        created_by: tx.actor().clone(),
        updated_at: now,
        ext: Default::default(),
    };
    tx.put(&issue)?;
    Ok(issue)
}

pub fn update(s: &ProjectStore, actor: &Actor, r: &str, patch: IssuePatch) -> Result<Issue> {
    s.write(actor, |tx| {
        let id = resolve_in_tx(tx, r)?;
        update_in_tx(tx, &id, patch)
    })
}

/// Apply a patch inside a transaction. A status change goes through the same
/// path as `set_status` (history, cascade unblock).
pub fn update_in_tx(tx: &mut Tx, id: &Id, patch: IssuePatch) -> Result<Issue> {
    let mut issue: Issue = tx.get(id)?;
    if let Some(t) = patch.title {
        issue.title = clean_title(&t)?;
    }
    if let Some(b) = patch.body {
        issue.body = clean_opt(b);
    }
    if let Some(p) = patch.priority {
        issue.priority = p;
    }
    if let Some(l) = patch.labels {
        issue.labels = clean_labels(&l)?;
        ensure_labels_in_tx(tx, &issue.labels)?;
    }
    if let Some(e) = patch.epic_id {
        if let Some(e) = &e {
            tx.get::<Epic>(e)?;
        }
        issue.epic_id = e;
    }
    if let Some(p) = patch.parent_id {
        if let Some(p) = &p {
            check_parent(tx, &issue.id, p)?;
        }
        issue.parent_id = p;
    }
    if let Some(b) = patch.blocked_by {
        issue.blocked_by = existing_ids(tx, &issue.id, &b, "blockedBy")?;
    }
    if let Some(d) = patch.depends_on {
        issue.depends_on = existing_ids(tx, &issue.id, &d, "dependsOn")?;
    }
    if let Some(u) = patch.user_story {
        issue.user_story = clean_opt(u);
    }
    if let Some(ac) = patch.acceptance_criteria {
        issue.acceptance_criteria = criteria(ac);
    }
    if let Some(src) = patch.source {
        issue.source = src.filter(|s| !s.is_empty());
    }
    if let Some(m) = patch.mission_id {
        issue.mission_id = m;
    }
    if let Some(ext) = patch.ext {
        for (k, v) in ext {
            if v.is_null() {
                issue.ext.remove(&k);
            } else {
                issue.ext.insert(k, v);
            }
        }
    }
    let now = now_ms();
    if let Some(st) = patch.status {
        apply_status_in_tx(tx, &mut issue, st, now)?;
    }
    issue.updated_at = now;
    tx.put(&issue)?;
    Ok(issue)
}

pub fn set_status(s: &ProjectStore, actor: &Actor, r: &str, status: IssueStatus) -> Result<Issue> {
    s.write(actor, |tx| {
        let id = resolve_in_tx(tx, r)?;
        set_status_in_tx(tx, &id, status)
    })
}

/// Change an issue's status inside a transaction (§6.3 invariants): appends a
/// `StatusChange`, sets `updatedAt`, and on `done` removes the issue from every
/// other issue's `blockedBy`, moving now-unblocked `blocked` issues to `todo`.
pub fn set_status_in_tx(tx: &mut Tx, id: &Id, status: IssueStatus) -> Result<Issue> {
    let mut issue: Issue = tx.get(id)?;
    let now = now_ms();
    apply_status_in_tx(tx, &mut issue, status, now)?;
    issue.updated_at = now;
    tx.put(&issue)?;
    Ok(issue)
}

/// Mutates `issue` (caller writes it) and writes every other affected issue.
fn apply_status_in_tx(tx: &mut Tx, issue: &mut Issue, to: IssueStatus, now: Timestamp) -> Result<()> {
    if issue.status == to {
        return Ok(());
    }
    let from = issue.status;
    issue.history.push(StatusChange { from: Some(from), to, at: now, by: tx.actor().clone() });
    issue.status = to;
    if to == IssueStatus::Done {
        unlink_in_tx(tx, &issue.id, now, false)?;
    }
    // §6.3 invariant 3: move the source plan step (and run the plan
    // auto-transition) in this transaction.
    crate::domains::plans::sync_step_from_issue_in_tx(tx, issue)?;
    // §6.3 invariant 4: mission activity (and the merge-queue handoff on done).
    if issue.mission_id.is_some() {
        crate::domains::missions::on_issue_status_in_tx(tx, issue, from, to, now)?;
    }
    Ok(())
}

/// Remove `id` from other issues' `blockedBy` (and, when `deleting`, also
/// `dependsOn` / `parentId`). An issue left with no blockers whose status is
/// `blocked` moves to `todo`.
fn unlink_in_tx(tx: &mut Tx, id: &Id, now: Timestamp, deleting: bool) -> Result<()> {
    let all = tx.list::<Issue>()?;
    for mut other in all.items {
        if &other.id == id {
            continue;
        }
        let mut changed = false;
        if other.blocked_by.contains(id) {
            other.blocked_by.retain(|b| b != id);
            changed = true;
            if other.blocked_by.is_empty() && other.status == IssueStatus::Blocked {
                other.history.push(StatusChange {
                    from: Some(IssueStatus::Blocked),
                    to: IssueStatus::Todo,
                    at: now,
                    by: tx.actor().clone(),
                });
                other.status = IssueStatus::Todo;
            }
        }
        if deleting {
            if other.depends_on.contains(id) {
                other.depends_on.retain(|d| d != id);
                changed = true;
            }
            if other.parent_id.as_ref() == Some(id) {
                other.parent_id = None;
                changed = true;
            }
        }
        if changed {
            other.updated_at = now;
            tx.put(&other)?;
        }
    }
    Ok(())
}

/// `= set_status(done)`: closes the issue and cascades the unblock.
pub fn close(s: &ProjectStore, actor: &Actor, r: &str) -> Result<Issue> {
    set_status(s, actor, r, IssueStatus::Done)
}

/// `= set_status(todo)`.
pub fn reopen(s: &ProjectStore, actor: &Actor, r: &str) -> Result<Issue> {
    set_status(s, actor, r, IssueStatus::Todo)
}

/// Delete an issue; removes its id from other issues' `blockedBy`,
/// `dependsOn` and `parentId`.
pub fn delete(s: &ProjectStore, actor: &Actor, r: &str) -> Result<()> {
    s.write(actor, |tx| {
        let id = resolve_in_tx(tx, r)?;
        let issue: Issue = tx.get(&id)?;
        tx.delete::<Issue>(&id)?;
        unlink_in_tx(tx, &id, now_ms(), true)?;
        crate::domains::plans::unlink_issue_in_tx(tx, &issue)
    })
}

pub fn add_comment(s: &ProjectStore, actor: &Actor, r: &str, body: &str) -> Result<Issue> {
    let body = body.trim();
    if body.is_empty() {
        return Err(CoreError::invalid_input("comment body must not be empty"));
    }
    s.write(actor, |tx| {
        let id = resolve_in_tx(tx, r)?;
        let mut issue: Issue = tx.get(&id)?;
        let now = now_ms();
        issue.comments.push(IssueComment { id: new_id(), body: body.to_string(), created_at: now, created_by: tx.actor().clone() });
        issue.updated_at = now;
        tx.put(&issue)?;
        Ok(issue)
    })
}

pub fn delete_comment(s: &ProjectStore, actor: &Actor, r: &str, comment_id: &Id) -> Result<Issue> {
    s.write(actor, |tx| {
        let id = resolve_in_tx(tx, r)?;
        let mut issue: Issue = tx.get(&id)?;
        let before = issue.comments.len();
        issue.comments.retain(|c| &c.id != comment_id);
        if issue.comments.len() == before {
            return Err(CoreError::not_found(format!("comment {comment_id} not found")));
        }
        issue.updated_at = now_ms();
        tx.put(&issue)?;
        Ok(issue)
    })
}

/// Flip a criterion (`checked = None`) or set it explicitly.
pub fn toggle_criterion(s: &ProjectStore, actor: &Actor, r: &str, criterion_id: &Id, checked: Option<bool>) -> Result<Issue> {
    s.write(actor, |tx| {
        let id = resolve_in_tx(tx, r)?;
        let mut issue: Issue = tx.get(&id)?;
        let c = issue
            .acceptance_criteria
            .iter_mut()
            .find(|c| &c.id == criterion_id)
            .ok_or_else(|| CoreError::not_found(format!("criterion {criterion_id} not found")))?;
        c.checked = checked.unwrap_or(!c.checked);
        issue.updated_at = now_ms();
        tx.put(&issue)?;
        Ok(issue)
    })
}

/// Assign the issue to an agent. Fails with `conflict` if someone else holds
/// it with a heartbeat younger than [`CLAIM_TTL_MS`]. Re-claiming from the same
/// terminal/session refreshes the claim. `backlog`/`todo` move to `in_progress`.
pub fn claim(s: &ProjectStore, actor: &Actor, r: &str, input: ClaimInput) -> Result<Issue> {
    s.write(actor, |tx| {
        let id = resolve_in_tx(tx, r)?;
        claim_in_tx(tx, &id, input)
    })
}

/// [`claim`] inside an existing transaction (missions `claim_next_issue`).
pub fn claim_in_tx(tx: &mut Tx, id: &Id, input: ClaimInput) -> Result<Issue> {
    let agent_label = input.agent_label.trim().to_string();
    if agent_label.is_empty() {
        return Err(CoreError::invalid_input("agentLabel must not be empty"));
    }
    if let Some(sid) = &input.session_id {
        validate_session_id(sid)?;
    }
    let terminal_id = input.terminal_id.filter(|t| !t.trim().is_empty());
    let provider_id = input.provider_id.filter(|t| !t.trim().is_empty());
    {
        let mut issue: Issue = tx.get(id)?;
        let now = now_ms();
        let mut assigned_at = now;
        if let Some(a) = &issue.assignment {
            let same = (a.terminal_id.is_some() && a.terminal_id == terminal_id)
                || (a.session_id.is_some() && a.session_id == input.session_id);
            if same {
                assigned_at = a.assigned_at;
            } else if now - a.last_heartbeat < CLAIM_TTL_MS {
                return Err(CoreError::conflict(format!(
                    "issue is already claimed by {} (last heartbeat {}s ago)",
                    a.agent_label,
                    (now - a.last_heartbeat) / 1000
                ))
                .with_details(serde_json::to_value(a).unwrap_or_default()));
            }
        }
        issue.assignment = Some(Assignment {
            agent_label: agent_label.clone(),
            terminal_id: terminal_id.clone(),
            provider_id: provider_id.clone(),
            session_id: input.session_id.clone(),
            assigned_at,
            last_heartbeat: now,
        });
        if matches!(issue.status, IssueStatus::Backlog | IssueStatus::Todo) {
            apply_status_in_tx(tx, &mut issue, IssueStatus::InProgress, now)?;
        }
        issue.updated_at = now;
        tx.put(&issue)?;
        Ok(issue)
    }
}

/// Refresh the claim's heartbeat. `conflict` if the issue is not claimed.
pub fn heartbeat(s: &ProjectStore, actor: &Actor, r: &str) -> Result<Issue> {
    s.write(actor, |tx| {
        let id = resolve_in_tx(tx, r)?;
        let mut issue: Issue = tx.get(&id)?;
        let now = now_ms();
        let a = issue.assignment.as_mut().ok_or_else(|| CoreError::conflict("issue is not claimed"))?;
        a.last_heartbeat = now;
        issue.updated_at = now;
        tx.put(&issue)?;
        Ok(issue)
    })
}

/// Drop the claim. An `in_progress` issue goes back to `todo`.
pub fn release(s: &ProjectStore, actor: &Actor, r: &str) -> Result<Issue> {
    s.write(actor, |tx| {
        let id = resolve_in_tx(tx, r)?;
        let mut issue: Issue = tx.get(&id)?;
        let now = now_ms();
        issue.assignment = None;
        if issue.status == IssueStatus::InProgress {
            apply_status_in_tx(tx, &mut issue, IssueStatus::Todo, now)?;
        }
        issue.updated_at = now;
        tx.put(&issue)?;
        Ok(issue)
    })
}

// ---------------------------------------------------------------- helpers

/// Resolve a ref inside a transaction (reads are lock-free, so this sees
/// everything committed before the lock was taken).
pub fn resolve_in_tx(tx: &Tx, r: &str) -> Result<Id> {
    let store = tx.store();
    let code = project_config::read(store)?.code;
    match refs::parse(&code, r)? {
        RefInput::Id(id) => {
            tx.get::<Issue>(&id)?;
            Ok(id)
        }
        n @ RefInput::Number(_) => {
            let list = tx.list::<Issue>()?;
            refs::find(&list.items, &n)
                .map(|i| i.id.clone())
                .ok_or_else(|| CoreError::not_found(format!("issue {r} not found")))
        }
    }
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

pub(crate) fn clean_labels(labels: &[String]) -> Result<Vec<String>> {
    let mut set = BTreeSet::new();
    for l in labels {
        set.insert(super::labels::validate_label_name(l)?);
    }
    Ok(set.into_iter().collect())
}

fn existing_ids(tx: &Tx, self_id: &Id, ids: &[Id], field: &str) -> Result<Vec<Id>> {
    let mut out: Vec<Id> = Vec::new();
    for id in ids {
        if id == self_id {
            return Err(CoreError::invalid_input(format!("an issue cannot be in its own {field}")));
        }
        tx.get::<Issue>(id)?;
        if !out.contains(id) {
            out.push(id.clone());
        }
    }
    Ok(out)
}

fn check_parent(tx: &Tx, self_id: &Id, parent: &Id) -> Result<()> {
    let mut cur = parent.clone();
    for _ in 0..1000 {
        if &cur == self_id {
            return Err(CoreError::invalid_input("an issue cannot be its own ancestor"));
        }
        let p: Issue = tx.get(&cur)?;
        match p.parent_id {
            Some(next) => cur = next,
            None => return Ok(()),
        }
    }
    Err(CoreError::invalid_input("parent chain is too deep"))
}

/// Caller-supplied ids are kept (edits); missing or duplicate ids get fresh ones.
fn criteria(input: Vec<CriterionInput>) -> Vec<Criterion> {
    let mut out: Vec<Criterion> = Vec::new();
    for c in input {
        let text = c.text.trim();
        if text.is_empty() {
            continue;
        }
        let id = match c.id {
            Some(id) if !out.iter().any(|o| o.id == id) => id,
            _ => new_id(),
        };
        out.push(Criterion { id, text: text.to_string(), checked: c.checked });
    }
    out
}

fn session_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z0-9._:-]{1,128}$").unwrap())
}

pub fn validate_session_id(s: &str) -> Result<()> {
    if session_re().is_match(s) {
        Ok(())
    } else {
        Err(CoreError::invalid_input(format!("invalid session id {s:?}: expected [A-Za-z0-9._:-]{{1,128}}")))
    }
}
