//! Cross-process concurrency (data-layer.md §12.2).
//!
//! The test re-executes its own binary with `QF_CONC_CHILD=1`; `child_entry`
//! returns immediately unless that variable is set, and otherwise runs the
//! child workload.

mod common;

use common::PROFILE;
use quadflow_core::domains::issues::{self, Issue, IssueQuery, Label, Labels, NewIssue};
use quadflow_core::domains::missions;
use quadflow_core::events::EventBus;
use quadflow_core::store::{AppChange, AppDb, ProjectStore};
use quadflow_core::{new_id, Actor, Id, ProjectRoot};
use std::path::Path;
use std::process::{Child, Command};
use std::time::Duration;

const PROCS: usize = 8;
const WRITES: usize = 50;
const LABELS: usize = 10;
const DB_PROCS: usize = 4;
const DB_WRITES: usize = 100;
const MSG_PROCS: usize = 4;
const MSG_WRITES: usize = 50;

fn spawn_child(mode: &str, root: &Path, shared: &str, idx: usize) -> Child {
    Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "child_entry", "--nocapture", "--test-threads=1"])
        .env("QF_CONC_CHILD", "1")
        .env("QF_CONC_MODE", mode)
        .env("QF_CONC_ROOT", root)
        .env("QF_CONC_SHARED", shared)
        .env("QF_CONC_IDX", idx.to_string())
        .spawn()
        .expect("spawn child")
}

#[test]
fn child_entry() {
    if std::env::var("QF_CONC_CHILD").is_err() {
        return;
    }
    let root = std::path::PathBuf::from(std::env::var("QF_CONC_ROOT").unwrap());
    let shared = std::env::var("QF_CONC_SHARED").unwrap();
    let idx: usize = std::env::var("QF_CONC_IDX").unwrap().parse().unwrap();
    let actor = Actor::human(format!("child-{idx}"));
    match std::env::var("QF_CONC_MODE").unwrap().as_str() {
        "project" => {
            let store = ProjectStore::open(ProjectRoot::open_with(&root, PROFILE).unwrap(), EventBus::new())
                .unwrap()
                .with_lock_timeout(Duration::from_secs(60));
            let shared = Id::parse(&shared).unwrap();
            for i in 0..WRITES {
                issues::create(&store, &actor, NewIssue { title: format!("c{idx}-{i}"), ..Default::default() }).unwrap();
                issues::add_comment(&store, &actor, shared.as_str(), &format!("c{idx}-{i}")).unwrap();
                if i < LABELS {
                    let name = format!("l{idx}-{i}");
                    let color = issues::labels::default_color(&name).to_string();
                    issues::label_upsert(&store, &actor, Label { name, color, description: None }, None).unwrap();
                }
            }
        }
        "missions" => {
            let store = ProjectStore::open(ProjectRoot::open_with(&root, PROFILE).unwrap(), EventBus::new())
                .unwrap()
                .with_lock_timeout(Duration::from_secs(60));
            let mission = Id::parse(&shared).unwrap();
            for i in 0..MSG_WRITES {
                missions::send_message(&store, &actor, &mission, missions::NewMissionMessage {
                    content: format!("c{idx}-{i}"),
                    kind: Some(missions::MissionMessageKind::Finding),
                    ..Default::default()
                })
                .unwrap();
            }
        }
        "appdb" => {
            let db = AppDb::open_at(&root, EventBus::new()).unwrap();
            for i in 0..DB_WRITES {
                let key = format!("k{idx}-{i}");
                db.write(
                    &[AppChange::new(quadflow_core::events::Domain::Settings, quadflow_core::events::ChangeKind::Updated, Some(key.clone()))],
                    |tx| {
                        tx.execute(
                            "INSERT OR REPLACE INTO settings (namespace, key, value, updated_at) VALUES ('test', ?1, '1', 0)",
                            [&key],
                        )?;
                        tx.execute(
                            "INSERT INTO chat_messages (id, conversation_id, role, content, created_at) VALUES (?1, ?2, 'user', 'hi', 0)",
                            [new_id().as_str(), shared.as_str()],
                        )
                    },
                )
                .unwrap();
            }
        }
        other => panic!("unknown mode {other}"),
    }
}

