//! QuadFlow 1.x (identifier `com.quadflow.app`) — the one piece of backwards
//! compatibility in the repository (data-layer.md §15).
//!
//! Two things, nothing more:
//!
//! 1. **Project list import.** The 1.x app DB `<1.x data dir>/quadflow.db`
//!    lists the user's projects (name + folder). [`run`] registers them in this
//!    app's projects list. The DB is read from a temporary copy (with its
//!    `-wal`/`-shm`), so a running 1.x is never disturbed. App settings and the
//!    1.x workspaces are not imported: they start at the defaults.
//! 2. **1.x project folders.** This version cannot read a 1.x `.quadflow/`
//!    folder (no `formatVersion`, other shapes). [`legacy::check_project`] —
//!    run when the GUI or CLI opens a project, and for every imported project —
//!    moves such a folder aside to `.quadflow-v1-backup/` (numbered suffix if
//!    taken; never deleted) and creates a fresh `.quadflow/`. In the dev profile
//!    nothing is moved (dev builds only write `.quadflow-dev/`): it is reported.
//!
//! The 1.x data dir is `<platform data dir>/com.quadflow.app` in release
//! builds, overridable with `QUADFLOW_V1_DATA_DIR`. Dev builds only ever read an
//! explicit `QUADFLOW_V1_DATA_DIR` — never the real installation.

pub mod legacy;

#[cfg(test)]
mod tests;

use crate::domains::app::{projects, settings};
use crate::error::{CoreError, Result};
use crate::events::EventBus;
use crate::model::Timestamp;
use crate::paths::{root_key, Profile};
use crate::store::AppDb;
use crate::time::now_ms;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// Env override for the 1.x data dir (tests, dev builds).
pub const ENV_V1_DATA_DIR: &str = "QUADFLOW_V1_DATA_DIR";
/// 1.x Tauri identifier (= its app-data folder name).
pub const V1_APP_ID: &str = "com.quadflow.app";
/// Settings namespace / key of the import state.
pub const STATE_NS: &str = "importV1";
pub const STATE_KEY: &str = "state";

// ---------------------------------------------------------------- types

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ImportV1Outcome {
    /// Added to the projects list (its folder has no 1.x data).
    Registered,
    /// Already in the projects list.
    AlreadyRegistered,
    /// The 1.x `.quadflow/` was moved aside, a fresh one created, and the project added.
    MovedAside,
    /// Dry run: would be added (no 1.x data in the folder).
    WouldRegister,
    /// Dry run: the 1.x `.quadflow/` would be moved aside, then the project added.
    WouldMoveAside,
    /// Dev profile: the folder has 1.x data in `.quadflow/`; left as is.
    V1DataKept,
    /// The project folder does not exist any more.
    MissingDir,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportV1ProjectReport {
    pub name: String,
    pub root: String,
    pub outcome: ImportV1Outcome,
    /// Where the 1.x folder was (or would be) moved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportV1Report {
    pub dry_run: bool,
    pub profile: Profile,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_dir: Option<String>,
    pub projects: Vec<ImportV1ProjectReport>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ImportV1StateStatus {
    Completed,
    Dismissed,
}

/// Persisted in settings `importV1/state`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportV1State {
    pub status: ImportV1StateStatus,
    pub at: Timestamp,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportV1Detection {
    /// A 1.x installation (its app DB) was found.
    pub found: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<ImportV1State>,
    /// Dry-run preview of every 1.x project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<ImportV1Report>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportV1Options {
    /// Project folders to import (default with `all`: every 1.x project).
    #[serde(default)]
    pub projects: Vec<String>,
    #[serde(default)]
    pub all: bool,
    #[serde(default)]
    pub dry_run: bool,
}

/// Process-level inputs.
#[derive(Clone, Debug)]
pub struct ImportV1Env {
    pub profile: Profile,
    /// `QUADFLOW_V1_DATA_DIR`.
    pub v1_override: Option<String>,
}

// ---------------------------------------------------------------- locating 1.x

/// The 1.x data dir for this process. Dev builds only use an explicit override.
pub fn locate(profile: Profile, override_dir: Option<&str>) -> Option<PathBuf> {
    let dir = match override_dir.map(str::trim).filter(|s| !s.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None if profile == Profile::Release => dirs::data_dir()?.join(V1_APP_ID),
        None => return None,
    };
    dir.join("quadflow.db").is_file().then_some(dir)
}

/// One row of the 1.x `projects` table.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct V1Project {
    pub name: String,
    pub root: String,
    pub active: bool,
}

/// The 1.x projects list, most recently updated first (read from a temporary copy).
pub fn read_v1_projects(data_dir: &Path) -> Result<Vec<V1Project>> {
    let db_file = data_dir.join("quadflow.db");
    let tmp = tempfile::tempdir().map_err(|e| CoreError::io(Path::new("temp dir"), e))?;
    for suffix in ["", "-wal", "-shm"] {
        let from = data_dir.join(format!("quadflow.db{suffix}"));
        if from.is_file() {
            std::fs::copy(&from, tmp.path().join(format!("quadflow.db{suffix}"))).map_err(|e| CoreError::io(&from, e))?;
        }
    }
    let corrupt = |e: rusqlite::Error| CoreError::corrupt(&db_file, e);
    let conn = rusqlite::Connection::open(tmp.path().join("quadflow.db")).map_err(corrupt)?;
    let has_projects = conn
        .query_row("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'", [], |_| Ok(()))
        .is_ok();
    if !has_projects {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare("SELECT name, working_directory, COALESCE(is_active, 0) FROM projects ORDER BY updated_at DESC")
        .map_err(corrupt)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(V1Project {
                name: r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                root: r.get::<_, String>(1)?,
                active: r.get::<_, i64>(2)? != 0,
            })
        })
        .map_err(corrupt)?;
    let list: Vec<V1Project> = rows.flatten().filter(|p| !p.root.trim().is_empty()).collect();
    Ok(list)
}

