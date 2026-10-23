//! Working-directory project registry (data-layer.md §7 `projects`, §7.1).
//!
//! "Project" means a working directory, only. Paths are deduplicated by
//! [`root_key`](crate::paths::root_key) (`C:\Foo` and `c:/foo/` are one
//! project). The active project is the setting `shell.activeProjectId`.

use super::settings::{self, KEY_ACTIVE_PROJECT, SHELL};
use crate::domains::project_config;
use crate::error::{CoreError, Result};
use crate::events::{ChangeKind, Domain};
use crate::ids::{new_id, Id};
use crate::model::{JsonValue, Timestamp};
use crate::paths::{root_key, Profile};
use crate::store::{AppChange, AppDb};
use crate::time::now_ms;
use rusqlite::{OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: Id,
    pub name: String,
    /// Canonical path as displayed.
    pub root: String,
    /// Normalized comparison key (`paths::root_key`).
    pub root_key: String,
    /// Shell-defined default workspace template (opaque JSON).
    #[specta(type = Option<JsonValue>)]
    pub default_workspace_template: Option<serde_json::Value>,
    pub last_opened_at: Option<Timestamp>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

/// Patch: absent = unchanged; `defaultWorkspaceTemplate: null` clears it.
#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<JsonValue>)]
    pub default_workspace_template: Option<Option<serde_json::Value>>,
}

const COLS: &str = "id, name, root, root_key, default_workspace_template, last_opened_at, created_at, updated_at";

fn from_row(r: &Row) -> rusqlite::Result<(Project, Option<String>)> {
    let id: String = r.get(0)?;
    Ok((
        Project {
            id: Id::parse(&id).map_err(|e| rusqlite::Error::InvalidColumnType(0, e.message, rusqlite::types::Type::Text))?,
            name: r.get(1)?,
            root: r.get(2)?,
            root_key: r.get(3)?,
            default_workspace_template: None,
            last_opened_at: r.get(5)?,
            created_at: r.get(6)?,
            updated_at: r.get(7)?,
        },
        r.get(4)?,
    ))
}

fn finish((mut p, tpl): (Project, Option<String>)) -> Result<Project> {
    p.default_workspace_template = super::parse_json_opt("projects", p.id.as_str(), "default_workspace_template", tpl)?;
    Ok(p)
}

fn query(c: &rusqlite::Connection, sql_tail: &str, params: impl rusqlite::Params) -> rusqlite::Result<Vec<(Project, Option<String>)>> {
    let mut stmt = c.prepare(&format!("SELECT {COLS} FROM projects {sql_tail}"))?;
    let rows = stmt.query_map(params, from_row)?;
    rows.collect()
}

/// Most recently opened first.
pub fn list(db: &AppDb) -> Result<Vec<Project>> {
    let rows = db.read(|c| query(c, "ORDER BY COALESCE(last_opened_at, updated_at) DESC, created_at DESC", []))?;
    rows.into_iter().map(finish).collect()
}

pub fn get(db: &AppDb, id: &Id) -> Result<Project> {
    let rows = db.read(|c| query(c, "WHERE id = ?1", [id.as_str()]))?;
    rows.into_iter().next().map(finish).unwrap_or_else(|| Err(CoreError::not_found(format!("project {id}"))))
}

/// The registered project whose root has the same [`root_key`] as `path`.
pub fn find_by_path(db: &AppDb, path: &Path) -> Result<Option<Project>> {
    let key = root_key(path);
    let rows = db.read(|c| query(c, "WHERE root_key = ?1", [key.as_str()]))?;
    rows.into_iter().next().map(finish).transpose()
}

fn canonical_dir(path: &Path) -> Result<std::path::PathBuf> {
    let canon = dunce::canonicalize(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            CoreError::not_found(format!("{} does not exist", path.display()))
        } else {
            CoreError::io(path, e)
        }
    })?;
    if !canon.is_dir() {
        return Err(CoreError::invalid_input(format!("{} is not a directory", canon.display())));
    }
    Ok(canon)
}

