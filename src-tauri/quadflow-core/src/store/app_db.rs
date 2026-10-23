//! `AppDb`: the one app-level SQLite database (data-layer.md §4.6, §7).
//!
//! Every connection (GUI and CLI) runs WAL + `busy_timeout=5000` +
//! `foreign_keys=ON`. Writes are `BEGIN IMMEDIATE` transactions that also insert
//! `app_changes` rows, so other processes can follow changes (§8.3).

use crate::error::{CoreError, Result};
use crate::events::{ChangeKind, ChangeScope, Domain, EventBus, Origin};
use crate::paths::AppPaths;
use crate::time::now_ms;
use parking_lot::Mutex;
use rusqlite::{Connection, Transaction, TransactionBehavior};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// Schema migrations, applied in order and tracked by `PRAGMA user_version`.
pub const MIGRATIONS: &[&str] = &[include_str!("migrations/0001_init.sql")];

/// One row to record in `app_changes` alongside a write.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppChange {
    pub domain: Domain,
    pub entity_id: Option<String>,
    pub op: ChangeKind,
}

impl AppChange {
    pub fn new(domain: Domain, op: ChangeKind, entity_id: Option<impl Into<String>>) -> Self {
        Self { domain, op, entity_id: entity_id.map(Into::into) }
    }
}

pub struct AppDb {
    conn: Mutex<Connection>,
    bus: EventBus,
    path: PathBuf,
}

/// Apply the per-connection pragmas.
pub fn configure(conn: &Connection) -> Result<()> {
    conn.busy_timeout(std::time::Duration::from_millis(5000))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;",
    )?;
    Ok(())
}

impl AppDb {
    pub fn open(paths: &AppPaths, bus: EventBus) -> Result<Self> {
        Self::open_at(&paths.db_path, bus)
    }

    pub fn open_at(path: &Path, bus: EventBus) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| CoreError::io(dir, e))?;
        }
        let mut conn = Connection::open(path).map_err(|e| CoreError::io(path, e))?;
        configure(&conn)?;
        migrate(&mut conn, path)?;
        Ok(Self { conn: Mutex::new(conn), bus, path: path.to_path_buf() })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn bus(&self) -> &EventBus {
        &self.bus
    }

    pub fn read<R>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<R>) -> Result<R> {
        let conn = self.conn.lock();
        Ok(f(&conn)?)
    }

    /// `BEGIN IMMEDIATE; f; INSERT app_changes rows; COMMIT;` then publish one
    /// `Local` event per (domain, op).
    pub fn write<R>(&self, changes: &[AppChange], f: impl FnOnce(&Transaction) -> rusqlite::Result<R>) -> Result<R> {
        let value = {
            let mut conn = self.conn.lock();
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let value = f(&tx)?;
            {
                let mut stmt = tx.prepare_cached(
                    "INSERT INTO app_changes (domain, entity_id, op, at, pid) VALUES (?1, ?2, ?3, ?4, ?5)",
                )?;
                let at = now_ms();
                let pid = std::process::id() as i64;
                for c in changes {
                    stmt.execute(rusqlite::params![c.domain.as_str(), c.entity_id, c.op.as_str(), at, pid])?;
                }
            }
            tx.commit()?;
            value
        };
        let mut grouped: BTreeMap<(Domain, ChangeKind), BTreeSet<String>> = BTreeMap::new();
        for c in changes {
            let ids = grouped.entry((c.domain, c.op)).or_default();
            if let Some(id) = &c.entity_id {
                ids.insert(id.clone());
            }
        }
        for ((domain, op), ids) in grouped {
            self.bus.emit(ChangeScope::App, domain, op, ids.into_iter().collect(), Origin::Local);
        }
        Ok(value)
    }

    /// Like [`AppDb::write`], but the closure returns a `CoreError` result and
    /// collects the change rows itself (ids are often only known inside the
    /// transaction). `Err` rolls the whole transaction back and records nothing.
    pub fn transact<R>(&self, f: impl FnOnce(&Transaction, &mut Vec<AppChange>) -> Result<R>) -> Result<R> {
        let mut changes = Vec::new();
        let value = {
            let mut conn = self.conn.lock();
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let value = f(&tx, &mut changes)?; // drop(tx) on Err = rollback
            {
                let mut stmt = tx.prepare_cached(
                    "INSERT INTO app_changes (domain, entity_id, op, at, pid) VALUES (?1, ?2, ?3, ?4, ?5)",
                )?;
                let at = now_ms();
                let pid = std::process::id() as i64;
                for c in &changes {
                    stmt.execute(rusqlite::params![c.domain.as_str(), c.entity_id, c.op.as_str(), at, pid])?;
                }
            }
            tx.commit()?;
            value
        };
        self.publish(&changes);
        Ok(value)
    }

    fn publish(&self, changes: &[AppChange]) {
        let mut grouped: BTreeMap<(Domain, ChangeKind), BTreeSet<String>> = BTreeMap::new();
        for c in changes {
            let ids = grouped.entry((c.domain, c.op)).or_default();
            if let Some(id) = &c.entity_id {
                ids.insert(id.clone());
            }
        }
        for ((domain, op), ids) in grouped {
            self.bus.emit(ChangeScope::App, domain, op, ids.into_iter().collect(), Origin::Local);
        }
    }

    /// Delete `app_changes` rows older than `max_age_ms` (GUI: on startup and hourly).
    pub fn prune_changes(&self, max_age_ms: i64) -> Result<usize> {
        let cutoff = now_ms() - max_age_ms;
        let conn = self.conn.lock();
        Ok(conn.execute("DELETE FROM app_changes WHERE at < ?1", [cutoff])?)
    }
}

