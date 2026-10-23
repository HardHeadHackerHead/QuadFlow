use super::*;
use crate::error::ErrorCode;
use crate::events::{ChangeEvent, ChangeKind, Domain};
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

fn new(title: &str) -> NewIssue {
    NewIssue { title: title.into(), ..Default::default() }
}

fn code(t: &TempProject) -> String {
    crate::domains::project_config::read(&t.store).unwrap().code
}

#[test]
fn create_get_list_round_trip_and_numbers() {
    let t = tp();
    let a = create(&t.store, &actor(), NewIssue {
        title: "  First  ".into(),
        body: Some("body".into()),
        priority: Some(Priority::Low),
        labels: vec!["ui".into(), "bug".into(), "ui".into()],
        acceptance_criteria: vec!["works".into(), " ".into()],
        ..Default::default()
    })
    .unwrap();
    let b = create(&t.store, &actor(), NewIssue { priority: Some(Priority::Critical), ..new("Second") }).unwrap();
    assert_eq!((a.number, b.number), (1, 2));
    assert_eq!(a.title, "First");
    assert_eq!(a.status, IssueStatus::Todo);
    assert_eq!(a.labels, vec!["bug", "ui"]);
    assert_eq!(a.acceptance_criteria.len(), 1);
    assert_eq!(a.history.len(), 1);
    assert_eq!(a.created_by, actor());

    // Labels used by issues are added to the catalog.
    let labels = labels_list(&t.store).unwrap();
    assert_eq!(labels.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(), vec!["bug", "ui"]);

    let c = code(&t);
    for r in [a.id.to_string(), format!("{c}-1"), format!("{}-1", c.to_lowercase()), "#1".into(), "1".into()] {
        assert_eq!(get(&t.store, &r).unwrap().id, a.id, "{r}");
    }
    assert_eq!(get(&t.store, "QX-1").unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(get(&t.store, "#99").unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(get(&t.store, "../etc").unwrap_err().code, ErrorCode::InvalidInput);
    assert_eq!(display_ref(&crate::domains::project_config::read(&t.store).unwrap(), &a), format!("{c}-1"));

    // Sorted by priority desc, then number.
    let l = list(&t.store, &IssueQuery::default()).unwrap();
    assert_eq!(l.items.iter().map(|i| i.number).collect::<Vec<_>>(), vec![2, 1]);
    let l = list(&t.store, &IssueQuery { text: Some(format!("{c}-2")), ..Default::default() }).unwrap();
    assert_eq!(l.items.len(), 1);
    let l = list(&t.store, &IssueQuery { labels: vec!["ui".into()], ..Default::default() }).unwrap();
    assert_eq!(l.items.len(), 1);

    // Numbers stay monotonic after deletion.
    delete(&t.store, &actor(), "#2").unwrap();
    assert_eq!(create(&t.store, &actor(), new("Third")).unwrap().number, 3);

    // On disk: camelCase, canonical enum values, no `state`.
    let raw: serde_json::Value = serde_json::from_slice(
        &std::fs::read(t.store.data_dir().join("issues").join(format!("{}.json", a.id))).unwrap(),
    )
    .unwrap();
    assert_eq!(raw["status"], "todo");
    assert!(raw.get("state").is_none());
    assert!(raw.get("createdAt").is_some());
}

#[test]
fn patch_sets_and_clears() {
    let t = tp();
    let epic = epic_create(&t.store, &actor(), NewEpic { title: "E".into(), ..Default::default() }).unwrap();
    let parent = create(&t.store, &actor(), new("parent")).unwrap();
    let i = create(&t.store, &actor(), NewIssue { body: Some("b".into()), user_story: Some("u".into()), ..new("x") }).unwrap();
    let p: IssuePatch = serde_json::from_value(serde_json::json!({
        "epicId": epic.id, "parentId": parent.id, "title": "y", "status": "qa"
    }))
    .unwrap();
    let u = update(&t.store, &actor(), i.id.as_str(), p).unwrap();
    assert_eq!(u.epic_id.as_ref(), Some(&epic.id));
    assert_eq!(u.parent_id.as_ref(), Some(&parent.id));
    assert_eq!(u.title, "y");
    assert_eq!(u.status, IssueStatus::Qa);
    assert_eq!(u.history.len(), 2);
    assert_eq!(u.body.as_deref(), Some("b"), "absent field unchanged");

    let p: IssuePatch =
        serde_json::from_value(serde_json::json!({ "body": null, "userStory": null, "epicId": null, "parentId": null }))
            .unwrap();
    let u = update(&t.store, &actor(), i.id.as_str(), p).unwrap();
    assert!(u.body.is_none() && u.user_story.is_none() && u.epic_id.is_none() && u.parent_id.is_none());

    // Self-references are rejected.
    let p = IssuePatch { blocked_by: Some(vec![i.id.clone()]), ..Default::default() };
    assert_eq!(update(&t.store, &actor(), i.id.as_str(), p).unwrap_err().code, ErrorCode::InvalidInput);
    let p = IssuePatch { parent_id: Some(Some(i.id.clone())), ..Default::default() };
    assert_eq!(update(&t.store, &actor(), i.id.as_str(), p).unwrap_err().code, ErrorCode::InvalidInput);
    // Unknown references are not_found.
    let p = IssuePatch { depends_on: Some(vec![crate::ids::new_id()]), ..Default::default() };
    assert_eq!(update(&t.store, &actor(), i.id.as_str(), p).unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(update(&t.store, &actor(), "x", IssuePatch::default()).unwrap_err().code, ErrorCode::InvalidInput);
}

#[test]
fn patch_merges_ext_per_key() {
    let t = tp();
    let i = create(&t.store, &actor(), new("x")).unwrap();
    let p: IssuePatch =
        serde_json::from_value(serde_json::json!({ "ext": { "github": { "number": 7 }, "other": 1 } })).unwrap();
    let u = update(&t.store, &actor(), i.id.as_str(), p).unwrap();
    assert_eq!(u.ext.get("github"), Some(&serde_json::json!({ "number": 7 })));
    let p: IssuePatch = serde_json::from_value(serde_json::json!({ "ext": { "other": null } })).unwrap();
    let u = update(&t.store, &actor(), i.id.as_str(), p).unwrap();
    assert!(u.ext.contains_key("github"), "keys not named are kept");
    assert!(!u.ext.contains_key("other"), "null removes the key");
}

#[test]
fn close_sets_done_and_cascades_unblock() {
    let t = tp();
    let a = create(&t.store, &actor(), new("blocker A")).unwrap();
    let b = create(&t.store, &actor(), new("blocker B")).unwrap();
    let blocked = create(&t.store, &actor(), NewIssue {
        status: Some(IssueStatus::Blocked),
        blocked_by: vec![a.id.clone(), b.id.clone()],
        ..new("blocked")
    })
    .unwrap();
    let backlog = create(&t.store, &actor(), NewIssue {
        status: Some(IssueStatus::Backlog),
        blocked_by: vec![a.id.clone()],
        ..new("backlog")
    })
    .unwrap();

    let events: Arc<Mutex<Vec<ChangeEvent>>> = Default::default();
    let ev = events.clone();
    t.store.bus().subscribe(move |e| ev.lock().unwrap().push(e.clone()));

    let closed = close(&t.store, &actor(), &a.id.to_string()).unwrap();
    assert_eq!(closed.status, IssueStatus::Done);
    assert!(closed.is_closed());
    let x = get(&t.store, blocked.id.as_str()).unwrap();
    assert_eq!(x.blocked_by, vec![b.id.clone()]);
    assert_eq!(x.status, IssueStatus::Blocked, "still blocked by B");
    let y = get(&t.store, backlog.id.as_str()).unwrap();
    assert!(y.blocked_by.is_empty());
    assert_eq!(y.status, IssueStatus::Backlog, "only `blocked` issues move to todo");

    {
        let ev = events.lock().unwrap();
        assert_eq!(ev.len(), 1, "one event per domain per transaction: {ev:?}");
        assert_eq!(ev[0].domain, Domain::Issues);
        assert_eq!(ev[0].kind, ChangeKind::Updated);
        assert_eq!(ev[0].ids.len(), 3);
    }

    set_status(&t.store, &actor(), b.id.as_str(), IssueStatus::Done).unwrap();
    let x = get(&t.store, blocked.id.as_str()).unwrap();
    assert!(x.blocked_by.is_empty());
    assert_eq!(x.status, IssueStatus::Todo);
    assert_eq!(x.history.last().unwrap().from, Some(IssueStatus::Blocked));

    let r = reopen(&t.store, &actor(), a.id.as_str()).unwrap();
    assert_eq!(r.status, IssueStatus::Todo);
}

#[test]
fn delete_unlinks_references() {
    let t = tp();
    let a = create(&t.store, &actor(), new("a")).unwrap();
    let b = create(&t.store, &actor(), NewIssue {
        status: Some(IssueStatus::Blocked),
        blocked_by: vec![a.id.clone()],
        depends_on: vec![a.id.clone()],
        parent_id: Some(a.id.clone()),
        ..new("b")
    })
    .unwrap();
    assert_eq!(children(&t.store, a.id.as_str()).unwrap().len(), 1);
    assert_eq!(blocking(&t.store, b.id.as_str()).unwrap().len(), 1);
    delete(&t.store, &actor(), a.id.as_str()).unwrap();
    let b = get(&t.store, b.id.as_str()).unwrap();
    assert!(b.blocked_by.is_empty() && b.depends_on.is_empty() && b.parent_id.is_none());
    assert_eq!(b.status, IssueStatus::Todo);
    assert_eq!(delete(&t.store, &actor(), a.id.as_str()).unwrap_err().code, ErrorCode::NotFound);
}

#[test]
fn comments_and_criteria() {
    let t = tp();
    let i = create(&t.store, &actor(), NewIssue { acceptance_criteria: vec!["one".into()], ..new("x") }).unwrap();
    let i2 = add_comment(&t.store, &Actor::human("bob"), "#1", "hello").unwrap();
    assert_eq!(i2.comments.len(), 1);
    assert_eq!(i2.comments[0].created_by.name, "bob");
    assert_eq!(add_comment(&t.store, &actor(), "#1", "  ").unwrap_err().code, ErrorCode::InvalidInput);
    let i3 = delete_comment(&t.store, &actor(), "#1", &i2.comments[0].id).unwrap();
    assert!(i3.comments.is_empty());
    assert_eq!(delete_comment(&t.store, &actor(), "#1", &i2.comments[0].id).unwrap_err().code, ErrorCode::NotFound);

    let cid = i.acceptance_criteria[0].id.clone();
    assert!(toggle_criterion(&t.store, &actor(), "#1", &cid, None).unwrap().acceptance_criteria[0].checked);
    assert!(!toggle_criterion(&t.store, &actor(), "#1", &cid, None).unwrap().acceptance_criteria[0].checked);
    assert!(toggle_criterion(&t.store, &actor(), "#1", &cid, Some(true)).unwrap().acceptance_criteria[0].checked);
}

#[test]
fn claim_heartbeat_release() {
    let t = tp();
    create(&t.store, &actor(), new("x")).unwrap();
    let claim_as = |label: &str, term: &str| ClaimInput {
        agent_label: label.into(),
        terminal_id: Some(term.into()),
        session_id: Some("sess-1".into()),
        ..Default::default()
    };
    assert_eq!(heartbeat(&t.store, &actor(), "#1").unwrap_err().code, ErrorCode::Conflict);
    let c = claim(&t.store, &actor(), "#1", claim_as("agent A", "t1")).unwrap();
    assert_eq!(c.status, IssueStatus::InProgress);
    assert_eq!(c.assignment.as_ref().unwrap().agent_label, "agent A");
    // Same terminal re-claims fine; another agent conflicts while fresh.
    claim(&t.store, &actor(), "#1", claim_as("agent A", "t1")).unwrap();
    let other = ClaimInput { agent_label: "agent B".into(), terminal_id: Some("t2".into()), ..Default::default() };
    assert_eq!(claim(&t.store, &actor(), "#1", other.clone()).unwrap_err().code, ErrorCode::Conflict);
    heartbeat(&t.store, &actor(), "#1").unwrap();
    let bad = ClaimInput { session_id: Some("x; rm -rf ~".into()), ..other.clone() };
    assert_eq!(claim(&t.store, &actor(), "#1", bad).unwrap_err().code, ErrorCode::InvalidInput);

    // A stale claim can be taken over.
    let id = get(&t.store, "#1").unwrap().id;
    t.store
        .write(&actor(), |tx| {
            let mut i: Issue = tx.get(&id)?;
            i.assignment.as_mut().unwrap().last_heartbeat -= CLAIM_TTL_MS + 1;
            tx.put(&i)
        })
        .unwrap();
    let c = claim(&t.store, &actor(), "#1", other).unwrap();
    assert_eq!(c.assignment.as_ref().unwrap().agent_label, "agent B");

    let r = release(&t.store, &actor(), "#1").unwrap();
    assert!(r.assignment.is_none());
    assert_eq!(r.status, IssueStatus::Todo);
}

#[test]
fn labels_upsert_rename_delete() {
    let t = tp();
    create(&t.store, &actor(), NewIssue { labels: vec!["bug".into()], ..new("x") }).unwrap();
    let e = epic_create(&t.store, &actor(), NewEpic { title: "E".into(), labels: vec!["bug".into()], ..Default::default() })
        .unwrap();
    let l = label_upsert(&t.store, &actor(), Label { name: "bug".into(), color: "#FF0000".into(), description: None }, None)
        .unwrap();
    assert_eq!(l, vec![Label { name: "bug".into(), color: "#ff0000".into(), description: None }]);
    assert_eq!(
        label_upsert(&t.store, &actor(), Label { name: "x".into(), color: "red".into(), description: None }, None)
            .unwrap_err()
            .code,
        ErrorCode::InvalidInput
    );
    label_upsert(&t.store, &actor(), Label { name: "defect".into(), color: "#00ff00".into(), description: None }, Some("bug".into()))
        .unwrap();
    assert_eq!(get(&t.store, "#1").unwrap().labels, vec!["defect"]);
    assert_eq!(epic_get(&t.store, &e.id).unwrap().labels, vec!["defect"]);
    let l = label_delete(&t.store, &actor(), "defect").unwrap();
    assert!(l.is_empty());
    assert!(get(&t.store, "#1").unwrap().labels.is_empty());
    assert!(epic_get(&t.store, &e.id).unwrap().labels.is_empty());
    assert_eq!(label_delete(&t.store, &actor(), "defect").unwrap_err().code, ErrorCode::NotFound);
}

#[test]
fn epics_crud_and_delete_unlinks() {
    let t = tp();
    let e = epic_create(&t.store, &actor(), NewEpic { title: "Epic".into(), ..Default::default() }).unwrap();
    assert_eq!(e.status, EpicStatus::Open);
    let i = create(&t.store, &actor(), NewIssue { epic_id: Some(e.id.clone()), ..new("x") }).unwrap();
    let p: EpicPatch = serde_json::from_value(serde_json::json!({"status": "in_progress", "description": "d"})).unwrap();
    let e2 = epic_update(&t.store, &actor(), &e.id, p).unwrap();
    assert_eq!(e2.status, EpicStatus::InProgress);
    assert_eq!(e2.description.as_deref(), Some("d"));
    let p: EpicPatch = serde_json::from_value(serde_json::json!({"description": null})).unwrap();
    assert!(epic_update(&t.store, &actor(), &e.id, p).unwrap().description.is_none());
    assert_eq!(epics_list(&t.store).unwrap().items.len(), 1);
    epic_delete(&t.store, &actor(), &e.id).unwrap();
    assert!(get(&t.store, i.id.as_str()).unwrap().epic_id.is_none());
    assert_eq!(epic_get(&t.store, &e.id).unwrap_err().code, ErrorCode::NotFound);
    let unknown = NewIssue { epic_id: Some(e.id.clone()), ..new("y") };
    assert_eq!(create(&t.store, &actor(), unknown).unwrap_err().code, ErrorCode::NotFound);
}

#[test]
fn corrupt_issue_is_reported_and_never_overwritten() {
    let t = tp();
    let good = create(&t.store, &actor(), new("good")).unwrap();
    let bad_id = crate::ids::new_id();
    let path = t.store.data_dir().join("issues").join(format!("{bad_id}.json"));
    std::fs::write(&path, r#"{"id": "broken", "number": 7"#).unwrap();
    let l = list(&t.store, &IssueQuery::default()).unwrap();
    assert_eq!(l.items.len(), 1);
    assert_eq!(l.errors.len(), 1);
    assert_eq!(update(&t.store, &actor(), bad_id.as_str(), IssuePatch::default()).unwrap_err().code, ErrorCode::Corrupt);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), r#"{"id": "broken", "number": 7"#);
    // The lenient counter still sees number 7.
    assert_eq!(create(&t.store, &actor(), new("next")).unwrap().number, 8);
    let _ = good;
}

#[test]
fn create_in_tx_composes_with_other_writes() {
    let t = tp();
    let (a, b) = t
        .store
        .write(&actor(), |tx| {
            let a = create_in_tx(tx, new("a"))?;
            let b = create_in_tx(tx, NewIssue { blocked_by: vec![a.id.clone()], ..new("b") })?;
            set_status_in_tx(tx, &a.id, IssueStatus::Done)?;
            Ok((a, b))
        })
        .unwrap();
    assert_eq!((a.number, b.number), (1, 2));
    assert!(get(&t.store, b.id.as_str()).unwrap().blocked_by.is_empty());
}
