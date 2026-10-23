//! Watcher acceptance (DL-1): an external write produces exactly one
//! `External` event; this process's own write produces none (only its `Local` one).

mod common;

use common::TestEntity;
use quadflow_core::events::watcher::ProjectWatcher;
use quadflow_core::events::{ChangeEvent, ChangeKind, Domain, Origin};
use quadflow_core::store::atomic_write_json;
use quadflow_core::{new_id, Actor};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn wait_for(events: &Arc<Mutex<Vec<ChangeEvent>>>, pred: impl Fn(&ChangeEvent) -> bool, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if events.lock().unwrap().iter().any(&pred) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    false
}

#[test]
fn external_write_one_event_own_write_none() {
    let tp = common::TempProject::new();
    let events = Arc::new(Mutex::new(Vec::<ChangeEvent>::new()));
    let sink = events.clone();
    tp.store.bus().subscribe(move |e| sink.lock().unwrap().push(e.clone()));
    let watcher = ProjectWatcher::start(tp.store.root(), tp.store.bus().clone(), tp.store.recent_writes().clone()).unwrap();
    // Let the OS watcher settle.
    std::thread::sleep(Duration::from_millis(300));

    // 1. Own write: one Local event, no External.
    let own = TestEntity { id: new_id(), number: 1, title: "own".into() };
    tp.store.write(&Actor::system(), |tx| tx.put(&own)).unwrap();
    std::thread::sleep(Duration::from_millis(1200));
    {
        let ev = events.lock().unwrap();
        let local: Vec<_> = ev.iter().filter(|e| e.origin == Origin::Local).collect();
        let external: Vec<_> = ev.iter().filter(|e| e.origin == Origin::External).collect();
        assert_eq!(local.len(), 1, "{ev:?}");
        assert!(external.is_empty(), "own write leaked as external: {external:?}");
    }

    // 2. External write (what another process does): exactly one External event.
    let ext = TestEntity { id: new_id(), number: 2, title: "ext".into() };
    let path = tp.store.data_dir().join("issues").join(format!("{}.json", ext.id));
    atomic_write_json(&path, &ext).unwrap();
    let id = ext.id.to_string();
    assert!(
        wait_for(&events, |e| e.origin == Origin::External && e.ids.contains(&id), Duration::from_secs(5)),
        "no external event: {:?}",
        events.lock().unwrap()
    );
    std::thread::sleep(Duration::from_millis(800));
    let ev = events.lock().unwrap();
    let external: Vec<_> = ev.iter().filter(|e| e.origin == Origin::External).collect();
    assert_eq!(external.len(), 1, "{external:?}");
    assert_eq!(external[0].domain, Domain::Issues);
    assert_eq!(external[0].kind, ChangeKind::Updated);
    assert_eq!(external[0].ids, vec![id]);
    drop(ev);

    // 3. External delete → one Deleted event.
    std::fs::remove_file(&path).unwrap();
    assert!(wait_for(
        &events,
        |e| e.origin == Origin::External && e.kind == ChangeKind::Deleted,
        Duration::from_secs(5)
    ));
    drop(watcher);
}
