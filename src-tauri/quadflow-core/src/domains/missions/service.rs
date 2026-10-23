//! Mission service (data-layer.md §6.9). A mission lives in
//! `.quadflow/local/missions/<id>/`: `mission.json` (members, proposals, merge
//! queue), append-only `messages.jsonl` / `activity.jsonl`, and `reads.json`
//! (read cursors). Every mutation is one locked project transaction; issue
//! effects (assign, claim) run in the same transaction through the issue
//! domain's `*_in_tx` helpers.

use super::builtins::{builtin_agent_definition, builtin_agent_definitions, builtin_templates};
use super::model::*;
use crate::domains::app::agent_definitions::{self, AgentDefinition};
use crate::domains::issues::{self, ClaimInput, Issue, IssueStatus, Priority, CLAIM_TTL_MS};
use crate::domains::project_config;
use crate::error::{CoreError, ErrorCode, Result};
use crate::ids::{new_id, Id};
use crate::model::{Actor, CorruptEntry, ListResult, Timestamp};
use crate::store::{AppDb, ProjectStore, RelPath, Tx};
use crate::time::now_ms;
use std::collections::BTreeMap;

const MAX_NAME: usize = 200;
const MAX_CONTENT: usize = 32 * 1024;

// ------------------------------------------------------------------ paths

fn dir_rel(id: &Id) -> String {
    format!("local/missions/{id}")
}

fn rel(id: &Id, file: &str) -> RelPath {
    RelPath::new(format!("{}/{file}", dir_rel(id))).expect("mission paths are valid")
}

fn mission_rel(id: &Id) -> RelPath {
    rel(id, "mission.json")
}

fn messages_rel(id: &Id) -> RelPath {
    rel(id, "messages.jsonl")
}

fn activity_rel(id: &Id) -> RelPath {
    rel(id, "activity.jsonl")
}

fn reads_rel(id: &Id) -> RelPath {
    rel(id, "reads.json")
}

// ------------------------------------------------------------------ validation

/// Model ids are passed to agent argv (agent-providers.md §0 rule 4).
pub fn validate_model(m: &str) -> Result<()> {
    crate::agents::validate_model_id(m)
}

fn clean_model(m: Option<String>) -> Result<Option<String>> {
    match m.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        Some(m) => {
            validate_model(&m)?;
            Ok(Some(m))
        }
        None => Ok(None),
    }
}

fn clean_name(field: &str, v: &str) -> Result<String> {
    let t = v.trim();
    if t.is_empty() {
        return Err(CoreError::invalid_input(format!("{field} must not be empty")));
    }
    if t.chars().count() > MAX_NAME {
        return Err(CoreError::invalid_input(format!("{field} is longer than {MAX_NAME} characters")));
    }
    Ok(t.to_string())
}

fn clean_opt(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn clean_opaque(field: &str, s: Option<String>) -> Result<Option<String>> {
    match clean_opt(s) {
        Some(v) if v.len() > 1024 || v.chars().any(char::is_control) => {
            Err(CoreError::invalid_input(format!("invalid {field} {v:?}")))
        }
        v => Ok(v),
    }
}

fn clean_strings(v: Vec<String>) -> Vec<String> {
    v.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
}

fn clean_config(mut c: MissionConfig) -> MissionConfig {
    c.skills_used = clean_strings(c.skills_used);
    c.success_criteria = clean_strings(c.success_criteria);
    c.workflow_phases.retain(|p| !p.name.trim().is_empty());
    c.orchestrator_prompt_extra = clean_opt(c.orchestrator_prompt_extra);
    c.member_prompt_extra = clean_opt(c.member_prompt_extra);
    c
}

// ------------------------------------------------------------------ reads

/// All missions (newest first), optionally filtered by status.
pub fn list(s: &ProjectStore, status: Option<MissionStatus>) -> Result<ListResult<Mission>> {
    let dir = s.data_dir().join("local").join("missions");
    let mut out = ListResult::default();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(CoreError::io(&dir, e)),
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || !entry.path().is_dir() {
            continue;
        }
        let path = entry.path().join("mission.json");
        let corrupt = |message: String| CorruptEntry { path: path.display().to_string(), message };
        let Ok(id) = Id::parse(&name) else {
            out.errors.push(corrupt("mission directory name is not a valid id".into()));
            continue;
        };
        match s.read_json::<Mission>(&mission_rel(&id)) {
            Ok(Some(m)) if m.id == id => out.items.push(m),
            Ok(Some(m)) => out.errors.push(corrupt(format!("id {} does not match directory name", m.id))),
            Ok(None) => {} // being created or deleted
            Err(e) => out.errors.push(corrupt(e.message)),
        }
    }
    if let Some(st) = status {
        out.items.retain(|m| m.status == st);
    }
    out.items.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(out)
}

pub fn get(s: &ProjectStore, id: &Id) -> Result<Mission> {
    match s.read_json::<Mission>(&mission_rel(id))? {
        Some(m) => Ok(m),
        None => Err(CoreError::not_found(format!("mission {id} not found"))),
    }
}

/// Computed from the issues whose `missionId` is this mission.
pub fn progress(s: &ProjectStore, id: &Id) -> Result<MissionProgress> {
    let m = get(s, id)?;
    let all = s.list::<Issue>()?;
    let mut by_status: BTreeMap<IssueStatus, u32> = IssueStatus::ALL.iter().map(|st| (*st, 0)).collect();
    let mut total = 0;
    for i in all.items.iter().filter(|i| i.mission_id.as_ref() == Some(id)) {
        total += 1;
        *by_status.entry(i.status).or_default() += 1;
    }
    Ok(MissionProgress {
        mission_id: id.clone(),
        total,
        by_status,
        active_members: m.members.iter().filter(|m| m.status.is_active()).count() as u32,
        total_members: m.members.len() as u32,
    })
}