// ---------------------------------------------------------------- state

pub fn state(db: &AppDb) -> Result<Option<ImportV1State>> {
    Ok(settings::get_value(db, STATE_NS, STATE_KEY)?.and_then(|v| serde_json::from_value(v).ok()))
}

fn set_state(db: &AppDb, status: ImportV1StateStatus) -> Result<()> {
    let st = ImportV1State { status, at: now_ms() };
    settings::set(db, STATE_NS, STATE_KEY, serde_json::to_value(st).expect("state serializes"))
}

/// "Not now" in the first-run dialog: never offered automatically again.
pub fn dismiss(db: &AppDb) -> Result<()> {
    set_state(db, ImportV1StateStatus::Dismissed)
}

// ---------------------------------------------------------------- detect / run

/// Is there a 1.x installation, has the import run, and what would it do?
pub fn detect(db: &AppDb, env: &ImportV1Env) -> Result<ImportV1Detection> {
    let state = state(db)?;
    let Some(dir) = locate(env.profile, env.v1_override.as_deref()) else {
        return Ok(ImportV1Detection { found: false, data_dir: None, state, preview: None });
    };
    let preview = run(db, env, ImportV1Options { all: true, dry_run: true, ..Default::default() }, &EventBus::new())?;
    Ok(ImportV1Detection { found: true, data_dir: Some(dir.display().to_string()), state, preview: Some(preview) })
}

