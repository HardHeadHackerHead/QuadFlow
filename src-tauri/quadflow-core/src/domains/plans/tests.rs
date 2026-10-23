use super::*;
use crate::domains::issues::{self, Epic, IssueQuery, IssueStatus, Priority};
use crate::error::ErrorCode;
use crate::events::{ChangeEvent, ChangeKind, Domain};
use crate::ids::Id;
use crate::model::Actor;
use crate::paths::Profile;
use crate::testing::TempProject;
use std::sync::{Arc, Mutex};

fn tp() -> TempProject {
    TempProject::with_profile(Profile::Dev)
}

fn actor() -> Actor {
    Actor::human("tester")
}

fn plan(t: &TempProject, title: &str) -> Plan {
    create(&t.store, &actor(), NewPlan { title: title.into(), ..Default::default() }).unwrap()
}

fn step(t: &TempProject, p: &Id, title: &str) -> Id {
    let plan = step_add(&t.store, &actor(), p, NewPlanStep { title: title.into(), ..Default::default() }).unwrap();
    plan.steps.last().unwrap().id.clone()
}

fn step_of<'a>(p: &'a Plan, id: &Id) -> &'a PlanStep {
    p.step(id).unwrap()
}

fn record(t: &TempProject) -> Arc<Mutex<Vec<ChangeEvent>>> {
    let ev = Arc::new(Mutex::new(Vec::new()));
    let sink = ev.clone();
    t.store.bus().subscribe(move |e| sink.lock().unwrap().push(e.clone()));
    ev
}

#[test]
fn create_get_list_round_trip() {
    let t = tp();
    let a = create(&t.store, &actor(), NewPlan {
        title: "  Auth  ".into(),
        description: Some("login".into()),
        spec: Some(PlanSpec { content: "# Spec".into(), kind: PlanSpecKind::Greenfield }),
        decisions: vec![PlanDecision { decision: "JWT".into(), rationale: "stateless".into() }],
        steps: vec![NewPlanStep { title: "one".into(), ..Default::default() }, NewPlanStep { title: "two".into(), ..Default::default() }],
        ..Default::default()
    })
    .unwrap();
    assert_eq!(a.title, "Auth");
    assert_eq!(a.status, PlanStatus::Decomposing);
    assert_eq!(a.steps.iter().map(|s| s.order).collect::<Vec<_>>(), vec![0, 1]);
    assert_eq!(a.created_by, actor());
    let b = plan(&t, "Second");
    assert_eq!(b.status, PlanStatus::SpecDraft);
    assert_eq!(get(&t.store, &a.id).unwrap(), a);
    let l = list(&t.store, &PlanQuery::default()).unwrap();
    assert_eq!(l.items.iter().map(|p| p.title.as_str()).collect::<Vec<_>>(), vec!["Second", "Auth"]);
    let l = list(&t.store, &PlanQuery { text: Some("spec".into()), ..Default::default() }).unwrap();
    assert_eq!(l.items.len(), 1);
    assert_eq!(create(&t.store, &actor(), NewPlan { title: " ".into(), ..Default::default() }).unwrap_err().code, ErrorCode::InvalidInput);
}

