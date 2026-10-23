use super::*;
use crate::domains::issues::{self, IssueStatus, NewIssue, Priority};
use crate::error::ErrorCode;
use crate::events::{ChangeEvent, Domain};
use crate::ids::Id;
use crate::model::Actor;
use crate::testing::TempProject;
use std::sync::{Arc, Mutex};

fn actor() -> Actor {
    Actor::human("tester")
}

fn issue(tp: &TempProject, title: &str, priority: Priority, mission: Option<&Id>) -> issues::Issue {
    issues::create(&tp.store, &actor(), NewIssue {
        title: title.into(),
        priority: Some(priority),
        mission_id: mission.cloned(),
        ..Default::default()
    })
    .unwrap()
}

fn mission(tp: &TempProject) -> Mission {
    create(&tp.store, &actor(), NewMission { name: "Sprint".into(), ..Default::default() }).unwrap()
}

fn worker(tp: &TempProject, m: &Mission, name: &str) -> MissionMember {
    let def = builtins::builtin_agent_definition("builtin-fullstack-dev").unwrap();
    member_add(&tp.store, &actor(), &m.id, NewMissionMember::from_definition(&def, Some(name.into()), None)).unwrap()
}

#[test]
fn create_get_list_update_delete() {
    let tp = TempProject::new();
    let events: Arc<Mutex<Vec<ChangeEvent>>> = Default::default();
    let e2 = events.clone();
    tp.store.bus().subscribe(move |e| e2.lock().unwrap().push(e.clone()));

    let i = issue(&tp, "a", Priority::Medium, None);
    let m = create(&tp.store, &actor(), NewMission {
        name: " Build ".into(),
        template_id: Some(Id::builtin("feature-build")),
        orchestrator_mode: Some(MissionOrchestratorMode::Persistent),
        issue_refs: vec!["#1".into()],
        ..Default::default()
    })
    .unwrap();
    assert_eq!(m.name, "Build");
    assert_eq!(m.status, MissionStatus::Preparing);
    assert_eq!(m.config.workflow_phases.len(), 5, "template playbook copied");
    assert_eq!(get(&tp.store, &m.id).unwrap(), m);
    assert_eq!(issues::get(&tp.store, i.id.as_str()).unwrap().mission_id.as_ref(), Some(&m.id));
    assert!(tp.store.data_dir().join("local").join("missions").join(m.id.as_str()).join("mission.json").is_file());
    {
        let ev = events.lock().unwrap();
        assert!(ev.iter().any(|e| e.domain == Domain::Missions && e.ids == vec![m.id.to_string()]), "{ev:?}");
        assert!(ev.iter().any(|e| e.domain == Domain::MissionActivity));
    }

    let u = update(&tp.store, &actor(), &m.id, MissionPatch { status: Some(MissionStatus::Active), ..Default::default() }).unwrap();
    assert!(u.started_at.is_some());
    let u = update(&tp.store, &actor(), &m.id, MissionPatch { status: Some(MissionStatus::Completed), ..Default::default() }).unwrap();
    assert!(u.completed_at.is_some());
    let kinds: Vec<_> = activity(&tp.store, &m.id, None, None).unwrap().items.into_iter().map(|a| a.kind).collect();
    assert!(kinds.contains(&MissionActivityKind::MissionStarted) && kinds.contains(&MissionActivityKind::MissionCompleted));

    let m2 = mission(&tp);
    let l = list(&tp.store, None).unwrap();
    assert_eq!(l.items.iter().map(|x| &x.id).collect::<Vec<_>>(), vec![&m2.id, &m.id], "newest first");
    assert_eq!(list(&tp.store, Some(MissionStatus::Completed)).unwrap().items.len(), 1);

    delete(&tp.store, &actor(), &m.id).unwrap();
    assert_eq!(get(&tp.store, &m.id).unwrap_err().code, ErrorCode::NotFound);
    assert!(!tp.store.data_dir().join("local").join("missions").join(m.id.as_str()).exists());
    assert_eq!(issues::get(&tp.store, i.id.as_str()).unwrap().mission_id, None);
    assert_eq!(list(&tp.store, None).unwrap().items.len(), 1);
}

