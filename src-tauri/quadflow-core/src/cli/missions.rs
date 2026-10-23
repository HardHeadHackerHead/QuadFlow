//! `quadflow missions …` (data-layer.md §6.8, §6.9, §11). Thin layer over
//! `domains::missions`: parses arguments, resolves member / issue refs, prints
//! the JSON envelope or human output. Mission agents drive their whole loop
//! through these subcommands (heartbeat, inbox, send, claim-next, …).

use super::output::Out;
use super::Ctx;
use crate::domains::app::agent_definitions::{self, AgentDefinition, AgentDefinitionInput};
use crate::domains::issues::{self, Issue, Priority};
use crate::domains::missions::{
    self as svc, Mission, MissionActivity, MissionActivityKind, MissionAgentRole, MissionMember, MissionMemberAddInput,
    MissionMemberPatch, MissionMemberStatus, MissionMergeEntry, MissionMergeEntryPatch, MissionMergeStatus,
    MissionMessage, MissionMessageKind, MissionMessageQuery, MissionOrchestratorMode, MissionPatch, MissionProposal,
    MissionProposalPatch, MissionProposalStatus, MissionProposedAgent, MissionStatus, MissionTemplate,
    MissionTemplateInput, NewMission, NewMissionActivity, NewMissionMergeEntry, NewMissionMessage, NewMissionProposal,
};
use crate::error::{CoreError, Result};
use crate::events::EventBus;
use crate::ids::Id;
use crate::paths::{AppPaths, ENV_DATA_DIR};
use crate::store::{AppDb, ProjectStore};
use clap::{Args, Subcommand};
use std::io::Write;
use std::path::PathBuf;

// ------------------------------------------------------------------ parsing

fn parse_id(s: &str) -> std::result::Result<Id, String> {
    Id::parse(s).map_err(|e| e.message)
}

macro_rules! enum_parser {
    ($f:ident, $t:ty, $what:literal) => {
        fn $f(s: &str) -> std::result::Result<$t, String> {
            <$t>::parse(s).ok_or_else(|| format!("invalid {} {s:?}; expected one of {}", $what, <$t>::expected()))
        }
    };
}
enum_parser!(parse_status, MissionStatus, "mission status");
enum_parser!(parse_mode, MissionOrchestratorMode, "orchestrator mode");
enum_parser!(parse_member_status, MissionMemberStatus, "member status");
enum_parser!(parse_kind, MissionMessageKind, "message kind");
enum_parser!(parse_activity_kind, MissionActivityKind, "activity kind");
enum_parser!(parse_proposal_status, MissionProposalStatus, "proposal status");
enum_parser!(parse_merge_status, MissionMergeStatus, "merge status");
enum_parser!(parse_role, MissionAgentRole, "role");

fn parse_priority(s: &str) -> std::result::Result<Priority, String> {
    super::issues::parse_priority(s)
}

fn split_list(s: &str) -> Vec<String> {
    s.split(',').map(str::trim).filter(|x| !x.is_empty()).map(str::to_string).collect()
}

/// `none` / `""` → clear.
fn clearable(v: &str) -> Option<String> {
    let t = v.trim();
    if t.is_empty() || t.eq_ignore_ascii_case("none") || t.eq_ignore_ascii_case("null") {
        None
    } else {
        Some(t.to_string())
    }
}

fn json_arg<T: serde::de::DeserializeOwned>(what: &str, s: &str) -> Result<T> {
    serde_json::from_str(s).map_err(|e| CoreError::invalid_input(format!("--{what} is not valid JSON: {e}")))
}

// --------------------------------------------------------------------- args