/// Issues in the mission, sorted like `issues list` (priority, then number).
pub fn issues(s: &ProjectStore, id: &Id) -> Result<ListResult<Issue>> {
    get(s, id)?;
    issues::list(s, &issues::IssueQuery { mission_id: Some(id.clone()), include_done: true, ..Default::default() })
}

pub fn messages(s: &ProjectStore, id: &Id, q: &MissionMessageQuery) -> Result<ListResult<MissionMessage>> {
    get(s, id)?;
    let all = s.read_jsonl::<MissionMessage>(&messages_rel(id))?;
    let mut items = after_cursor(all.items, q.since.as_ref(), |m| &m.id);
    if let Some(member) = &q.for_member {
        items.retain(|m| m.to_member_id.is_none() || m.to_member_id.as_ref() == Some(member));
    }
    Ok(ListResult { items: newest(items, q.limit), errors: all.errors })
}

pub fn activity(s: &ProjectStore, id: &Id, since: Option<&Id>, limit: Option<u32>) -> Result<ListResult<MissionActivity>> {
    get(s, id)?;
    let all = s.read_jsonl::<MissionActivity>(&activity_rel(id))?;
    let items = after_cursor(all.items, since, |a| &a.id);
    Ok(ListResult { items: newest(items, limit), errors: all.errors })
}

/// Entries after the cursor. File order is the canonical order (appends happen
/// under the project lock); an unknown cursor falls back to id order.
fn after_cursor<T>(items: Vec<T>, since: Option<&Id>, id: impl Fn(&T) -> &Id) -> Vec<T> {
    let Some(since) = since else { return items };
    match items.iter().position(|x| id(x) == since) {
        Some(pos) => items.into_iter().skip(pos + 1).collect(),
        None => items.into_iter().filter(|x| id(x) > since).collect(),
    }
}

fn newest<T>(mut items: Vec<T>, limit: Option<u32>) -> Vec<T> {
    if let Some(l) = limit.filter(|l| *l > 0) {
        let l = l as usize;
        if items.len() > l {
            items.drain(..items.len() - l);
        }
    }
    items
}

pub fn reads(s: &ProjectStore, id: &Id) -> Result<MissionReads> {
    Ok(s.read_json::<MissionReads>(&reads_rel(id))?.unwrap_or_default())
}

/// Messages `reader` has not read yet: after its cursor, addressed to it (or
/// broadcast), not sent by it. `reader` = member id or `"human"` (humans see
/// every message sent by a member).
pub fn unread(s: &ProjectStore, id: &Id, reader: &str) -> Result<Vec<MissionMessage>> {
    let m = get(s, id)?;
    let reader = check_reader(&m, reader)?;
    let all = s.read_jsonl::<MissionMessage>(&messages_rel(id))?.items;
    let cursor = reads(s, id)?.last_read.get(&reader).cloned();
    let items = after_cursor(all, cursor.as_ref(), |m| &m.id);
    Ok(items.into_iter().filter(|msg| is_for_reader(msg, &reader)).collect())
}

pub fn unread_count(s: &ProjectStore, id: &Id, reader: &str) -> Result<u32> {
    Ok(unread(s, id, reader)?.len() as u32)
}

fn is_for_reader(msg: &MissionMessage, reader: &str) -> bool {
    if reader == HUMAN_READER {
        return msg.from_member_id.is_some();
    }
    msg.from_member_id.as_ref().map(Id::as_str) != Some(reader)
        && (msg.to_member_id.is_none() || msg.to_member_id.as_ref().map(Id::as_str) == Some(reader))
}

fn check_reader(m: &Mission, reader: &str) -> Result<String> {
    let r = reader.trim();
    if r == HUMAN_READER {
        return Ok(r.to_string());
    }
    let idx = member_index(m, r)?;
    Ok(m.members[idx].id.to_string())
}

// ------------------------------------------------------------------ tx helpers

fn load_in_tx(tx: &Tx, id: &Id) -> Result<Mission> {
    get(tx.store(), id)
}

fn save_in_tx(tx: &mut Tx, m: &mut Mission, now: Timestamp) -> Result<()> {
    m.updated_at = now;
    tx.put_json(&mission_rel(&m.id), m)
}

struct Act {
    kind: MissionActivityKind,
    member: Option<(Id, String)>,
    issue_id: Option<Id>,
    detail: Option<String>,
    metadata: Option<serde_json::Value>,
}

impl Act {
    fn new(kind: MissionActivityKind, detail: impl Into<String>) -> Self {
        Self { kind, member: None, issue_id: None, detail: Some(detail.into()), metadata: None }
    }
    fn member(mut self, m: &MissionMember) -> Self {
        self.member = Some((m.id.clone(), m.name.clone()));
        self
    }
    fn issue(mut self, id: Option<Id>) -> Self {
        self.issue_id = id;
        self
    }
    fn meta(mut self, v: serde_json::Value) -> Self {
        self.metadata = Some(v);
        self
    }
}

fn log_in_tx(tx: &mut Tx, mission_id: &Id, a: Act, now: Timestamp) -> Result<MissionActivity> {
    let (member_id, member_name) = match a.member {
        Some((id, name)) => (Some(id), Some(name)),
        None => (None, None),
    };
    let entry = MissionActivity {
        id: new_id(),
        kind: a.kind,
        member_id,
        member_name,
        issue_id: a.issue_id,
        detail: a.detail,
        metadata: a.metadata,
        created_at: now,
    };
    tx.append_jsonl(&activity_rel(mission_id), &entry)?;
    Ok(entry)
}

/// Member by id or (case-insensitive, unique) name.
fn member_index(m: &Mission, r: &str) -> Result<usize> {
    let r = r.trim();
    if let Ok(id) = Id::parse(r) {
        if let Some(i) = m.members.iter().position(|x| x.id == id) {
            return Ok(i);
        }
    }
    let hits: Vec<usize> =
        m.members.iter().enumerate().filter(|(_, x)| x.name.eq_ignore_ascii_case(r)).map(|(i, _)| i).collect();
    match hits.as_slice() {
        [i] => Ok(*i),
        [] => Err(CoreError::not_found(format!("member {r:?} not found in mission {}", m.id))),
        _ => Err(CoreError::invalid_input(format!("member name {r:?} is ambiguous; use the member id"))),
    }
}