fn folder_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| p.display().to_string())
}

/// Register `path` (idempotent by root key) without activating it.
pub fn register(db: &AppDb, path: &Path) -> Result<Project> {
    let canon = canonical_dir(path)?;
    let key = root_key(&canon);
    let root = canon.display().to_string();
    let name = folder_name(&canon);
    let id = db.transact(|tx, ch| register_in_tx(tx, ch, &key, &root, &name))?;
    get(db, &id)
}

fn register_in_tx(tx: &rusqlite::Transaction, ch: &mut Vec<AppChange>, key: &str, root: &str, name: &str) -> Result<Id> {
    let existing: Option<String> =
        tx.query_row("SELECT id FROM projects WHERE root_key = ?1", [key], |r| r.get(0)).optional()?;
    if let Some(id) = existing {
        return Id::parse(&id);
    }
    let id = new_id();
    let now = now_ms();
    tx.execute(
        "INSERT INTO projects (id, name, root, root_key, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        rusqlite::params![id.as_str(), name, root, key, now],
    )?;
    ch.push(AppChange::new(Domain::Projects, ChangeKind::Created, Some(id.as_str())));
    Ok(id)
}

/// Register `path` (idempotent), mark it opened now and make it the active
/// project. With `init_if_missing`, a folder that is not a QuadFlow project yet
/// gets `<project folder>/config.json` first (`quadflow init`).
pub fn open(db: &AppDb, path: &Path, profile: Profile, init_if_missing: bool) -> Result<Project> {
    let canon = canonical_dir(path)?;
    if init_if_missing {
        project_config::open_or_init(&canon, profile, db.bus().clone())?;
    }
    let key = root_key(&canon);
    let root = canon.display().to_string();
    let name = folder_name(&canon);
    let id = db.transact(|tx, ch| {
        let id = register_in_tx(tx, ch, &key, &root, &name)?;
        tx.execute(
            "UPDATE projects SET last_opened_at = ?1 WHERE id = ?2",
            rusqlite::params![now_ms(), id.as_str()],
        )?;
        ch.push(AppChange::new(Domain::Projects, ChangeKind::Updated, Some(id.as_str())));
        settings::set_in_tx(tx, SHELL, KEY_ACTIVE_PROJECT, &serde_json::Value::String(id.to_string()))?;
        ch.push(AppChange::new(Domain::Settings, ChangeKind::Updated, Some(format!("{SHELL}/{KEY_ACTIVE_PROJECT}"))));
        Ok(id)
    })?;
    get(db, &id)
}

pub fn update(db: &AppDb, id: &Id, patch: ProjectPatch) -> Result<Project> {
    let name = patch.name.as_deref().map(|n| super::non_empty("project name", n)).transpose()?;
    db.transact(|tx, ch| {
        let now = now_ms();
        let n = tx.execute("UPDATE projects SET updated_at = ?1 WHERE id = ?2", rusqlite::params![now, id.as_str()])?;
        if n == 0 {
            return Err(CoreError::not_found(format!("project {id}")));
        }
        if let Some(name) = &name {
            tx.execute("UPDATE projects SET name = ?1 WHERE id = ?2", rusqlite::params![name, id.as_str()])?;
        }
        if let Some(tpl) = &patch.default_workspace_template {
            let v = tpl.as_ref().filter(|v| !v.is_null()).map(super::to_json);
            tx.execute(
                "UPDATE projects SET default_workspace_template = ?1 WHERE id = ?2",
                rusqlite::params![v, id.as_str()],
            )?;
        }
        ch.push(AppChange::new(Domain::Projects, ChangeKind::Updated, Some(id.as_str())));
        Ok(())
    })?;
    get(db, id)
}