#[derive(Subcommand, Debug)]
pub enum MissionsAction {
    /// List missions (newest first).
    List {
        #[arg(long, value_parser = parse_status)]
        status: Option<MissionStatus>,
    },
    /// Show a mission (members, proposals, merge queue).
    Get(MissionArg),
    /// Create a mission.
    Create(CreateArgs),
    /// Update a mission's name, status, orchestrator mode, orchestrator or plan.
    Update(UpdateArgs),
    /// Delete a mission (its issues are released from it).
    Delete(MissionArg),
    /// Progress computed from the mission's issues.
    Progress(MissionArg),
    /// Issues in the mission.
    Issues(MissionArg),
    /// Put issues in the mission.
    Assign {
        #[arg(value_parser = parse_id)]
        mission: Id,
        /// Issue refs (id, CODE-n, #n, n).
        #[arg(required = true)]
        issues: Vec<String>,
    },
    /// Atomically claim the next available issue for a member (prints null if none).
    ClaimNext(MemberArgs),
    /// List the mission's members.
    Members(MissionArg),
    /// Add a member from an agent definition (see `missions agents`).
    MemberAdd(MemberAddArgs),
    /// Update a member (status, terminal, session, assigned issue, worktree, …).
    MemberUpdate(MemberUpdateArgs),
    /// Remove a member.
    MemberRemove(MemberArgs),
    /// Report that a member is alive (also refreshes its claimed issue).
    Heartbeat(MemberArgs),
    /// Send a message to a member (--to) or to everyone.
    Send(SendArgs),
    /// List messages.
    Messages(MessagesArgs),
    /// Unread messages for a member (or "human"); marks them read unless --peek.
    Inbox {
        #[arg(value_parser = parse_id)]
        mission: Id,
        /// Member id or name, or "human".
        reader: String,
        #[arg(long)]
        peek: bool,
    },
    /// Mark messages read up to a message (default: the latest).
    MarkRead {
        #[arg(value_parser = parse_id)]
        mission: Id,
        reader: String,
        #[arg(long, value_parser = parse_id)]
        up_to: Option<Id>,
    },
    /// Number of unread messages for a reader.
    Unread {
        #[arg(value_parser = parse_id)]
        mission: Id,
        reader: String,
    },
    /// The mission's activity log.
    Activity {
        #[arg(value_parser = parse_id)]
        mission: Id,
        #[arg(long, value_parser = parse_id)]
        since: Option<Id>,
        #[arg(long)]
        limit: Option<u32>,
    },
    /// Log a decision / note to the activity feed.
    Log(LogArgs),
    /// Propose a team (the human approves it in the Missions UI).
    Propose(ProposeArgs),
    /// List the mission's proposals.
    Proposals(MissionArg),
    /// Set a proposal's status.
    ProposalStatus {
        #[arg(value_parser = parse_id)]
        mission: Id,
        #[arg(value_parser = parse_id)]
        proposal: Id,
        #[arg(value_parser = parse_proposal_status)]
        status: MissionProposalStatus,
    },
    /// Edit a pending proposal (status becomes `modified`).
    ProposalModify(ProposalModifyArgs),
    /// Queue a member's branch for merging.
    MergeEnqueue(MergeEnqueueArgs),
    /// The merge queue in processing order.
    MergeQueue(MissionArg),
    /// Take the next queued branch (marks it `merging`; null if none).
    MergeNext(MissionArg),
    /// Update a merge queue entry.
    MergeUpdate(MergeUpdateArgs),
    /// Mission templates (built-in and custom).
    Templates,
    /// Show one template.
    Template {
        #[arg(value_parser = parse_id)]
        id: Id,
    },
    /// Create or replace a custom template from JSON (MissionTemplateInput).
    TemplateUpsert {
        /// JSON object (`{"name": …, "category": …, "workflowPhases": [...]}`).
        input: String,
    },
    /// Delete a custom template.
    TemplateDelete {
        #[arg(value_parser = parse_id)]
        id: Id,
    },
    /// Agent definitions (built-in and custom).
    Agents,
    /// Create or replace a custom agent definition.
    AgentUpsert(AgentUpsertArgs),
    /// Delete a custom agent definition.
    AgentDelete {
        #[arg(value_parser = parse_id)]
        id: Id,
    },
}

#[derive(Args, Debug)]
pub struct MissionArg {
    #[arg(value_parser = parse_id)]
    mission: Id,
}

#[derive(Args, Debug)]
pub struct MemberArgs {
    #[arg(value_parser = parse_id)]
    mission: Id,
    /// Member id or (unique) name.
    member: String,
}

#[derive(Args, Debug)]
pub struct CreateArgs {
    name: String,
    /// Template id (copies its playbook), e.g. builtin-feature-build.
    #[arg(long, value_parser = parse_id)]
    template: Option<Id>,
    /// manual | on_demand | persistent (default manual).
    #[arg(long, value_parser = parse_mode)]
    mode: Option<MissionOrchestratorMode>,
    #[arg(long, value_parser = parse_id)]
    plan: Option<Id>,
    /// Comma-separated issue refs to put in the mission.
    #[arg(long)]
    issues: Option<String>,
}