fn migrate(conn: &mut Connection, path: &Path) -> Result<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let version: i64 = tx.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version as usize > MIGRATIONS.len() {
        return Err(CoreError::incompatible(format!(
            "{} was created by a newer QuadFlow (schema v{version}, this build knows v{})",
            path.display(),
            MIGRATIONS.len()
        )));
    }
    if version == 0 {
        // A pre-existing database we didn't create (e.g. the old TS-layer DB) is never
        // touched: refuse instead of mixing schemas.
        let foreign: i64 = tx.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            [],
            |r| r.get(0),
        )?;
        if foreign > 0 {
            return Err(CoreError::incompatible(format!(
                "{} is not a quadflow-core database (old format); delete it to start fresh",
                path.display()
            )));
        }
    }
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (i + 1) as i64)?;
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex as StdMutex};

    #[test]
    fn opens_migrates_and_records_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let bus = EventBus::new();
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let s2 = seen.clone();
        bus.subscribe(move |e| s2.lock().unwrap().push(e.clone()));
        let db = AppDb::open(&AppPaths::under(tmp.path()), bus.clone()).unwrap();
        let v: i64 = db.read(|c| c.query_row("PRAGMA user_version", [], |r| r.get(0))).unwrap();
        assert_eq!(v, 1);
        let mode: String = db.read(|c| c.query_row("PRAGMA journal_mode", [], |r| r.get(0))).unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        let fk: i64 = db.read(|c| c.query_row("PRAGMA foreign_keys", [], |r| r.get(0))).unwrap();
        assert_eq!(fk, 1);

        db.write(&[AppChange::new(Domain::Settings, ChangeKind::Updated, Some("shell.x"))], |tx| {
            tx.execute(
                "INSERT INTO settings (namespace, key, value, updated_at) VALUES ('shell','x','1',0)",
                [],
            )
        })
        .unwrap();
        let n: i64 = db.read(|c| c.query_row("SELECT COUNT(*) FROM app_changes", [], |r| r.get(0))).unwrap();
        assert_eq!(n, 1);
        let ev = seen.lock().unwrap();
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0].scope, ChangeScope::App);
        assert_eq!(ev[0].ids, vec!["shell.x".to_string()]);
        drop(ev);

        // Re-open is a no-op migration.
        drop(db);
        AppDb::open(&AppPaths::under(tmp.path()), bus).unwrap();
    }

    #[test]
    fn refuses_newer_and_foreign_databases() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("newer.db");
        {
            let c = Connection::open(&p).unwrap();
            c.pragma_update(None, "user_version", 99).unwrap();
        }
        let e = AppDb::open_at(&p, EventBus::new()).err().unwrap();
        assert_eq!(e.code, crate::error::ErrorCode::Incompatible);

        let p = tmp.path().join("foreign.db");
        {
            let c = Connection::open(&p).unwrap();
            c.execute_batch("CREATE TABLE projects (id TEXT, working_directory TEXT);").unwrap();
        }
        let e = AppDb::open_at(&p, EventBus::new()).err().unwrap();
        assert_eq!(e.code, crate::error::ErrorCode::Incompatible);
        // The foreign table is untouched.
        let c = Connection::open(&p).unwrap();
        let cols: i64 = c.query_row("SELECT COUNT(*) FROM pragma_table_info('projects')", [], |r| r.get(0)).unwrap();
        assert_eq!(cols, 2);
    }
}