/// Mark a project as just used (sorts it first) without activating it.
pub fn touch(db: &AppDb, id: &Id) -> Result<()> {
    db.transact(|tx, ch| {
        let n = tx.execute("UPDATE projects SET last_opened_at = ?1 WHERE id = ?2", rusqlite::params![now_ms(), id.as_str()])?;
        if n == 0 {
            return Err(CoreError::not_found(format!("project {id}")));
        }
        ch.push(AppChange::new(Domain::Projects, ChangeKind::Updated, Some(id.as_str())));
        Ok(())
    })
}

/// Remove from the registry (cascades to its workspaces). Files are untouched.
pub fn remove(db: &AppDb, id: &Id) -> Result<()> {
    db.transact(|tx, ch| {
        let ws_ids: Vec<String> = {
            let mut stmt = tx.prepare("SELECT id FROM workspaces WHERE project_id = ?1")?;
            let rows = stmt.query_map([id.as_str()], |r| r.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let n = tx.execute("DELETE FROM projects WHERE id = ?1", [id.as_str()])?;
        if n == 0 {
            return Err(CoreError::not_found(format!("project {id}")));
        }
        ch.push(AppChange::new(Domain::Projects, ChangeKind::Deleted, Some(id.as_str())));
        for w in ws_ids {
            ch.push(AppChange::new(Domain::Workspaces, ChangeKind::Deleted, Some(w)));
        }
        let ws_key = settings::active_workspace_key(id.as_str());
        if settings::delete_in_tx(tx, SHELL, &ws_key)? {
            ch.push(AppChange::new(Domain::Settings, ChangeKind::Deleted, Some(format!("{SHELL}/{ws_key}"))));
        }
        let active: Option<String> = tx
            .query_row("SELECT value FROM settings WHERE namespace = ?1 AND key = ?2", [SHELL, KEY_ACTIVE_PROJECT], |r| r.get(0))
            .optional()?;
        if active.as_deref() == Some(&super::to_json(&serde_json::Value::String(id.to_string()))) {
            settings::delete_in_tx(tx, SHELL, KEY_ACTIVE_PROJECT)?;
            ch.push(AppChange::new(Domain::Settings, ChangeKind::Deleted, Some(format!("{SHELL}/{KEY_ACTIVE_PROJECT}"))));
        }
        Ok(())
    })
}

/// The active project (`shell.activeProjectId`), if it is still registered.
pub fn active(db: &AppDb) -> Result<Option<Project>> {
    let Some(id) = settings::get_string(db, SHELL, KEY_ACTIVE_PROJECT)? else { return Ok(None) };
    let Ok(id) = Id::parse(&id) else { return Ok(None) };
    match get(db, &id) {
        Ok(p) => Ok(Some(p)),
        Err(e) if e.code == crate::error::ErrorCode::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// For a set of live terminal ids: project id → number of those terminals saved
/// in that project's workspaces.
pub fn terminal_counts(db: &AppDb, terminal_ids: &[String]) -> Result<BTreeMap<String, u32>> {
    if terminal_ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let wanted: std::collections::HashSet<&str> = terminal_ids.iter().map(String::as_str).collect();
    let rows: Vec<(String, String)> = db.read(|c| {
        let mut stmt = c.prepare(
            "SELECT DISTINCT w.project_id, t.id FROM workspace_terminals t JOIN workspaces w ON w.id = t.workspace_id",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    })?;
    let mut out: BTreeMap<String, u32> = BTreeMap::new();
    for (pid, tid) in rows {
        if wanted.contains(tid.as_str()) {
            *out.entry(pid).or_default() += 1;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domains::app::test_util::app;
    use crate::error::ErrorCode;

    #[test]
    fn path_normalization_dedupes() {
        let a = app();
        let dir = a.dir.path().join("Foo");
        std::fs::create_dir(&dir).unwrap();
        let p1 = register(&a.db, &dir).unwrap();
        // Same folder with a trailing separator, forward slashes and (on
        // case-insensitive filesystems) a different case.
        let s = dir.display().to_string();
        let mut variants = vec![format!("{s}/"), s.replace('\\', "/"), format!("{}/", s.replace('\\', "/"))];
        if cfg!(any(windows, target_os = "macos")) {
            variants.push(s.to_lowercase());
            variants.push(format!("{}/", s.to_uppercase().replace('\\', "/")));
        }
        for v in variants {
            let p = register(&a.db, Path::new(&v)).unwrap();
            assert_eq!(p.id, p1.id, "{v} registered a duplicate");
            let o = open(&a.db, Path::new(&v), Profile::Dev, false).unwrap();
            assert_eq!(o.id, p1.id);
        }
        assert_eq!(list(&a.db).unwrap().len(), 1);
        assert_eq!(find_by_path(&a.db, &dir).unwrap().unwrap().id, p1.id);
        assert_eq!(p1.name, "Foo");
        assert!(!p1.root_key.ends_with('/'));
    }

    #[test]
    fn open_activates_and_inits() {
        let a = app();
        let d1 = a.dir.path().join("one");
        let d2 = a.dir.path().join("two");
        std::fs::create_dir(&d1).unwrap();
        std::fs::create_dir(&d2).unwrap();
        assert!(active(&a.db).unwrap().is_none());
        let p1 = open(&a.db, &d1, Profile::Dev, true).unwrap();
        assert!(d1.join(".quadflow-dev").join("config.json").is_file());
        assert_eq!(active(&a.db).unwrap().unwrap().id, p1.id);
        let p2 = open(&a.db, &d2, Profile::Dev, false).unwrap();
        assert!(!d2.join(".quadflow-dev").exists());
        assert_eq!(active(&a.db).unwrap().unwrap().id, p2.id);
        // Re-opening an initialized project is fine (ms timestamps: make it strictly later).
        std::thread::sleep(std::time::Duration::from_millis(5));
        open(&a.db, &d1, Profile::Dev, true).unwrap();
        assert_eq!(list(&a.db).unwrap()[0].id, p1.id, "most recently opened first");

        let missing = open(&a.db, &a.dir.path().join("nope"), Profile::Dev, true).unwrap_err();
        assert_eq!(missing.code, ErrorCode::NotFound);
    }

    #[test]
    fn update_and_remove() {
        let a = app();
        let d = a.dir.path().join("p");
        std::fs::create_dir(&d).unwrap();
        let p = open(&a.db, &d, Profile::Dev, false).unwrap();
        let u = update(&a.db, &p.id, ProjectPatch { name: Some("Renamed".into()), default_workspace_template: Some(Some(serde_json::json!({"terminalCount": 2}))) }).unwrap();
        assert_eq!(u.name, "Renamed");
        assert_eq!(u.default_workspace_template, Some(serde_json::json!({"terminalCount": 2})));
        // Absent = unchanged; explicit null clears.
        let patch: ProjectPatch = serde_json::from_str("{}").unwrap();
        assert!(update(&a.db, &p.id, patch).unwrap().default_workspace_template.is_some());
        let patch: ProjectPatch = serde_json::from_str(r#"{"defaultWorkspaceTemplate":null}"#).unwrap();
        assert!(update(&a.db, &p.id, patch).unwrap().default_workspace_template.is_none());
        assert_eq!(update(&a.db, &p.id, ProjectPatch { name: Some(" ".into()), ..Default::default() }).unwrap_err().code, ErrorCode::InvalidInput);

        a.take_events();
        remove(&a.db, &p.id).unwrap();
        assert!(active(&a.db).unwrap().is_none());
        assert!(list(&a.db).unwrap().is_empty());
        assert!(d.exists(), "files untouched");
        let ev = a.take_events();
        assert!(ev.iter().any(|e| e.domain == Domain::Projects && e.kind == ChangeKind::Deleted));
        assert_eq!(remove(&a.db, &p.id).unwrap_err().code, ErrorCode::NotFound);
    }
}