#[derive(Args, Debug)]
pub struct UpdateArgs {
    #[arg(value_parser = parse_id)]
    mission: Id,
    #[arg(long)]
    name: Option<String>,
    #[arg(long, value_parser = parse_status)]
    status: Option<MissionStatus>,
    #[arg(long, value_parser = parse_mode)]
    mode: Option<MissionOrchestratorMode>,
    /// Orchestrator member id or name; "none" clears.
    #[arg(long)]
    orchestrator: Option<String>,
    /// Plan id; "none" clears.
    #[arg(long)]
    plan: Option<String>,
}

#[derive(Args, Debug)]
pub struct MemberAddArgs {
    #[arg(value_parser = parse_id)]
    mission: Id,
    /// Agent definition id (e.g. builtin-fullstack-dev).
    agent_definition: String,
    #[arg(long)]
    name: Option<String>,
    #[arg(long)]
    model: Option<String>,
}

#[derive(Args, Debug)]
pub struct MemberUpdateArgs {
    #[arg(value_parser = parse_id)]
    mission: Id,
    member: String,
    #[arg(long)]
    name: Option<String>,
    #[arg(long, value_parser = parse_member_status)]
    status: Option<MissionMemberStatus>,
    /// "none" clears (also for the options below).
    #[arg(long)]
    model: Option<String>,
    #[arg(long)]
    terminal: Option<String>,
    #[arg(long)]
    session: Option<String>,
    /// Assigned issue ref.
    #[arg(long)]
    issue: Option<String>,
    #[arg(long)]
    worktree: Option<String>,
    #[arg(long)]
    branch: Option<String>,
    #[arg(long)]
    error: Option<String>,
}

#[derive(Args, Debug)]
pub struct SendArgs {
    #[arg(value_parser = parse_id)]
    mission: Id,
    /// Message text.
    content: String,
    /// Sender member id or name (omit when a human sends).
    #[arg(long)]
    from: Option<String>,
    /// Recipient member id or name (omit to broadcast).
    #[arg(long)]
    to: Option<String>,
    /// chat | status | finding | blocker | completion | assignment | help_request | review | question | answer | decision | handoff
    #[arg(long, value_parser = parse_kind)]
    kind: Option<MissionMessageKind>,
    /// Related issue ref.
    #[arg(long)]
    issue: Option<String>,
}

#[derive(Args, Debug)]
pub struct MessagesArgs {
    #[arg(value_parser = parse_id)]
    mission: Id,
    /// Only messages after this message id.
    #[arg(long, value_parser = parse_id)]
    since: Option<Id>,
    /// Only messages to this member (id or name) and broadcasts.
    #[arg(long = "for")]
    for_member: Option<String>,
    /// The newest N messages.
    #[arg(long)]
    limit: Option<u32>,
}

#[derive(Args, Debug)]
pub struct LogArgs {
    #[arg(value_parser = parse_id)]
    mission: Id,
    detail: String,
    #[arg(long, value_parser = parse_activity_kind)]
    kind: Option<MissionActivityKind>,
    /// Member id or name.
    #[arg(long)]
    member: Option<String>,
    /// Issue ref.
    #[arg(long)]
    issue: Option<String>,
}

#[derive(Args, Debug)]
pub struct ProposeArgs {
    #[arg(value_parser = parse_id)]
    mission: Id,
    #[arg(long)]
    goal: String,
    /// JSON array of agents: [{"name","role","issueIds":[…],"allowedFiles":[…],"rationale"}]; issue refs are accepted in issueIds.
    #[arg(long)]
    agents: Option<String>,
    /// Add one agent: "<role>:<name>" (repeatable; combine with --agents).
    #[arg(long = "agent")]
    agent: Vec<String>,
    #[arg(long)]
    cost: Option<f64>,
    #[arg(long)]
    minutes: Option<u32>,
    #[arg(long)]
    rationale: Option<String>,
}

#[derive(Args, Debug)]
pub struct ProposalModifyArgs {
    #[arg(value_parser = parse_id)]
    mission: Id,
    #[arg(value_parser = parse_id)]
    proposal: Id,
    #[arg(long)]
    goal: Option<String>,
    /// JSON array of agents (replaces them).
    #[arg(long)]
    agents: Option<String>,
    #[arg(long)]
    cost: Option<f64>,
    #[arg(long)]
    minutes: Option<u32>,
    #[arg(long)]
    rationale: Option<String>,
}