fn status_activity(to: MissionStatus) -> Option<MissionActivityKind> {
    match to {
        MissionStatus::Active => Some(MissionActivityKind::MissionStarted),
        MissionStatus::Paused => Some(MissionActivityKind::MissionPaused),
        MissionStatus::Completed | MissionStatus::Cancelled => Some(MissionActivityKind::MissionCompleted),
        MissionStatus::Preparing => None,
    }
}

fn apply_mission_status(tx: &mut Tx, m: &mut Mission, to: MissionStatus, now: Timestamp) -> Result<()> {
    if m.status == to {
        return Ok(());
    }
    let from = m.status;
    m.status = to;
    if to == MissionStatus::Active && m.started_at.is_none() {
        m.started_at = Some(now);
    }
    if to.is_finished() {
        m.completed_at = Some(now);
    } else {
        m.completed_at = None;
    }
    if let Some(kind) = status_activity(to) {
        let a = Act::new(kind, format!("Mission \"{}\" {} → {}", m.name, from.as_str(), to.as_str()))
            .meta(serde_json::json!({ "from": from, "to": to }));
        log_in_tx(tx, &m.id.clone(), a, now)?;
    }
    Ok(())
}

// ------------------------------------------------------------------ missions

pub fn create(s: &ProjectStore, actor: &Actor, new: NewMission) -> Result<Mission> {
    let name = clean_name("mission name", &new.name)?;
    let config = match (&new.config, &new.template_id) {
        (Some(c), _) => clean_config(c.clone()),
        (None, Some(t)) => MissionConfig::from_template(&template_get(s, t)?),
        (None, None) => MissionConfig::default(),
    };
    if let Some(t) = &new.template_id {
        template_get(s, t)?;
    }
    s.write(actor, |tx| {
        // Resolve every issue ref before writing anything (no half-created mission).
        for r in &new.issue_refs {
            issues::resolve_in_tx(tx, r)?;
        }
        let now = now_ms();
        let mut m = Mission {
            id: new_id(),
            name,
            status: MissionStatus::Preparing,
            orchestrator_mode: new.orchestrator_mode.unwrap_or_default(),
            orchestrator_member_id: None,
            plan_id: new.plan_id,
            template_id: new.template_id,
            config,
            members: Vec::new(),
            proposals: Vec::new(),
            merge_queue: Vec::new(),
            started_at: None,
            completed_at: None,
            created_at: now,
            created_by: tx.actor().clone(),
            updated_at: now,
            ext: Default::default(),
        };
        save_in_tx(tx, &mut m, now)?;
        if !new.issue_refs.is_empty() {
            assign_in_tx(tx, &m.id, &new.issue_refs, now)?;
        }
        Ok(m)
    })
}

pub fn update(s: &ProjectStore, actor: &Actor, id: &Id, patch: MissionPatch) -> Result<Mission> {
    s.write(actor, |tx| {
        let mut m = load_in_tx(tx, id)?;
        let now = now_ms();
        if let Some(n) = patch.name {
            m.name = clean_name("mission name", &n)?;
        }
        if let Some(mode) = patch.orchestrator_mode {
            m.orchestrator_mode = mode;
        }
        if let Some(o) = patch.orchestrator_member_id {
            if let Some(mid) = &o {
                if m.member(mid).is_none() {
                    return Err(CoreError::not_found(format!("member {mid} not found in mission {id}")));
                }
            }
            m.orchestrator_member_id = o;
        }
        if let Some(p) = patch.plan_id {
            m.plan_id = p;
        }
        if let Some(c) = patch.config {
            m.config = clean_config(c);
        }
        if let Some(st) = patch.status {
            apply_mission_status(tx, &mut m, st, now)?;
        }
        save_in_tx(tx, &mut m, now)?;
        Ok(m)
    })
}

/// Delete the mission directory; its issues lose their `missionId`.
pub fn delete(s: &ProjectStore, actor: &Actor, id: &Id) -> Result<()> {
    s.write(actor, |tx| {
        load_in_tx(tx, id)?;
        let now = now_ms();
        for mut i in tx.list::<Issue>()?.items.into_iter().filter(|i| i.mission_id.as_ref() == Some(id)) {
            i.mission_id = None;
            i.updated_at = now;
            tx.put(&i)?;
        }
        for f in [messages_rel(id), activity_rel(id), reads_rel(id), mission_rel(id)] {
            tx.delete_file(&f)?;
        }
        let dir = tx.store().data_dir().join("local").join("missions").join(id.as_str());
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(CoreError::io(&dir, e)),
        }
    })
}

/// Put issues in the mission (sets their `missionId`).
pub fn assign_issues(s: &ProjectStore, actor: &Actor, id: &Id, refs: &[String]) -> Result<Vec<Issue>> {
    if refs.is_empty() {
        return Err(CoreError::invalid_input("no issues given"));
    }
    s.write(actor, |tx| {
        load_in_tx(tx, id)?;
        assign_in_tx(tx, id, refs, now_ms())
    })
}

fn assign_in_tx(tx: &mut Tx, id: &Id, refs: &[String], now: Timestamp) -> Result<Vec<Issue>> {
    // Validate every ref before the first write.
    let ids = refs.iter().map(|r| issues::resolve_in_tx(tx, r)).collect::<Result<Vec<Id>>>()?;
    let mut out = Vec::new();
    for iid in ids {
        let mut i: Issue = tx.get(&iid)?;
        if i.mission_id.as_ref() != Some(id) {
            i.mission_id = Some(id.clone());
            i.updated_at = now;
            tx.put(&i)?;
        }
        out.push(i);
    }
    let numbers: Vec<String> = out.iter().map(|i| format!("#{}", i.number)).collect();
    let ids: Vec<&Id> = out.iter().map(|i| &i.id).collect();
    let a = Act::new(MissionActivityKind::IssuesAssigned, format!("Added issues {}", numbers.join(", ")))
        .meta(serde_json::json!({ "issueIds": ids }));
    log_in_tx(tx, id, a, now)?;
    Ok(out)
}