#[test]
fn patch_sets_and_clears_fields() {
    let t = tp();
    let p = plan(&t, "P");
    let patch: PlanPatch = serde_json::from_value(serde_json::json!({
        "description": "d", "riskNotes": "r", "context": "c",
        "spec": {"content": "s", "kind": "refactor"},
        "promotionProfile": {"createEpics": false, "labelStrategy": "none"},
        "status": "spec_review"
    }))
    .unwrap();
    let p2 = update(&t.store, &actor(), &p.id, patch).unwrap();
    assert_eq!(p2.description.as_deref(), Some("d"));
    assert_eq!(p2.spec.as_ref().unwrap().kind, PlanSpecKind::Refactor);
    assert_eq!(p2.status, PlanStatus::SpecReview);
    assert!(!p2.promotion_profile.as_ref().unwrap().create_epics);
    // Absent = unchanged.
    let p3 = update(&t.store, &actor(), &p.id, PlanPatch { title: Some("Q".into()), ..Default::default() }).unwrap();
    assert_eq!(p3.description.as_deref(), Some("d"));
    // null = clear.
    let clear: PlanPatch = serde_json::from_value(serde_json::json!({
        "description": null, "riskNotes": null, "context": null, "spec": null, "promotionProfile": null
    }))
    .unwrap();
    let p4 = update(&t.store, &actor(), &p.id, clear).unwrap();
    assert!(p4.description.is_none() && p4.risk_notes.is_none() && p4.context.is_none());
    assert!(p4.spec.is_none() && p4.promotion_profile.is_none());

    // Step patch fields clear too.
    let s = step(&t, &p.id, "S");
    let set: PlanStepPatch = serde_json::from_value(serde_json::json!({
        "description": "x", "notes": "n", "kind": "test", "effort": "high", "codeContext": "fn",
        "estimatedHours": 2.5, "verification": {"method": "cargo test"}
    }))
    .unwrap();
    let pl = step_update(&t.store, &actor(), &p.id, &s, set).unwrap();
    let st = step_of(&pl, &s);
    assert_eq!((st.kind, st.effort, st.estimated_hours), (Some(PlanStepKind::Test), Some(PlanStepEffort::High), Some(2.5)));
    let clear: PlanStepPatch = serde_json::from_value(serde_json::json!({
        "description": null, "notes": null, "kind": null, "effort": null, "codeContext": null,
        "estimatedHours": null, "verification": null
    }))
    .unwrap();
    let pl = step_update(&t.store, &actor(), &p.id, &s, clear).unwrap();
    let st = step_of(&pl, &s);
    assert!(st.description.is_none() && st.notes.is_none() && st.kind.is_none() && st.effort.is_none());
    assert!(st.code_context.is_none() && st.estimated_hours.is_none() && st.verification.is_none());
    let bad: PlanStepPatch = serde_json::from_value(serde_json::json!({"actualHours": -1.0})).unwrap();
    assert_eq!(step_update(&t.store, &actor(), &p.id, &s, bad).unwrap_err().code, ErrorCode::InvalidInput);
}

