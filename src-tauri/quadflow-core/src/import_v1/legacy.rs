//! 1.x `.quadflow/` folders: detect them, move them aside, start fresh.
//!
//! This version cannot read the 1.x project format (no `formatVersion`, 16-hex
//! file names, mixed camelCase / snake_case shapes). When a project whose
//! `.quadflow/` is in that format is opened (GUI, CLI) or imported, the folder
//! is renamed to `.quadflow-v1-backup/` (or `.quadflow-v1-backup-2/`, `-3/`, …
//! if taken — nothing is ever deleted or overwritten) and a fresh current-format
//! `.quadflow/` is created. Dev builds only write `.quadflow-dev/`, so in the
//! dev profile the 1.x folder is detected and reported, never moved.

use crate::domains::project_config::{self, InitOptions};
use crate::error::{CoreError, Result};
use crate::events::EventBus;
use crate::ids::Id;
use crate::paths::Profile;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The 1.x per-project folder (same name as the release folder of this version).
pub const V1_PROJECT_DIR: &str = ".quadflow";
/// Where a 1.x folder is moved.
pub const BACKUP_DIR: &str = ".quadflow-v1-backup";
/// 1.x collections (one JSON file per entity, non-ULID names).
const V1_COLLECTIONS: &[&str] = &["ideas", "issues", "epics", "plans", "scripts", "missions"];

/// What happened to a project's 1.x folder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportV1LegacyNotice {
    /// Project folder.
    pub root: String,
    /// Moved aside (release) or only detected (dev profile).
    pub moved: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup_dir: Option<String>,
    /// Plain-language message for the user.
    pub message: String,
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
}

/// Is `dir` (a project's `.quadflow/`) in the 1.x format?
///
/// * `config.json` is a JSON object without `formatVersion` (every
///   current-format config has it) → 1.x. An unparseable `config.json` is
///   *not* treated as 1.x (it may be a damaged current-format project; doctor
///   reports it).
/// * No `config.json`: 1.x if `labels.json` is a JSON array, or a 1.x
///   collection holds a `*.json` file whose name is not a ULID.
pub fn is_v1_dir(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let cfg = dir.join("config.json");
    if cfg.exists() {
        return matches!(read_json(&cfg), Some(serde_json::Value::Object(o)) if !o.contains_key("formatVersion"));
    }
    if matches!(read_json(&dir.join("labels.json")), Some(serde_json::Value::Array(_))) {
        return true;
    }
    V1_COLLECTIONS.iter().any(|c| {
        std::fs::read_dir(dir.join(c)).into_iter().flatten().flatten().any(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.strip_suffix(".json").is_some_and(|stem| !stem.starts_with('.') && Id::parse(stem).is_err())
        })
    })
}

/// The first free backup name next to `.quadflow/`: `.quadflow-v1-backup`, then `-2`, `-3`, ….
pub fn backup_path(project: &Path) -> PathBuf {
    let first = project.join(BACKUP_DIR);
    if !first.exists() {
        return first;
    }
    (2..)
        .map(|n| project.join(format!("{BACKUP_DIR}-{n}")))
        .find(|p| !p.exists())
        .expect("an unused backup name exists")
}

/// The user-facing message after moving a 1.x folder aside.
pub fn moved_message(backup: &Path) -> String {
    let name = backup.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| BACKUP_DIR.into());
    format!(
        "This project has data from QuadFlow 1.x, which this version can't read. It was moved to {name}/ and a fresh .quadflow/ was created."
    )
}

/// If `project`'s `.quadflow/` is in the 1.x format: move it aside and create a
/// fresh project folder (release), or only report it (dev). `None` = no 1.x data.
pub fn check_project(project: &Path, profile: Profile, bus: &EventBus) -> Result<Option<ImportV1LegacyNotice>> {
    let v1 = project.join(V1_PROJECT_DIR);
    if !is_v1_dir(&v1) {
        return Ok(None);
    }
    let canon = dunce::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
    let (project, v1) = (canon.as_path(), canon.join(V1_PROJECT_DIR));
    let root = project.display().to_string();
    if profile == Profile::Dev {
        return Ok(Some(ImportV1LegacyNotice {
            root,
            moved: false,
            backup_dir: None,
            message: format!(
                "This project has data from QuadFlow 1.x in {V1_PROJECT_DIR}/, which this version can't read. \
                 Dev builds use {}/ and leave it as is.",
                profile.project_dir_name()
            ),
        }));
    }
    let backup = backup_path(project);
    std::fs::rename(&v1, &backup).map_err(|e| {
        CoreError::io(&v1, format!("could not move it to {} ({e}); close QuadFlow 1.x and try again", backup.display()))
    })?;
    project_config::init_with(project, profile, InitOptions::default(), bus.clone())?;
    tracing::info!("moved 1.x project data {} -> {}", v1.display(), backup.display());
    Ok(Some(ImportV1LegacyNotice {
        root,
        moved: true,
        backup_dir: Some(backup.display().to_string()),
        message: moved_message(&backup),
    }))
}