/// Atomically take the next issue for a member: the highest-priority `todo`
/// issue in the mission with no blockers and no live claim. Claims it (issue
/// assignment, `in_progress`) and assigns it to the member in one transaction.
/// `None` when nothing is available.
pub fn claim_next_issue(s: &ProjectStore, actor: &Actor, id: &Id, member_ref: &str) -> Result<Option<Issue>> {
    s.write(actor, |tx| {
        let mut m = load_in_tx(tx, id)?;
        let idx = member_index(&m, member_ref)?;
        let now = now_ms();
        let mut candidates: Vec<Issue> = tx
            .list::<Issue>()?
            .items
            .into_iter()
            .filter(|i| i.mission_id.as_ref() == Some(id))
            .filter(|i| i.status == IssueStatus::Todo && i.blocked_by.is_empty())
            .filter(|i| i.assignment.as_ref().map_or(true, |a| now - a.last_heartbeat >= CLAIM_TTL_MS))
            .collect();
        issues::sort_issues(&mut candidates);
        let Some(next) = candidates.into_iter().next() else { return Ok(None) };
        let member = m.members[idx].clone();
        let claimed = issues::claim_in_tx(
            tx,
            &next.id,
            ClaimInput {
                agent_label: member.name.clone(),
                terminal_id: member.terminal_id.clone(),
                provider_id: Some(member.provider_id.clone()),
                session_id: member.session_id.clone(),
            },
        )?;
        {
            let mm = &mut m.members[idx];
            mm.assigned_issue_id = Some(claimed.id.clone());
            mm.status = MissionMemberStatus::Working;
            mm.last_heartbeat = Some(now);
            mm.updated_at = now;
        }
        let a = Act::new(MissionActivityKind::IssueClaimed, format!("{} claimed #{}: {}", member.name, claimed.number, claimed.title))
            .member(&member)
            .issue(Some(claimed.id.clone()));
        log_in_tx(tx, id, a, now)?;
        save_in_tx(tx, &mut m, now)?;
        Ok(Some(claimed))
    })
}

// ------------------------------------------------------------------ members

impl NewMissionMember {
    /// A member from an agent definition; `name` / `model` override the definition's.
    pub fn from_definition(def: &AgentDefinition, name: Option<String>, model: Option<String>) -> Self {
        Self {
            agent_definition_id: def.id.to_string(),
            name: clean_opt(name).unwrap_or_else(|| def.name.clone()),
            role: MissionAgentRole::parse(&def.role).unwrap_or(MissionAgentRole::Custom),
            provider_id: def.provider_id.clone(),
            model: clean_opt(model).or_else(|| def.model.clone()),
            system_prompt: def.system_prompt.clone(),
        }
    }
}

pub fn member_add(s: &ProjectStore, actor: &Actor, id: &Id, new: NewMissionMember) -> Result<MissionMember> {
    let name = clean_name("member name", &new.name)?;
    let provider_id = new.provider_id.trim().to_string();
    crate::agents::spec::validate_provider_id(&provider_id)?;
    let agent_definition_id = clean_name("agentDefinitionId", &new.agent_definition_id)?;
    let model = clean_model(new.model)?;
    s.write(actor, |tx| {
        let mut m = load_in_tx(tx, id)?;
        let now = now_ms();
        let member = MissionMember {
            id: new_id(),
            agent_definition_id,
            name,
            role: new.role,
            provider_id,
            model,
            status: MissionMemberStatus::Pending,
            terminal_id: None,
            session_id: None,
            assigned_issue_id: None,
            system_prompt: clean_opt(new.system_prompt),
            worktree_path: None,
            branch_name: None,
            last_heartbeat: None,
            error: None,
            created_at: now,
            updated_at: now,
        };
        m.members.push(member.clone());
        let a = Act::new(MissionActivityKind::MemberJoined, format!("{} joined as {}", member.name, member.role.as_str()))
            .member(&member);
        log_in_tx(tx, id, a, now)?;
        save_in_tx(tx, &mut m, now)?;
        Ok(member)
    })
}

pub fn member_update(s: &ProjectStore, actor: &Actor, id: &Id, member_ref: &str, p: MissionMemberPatch) -> Result<MissionMember> {
    s.write(actor, |tx| {
        let mut m = load_in_tx(tx, id)?;
        let idx = member_index(&m, member_ref)?;
        let now = now_ms();
        let mut acts = Vec::new();
        {
            let mm = &mut m.members[idx];
            if let Some(n) = p.name {
                mm.name = clean_name("member name", &n)?;
            }
            if let Some(model) = p.model {
                mm.model = clean_model(model)?;
            }
            if let Some(t) = p.terminal_id {
                mm.terminal_id = clean_opaque("terminalId", t)?;
            }
            if let Some(sid) = p.session_id {
                let sid = clean_opt(sid);
                if let Some(v) = &sid {
                    issues::validate_session_id(v)?;
                }
                mm.session_id = sid;
            }
            if let Some(sp) = p.system_prompt {
                mm.system_prompt = clean_opt(sp);
            }
            if let Some(w) = p.worktree_path {
                mm.worktree_path = clean_opaque("worktreePath", w)?;
            }
            if let Some(b) = p.branch_name {
                mm.branch_name = clean_opaque("branchName", b)?;
            }
            if let Some(e) = p.error {
                mm.error = clean_opt(e);
            }
            if let Some(a) = p.assigned_issue_id {
                if let Some(iid) = &a {
                    let issue: Issue = tx.get(iid)?;
                    if mm.assigned_issue_id.as_ref() != Some(iid) {
                        acts.push(
                            Act::new(MissionActivityKind::IssuesAssigned, format!("Assigned #{} to {}", issue.number, mm.name))
                                .member(mm)
                                .issue(Some(iid.clone())),
                        );
                    }
                }
                mm.assigned_issue_id = a;
            }
            if let Some(st) = p.status {
                if st != mm.status {
                    match st {
                        MissionMemberStatus::Stopped => {
                            acts.push(Act::new(MissionActivityKind::MemberLeft, format!("{} stopped", mm.name)).member(mm))
                        }
                        MissionMemberStatus::Error => acts.push(
                            Act::new(MissionActivityKind::Error, format!("{}: {}", mm.name, mm.error.as_deref().unwrap_or("error")))
                                .member(mm),
                        ),
                        _ => {}
                    }
                    mm.status = st;
                }
            }
            mm.updated_at = now;
        }
        for a in acts {
            log_in_tx(tx, id, a, now)?;
        }
        let member = m.members[idx].clone();
        save_in_tx(tx, &mut m, now)?;
        Ok(member)
    })
}