#[derive(Args, Debug)]
pub struct MergeEnqueueArgs {
    #[arg(value_parser = parse_id)]
    mission: Id,
    /// Member id or name.
    member: String,
    /// Default: the member's branch.
    #[arg(long)]
    branch: Option<String>,
    /// Default: the member's worktree.
    #[arg(long)]
    worktree: Option<String>,
    /// Issue ref (default: the member's assigned issue).
    #[arg(long)]
    issue: Option<String>,
    #[arg(long, value_parser = parse_priority)]
    priority: Option<Priority>,
}

#[derive(Args, Debug)]
pub struct MergeUpdateArgs {
    #[arg(value_parser = parse_id)]
    mission: Id,
    #[arg(value_parser = parse_id)]
    entry: Id,
    #[arg(long, value_parser = parse_merge_status)]
    status: Option<MissionMergeStatus>,
    #[arg(long, value_parser = parse_priority)]
    priority: Option<Priority>,
    /// "none" clears.
    #[arg(long)]
    reason: Option<String>,
}

#[derive(Args, Debug)]
pub struct AgentUpsertArgs {
    /// Existing custom definition id (omit to create).
    #[arg(long, value_parser = parse_id)]
    id: Option<Id>,
    #[arg(long)]
    name: String,
    #[arg(long, value_parser = parse_role)]
    role: MissionAgentRole,
    /// Agent provider id (default: `default` = the user's default provider).
    #[arg(long)]
    provider: Option<String>,
    #[arg(long)]
    model: Option<String>,
    #[arg(long)]
    description: Option<String>,
    #[arg(long)]
    system_prompt: Option<String>,
}

// ----------------------------------------------------------------- dispatch

fn app_db(ctx: &Ctx) -> Result<AppDb> {
    let paths = AppPaths::resolve_with(ctx.profile, ctx.env.var(ENV_DATA_DIR).map(PathBuf::from), dirs::data_dir())?;
    AppDb::open(&paths, EventBus::new())
}

fn member_id(s: &ProjectStore, mission: &Id, r: &str) -> Result<Id> {
    let m = svc::get(s, mission)?;
    let r = r.trim();
    if let Ok(id) = Id::parse(r) {
        if m.member(&id).is_some() {
            return Ok(id);
        }
    }
    let hits: Vec<&MissionMember> = m.members.iter().filter(|x| x.name.eq_ignore_ascii_case(r)).collect();
    match hits.as_slice() {
        [one] => Ok(one.id.clone()),
        [] => Err(CoreError::not_found(format!("member {r:?} not found in mission {mission}"))),
        _ => Err(CoreError::invalid_input(format!("member name {r:?} is ambiguous; use the member id"))),
    }
}

fn issue_id(s: &ProjectStore, r: &str) -> Result<Id> {
    issues::refs::resolve(s, r)
}

/// Issue ids in a proposal may be given as refs (`CODE-n`, `#n`).
fn proposed_agents(s: &ProjectStore, json: Option<&str>, short: &[String]) -> Result<Vec<MissionProposedAgent>> {
    let mut out: Vec<MissionProposedAgent> = Vec::new();
    if let Some(j) = json {
        let raw: Vec<serde_json::Value> = json_arg("agents", j)?;
        for mut v in raw {
            if let Some(ids) = v.get_mut("issueIds").and_then(|x| x.as_array_mut()) {
                for x in ids.iter_mut() {
                    if let Some(r) = x.as_str() {
                        *x = serde_json::Value::String(issue_id(s, r)?.to_string());
                    }
                }
            }
            out.push(serde_json::from_value(v).map_err(|e| CoreError::invalid_input(format!("--agents: {e}")))?);
        }
    }
    for a in short {
        let (role, name) = a
            .split_once(':')
            .ok_or_else(|| CoreError::invalid_input(format!("--agent {a:?}: expected <role>:<name>")))?;
        let role = parse_role(role).map_err(CoreError::invalid_input)?;
        out.push(MissionProposedAgent { name: name.to_string(), role, ..Default::default() });
    }
    Ok(out)
}

