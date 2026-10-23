//! Cross-process app-DB change cursor (data-layer.md §8.3).
//!
//! The GUI watches `quadflow.db` / `quadflow.db-wal` and, on change, runs one
//! query `seq > cursor`, advancing the cursor to the max seq **of the returned
//! rows** (no second query → no race). Rows written by this process are skipped
//! (the in-process bus already published them).
//!
//! The file watcher alone is not enough everywhere: a write into an existing
//! WAL page range from another process does not always produce a change
//! notification (Windows defers last-write updates of files kept open). A cheap
//! fallback tick (the same cursor query every [`FALLBACK_POLL`]) makes sure a
//! CLI write reaches the GUI within a couple of seconds.

use super::{ChangeKind, ChangeScope, Domain, EventBus, Origin};
use crate::error::{CoreError, Result};
use crate::store::app_db::configure;
use notify_debouncer_full::notify::{RecommendedWatcher, RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, FileIdMap};
use parking_lot::Mutex;
use rusqlite::Connection;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Interval of the fallback cursor query (see the module docs).
pub const FALLBACK_POLL: Duration = Duration::from_millis(1500);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppChangeRow {
    pub seq: i64,
    pub domain: String,
    pub entity_id: Option<String>,
    pub op: String,
    pub pid: i64,
}