pub fn member_remove(s: &ProjectStore, actor: &Actor, id: &Id, member_ref: &str) -> Result<()> {
    s.write(actor, |tx| {
        let mut m = load_in_tx(tx, id)?;
        let idx = member_index(&m, member_ref)?;
        let now = now_ms();
        let member = m.members.remove(idx);
        if m.orchestrator_member_id.as_ref() == Some(&member.id) {
            m.orchestrator_member_id = None;
        }
        log_in_tx(tx, id, Act::new(MissionActivityKind::MemberLeft, format!("{} removed", member.name)).member(&member), now)?;
        save_in_tx(tx, &mut m, now)
    })
}

/// The member is alive: refresh its heartbeat (and the heartbeat of the issue
/// it has claimed). A `pending`/`spawning` member becomes `working`.
pub fn member_heartbeat(s: &ProjectStore, actor: &Actor, id: &Id, member_ref: &str) -> Result<MissionMember> {
    s.write(actor, |tx| {
        let mut m = load_in_tx(tx, id)?;
        let idx = member_index(&m, member_ref)?;
        let now = now_ms();
        let mm = &mut m.members[idx];
        mm.last_heartbeat = Some(now);
        if matches!(mm.status, MissionMemberStatus::Pending | MissionMemberStatus::Spawning) {
            mm.status = MissionMemberStatus::Working;
        }
        mm.updated_at = now;
        if let Some(iid) = mm.assigned_issue_id.clone() {
            match tx.get::<Issue>(&iid) {
                Ok(mut issue) => {
                    if let Some(a) = issue.assignment.as_mut() {
                        a.last_heartbeat = now;
                        issue.updated_at = now;
                        tx.put(&issue)?;
                    }
                }
                Err(e) if e.code == ErrorCode::NotFound => {}
                Err(e) => return Err(e),
            }
        }
        let member = m.members[idx].clone();
        save_in_tx(tx, &mut m, now)?;
        Ok(member)
    })
}

// ------------------------------------------------------------------ messages

pub fn send_message(s: &ProjectStore, actor: &Actor, id: &Id, new: NewMissionMessage) -> Result<MissionMessage> {
    let content = new.content.trim().to_string();
    if content.is_empty() {
        return Err(CoreError::invalid_input("message content must not be empty"));
    }
    if content.len() > MAX_CONTENT {
        return Err(CoreError::invalid_input(format!("message is longer than {MAX_CONTENT} bytes")));
    }
    s.write(actor, |tx| {
        let m = load_in_tx(tx, id)?;
        let now = now_ms();
        let from = match &new.from_member_id {
            Some(f) => Some(m.member(f).ok_or_else(|| CoreError::not_found(format!("member {f} not found in mission {id}")))?),
            None => None,
        };
        if let Some(t) = &new.to_member_id {
            if m.member(t).is_none() {
                return Err(CoreError::not_found(format!("member {t} not found in mission {id}")));
            }
        }
        if let Some(i) = &new.issue_id {
            tx.get::<Issue>(i)?;
        }
        let kind = new.kind.unwrap_or_default();
        let msg = MissionMessage {
            id: new_id(),
            from_member_id: from.map(|f| f.id.clone()),
            from_name: from.map(|f| f.name.clone()).unwrap_or_else(|| tx.actor().name.clone()),
            to_member_id: new.to_member_id.clone(),
            kind,
            content,
            issue_id: new.issue_id.clone(),
            created_at: now,
        };
        tx.append_jsonl(&messages_rel(id), &msg)?;
        if !matches!(kind, MissionMessageKind::Chat | MissionMessageKind::Status) {
            let to = new.to_member_id.as_ref().and_then(|t| m.member(t)).map(|t| t.name.as_str()).unwrap_or("everyone");
            let mut a = Act::new(MissionActivityKind::MessageSent, format!("{} → {}: {}", msg.from_name, to, kind.as_str()))
                .issue(msg.issue_id.clone())
                .meta(serde_json::json!({ "messageId": msg.id }));
            if let Some(f) = from {
                a = a.member(f);
            }
            log_in_tx(tx, id, a, now)?;
        }
        Ok(msg)
    })
}

/// Advance `reader`'s cursor to `up_to` (default: the latest message). Cursors
/// never move backwards.
pub fn mark_read(s: &ProjectStore, actor: &Actor, id: &Id, reader: &str, up_to: Option<&Id>) -> Result<MissionReads> {
    s.write(actor, |tx| {
        let m = load_in_tx(tx, id)?;
        let reader = check_reader(&m, reader)?;
        let all = tx.store().read_jsonl::<MissionMessage>(&messages_rel(id))?.items;
        let target = match up_to {
            Some(u) => {
                all.iter().position(|x| &x.id == u).ok_or_else(|| CoreError::not_found(format!("message {u} not found")))?
            }
            None => match all.len() {
                0 => return reads(tx.store(), id),
                n => n - 1,
            },
        };
        let mut r = reads(tx.store(), id)?;
        let current = r.last_read.get(&reader).and_then(|c| all.iter().position(|x| &x.id == c));
        if current.map_or(true, |c| target > c) {
            r.last_read.insert(reader, all[target].id.clone());
            tx.put_json(&reads_rel(id), &r)?;
        }
        Ok(r)
    })
}