pub fn handle(ctx: &Ctx, out: &mut Out, action: MissionsAction) -> i32 {
    // App-DB-only subcommands work outside a project.
    match action {
        MissionsAction::Agents => {
            return out.result(app_db(ctx).and_then(|db| svc::agent_definitions_list(&db)), print_agents);
        }
        MissionsAction::AgentUpsert(u) => {
            let input = AgentDefinitionInput {
                id: u.id,
                name: u.name,
                description: u.description,
                role: u.role.as_str().to_string(),
                provider_id: u.provider.unwrap_or_else(|| svc::BUILTIN_AGENT_PROVIDER.to_string()),
                model: u.model,
                system_prompt: u.system_prompt,
            };
            let res = input
                .model
                .as_deref()
                .map_or(Ok(()), svc::validate_model)
                .and_then(|()| app_db(ctx))
                .and_then(|db| agent_definitions::upsert(&db, input));
            return out.result(res, |w, d| print_agents(w, &vec![d.clone()]));
        }
        MissionsAction::AgentDelete { id } => {
            let res = app_db(ctx).and_then(|db| agent_definitions::delete(&db, &id)).map(|()| serde_json::json!({ "id": id }));
            return out.result(res, |w, _| writeln!(w, "Deleted agent definition {id}"));
        }
        action => handle_project(ctx, out, action),
    }
}