/// One cursor query. Returns the rows and the new cursor.
pub fn poll(conn: &Connection, cursor: i64) -> Result<(Vec<AppChangeRow>, i64)> {
    let mut stmt = conn.prepare_cached(
        "SELECT seq, domain, entity_id, op, pid FROM app_changes WHERE seq > ?1 ORDER BY seq",
    )?;
    let rows = stmt
        .query_map([cursor], |r| {
            Ok(AppChangeRow { seq: r.get(0)?, domain: r.get(1)?, entity_id: r.get(2)?, op: r.get(3)?, pid: r.get(4)? })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let next = rows.last().map(|r| r.seq).unwrap_or(cursor);
    Ok((rows, next))
}

/// Publish `External` events for rows not written by `own_pid` (one per domain+op).
pub fn publish_rows(bus: &EventBus, rows: &[AppChangeRow], own_pid: i64) {
    let mut grouped: std::collections::BTreeMap<(Domain, ChangeKind), std::collections::BTreeSet<String>> =
        Default::default();
    for r in rows.iter().filter(|r| r.pid != own_pid) {
        let (Some(domain), Some(op)) = (Domain::parse(&r.domain), ChangeKind::parse(&r.op)) else { continue };
        let ids = grouped.entry((domain, op)).or_default();
        if let Some(id) = &r.entity_id {
            ids.insert(id.clone());
        }
    }
    for ((domain, op), ids) in grouped {
        bus.emit(ChangeScope::App, domain, op, ids.into_iter().collect(), Origin::External);
    }
}

/// Follows the app DB from another process' point of view; stops when dropped.
pub struct AppChangesWatcher {
    _debouncer: Debouncer<RecommendedWatcher, FileIdMap>,
    stop: Arc<AtomicBool>,
}

impl Drop for AppChangesWatcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

type CursorState = Arc<Mutex<(Connection, i64)>>;

fn run_poll(state: &CursorState, bus: &EventBus, own_pid: i64) {
    let mut guard = state.lock();
    let (conn, cursor) = &mut *guard;
    match poll(conn, *cursor) {
        Ok((rows, next)) => {
            *cursor = next;
            publish_rows(bus, &rows, own_pid);
        }
        Err(e) => tracing::warn!("app_changes poll failed: {e}"),
    }
}

impl AppChangesWatcher {
    pub fn start(db_path: &Path, bus: EventBus) -> Result<Self> {
        let conn = Connection::open(db_path).map_err(|e| CoreError::io(db_path, e))?;
        configure(&conn)?;
        let start: i64 = conn.query_row("SELECT COALESCE(MAX(seq), 0) FROM app_changes", [], |r| r.get(0))?;
        let state: CursorState = Arc::new(Mutex::new((conn, start)));
        let own_pid = std::process::id() as i64;
        let file_name = db_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let wal_name = format!("{file_name}-wal");
        let (h_state, h_bus) = (Arc::clone(&state), bus.clone());
        let handler = move |result: DebounceEventResult| {
            let relevant = match &result {
                Ok(events) => events.iter().any(|e| {
                    e.paths.iter().any(|p| {
                        p.file_name().map(|n| n == file_name.as_str() || n == wal_name.as_str()).unwrap_or(false)
                    })
                }),
                Err(_) => true,
            };
            if !relevant {
                return;
            }
            run_poll(&h_state, &h_bus, own_pid);
        };
        let dir = db_path.parent().ok_or_else(|| CoreError::invalid_input("db path has no parent"))?;
        let mut debouncer = new_debouncer(Duration::from_millis(200), None, handler)
            .map_err(|e| CoreError::internal(format!("start app-db watcher: {e}")))?;
        debouncer.watcher().watch(dir, RecursiveMode::NonRecursive).map_err(|e| CoreError::io(dir, e))?;
        let stop = Arc::new(AtomicBool::new(false));
        let s2 = Arc::clone(&stop);
        std::thread::Builder::new()
            .name("app-changes-poll".into())
            .spawn(move || {
                while !s2.load(Ordering::SeqCst) {
                    std::thread::sleep(FALLBACK_POLL);
                    if s2.load(Ordering::SeqCst) {
                        break;
                    }
                    run_poll(&state, &bus, own_pid);
                }
            })
            .map_err(|e| CoreError::internal(format!("start app-db poll thread: {e}")))?;
        Ok(Self { _debouncer: debouncer, stop })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::AppPaths;
    use crate::store::{AppChange, AppDb};

    #[test]
    fn cursor_advances_and_skips_own_pid() {
        let tmp = tempfile::tempdir().unwrap();
        let db = AppDb::open(&AppPaths::under(tmp.path()), EventBus::new()).unwrap();
        db.write(&[AppChange::new(Domain::Settings, ChangeKind::Updated, Some("a"))], |_| Ok(())).unwrap();
        db.read(|c| {
            c.execute(
                "INSERT INTO app_changes (domain, entity_id, op, at, pid) VALUES ('chat','c1','created',0,-7)",
                [],
            )
        })
        .unwrap();
        let conn = Connection::open(db.path()).unwrap();
        let (rows, cursor) = poll(&conn, 0).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(cursor, rows[1].seq);
        let bus = EventBus::new();
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let s2 = seen.clone();
        bus.subscribe(move |e| s2.lock().unwrap().push(e.clone()));
        publish_rows(&bus, &rows, std::process::id() as i64);
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].domain, Domain::Chat);
        assert_eq!(seen[0].origin, Origin::External);
        let (rows, c2) = poll(&conn, cursor).unwrap();
        assert!(rows.is_empty());
        assert_eq!(c2, cursor);
    }

    /// A write by "another process" (a row with a foreign pid, through its own
    /// connection) reaches the bus of a process that watches the DB.
    #[test]
    fn watcher_publishes_foreign_writes() {
        let tmp = tempfile::tempdir().unwrap();
        let db = AppDb::open(&AppPaths::under(tmp.path()), EventBus::new()).unwrap();
        let bus = EventBus::new();
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let s2 = seen.clone();
        bus.subscribe(move |e| s2.lock().unwrap().push(e.clone()));
        let _w = AppChangesWatcher::start(db.path(), bus).unwrap();
        let other = Connection::open(db.path()).unwrap();
        configure(&other).unwrap();
        other
            .execute("INSERT INTO app_changes (domain, entity_id, op, at, pid) VALUES ('chat','c9','created',0,-42)", [])
            .unwrap();
        drop(other);
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while seen.lock().unwrap().is_empty() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert_eq!(seen[0].domain, Domain::Chat);
        assert_eq!(seen[0].ids, vec!["c9".to_string()]);
        assert_eq!(seen[0].origin, Origin::External);
    }
}