pub fn log_activity(s: &ProjectStore, actor: &Actor, id: &Id, new: NewMissionActivity) -> Result<MissionActivity> {
    let detail = clean_opt(new.detail);
    if detail.as_ref().is_some_and(|d| d.len() > MAX_CONTENT) {
        return Err(CoreError::invalid_input(format!("detail is longer than {MAX_CONTENT} bytes")));
    }
    s.write(actor, |tx| {
        let m = load_in_tx(tx, id)?;
        let mut a = Act {
            kind: new.kind.unwrap_or_default(),
            member: None,
            issue_id: new.issue_id.clone(),
            detail,
            metadata: new.metadata.clone(),
        };
        if let Some(mid) = &new.member_id {
            a = a.member(m.member(mid).ok_or_else(|| CoreError::not_found(format!("member {mid} not found in mission {id}")))?);
        }
        if let Some(i) = &new.issue_id {
            tx.get::<Issue>(i)?;
        }
        log_in_tx(tx, id, a, now_ms())
    })
}

// ------------------------------------------------------------------ proposals

fn clean_agents(agents: Vec<MissionProposedAgent>) -> Result<Vec<MissionProposedAgent>> {
    agents
        .into_iter()
        .map(|mut a| {
            a.name = clean_name("proposed agent name", &a.name)?;
            a.model = clean_model(a.model)?;
            a.agent_definition_id = clean_opt(a.agent_definition_id);
            a.provider_id = clean_opt(a.provider_id);
            if let Some(p) = &a.provider_id {
                crate::agents::spec::validate_provider_id(p)?;
            }
            a.focus = clean_opt(a.focus);
            a.rationale = clean_opt(a.rationale);
            a.allowed_files = clean_strings(a.allowed_files);
            Ok(a)
        })
        .collect()
}

fn check_issue_ids(tx: &Tx, agents: &[MissionProposedAgent]) -> Result<()> {
    for a in agents {
        for i in &a.issue_ids {
            tx.get::<Issue>(i)?;
        }
    }
    Ok(())
}

pub fn proposal_create(s: &ProjectStore, actor: &Actor, id: &Id, new: NewMissionProposal) -> Result<MissionProposal> {
    let goal = clean_name("proposal goal", &new.goal)?;
    let agents = clean_agents(new.agents)?;
    s.write(actor, |tx| {
        let mut m = load_in_tx(tx, id)?;
        check_issue_ids(tx, &agents)?;
        let now = now_ms();
        let p = MissionProposal {
            id: new_id(),
            goal,
            agents,
            estimated_cost_usd: new.estimated_cost_usd,
            estimated_minutes: new.estimated_minutes,
            rationale: clean_opt(new.rationale),
            status: MissionProposalStatus::Pending,
            created_at: now,
            updated_at: now,
        };
        m.proposals.push(p.clone());
        let a = Act::new(MissionActivityKind::ProposalCreated, format!("Proposal: {} ({} agents)", p.goal, p.agents.len()))
            .meta(serde_json::json!({ "proposalId": p.id }));
        log_in_tx(tx, id, a, now)?;
        save_in_tx(tx, &mut m, now)?;
        Ok(p)
    })
}

fn proposal_index(m: &Mission, pid: &Id) -> Result<usize> {
    m.proposals.iter().position(|p| &p.id == pid).ok_or_else(|| CoreError::not_found(format!("proposal {pid} not found")))
}

pub fn proposal_update_status(
    s: &ProjectStore,
    actor: &Actor,
    id: &Id,
    proposal_id: &Id,
    status: MissionProposalStatus,
) -> Result<MissionProposal> {
    s.write(actor, |tx| {
        let mut m = load_in_tx(tx, id)?;
        let idx = proposal_index(&m, proposal_id)?;
        let now = now_ms();
        let p = &mut m.proposals[idx];
        if p.status == status {
            return Ok(p.clone());
        }
        if matches!(p.status, MissionProposalStatus::Approved | MissionProposalStatus::Rejected) {
            return Err(CoreError::conflict(format!("proposal is already {}", p.status.as_str())));
        }
        p.status = status;
        p.updated_at = now;
        let p = p.clone();
        let a = Act::new(MissionActivityKind::ProposalUpdated, format!("Proposal {}: {}", status.as_str(), p.goal))
            .meta(serde_json::json!({ "proposalId": p.id, "status": status }));
        log_in_tx(tx, id, a, now)?;
        save_in_tx(tx, &mut m, now)?;
        Ok(p)
    })
}

pub fn proposal_modify(
    s: &ProjectStore,
    actor: &Actor,
    id: &Id,
    proposal_id: &Id,
    patch: MissionProposalPatch,
) -> Result<MissionProposal> {
    let goal = patch.goal.as_deref().map(|g| clean_name("proposal goal", g)).transpose()?;
    let agents = patch.agents.map(clean_agents).transpose()?;
    s.write(actor, |tx| {
        let mut m = load_in_tx(tx, id)?;
        let idx = proposal_index(&m, proposal_id)?;
        if let Some(a) = &agents {
            check_issue_ids(tx, a)?;
        }
        let now = now_ms();
        let p = &mut m.proposals[idx];
        if matches!(p.status, MissionProposalStatus::Approved | MissionProposalStatus::Rejected) {
            return Err(CoreError::conflict(format!("proposal is already {}", p.status.as_str())));
        }
        if let Some(g) = goal {
            p.goal = g;
        }
        if let Some(a) = agents {
            p.agents = a;
        }
        if let Some(c) = patch.estimated_cost_usd {
            p.estimated_cost_usd = c;
        }
        if let Some(mi) = patch.estimated_minutes {
            p.estimated_minutes = mi;
        }
        if let Some(r) = patch.rationale {
            p.rationale = clean_opt(r);
        }
        p.status = MissionProposalStatus::Modified;
        p.updated_at = now;
        let p = p.clone();
        save_in_tx(tx, &mut m, now)?;
        Ok(p)
    })
}