fn handle_project(ctx: &Ctx, out: &mut Out, action: MissionsAction) -> i32 {
    let store = match ctx.project_store() {
        Ok(s) => s,
        Err(e) => return out.err(&e),
    };
    let s = &store;
    let a = &ctx.actor;
    let one = |out: &mut Out, r: Result<Mission>| out.result(r, |w, m| print_mission(w, m));
    let member = |out: &mut Out, r: Result<MissionMember>| out.result(r, |w, m| print_members(w, std::slice::from_ref(m)));
    match action {
        MissionsAction::Agents | MissionsAction::AgentUpsert(_) | MissionsAction::AgentDelete { .. } => unreachable!(),
        MissionsAction::List { status } => match svc::list(s, status) {
            Ok(res) => out.ok(&res.items, &res.errors, |w| {
                for m in &res.items {
                    writeln!(w, "{}  {:<10} {:<10} {} ({} members)", m.id, m.status.as_str(), m.orchestrator_mode.as_str(), m.name, m.members.len())?;
                }
                if res.items.is_empty() {
                    writeln!(w, "No missions.")?;
                }
                Ok(())
            }),
            Err(e) => out.err(&e),
        },
        MissionsAction::Get(m) => one(out, svc::get(s, &m.mission)),
        MissionsAction::Create(c) => one(
            out,
            svc::create(s, a, NewMission {
                name: c.name,
                plan_id: c.plan,
                template_id: c.template,
                orchestrator_mode: c.mode,
                config: None,
                issue_refs: c.issues.as_deref().map(split_list).unwrap_or_default(),
            }),
        ),
        MissionsAction::Update(u) => {
            let res = (|| {
                let orchestrator = match u.orchestrator.as_deref() {
                    None => None,
                    Some(o) => Some(match clearable(o) {
                        None => None,
                        Some(r) => Some(member_id(s, &u.mission, &r)?),
                    }),
                };
                let plan = match u.plan.as_deref() {
                    None => None,
                    Some(p) => Some(clearable(p).map(|p| Id::parse(&p)).transpose()?),
                };
                svc::update(s, a, &u.mission, MissionPatch {
                    name: u.name,
                    status: u.status,
                    orchestrator_mode: u.mode,
                    orchestrator_member_id: orchestrator,
                    plan_id: plan,
                    config: None,
                })
            })();
            one(out, res)
        }
        MissionsAction::Delete(m) => out.result(svc::delete(s, a, &m.mission).map(|()| serde_json::json!({ "id": m.mission })), |w, _| {
            writeln!(w, "Deleted mission {}", m.mission)
        }),
        MissionsAction::Progress(m) => out.result(svc::progress(s, &m.mission), |w, p| {
            writeln!(w, "{} issues · {} of {} members active", p.total, p.active_members, p.total_members)?;
            for (st, n) in p.by_status.iter().filter(|(_, n)| **n > 0) {
                writeln!(w, "  {:<12} {n}", st.as_str())?;
            }
            Ok(())
        }),
        MissionsAction::Issues(m) => match svc::issues(s, &m.mission) {
            Ok(res) => {
                let code = svc::project_code(s);
                out.ok(&res.items, &res.errors, |w| print_issues(w, &code, &res.items))
            }
            Err(e) => out.err(&e),
        },
        MissionsAction::Assign { mission, issues } => {
            let code = svc::project_code(s);
            out.result(svc::assign_issues(s, a, &mission, &issues), |w, v| print_issues(w, &code, v))
        }
        MissionsAction::ClaimNext(m) => {
            let code = svc::project_code(s);
            out.result(svc::claim_next_issue(s, a, &m.mission, &m.member), |w, i| match i {
                Some(i) => writeln!(w, "Claimed {}: {}", issues::format_ref(&code, i.number), i.title),
                None => writeln!(w, "No issue available."),
            })
        }
        MissionsAction::Members(m) => out.result(svc::get(s, &m.mission).map(|m| m.members), |w, v| print_members(w, v)),
        MissionsAction::MemberAdd(m) => {
            let input = MissionMemberAddInput { agent_definition_id: m.agent_definition.clone(), name: m.name, model: m.model };
            let res = match svc::builtins::builtin_agent_definition(&m.agent_definition) {
                Some(def) => svc::member_add(s, a, &m.mission, crate::domains::missions::NewMissionMember::from_definition(&def, input.name, input.model)),
                None => app_db(ctx).and_then(|db| svc::member_add_from_definition(s, &db, a, &m.mission, input)),
            };
            member(out, res)
        }
        MissionsAction::MemberUpdate(u) => {
            let res = (|| {
                let issue = match u.issue.as_deref() {
                    None => None,
                    Some(r) => Some(clearable(r).map(|r| issue_id(s, &r)).transpose()?),
                };
                let opt = |v: Option<String>| v.map(|v| clearable(&v));
                svc::member_update(s, a, &u.mission, &u.member, MissionMemberPatch {
                    name: u.name,
                    status: u.status,
                    model: opt(u.model),
                    terminal_id: opt(u.terminal),
                    session_id: opt(u.session),
                    assigned_issue_id: issue,
                    system_prompt: None,
                    worktree_path: opt(u.worktree),
                    branch_name: opt(u.branch),
                    error: opt(u.error),
                })
            })();
            member(out, res)
        }
        MissionsAction::MemberRemove(m) => out.result(
            svc::member_remove(s, a, &m.mission, &m.member).map(|()| serde_json::json!({ "missionId": m.mission, "member": m.member })),
            |w, _| writeln!(w, "Removed member {}", m.member),
        ),
        MissionsAction::Heartbeat(m) => member(out, svc::member_heartbeat(s, a, &m.mission, &m.member)),
        MissionsAction::Send(x) => {
            let res = (|| {
                let from = x.from.as_deref().map(|r| member_id(s, &x.mission, r)).transpose()?;
                let to = x.to.as_deref().map(|r| member_id(s, &x.mission, r)).transpose()?;
                let issue = x.issue.as_deref().map(|r| issue_id(s, r)).transpose()?;
                svc::send_message(s, a, &x.mission, NewMissionMessage {
                    from_member_id: from,
                    to_member_id: to,
                    kind: x.kind,
                    content: x.content,
                    issue_id: issue,
                })
            })();
            out.result(res, |w, m| print_messages(w, std::slice::from_ref(m)))
        }
        MissionsAction::Messages(x) => {
            let res = (|| {
                let for_member = x.for_member.as_deref().map(|r| member_id(s, &x.mission, r)).transpose()?;
                svc::messages(s, &x.mission, &MissionMessageQuery { since: x.since, for_member, limit: x.limit })
            })();
            match res {
                Ok(r) => out.ok(&r.items, &r.errors, |w| print_messages(w, &r.items)),
                Err(e) => out.err(&e),
            }
        }
        MissionsAction::Inbox { mission, reader, peek } => {
            let res = svc::unread(s, &mission, &reader).and_then(|msgs| {
                if !peek {
                    if let Some(last) = msgs.last() {
                        svc::mark_read(s, a, &mission, &reader, Some(&last.id))?;
                    }
                }
                Ok(msgs)
            });
            out.result(res, |w, v| print_messages(w, v))
        }
        MissionsAction::MarkRead { mission, reader, up_to } => {
            out.result(svc::mark_read(s, a, &mission, &reader, up_to.as_ref()), |w, r| {
                for (k, v) in &r.last_read {
                    writeln!(w, "{k}: {v}")?;
                }
                Ok(())
            })
        }
        MissionsAction::Unread { mission, reader } => out.result(
            svc::unread_count(s, &mission, &reader).map(|n| serde_json::json!({ "reader": reader, "unread": n })),
            |w, v| writeln!(w, "{} unread", v["unread"]),
        ),
        MissionsAction::Activity { mission, since, limit } => match svc::activity(s, &mission, since.as_ref(), limit) {
            Ok(r) => out.ok(&r.items, &r.errors, |w| print_activity(w, &r.items)),
            Err(e) => out.err(&e),
        },
        MissionsAction::Log(l) => {
            let res = (|| {
                let member = l.member.as_deref().map(|r| member_id(s, &l.mission, r)).transpose()?;
                let issue = l.issue.as_deref().map(|r| issue_id(s, r)).transpose()?;
                svc::log_activity(s, a, &l.mission, NewMissionActivity {
                    kind: l.kind,
                    member_id: member,
                    issue_id: issue,
                    detail: Some(l.detail),
                    metadata: None,
                })
            })();
            out.result(res, |w, x| print_activity(w, std::slice::from_ref(x)))
        }
        MissionsAction::Propose(p) => {
            let res = proposed_agents(s, p.agents.as_deref(), &p.agent).and_then(|agents| {
                svc::proposal_create(s, a, &p.mission, NewMissionProposal {
                    goal: p.goal,
                    agents,
                    estimated_cost_usd: p.cost,
                    estimated_minutes: p.minutes,
                    rationale: p.rationale,
                })
            });
            out.result(res, |w, p| print_proposals(w, std::slice::from_ref(p)))
        }
        MissionsAction::Proposals(m) => out.result(svc::get(s, &m.mission).map(|m| m.proposals), |w, v| print_proposals(w, v)),
        MissionsAction::ProposalStatus { mission, proposal, status } => {
            out.result(svc::proposal_update_status(s, a, &mission, &proposal, status), |w, p| print_proposals(w, std::slice::from_ref(p)))
        }
        MissionsAction::ProposalModify(p) => {
            let res = (|| {
                let agents = p.agents.as_deref().map(|j| proposed_agents(s, Some(j), &[])).transpose()?;
                svc::proposal_modify(s, a, &p.mission, &p.proposal, MissionProposalPatch {
                    goal: p.goal,
                    agents,
                    estimated_cost_usd: p.cost.map(Some),
                    estimated_minutes: p.minutes.map(Some),
                    rationale: p.rationale.map(|r| clearable(&r)),
                })
            })();
            out.result(res, |w, p| print_proposals(w, std::slice::from_ref(p)))
        }
        MissionsAction::MergeEnqueue(x) => {
            let res = (|| {
                let mid = member_id(s, &x.mission, &x.member)?;
                let m = svc::get(s, &x.mission)?;
                let mm = m.member(&mid).expect("resolved member");
                let branch = x.branch.or_else(|| mm.branch_name.clone()).ok_or_else(|| CoreError::invalid_input("member has no branch; pass --branch"))?;
                let worktree =
                    x.worktree.or_else(|| mm.worktree_path.clone()).ok_or_else(|| CoreError::invalid_input("member has no worktree; pass --worktree"))?;
                let issue = match x.issue.as_deref() {
                    Some(r) => Some(issue_id(s, r)?),
                    None => mm.assigned_issue_id.clone(),
                };
                svc::merge_enqueue(s, a, &x.mission, NewMissionMergeEntry {
                    member_id: mid,
                    branch_name: branch,
                    worktree_path: worktree,
                    issue_id: issue,
                    priority: x.priority,
                })
            })();
            out.result(res, |w, e| print_queue(w, std::slice::from_ref(e)))
        }
        MissionsAction::MergeQueue(m) => out.result(svc::merge_queue(s, &m.mission), |w, v| print_queue(w, v)),
        MissionsAction::MergeNext(m) => out.result(svc::merge_next(s, a, &m.mission), |w, e| match e {
            Some(e) => print_queue(w, std::slice::from_ref(e)),
            None => writeln!(w, "Nothing to merge."),
        }),
        MissionsAction::MergeUpdate(x) => out.result(
            svc::merge_update(s, a, &x.mission, &x.entry, MissionMergeEntryPatch {
                status: x.status,
                priority: x.priority,
                skip_reason: x.reason.map(|r| clearable(&r)),
            }),
            |w, e| print_queue(w, std::slice::from_ref(e)),
        ),
        MissionsAction::Templates => match svc::templates_list(s) {
            Ok(r) => out.ok(&r.items, &r.errors, |w| print_templates(w, &r.items)),
            Err(e) => out.err(&e),
        },
        MissionsAction::Template { id } => out.result(svc::template_get(s, &id), |w, t| print_templates(w, std::slice::from_ref(t))),
        MissionsAction::TemplateUpsert { input } => {
            let res = json_arg::<MissionTemplateInput>("input", &input).and_then(|input| svc::template_upsert(s, a, input));
            out.result(res, |w, t| print_templates(w, std::slice::from_ref(t)))
        }
        MissionsAction::TemplateDelete { id } => out.result(svc::template_delete(s, a, &id).map(|()| serde_json::json!({ "id": id })), |w, _| {
            writeln!(w, "Deleted template {id}")
        }),
    }
}