/// Import (or, with `dry_run`, preview) the selected 1.x projects into the projects list.
pub fn run(db: &AppDb, env: &ImportV1Env, opts: ImportV1Options, bus: &EventBus) -> Result<ImportV1Report> {
    let data_dir = locate(env.profile, env.v1_override.as_deref());
    let v1 = match &data_dir {
        Some(d) => read_v1_projects(d)?,
        None => Vec::new(),
    };
    let all = opts.all || (opts.projects.is_empty() && opts.dry_run);
    if !all && opts.projects.is_empty() {
        return Err(CoreError::invalid_input("name one or more project folders, or pass --all"));
    }
    if all && data_dir.is_none() && opts.projects.is_empty() {
        return Err(CoreError::not_found(
            "no QuadFlow 1.x installation found (set QUADFLOW_V1_DATA_DIR to its data folder)",
        ));
    }

    let by_key: BTreeMap<String, &V1Project> = v1.iter().map(|p| (root_key(Path::new(&p.root)), p)).collect();
    let mut selected: Vec<(PathBuf, Option<&V1Project>)> = Vec::new();
    let mut seen = BTreeSet::new();
    for dir in &opts.projects {
        let p = PathBuf::from(dir);
        let key = root_key(&p);
        if seen.insert(key.clone()) {
            selected.push((p, by_key.get(&key).copied()));
        }
    }
    if all {
        for p in &v1 {
            if seen.insert(root_key(Path::new(&p.root))) {
                selected.push((PathBuf::from(&p.root), Some(p)));
            }
        }
    }

    let reports = selected
        .iter()
        .map(|(dir, entry)| import_project(db, dir, *entry, env.profile, opts.dry_run, bus))
        .collect();

    if !opts.dry_run {
        // The project that was active in 1.x becomes active here, unless one already is.
        if settings::get_string(db, settings::SHELL, settings::KEY_ACTIVE_PROJECT)?.is_none() {
            if let Some(active) = v1.iter().find(|p| p.active) {
                if let Some(project) = projects::find_by_path(db, Path::new(&active.root))? {
                    settings::set(db, settings::SHELL, settings::KEY_ACTIVE_PROJECT, serde_json::Value::String(project.id.to_string()))?;
                }
            }
        }
        set_state(db, ImportV1StateStatus::Completed)?;
    }
    Ok(ImportV1Report {
        dry_run: opts.dry_run,
        profile: env.profile,
        data_dir: data_dir.map(|d| d.display().to_string()),
        projects: reports,
    })
}

fn folder_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| p.display().to_string())
}

/// Register one project (moving 1.x data aside first). Failures are reported, not returned.
fn import_project(
    db: &AppDb,
    dir: &Path,
    v1: Option<&V1Project>,
    profile: Profile,
    dry_run: bool,
    bus: &EventBus,
) -> ImportV1ProjectReport {
    let name = v1.map(|p| p.name.clone()).filter(|n| !n.trim().is_empty()).unwrap_or_else(|| folder_name(dir));
    let mut rep = ImportV1ProjectReport {
        name: name.clone(),
        root: dir.display().to_string(),
        outcome: ImportV1Outcome::Failed,
        backup_dir: None,
        error: None,
    };
    if !dir.is_dir() {
        rep.outcome = ImportV1Outcome::MissingDir;
        return rep;
    }
    if let Ok(canon) = dunce::canonicalize(dir) {
        rep.root = canon.display().to_string();
    }
    let has_v1 = legacy::is_v1_dir(&dir.join(legacy::V1_PROJECT_DIR));
    let already = projects::find_by_path(db, dir).ok().flatten().is_some();
    if dry_run {
        rep.outcome = match (has_v1, profile) {
            (true, Profile::Release) => {
                rep.backup_dir = Some(legacy::backup_path(dir).display().to_string());
                ImportV1Outcome::WouldMoveAside
            }
            (true, Profile::Dev) => ImportV1Outcome::V1DataKept,
            (false, _) if already => ImportV1Outcome::AlreadyRegistered,
            (false, _) => ImportV1Outcome::WouldRegister,
        };
        return rep;
    }
    let notice = match legacy::check_project(dir, profile, bus) {
        Ok(n) => n,
        Err(e) => {
            rep.error = Some(e.message);
            return rep;
        }
    };
    if let Err(e) = register(db, dir, &name) {
        rep.error = Some(format!("could not add the project to the projects list: {}", e.message));
        return rep;
    }
    rep.outcome = match &notice {
        Some(n) if n.moved => {
            rep.backup_dir = n.backup_dir.clone();
            ImportV1Outcome::MovedAside
        }
        Some(_) => ImportV1Outcome::V1DataKept,
        None if already => ImportV1Outcome::AlreadyRegistered,
        None => ImportV1Outcome::Registered,
    };
    rep
}

fn register(db: &AppDb, dir: &Path, name: &str) -> Result<()> {
    let p = projects::register(db, dir)?;
    if !name.trim().is_empty() && p.name != name {
        projects::update(db, &p.id, projects::ProjectPatch { name: Some(name.to_string()), ..Default::default() })?;
    }
    Ok(())
}