// ------------------------------------------------------------------ merge queue

/// The merge queue in processing order (priority, then position).
pub fn merge_queue(s: &ProjectStore, id: &Id) -> Result<Vec<MissionMergeEntry>> {
    let mut q = get(s, id)?.merge_queue;
    sort_queue(&mut q);
    Ok(q)
}

fn sort_queue(q: &mut [MissionMergeEntry]) {
    q.sort_by(|a, b| b.priority.cmp(&a.priority).then(a.position.cmp(&b.position)));
}

fn enqueue_in_tx(
    tx: &mut Tx,
    m: &mut Mission,
    member: &MissionMember,
    branch_name: String,
    worktree_path: String,
    issue_id: Option<Id>,
    priority: Priority,
    now: Timestamp,
) -> Result<MissionMergeEntry> {
    let position = m.merge_queue.iter().map(|e| e.position).max().unwrap_or(0) + 1;
    let e = MissionMergeEntry {
        id: new_id(),
        member_id: member.id.clone(),
        branch_name,
        worktree_path,
        issue_id,
        status: MissionMergeStatus::Queued,
        position,
        priority,
        skip_reason: None,
        created_at: now,
        merged_at: None,
    };
    m.merge_queue.push(e.clone());
    let a = Act::new(MissionActivityKind::MergeQueued, format!("{} queued branch {}", member.name, e.branch_name))
        .member(member)
        .issue(e.issue_id.clone())
        .meta(serde_json::json!({ "entryId": e.id }));
    log_in_tx(tx, &m.id.clone(), a, now)?;
    Ok(e)
}

pub fn merge_enqueue(s: &ProjectStore, actor: &Actor, id: &Id, new: NewMissionMergeEntry) -> Result<MissionMergeEntry> {
    let branch = clean_opaque("branchName", Some(new.branch_name))?
        .ok_or_else(|| CoreError::invalid_input("branchName must not be empty"))?;
    let worktree = clean_opaque("worktreePath", Some(new.worktree_path))?
        .ok_or_else(|| CoreError::invalid_input("worktreePath must not be empty"))?;
    s.write(actor, |tx| {
        let mut m = load_in_tx(tx, id)?;
        let member = m.member(&new.member_id).cloned().ok_or_else(|| CoreError::not_found(format!("member {} not found", new.member_id)))?;
        if let Some(i) = &new.issue_id {
            tx.get::<Issue>(i)?;
        }
        let now = now_ms();
        let e = enqueue_in_tx(tx, &mut m, &member, branch, worktree, new.issue_id.clone(), new.priority.unwrap_or_default(), now)?;
        save_in_tx(tx, &mut m, now)?;
        Ok(e)
    })
}

/// Take the next `queued` entry (marks it `merging`). `None` if the queue is
/// empty or an entry is already merging.
pub fn merge_next(s: &ProjectStore, actor: &Actor, id: &Id) -> Result<Option<MissionMergeEntry>> {
    s.write(actor, |tx| {
        let mut m = load_in_tx(tx, id)?;
        if m.merge_queue.iter().any(|e| e.status == MissionMergeStatus::Merging) {
            return Ok(None);
        }
        let mut order: Vec<&MissionMergeEntry> = m.merge_queue.iter().filter(|e| e.status == MissionMergeStatus::Queued).collect();
        order.sort_by(|a, b| b.priority.cmp(&a.priority).then(a.position.cmp(&b.position)));
        let Some(next) = order.first().map(|e| e.id.clone()) else { return Ok(None) };
        let now = now_ms();
        let e = m.merge_queue.iter_mut().find(|e| e.id == next).expect("entry exists");
        e.status = MissionMergeStatus::Merging;
        let e = e.clone();
        save_in_tx(tx, &mut m, now)?;
        Ok(Some(e))
    })
}

pub fn merge_update(s: &ProjectStore, actor: &Actor, id: &Id, entry_id: &Id, p: MissionMergeEntryPatch) -> Result<MissionMergeEntry> {
    s.write(actor, |tx| {
        let mut m = load_in_tx(tx, id)?;
        let now = now_ms();
        let idx = m
            .merge_queue
            .iter()
            .position(|e| &e.id == entry_id)
            .ok_or_else(|| CoreError::not_found(format!("merge queue entry {entry_id} not found")))?;
        let mut completed = None;
        {
            let e = &mut m.merge_queue[idx];
            if let Some(pr) = p.priority {
                e.priority = pr;
            }
            if let Some(r) = p.skip_reason {
                e.skip_reason = clean_opt(r);
            }
            if let Some(st) = p.status {
                if st != e.status {
                    e.status = st;
                    e.merged_at = (st == MissionMergeStatus::Merged).then_some(now);
                    if matches!(st, MissionMergeStatus::Merged | MissionMergeStatus::Failed | MissionMergeStatus::Skipped) {
                        completed = Some(e.clone());
                    }
                }
            }
        }
        if let Some(e) = completed {
            let kind = if e.status == MissionMergeStatus::Failed { MissionActivityKind::Error } else { MissionActivityKind::MergeCompleted };
            let mut a = Act::new(kind, format!("Branch {} {}", e.branch_name, e.status.as_str()))
                .issue(e.issue_id.clone())
                .meta(serde_json::json!({ "entryId": e.id, "status": e.status }));
            if let Some(mm) = m.member(&e.member_id) {
                a = a.member(mm);
            }
            log_in_tx(tx, id, a, now)?;
        }
        let e = m.merge_queue[idx].clone();
        save_in_tx(tx, &mut m, now)?;
        Ok(e)
    })
}

// ------------------------------------------------------------------ issue hook