// ------------------------------------------------------------------ human output

fn print_mission(w: &mut dyn Write, m: &Mission) -> std::io::Result<()> {
    writeln!(w, "{} — {}", m.id, m.name)?;
    writeln!(w, "status: {}   orchestrator: {}", m.status.as_str(), m.orchestrator_mode.as_str())?;
    if let Some(t) = &m.template_id {
        writeln!(w, "template: {t}")?;
    }
    if !m.members.is_empty() {
        writeln!(w, "\nmembers:")?;
        print_members(w, &m.members)?;
    }
    if !m.proposals.is_empty() {
        writeln!(w, "\nproposals:")?;
        print_proposals(w, &m.proposals)?;
    }
    if !m.merge_queue.is_empty() {
        writeln!(w, "\nmerge queue:")?;
        print_queue(w, &m.merge_queue)?;
    }
    Ok(())
}

fn print_members(w: &mut dyn Write, v: &[MissionMember]) -> std::io::Result<()> {
    for m in v {
        writeln!(
            w,
            "{}  {:<9} {:<13} {}{}",
            m.id,
            m.status.as_str(),
            m.role.as_str(),
            m.name,
            m.assigned_issue_id.as_ref().map(|i| format!("  (issue {i})")).unwrap_or_default()
        )?;
    }
    if v.is_empty() {
        writeln!(w, "No members.")?;
    }
    Ok(())
}