#[test]
fn corrupt_mission_reported_and_never_overwritten() {
    let tp = TempProject::new();
    let m = mission(&tp);
    let p = tp.store.data_dir().join("local").join("missions").join(m.id.as_str()).join("mission.json");
    std::fs::write(&p, "{broken").unwrap();
    let l = list(&tp.store, None).unwrap();
    assert!(l.items.is_empty());
    assert_eq!(l.errors.len(), 1);
    let e = update(&tp.store, &actor(), &m.id, MissionPatch { name: Some("x".into()), ..Default::default() }).unwrap_err();
    assert_eq!(e.code, ErrorCode::Corrupt);
    assert_eq!(std::fs::read_to_string(&p).unwrap(), "{broken");
    assert_eq!(Id::parse("../x").unwrap_err().code, ErrorCode::InvalidInput);
}

#[test]
fn progress_reflects_issues() {
    let tp = TempProject::new();
    let m = mission(&tp);
    let a = issue(&tp, "a", Priority::Medium, Some(&m.id));
    issue(&tp, "b", Priority::Medium, Some(&m.id));
    issue(&tp, "outside", Priority::Medium, None);
    let w = worker(&tp, &m, "W");
    let p = progress(&tp.store, &m.id).unwrap();
    assert_eq!((p.total, p.by_status[&IssueStatus::Todo], p.by_status[&IssueStatus::Done]), (2, 2, 0));
    assert_eq!((p.total_members, p.active_members), (1, 0));
    issues::close(&tp.store, &actor(), a.id.as_str()).unwrap();
    member_update(&tp.store, &actor(), &m.id, w.id.as_str(), MissionMemberPatch { status: Some(MissionMemberStatus::Working), ..Default::default() }).unwrap();
    let p = progress(&tp.store, &m.id).unwrap();
    assert_eq!((p.by_status[&IssueStatus::Todo], p.by_status[&IssueStatus::Done], p.active_members), (1, 1, 1));
}

#[test]
fn claim_next_takes_highest_priority_unblocked_unclaimed() {
    let tp = TempProject::new();
    let m = mission(&tp);
    let low = issue(&tp, "low", Priority::Low, Some(&m.id));
    let high = issue(&tp, "high", Priority::High, Some(&m.id));
    let crit = issue(&tp, "crit-blocked", Priority::Critical, Some(&m.id));
    issues::update(&tp.store, &actor(), crit.id.as_str(), issues::IssuePatch { blocked_by: Some(vec![low.id.clone()]), ..Default::default() }).unwrap();
    issue(&tp, "other mission", Priority::Critical, None);
    let w1 = worker(&tp, &m, "W1");
    let w2 = worker(&tp, &m, "W2");

    let c = claim_next_issue(&tp.store, &actor(), &m.id, "w1").unwrap().unwrap();
    assert_eq!(c.id, high.id);
    assert_eq!(c.status, IssueStatus::InProgress);
    assert_eq!(c.assignment.as_ref().unwrap().agent_label, "W1");
    let got = get(&tp.store, &m.id).unwrap();
    let mm = got.member(&w1.id).unwrap();
    assert_eq!((mm.assigned_issue_id.as_ref(), mm.status), (Some(&high.id), MissionMemberStatus::Working));

    let c2 = claim_next_issue(&tp.store, &actor(), &m.id, w2.id.as_str()).unwrap().unwrap();
    assert_eq!(c2.id, low.id);
    assert!(claim_next_issue(&tp.store, &actor(), &m.id, "W1").unwrap().is_none(), "blocked + claimed issues are skipped");
    let kinds: Vec<_> = activity(&tp.store, &m.id, None, None).unwrap().items.into_iter().map(|a| a.kind).collect();
    assert!(kinds.contains(&MissionActivityKind::IssueClaimed));
    assert!(kinds.contains(&MissionActivityKind::StatusChanged), "issue status hook logs activity");
    assert_eq!(claim_next_issue(&tp.store, &actor(), &m.id, "nobody").unwrap_err().code, ErrorCode::NotFound);
}