/// §6.3 invariant 4, called by the issue domain inside its transaction when an
/// issue with a `missionId` changes status: logs `status_changed`; on `done`
/// the member working it goes `idle` and its branch is queued for merge.
pub(crate) fn on_issue_status_in_tx(tx: &mut Tx, issue: &Issue, from: IssueStatus, to: IssueStatus, now: Timestamp) -> Result<()> {
    let Some(mid) = issue.mission_id.clone() else { return Ok(()) };
    let Some(mut m) = tx.store().read_json::<Mission>(&mission_rel(&mid))? else { return Ok(()) };
    let idx = m.members.iter().position(|x| x.assigned_issue_id.as_ref() == Some(&issue.id));
    let mut a = Act::new(
        MissionActivityKind::StatusChanged,
        format!("#{} {}: {} → {}", issue.number, issue.title, from.as_str(), to.as_str()),
    )
    .issue(Some(issue.id.clone()))
    .meta(serde_json::json!({ "from": from, "to": to, "number": issue.number }));
    if let Some(i) = idx {
        a = a.member(&m.members[i]);
    }
    log_in_tx(tx, &mid, a, now)?;
    let Some(i) = idx.filter(|_| to == IssueStatus::Done) else { return Ok(()) };
    let member = m.members[i].clone();
    if member.status == MissionMemberStatus::Working {
        m.members[i].status = MissionMemberStatus::Idle;
        m.members[i].updated_at = now;
    }
    if let (Some(branch), Some(worktree)) = (member.branch_name.clone(), member.worktree_path.clone()) {
        let queued = m.merge_queue.iter().any(|e| e.member_id == member.id && e.issue_id.as_ref() == Some(&issue.id));
        if !queued {
            enqueue_in_tx(tx, &mut m, &member, branch, worktree, Some(issue.id.clone()), issue.priority, now)?;
        }
    }
    save_in_tx(tx, &mut m, now)
}

// ------------------------------------------------------------------ templates

/// Built-ins first, then custom templates (`mission-templates/<id>.json`) by name.
pub fn templates_list(s: &ProjectStore) -> Result<ListResult<MissionTemplate>> {
    let custom = s.list::<MissionTemplate>()?;
    let mut items = builtin_templates();
    let mut c = custom.items;
    c.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    items.extend(c);
    Ok(ListResult { items, errors: custom.errors })
}

pub fn template_get(s: &ProjectStore, id: &Id) -> Result<MissionTemplate> {
    if id.is_builtin() {
        return builtin_templates()
            .into_iter()
            .find(|t| &t.id == id)
            .ok_or_else(|| CoreError::not_found(format!("mission template {id} not found")));
    }
    s.get(id)
}

pub fn template_upsert(s: &ProjectStore, actor: &Actor, input: MissionTemplateInput) -> Result<MissionTemplate> {
    if input.id.as_ref().is_some_and(Id::is_builtin) {
        return Err(CoreError::conflict("built-in mission templates cannot be modified"));
    }
    let name = clean_name("template name", &input.name)?;
    let config = clean_config(MissionConfig {
        workflow_phases: input.workflow_phases,
        skills_used: input.skills_used,
        success_criteria: input.success_criteria,
        orchestrator_prompt_extra: input.orchestrator_prompt_extra,
        member_prompt_extra: input.member_prompt_extra,
    });
    s.write(actor, |tx| {
        let now = now_ms();
        let existing = match &input.id {
            Some(id) => Some(tx.get::<MissionTemplate>(id)?),
            None => None,
        };
        let t = MissionTemplate {
            id: existing.as_ref().map(|e| e.id.clone()).unwrap_or_else(new_id),
            name,
            description: clean_opt(input.description),
            category: input.category.unwrap_or_default(),
            workflow_phases: config.workflow_phases,
            skills_used: config.skills_used,
            success_criteria: config.success_criteria,
            orchestrator_prompt_extra: config.orchestrator_prompt_extra,
            member_prompt_extra: config.member_prompt_extra,
            built_in: false,
            created_at: existing.as_ref().map_or(now, |e| e.created_at),
            created_by: existing.as_ref().map_or_else(|| tx.actor().clone(), |e| e.created_by.clone()),
            updated_at: now,
            ext: existing.map(|e| e.ext).unwrap_or_default(),
        };
        tx.put(&t)?;
        Ok(t)
    })
}

pub fn template_delete(s: &ProjectStore, actor: &Actor, id: &Id) -> Result<()> {
    if id.is_builtin() {
        return Err(CoreError::conflict("built-in mission templates cannot be deleted"));
    }
    s.write(actor, |tx| tx.delete::<MissionTemplate>(id))
}

// ------------------------------------------------------------------ agent definitions

/// Built-in definitions (consts) followed by custom ones (app DB).
pub fn agent_definitions_list(db: &AppDb) -> Result<Vec<AgentDefinition>> {
    agent_definitions::list(db, &builtin_agent_definitions())
}

/// A built-in (`builtin-*`) or custom definition.
pub fn agent_definition_get(db: &AppDb, id: &str) -> Result<AgentDefinition> {
    if let Some(d) = builtin_agent_definition(id) {
        return Ok(d);
    }
    let id = Id::parse(id)?;
    if id.is_builtin() {
        return Err(CoreError::not_found(format!("agent definition {id}")));
    }
    agent_definitions::get(db, &id)
}

/// Resolve the definition and add the member.
pub fn member_add_from_definition(
    s: &ProjectStore,
    db: &AppDb,
    actor: &Actor,
    id: &Id,
    input: MissionMemberAddInput,
) -> Result<MissionMember> {
    let def = agent_definition_get(db, &input.agent_definition_id)?;
    member_add(s, actor, id, NewMissionMember::from_definition(&def, input.name, input.model))
}

/// Project code, for human output.
pub fn project_code(s: &ProjectStore) -> String {
    project_config::read(s).map(|c| c.code).unwrap_or_default()
}