fn print_messages(w: &mut dyn Write, v: &[MissionMessage]) -> std::io::Result<()> {
    for m in v {
        let to = m.to_member_id.as_ref().map(|t| format!(" → {t}")).unwrap_or_default();
        writeln!(w, "[{}] {}{} ({}): {}", m.id, m.from_name, to, m.kind.as_str(), m.content)?;
    }
    if v.is_empty() {
        writeln!(w, "No messages.")?;
    }
    Ok(())
}

fn print_activity(w: &mut dyn Write, v: &[MissionActivity]) -> std::io::Result<()> {
    for a in v {
        writeln!(w, "{:<17} {}{}", a.kind.as_str(), a.member_name.as_deref().map(|n| format!("{n}: ")).unwrap_or_default(), a.detail.as_deref().unwrap_or(""))?;
    }
    if v.is_empty() {
        writeln!(w, "No activity.")?;
    }
    Ok(())
}

fn print_proposals(w: &mut dyn Write, v: &[MissionProposal]) -> std::io::Result<()> {
    for p in v {
        writeln!(w, "{}  {:<8} {} ({} agents)", p.id, p.status.as_str(), p.goal, p.agents.len())?;
    }
    if v.is_empty() {
        writeln!(w, "No proposals.")?;
    }
    Ok(())
}

fn print_queue(w: &mut dyn Write, v: &[MissionMergeEntry]) -> std::io::Result<()> {
    for e in v {
        writeln!(w, "{}  #{:<3} {:<8} {:<8} {}", e.id, e.position, e.status.as_str(), e.priority.as_str(), e.branch_name)?;
    }
    if v.is_empty() {
        writeln!(w, "Merge queue is empty.")?;
    }
    Ok(())
}

fn print_templates(w: &mut dyn Write, v: &[MissionTemplate]) -> std::io::Result<()> {
    for t in v {
        writeln!(w, "{:<28} {:<9} {}", t.id.as_str(), t.category.as_str(), t.name)?;
    }
    Ok(())
}

fn print_agents(w: &mut dyn Write, v: &Vec<AgentDefinition>) -> std::io::Result<()> {
    for d in v {
        writeln!(w, "{:<28} {:<14} {:<12} {}", d.id.as_str(), d.role, d.provider_id, d.name)?;
    }
    Ok(())
}

fn print_issues(w: &mut dyn Write, code: &str, v: &[Issue]) -> std::io::Result<()> {
    for i in v {
        writeln!(w, "{:<10} {:<12} {:<8} {}", issues::format_ref(code, i.number), i.status.as_str(), i.priority.as_str(), i.title)?;
    }
    if v.is_empty() {
        writeln!(w, "No issues.")?;
    }
    Ok(())
}