#[test]
fn closing_an_issue_logs_activity_idles_member_and_queues_merge() {
    let tp = TempProject::new();
    let m = mission(&tp);
    let i = issue(&tp, "feat", Priority::High, Some(&m.id));
    let w = worker(&tp, &m, "W");
    member_update(&tp.store, &actor(), &m.id, "W", MissionMemberPatch {
        branch_name: Some(Some("agent/x/w".into())),
        worktree_path: Some(Some("/tmp/w".into())),
        ..Default::default()
    })
    .unwrap();
    claim_next_issue(&tp.store, &actor(), &m.id, "W").unwrap().unwrap();
    issues::close(&tp.store, &actor(), i.id.as_str()).unwrap();
    let got = get(&tp.store, &m.id).unwrap();
    assert_eq!(got.member(&w.id).unwrap().status, MissionMemberStatus::Idle);
    assert_eq!(got.merge_queue.len(), 1);
    assert_eq!(got.merge_queue[0].issue_id.as_ref(), Some(&i.id));
    let acts = activity(&tp.store, &m.id, None, None).unwrap().items;
    let last_status = acts.iter().rev().find(|a| a.kind == MissionActivityKind::StatusChanged).unwrap();
    assert_eq!(last_status.metadata.as_ref().unwrap()["to"], "done");
    // Re-closing (reopen + close) does not double-queue.
    issues::reopen(&tp.store, &actor(), i.id.as_str()).unwrap();
    issues::close(&tp.store, &actor(), i.id.as_str()).unwrap();
    assert_eq!(get(&tp.store, &m.id).unwrap().merge_queue.len(), 1);

    let next = merge_next(&tp.store, &actor(), &m.id).unwrap().unwrap();
    assert_eq!(next.status, MissionMergeStatus::Merging);
    assert!(merge_next(&tp.store, &actor(), &m.id).unwrap().is_none(), "one merge at a time");
    let done = merge_update(&tp.store, &actor(), &m.id, &next.id, MissionMergeEntryPatch { status: Some(MissionMergeStatus::Merged), ..Default::default() }).unwrap();
    assert!(done.merged_at.is_some());
}

#[test]
fn messages_cursors_and_unread() {
    let tp = TempProject::new();
    let m = mission(&tp);
    let a = worker(&tp, &m, "A");
    let b = worker(&tp, &m, "B");
    let send = |from: Option<&Id>, to: Option<&Id>, text: &str| {
        send_message(&tp.store, &actor(), &m.id, NewMissionMessage {
            from_member_id: from.cloned(),
            to_member_id: to.cloned(),
            content: text.into(),
            ..Default::default()
        })
        .unwrap()
    };
    let m1 = send(None, None, "hello all");
    let _m2 = send(Some(&a.id), Some(&b.id), "a to b");
    let m3 = send(Some(&b.id), None, "b broadcast");
    assert_eq!(m1.from_name, "tester");
    assert_eq!(messages(&tp.store, &m.id, &Default::default()).unwrap().items.len(), 3);
    let since = messages(&tp.store, &m.id, &MissionMessageQuery { since: Some(m1.id.clone()), ..Default::default() }).unwrap();
    assert_eq!(since.items.len(), 2);
    let for_a = messages(&tp.store, &m.id, &MissionMessageQuery { for_member: Some(a.id.clone()), ..Default::default() }).unwrap();
    assert_eq!(for_a.items.len(), 2, "broadcasts + direct only");
    assert_eq!(messages(&tp.store, &m.id, &MissionMessageQuery { limit: Some(1), ..Default::default() }).unwrap().items[0].id, m3.id);

    assert_eq!(unread_count(&tp.store, &m.id, a.id.as_str()).unwrap(), 2); // m1, m3
    assert_eq!(unread_count(&tp.store, &m.id, "B").unwrap(), 2); // m1, m2
    assert_eq!(unread_count(&tp.store, &m.id, HUMAN_READER).unwrap(), 2); // from members
    mark_read(&tp.store, &actor(), &m.id, a.id.as_str(), Some(&m1.id)).unwrap();
    assert_eq!(unread_count(&tp.store, &m.id, a.id.as_str()).unwrap(), 1);
    mark_read(&tp.store, &actor(), &m.id, a.id.as_str(), None).unwrap();
    assert_eq!(unread_count(&tp.store, &m.id, a.id.as_str()).unwrap(), 0);
    // Cursors never move backwards.
    let r = mark_read(&tp.store, &actor(), &m.id, a.id.as_str(), Some(&m1.id)).unwrap();
    assert_eq!(r.last_read[a.id.as_str()], m3.id);
    assert_eq!(unread_count(&tp.store, &m.id, "ghost").unwrap_err().code, ErrorCode::NotFound);

    let e = send_message(&tp.store, &actor(), &m.id, NewMissionMessage { content: "  ".into(), ..Default::default() }).unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidInput);
}