#[test]
fn project_store_8_processes_x_50_writes() {
    if std::env::var("QF_CONC_CHILD").is_ok() {
        return;
    }
    let tp = common::TempProject::new();
    let actor = Actor::system();
    // The shared comment thread is a real issue too (#1); children create #2..=#401.
    let shared = issues::create(&tp.store, &actor, NewIssue { title: "shared".into(), ..Default::default() }).unwrap();
    assert_eq!(shared.number, 1);

    let mut children: Vec<Child> =
        (0..PROCS).map(|i| spawn_child("project", tp.dir.path(), shared.id.as_str(), i)).collect();

    // Parent reads concurrently and must never see a parse error.
    let all = IssueQuery { include_done: true, ..Default::default() };
    let mut reads = 0usize;
    loop {
        let l = issues::list(&tp.store, &all).unwrap();
        assert!(l.errors.is_empty(), "parent observed unreadable files: {:?}", l.errors);
        let _: Issue = tp.store.get(&shared.id).unwrap();
        let _: Labels = tp.store.read_singleton().unwrap();
        reads += 1;
        let mut done = true;
        for c in children.iter_mut() {
            if c.try_wait().unwrap().is_none() {
                done = false;
            }
        }
        if done {
            break;
        }
    }
    for mut c in children {
        assert!(c.wait().unwrap().success(), "child failed");
    }
    assert!(reads > 0);

    let l = issues::list(&tp.store, &all).unwrap();
    assert!(l.errors.is_empty());
    assert_eq!(l.items.len(), PROCS * WRITES + 1);
    let mut numbers: Vec<u64> = l.items.iter().map(|e| e.number).collect();
    numbers.sort();
    assert_eq!(
        numbers,
        (1..=(PROCS * WRITES + 1) as u64).collect::<Vec<_>>(),
        "issue numbers must be unique and gap-free (1 shared + 400 from children)"
    );

    let t: Issue = tp.store.get(&shared.id).unwrap();
    assert_eq!(t.comments.len(), PROCS * WRITES);

    let labels = issues::labels_list(&tp.store).unwrap();
    assert_eq!(labels.len(), PROCS * LABELS);

    // No temp files left anywhere.
    fn temps(dir: &Path, n: &mut usize) {
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                temps(&p, n);
            } else if e.file_name().to_string_lossy().ends_with(".tmp") {
                *n += 1;
            }
        }
    }
    let mut n = 0;
    temps(&tp.store.data_dir(), &mut n);
    assert_eq!(n, 0, "temp files left behind");
}

#[test]
fn mission_send_message_4_processes_x_50() {
    if std::env::var("QF_CONC_CHILD").is_ok() {
        return;
    }
    let tp = common::TempProject::new();
    let actor = Actor::system();
    let m = missions::create(&tp.store, &actor, missions::NewMission { name: "conc".into(), ..Default::default() }).unwrap();
    let mut children: Vec<Child> =
        (0..MSG_PROCS).map(|i| spawn_child("missions", tp.dir.path(), m.id.as_str(), i)).collect();

    // Parent reads the log concurrently and must never see a bad line.
    loop {
        let l = missions::messages(&tp.store, &m.id, &Default::default()).unwrap();
        assert!(l.errors.is_empty(), "parent observed unreadable lines: {:?}", l.errors);
        let mut done = true;
        for c in children.iter_mut() {
            if c.try_wait().unwrap().is_none() {
                done = false;
            }
        }
        if done {
            break;
        }
    }
    for mut c in children {
        assert!(c.wait().unwrap().success(), "child failed");
    }
    let l = missions::messages(&tp.store, &m.id, &Default::default()).unwrap();
    assert!(l.errors.is_empty());
    assert_eq!(l.items.len(), MSG_PROCS * MSG_WRITES, "no message lost");
    let ids: std::collections::BTreeSet<_> = l.items.iter().map(|x| x.id.clone()).collect();
    assert_eq!(ids.len(), MSG_PROCS * MSG_WRITES, "message ids unique");
    let contents: std::collections::BTreeSet<_> = l.items.iter().map(|x| x.content.clone()).collect();
    for idx in 0..MSG_PROCS {
        for i in 0..MSG_WRITES {
            assert!(contents.contains(&format!("c{idx}-{i}")), "missing c{idx}-{i}");
        }
    }
    // Each process's own messages stay in order.
    for idx in 0..MSG_PROCS {
        let seq: Vec<usize> = l
            .items
            .iter()
            .filter_map(|x| x.content.strip_prefix(&format!("c{idx}-")).and_then(|n| n.parse().ok()))
            .collect();
        assert_eq!(seq, (0..MSG_WRITES).collect::<Vec<_>>());
    }
    // Activity (one line per finding) is complete too.
    let acts = missions::activity(&tp.store, &m.id, None, None).unwrap();
    assert!(acts.errors.is_empty());
    assert_eq!(acts.items.len(), MSG_PROCS * MSG_WRITES);
}

#[test]
fn app_db_4_processes_x_100_writes() {
    if std::env::var("QF_CONC_CHILD").is_ok() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let db_path = tmp.path().join("quadflow.db");
    let db = AppDb::open_at(&db_path, EventBus::new()).unwrap();
    let conv = new_id();
    db.write(&[], |tx| {
        tx.execute(
            "INSERT INTO chat_conversations (id, title, created_at, updated_at) VALUES (?1, 't', 0, 0)",
            [conv.as_str()],
        )
    })
    .unwrap();

    let children: Vec<Child> = (0..DB_PROCS).map(|i| spawn_child("appdb", &db_path, conv.as_str(), i)).collect();
    for mut c in children {
        assert!(c.wait().unwrap().success(), "child failed (SQLITE_BUSY surfaced?)");
    }
    let settings: i64 = db
        .read(|c| c.query_row("SELECT COUNT(*) FROM settings WHERE namespace = 'test'", [], |r| r.get(0)))
        .unwrap();
    let msgs: i64 = db.read(|c| c.query_row("SELECT COUNT(*) FROM chat_messages", [], |r| r.get(0))).unwrap();
    let changes: i64 = db.read(|c| c.query_row("SELECT COUNT(*) FROM app_changes", [], |r| r.get(0))).unwrap();
    assert_eq!(settings as usize, DB_PROCS * DB_WRITES);
    assert_eq!(msgs as usize, DB_PROCS * DB_WRITES);
    assert_eq!(changes as usize, DB_PROCS * DB_WRITES);
}