#[test]
fn steps_hierarchy_deps_reorder_delete() {
    let t = tp();
    let p = plan(&t, "P");
    let a = step(&t, &p.id, "a");
    let b = step(&t, &p.id, "b");
    let c = step(&t, &p.id, "c");
    // child of a, depends on b
    let pl = step_add(&t.store, &actor(), &p.id, NewPlanStep {
        title: "a1".into(),
        parent_id: Some(a.clone()),
        depends_on: vec![b.clone(), b.clone()],
        ..Default::default()
    })
    .unwrap();
    let a1 = pl.steps.last().unwrap().id.clone();
    assert_eq!(step_of(&pl, &a1).depends_on, vec![b.clone()]);
    // cycles / self refs / foreign ids rejected
    let cyc = PlanStepPatch { parent_id: Some(Some(a1.clone())), ..Default::default() };
    assert_eq!(step_update(&t.store, &actor(), &p.id, &a, cyc).unwrap_err().code, ErrorCode::InvalidInput);
    let selfdep = PlanStepPatch { depends_on: Some(vec![c.clone()]), ..Default::default() };
    assert_eq!(step_update(&t.store, &actor(), &p.id, &c, selfdep).unwrap_err().code, ErrorCode::InvalidInput);
    let foreign = PlanStepPatch { depends_on: Some(vec![crate::ids::new_id()]), ..Default::default() };
    assert_eq!(step_update(&t.store, &actor(), &p.id, &c, foreign).unwrap_err().code, ErrorCode::InvalidInput);

    let pl = steps_reorder(&t.store, &actor(), &p.id, &[c.clone(), a.clone()]).unwrap();
    assert_eq!(pl.steps.iter().map(|s| s.title.as_str()).collect::<Vec<_>>(), vec!["c", "a", "b", "a1"]);
    assert_eq!(pl.steps.iter().map(|s| s.order).collect::<Vec<_>>(), vec![0, 1, 2, 3]);
    assert_eq!(steps_reorder(&t.store, &actor(), &p.id, &[c.clone(), c.clone()]).unwrap_err().code, ErrorCode::InvalidInput);

    // deleting a: a1 moves to the root; deleting b: a1 drops the dependency
    let pl = step_delete(&t.store, &actor(), &p.id, &a).unwrap();
    assert!(step_of(&pl, &a1).parent_id.is_none());
    let pl = step_delete(&t.store, &actor(), &p.id, &b).unwrap();
    assert!(step_of(&pl, &a1).depends_on.is_empty());
    assert_eq!(pl.steps.iter().map(|s| s.order).collect::<Vec<_>>(), vec![0, 1]);
    assert_eq!(step_delete(&t.store, &actor(), &p.id, &b).unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(find_step_plan(&t.store, &a1).unwrap().id, p.id);
}

#[test]
fn comments_add_delete() {
    let t = tp();
    let p = plan(&t, "P");
    let pl = comment_add(&t.store, &actor(), &p.id, " looks good ", PlanCommentKind::Review).unwrap();
    assert_eq!(pl.comments.len(), 1);
    assert_eq!(pl.comments[0].body, "looks good");
    assert_eq!(pl.comments[0].kind, PlanCommentKind::Review);
    assert_eq!(comment_add(&t.store, &actor(), &p.id, "  ", PlanCommentKind::General).unwrap_err().code, ErrorCode::InvalidInput);
    let cid = pl.comments[0].id.clone();
    assert!(comment_delete(&t.store, &actor(), &p.id, &cid).unwrap().comments.is_empty());
    assert_eq!(comment_delete(&t.store, &actor(), &p.id, &cid).unwrap_err().code, ErrorCode::NotFound);
}

#[test]
fn auto_transitions() {
    let t = tp();
    let p = plan(&t, "P");
    let a = step(&t, &p.id, "a");
    let b = step(&t, &p.id, "b");
    update(&t.store, &actor(), &p.id, PlanPatch { status: Some(PlanStatus::ReviewSteps), ..Default::default() }).unwrap();
    let st = |s: PlanStepStatus| PlanStepPatch { status: Some(s), ..Default::default() };
    let pl = step_update(&t.store, &actor(), &p.id, &a, st(PlanStepStatus::InProgress)).unwrap();
    assert_eq!(pl.status, PlanStatus::Executing);
    assert!(step_of(&pl, &a).started_at.is_some());
    step_update(&t.store, &actor(), &p.id, &a, st(PlanStepStatus::Completed)).unwrap();
    let pl = step_update(&t.store, &actor(), &p.id, &b, st(PlanStepStatus::Skipped)).unwrap();
    assert_eq!(pl.status, PlanStatus::Completed);
    assert!(step_of(&pl, &a).completed_at.is_some());
    let pl = step_update(&t.store, &actor(), &p.id, &a, st(PlanStepStatus::Pending)).unwrap();
    assert_eq!(pl.status, PlanStatus::Executing);
    assert!(step_of(&pl, &a).completed_at.is_none());
}

#[test]
fn promote_step_links_issue_and_is_idempotent() {
    let t = tp();
    let p = plan(&t, "Auth");
    let a = step(&t, &p.id, "Design schema");
    let pl = step_update(&t.store, &actor(), &p.id, &a, PlanStepPatch {
        acceptance_criteria: Some(vec!["tables exist".into()]),
        target_files: Some(vec!["db.sql".into()]),
        effort: Some(Some(PlanStepEffort::High)),
        kind: Some(Some(PlanStepKind::Design)),
        ..Default::default()
    })
    .unwrap();
    assert!(step_of(&pl, &a).issue_id.is_none());

    let r1 = promote_step(&t.store, &actor(), &p.id, &a).unwrap();
    assert_eq!(r1.created, 1);
    assert_eq!(r1.issues.len(), 1);
    let issue = &r1.issues[0];
    assert_eq!(step_of(&r1.plan, &a).issue_id.as_ref(), Some(&issue.id));
    let src = issue.source.as_ref().unwrap();
    assert_eq!((src.plan_id.as_ref(), src.step_id.as_ref()), (Some(&p.id), Some(&a)));
    assert_eq!(issue.priority, Priority::High);
    assert_eq!(issue.labels, vec!["design", "plan"]);
    assert_eq!(issue.acceptance_criteria.len(), 1);
    assert!(issue.body.as_deref().unwrap().contains("`db.sql`"));

    let r2 = promote_step(&t.store, &actor(), &p.id, &a).unwrap();
    assert_eq!(r2.created, 0);
    assert_eq!(r2.issues[0].id, issue.id);
    assert_eq!(issues::list(&t.store, &IssueQuery { include_done: true, ..Default::default() }).unwrap().items.len(), 1);

    // A deleted issue unlinks the step; promoting again creates a new one.
    issues::delete(&t.store, &actor(), issue.id.as_str()).unwrap();
    assert!(step_of(&get(&t.store, &p.id).unwrap(), &a).issue_id.is_none());
    let r3 = promote_step(&t.store, &actor(), &p.id, &a).unwrap();
    assert_eq!(r3.created, 1);
    assert_ne!(r3.issues[0].id, issue.id);
}

#[test]
fn promote_all_idempotent_with_epics_and_blockers() {
    let t = tp();
    let p = plan(&t, "P");
    let epic = step(&t, &p.id, "Backend");
    let pl = step_add(&t.store, &actor(), &p.id, NewPlanStep { title: "API".into(), parent_id: Some(epic.clone()), ..Default::default() }).unwrap();
    let api = pl.steps.last().unwrap().id.clone();
    let pl = step_add(&t.store, &actor(), &p.id, NewPlanStep {
        title: "Tests".into(),
        parent_id: Some(epic.clone()),
        depends_on: vec![api.clone()],
        ..Default::default()
    })
    .unwrap();
    let tests = pl.steps.last().unwrap().id.clone();
    let skipped = step(&t, &p.id, "Docs");
    step_update(&t.store, &actor(), &p.id, &skipped, PlanStepPatch { status: Some(PlanStepStatus::Skipped), ..Default::default() }).unwrap();

    let r1 = promote_all(&t.store, &actor(), &p.id).unwrap();
    assert_eq!(r1.created, 3, "1 epic + 2 issues");
    assert_eq!(r1.epics.len(), 1);
    assert_eq!(r1.issues.len(), 2);
    let epic_id = step_of(&r1.plan, &epic).epic_id.clone().unwrap();
    assert!(step_of(&r1.plan, &epic).issue_id.is_none());
    assert!(step_of(&r1.plan, &skipped).issue_id.is_none());
    let api_issue = step_of(&r1.plan, &api).issue_id.clone().unwrap();
    let tests_issue = issues::get(&t.store, step_of(&r1.plan, &tests).issue_id.as_ref().unwrap().as_str()).unwrap();
    assert_eq!(tests_issue.epic_id.as_ref(), Some(&epic_id));
    assert_eq!(tests_issue.blocked_by, vec![api_issue.clone()]);

    let r2 = promote_all(&t.store, &actor(), &p.id).unwrap();
    assert_eq!(r2.created, 0);
    assert_eq!(r2.issues.iter().map(|i| &i.id).collect::<Vec<_>>(), r1.issues.iter().map(|i| &i.id).collect::<Vec<_>>());
    assert_eq!(r2.epics[0].id, epic_id);
    assert_eq!(issues::list(&t.store, &IssueQuery { include_done: true, ..Default::default() }).unwrap().items.len(), 2);
    assert_eq!(issues::epics_list(&t.store).unwrap().items.len(), 1);
}

#[test]
fn reverse_blockers_when_dependency_promoted_later() {
    let t = tp();
    let p = plan(&t, "P");
    let a = step(&t, &p.id, "a");
    let pl = step_add(&t.store, &actor(), &p.id, NewPlanStep { title: "b".into(), depends_on: vec![a.clone()], ..Default::default() }).unwrap();
    let b = pl.steps.last().unwrap().id.clone();
    let rb = promote_step(&t.store, &actor(), &p.id, &b).unwrap();
    assert!(rb.issues[0].blocked_by.is_empty());
    let ra = promote_step(&t.store, &actor(), &p.id, &a).unwrap();
    let b_issue = issues::get(&t.store, rb.issues[0].id.as_str()).unwrap();
    assert_eq!(b_issue.blocked_by, vec![ra.issues[0].id.clone()]);
}

#[test]
fn issue_status_moves_step_in_same_transaction() {
    let t = tp();
    let p = plan(&t, "P");
    let a = step(&t, &p.id, "a");
    update(&t.store, &actor(), &p.id, PlanPatch { status: Some(PlanStatus::Promoting), ..Default::default() }).unwrap();
    let issue = promote_step(&t.store, &actor(), &p.id, &a).unwrap().issues.remove(0);
    let ev = record(&t);

    // One transaction: inside it the plan already reflects the new issue status.
    let seen = t
        .store
        .write(&actor(), |tx| {
            issues::set_status_in_tx(tx, &issue.id, IssueStatus::InProgress)?;
            let plan: Plan = tx.get(&p.id)?;
            Ok(plan.step(&a).unwrap().status)
        })
        .unwrap();
    assert_eq!(seen, PlanStepStatus::InProgress);
    let pl = get(&t.store, &p.id).unwrap();
    assert_eq!(pl.status, PlanStatus::Executing);
    {
        let ev = ev.lock().unwrap();
        assert!(ev.iter().any(|e| e.domain == Domain::Issues && e.kind == ChangeKind::Updated));
        assert!(ev.iter().any(|e| e.domain == Domain::Plans && e.ids == vec![p.id.to_string()]));
    }

    issues::set_status(&t.store, &actor(), issue.id.as_str(), IssueStatus::Qa).unwrap();
    assert_eq!(step_of(&get(&t.store, &p.id).unwrap(), &a).status, PlanStepStatus::InProgress);
    issues::close(&t.store, &actor(), issue.id.as_str()).unwrap();
    let pl = get(&t.store, &p.id).unwrap();
    assert_eq!(step_of(&pl, &a).status, PlanStepStatus::Completed);
    assert_eq!(pl.status, PlanStatus::Completed);
    issues::reopen(&t.store, &actor(), issue.id.as_str()).unwrap();
    assert_eq!(step_of(&get(&t.store, &p.id).unwrap(), &a).status, PlanStepStatus::Pending);
}

#[test]
fn step_status_moves_issue_and_epic() {
    let t = tp();
    let p = plan(&t, "P");
    let parent = step(&t, &p.id, "parent");
    let pl = step_add(&t.store, &actor(), &p.id, NewPlanStep { title: "child".into(), parent_id: Some(parent.clone()), ..Default::default() }).unwrap();
    let child = pl.steps.last().unwrap().id.clone();
    let r = promote_all(&t.store, &actor(), &p.id).unwrap();
    let issue_id = step_of(&r.plan, &child).issue_id.clone().unwrap();
    let epic_id = step_of(&r.plan, &parent).epic_id.clone().unwrap();

    let st = |s: PlanStepStatus| PlanStepPatch { status: Some(s), ..Default::default() };
    step_update(&t.store, &actor(), &p.id, &child, st(PlanStepStatus::Completed)).unwrap();
    assert_eq!(issues::get(&t.store, issue_id.as_str()).unwrap().status, IssueStatus::Done);
    // qa maps to in_progress: moving the step to in_progress leaves a qa issue alone.
    issues::set_status(&t.store, &actor(), issue_id.as_str(), IssueStatus::Qa).unwrap();
    assert_eq!(step_of(&get(&t.store, &p.id).unwrap(), &child).status, PlanStepStatus::InProgress);
    step_update(&t.store, &actor(), &p.id, &child, st(PlanStepStatus::Skipped)).unwrap();
    assert_eq!(issues::get(&t.store, issue_id.as_str()).unwrap().status, IssueStatus::Qa);

    step_update(&t.store, &actor(), &p.id, &parent, st(PlanStepStatus::InProgress)).unwrap();
    let e: Epic = t.store.get(&epic_id).unwrap();
    assert_eq!(e.status, issues::EpicStatus::InProgress);
}

#[test]
fn deleted_plan_does_not_block_issue_changes() {
    let t = tp();
    let p = plan(&t, "P");
    let a = step(&t, &p.id, "a");
    let issue = promote_step(&t.store, &actor(), &p.id, &a).unwrap().issues.remove(0);
    delete(&t.store, &actor(), &p.id).unwrap();
    assert_eq!(issues::close(&t.store, &actor(), issue.id.as_str()).unwrap().status, IssueStatus::Done);
    assert_eq!(get(&t.store, &p.id).unwrap_err().code, ErrorCode::NotFound);
}

#[test]
fn corrupt_plan_is_reported_and_never_overwritten() {
    let t = tp();
    plan(&t, "good");
    let bad = crate::ids::new_id();
    let path = t.store.data_dir().join("plans").join(format!("{bad}.json"));
    std::fs::write(&path, "{ nope").unwrap();
    let l = list(&t.store, &PlanQuery::default()).unwrap();
    assert_eq!((l.items.len(), l.errors.len()), (1, 1));
    assert_eq!(update(&t.store, &actor(), &bad, PlanPatch::default()).unwrap_err().code, ErrorCode::Corrupt);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ nope");
    assert_eq!(crate::ids::Id::parse("../x").unwrap_err().code, ErrorCode::InvalidInput);
}