#[test]
fn proposals_members_templates() {
    let tp = TempProject::new();
    let m = mission(&tp);
    let i = issue(&tp, "x", Priority::Medium, Some(&m.id));
    let p = proposal_create(&tp.store, &actor(), &m.id, NewMissionProposal {
        goal: "Ship it".into(),
        agents: vec![MissionProposedAgent { name: "FE".into(), role: MissionAgentRole::Frontend, issue_ids: vec![i.id.clone()], ..Default::default() }],
        estimated_minutes: Some(30),
        ..Default::default()
    })
    .unwrap();
    let p2 = proposal_modify(&tp.store, &actor(), &m.id, &p.id, MissionProposalPatch { goal: Some("Ship it now".into()), ..Default::default() }).unwrap();
    assert_eq!(p2.status, MissionProposalStatus::Modified);
    let ap = proposal_update_status(&tp.store, &actor(), &m.id, &p.id, MissionProposalStatus::Approved).unwrap();
    assert_eq!(ap.status, MissionProposalStatus::Approved);
    let e = proposal_update_status(&tp.store, &actor(), &m.id, &p.id, MissionProposalStatus::Rejected).unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);

    let w = worker(&tp, &m, "W");
    let bad = member_update(&tp.store, &actor(), &m.id, "W", MissionMemberPatch { model: Some(Some("x; rm -rf ~".into())), ..Default::default() });
    assert_eq!(bad.unwrap_err().code, ErrorCode::InvalidInput);
    update(&tp.store, &actor(), &m.id, MissionPatch { orchestrator_member_id: Some(Some(w.id.clone())), ..Default::default() }).unwrap();
    let hb = member_heartbeat(&tp.store, &actor(), &m.id, "W").unwrap();
    assert!(hb.last_heartbeat.is_some());
    assert_eq!(hb.status, MissionMemberStatus::Working);
    member_remove(&tp.store, &actor(), &m.id, "W").unwrap();
    let got = get(&tp.store, &m.id).unwrap();
    assert!(got.members.is_empty() && got.orchestrator_member_id.is_none());

    // Templates: builtins merged at read time, nothing written.
    assert_eq!(templates_list(&tp.store).unwrap().items.len(), 8);
    assert!(!tp.store.data_dir().join("mission-templates").exists());
    let t = template_upsert(&tp.store, &actor(), MissionTemplateInput { name: "Mine".into(), skills_used: vec!["run-script".into(), " ".into()], ..Default::default() }).unwrap();
    assert_eq!(t.skills_used, vec!["run-script"]);
    assert!(!t.built_in);
    assert_eq!(templates_list(&tp.store).unwrap().items.len(), 9);
    let e = template_upsert(&tp.store, &actor(), MissionTemplateInput { id: Some(Id::builtin("bug-bash")), name: "x".into(), ..Default::default() }).unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(template_delete(&tp.store, &actor(), &Id::builtin("bug-bash")).unwrap_err().code, ErrorCode::Conflict);
    template_delete(&tp.store, &actor(), &t.id).unwrap();
    assert_eq!(templates_list(&tp.store).unwrap().items.len(), 8);
    let from_custom = template_get(&tp.store, &Id::builtin("bug-bash")).unwrap();
    assert_eq!(from_custom.name, "Bug Bash");
}
