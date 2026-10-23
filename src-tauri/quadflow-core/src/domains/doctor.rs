//! `quadflow doctor [--fix]`: project store health checks (data-layer.md §4.4).
//!
//! The only renumbering path for duplicate issue numbers lives here: `--fix`
//! renumbers the newer duplicates (by id order).

use super::project_config::{self, validate_code, GITIGNORE};
use crate::error::Result;
use crate::ids::Id;
use crate::model::Actor;
use crate::paths::Profile;
use crate::store::lock::ProjectLock;
use crate::store::project::numbers_in_dir;
use crate::store::{atomic_write, ProjectStore, RelPath};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Collection directories scanned for unreadable files.
pub const COLLECTION_DIRS: &[&str] =
    &["ideas", "issues", "epics", "plans", "discovery", "scripts", "script-groups", "mission-templates"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    Ok,
    Warn,
    Error,
}

#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DoctorCheck {
    pub id: String,
    pub status: CheckStatus,
    pub message: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
    #[serde(default)]
    pub fixed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub root: String,
    pub data_dir: String,
    pub profile: Profile,
    /// No check has status `error` after fixes.
    pub ok: bool,
    pub checks: Vec<DoctorCheck>,
}

fn check(id: &str, status: CheckStatus, message: impl Into<String>) -> DoctorCheck {
    DoctorCheck { id: id.into(), status, message: message.into(), paths: Vec::new(), fixed: false }
}

pub fn run(store: &ProjectStore, actor: &Actor, fix: bool) -> Result<DoctorReport> {
    let data_dir = store.data_dir();
    let mut checks = Vec::new();

    // 1. config.json
    match project_config::read(store) {
        Ok(cfg) => match validate_code(&cfg.code) {
            Ok(()) => checks.push(check("config", CheckStatus::Ok, format!("{} (code {})", cfg.name, cfg.code))),
            Err(e) => checks.push(check("config", CheckStatus::Error, e.message)),
        },
        Err(e) => checks.push(check("config", CheckStatus::Error, e.message)),
    }

    // 2. .gitignore
    let gi = data_dir.join(".gitignore");
    if gi.is_file() {
        checks.push(check("gitignore", CheckStatus::Ok, ".gitignore present"));
    } else {
        let mut c = check("gitignore", CheckStatus::Warn, ".gitignore missing (local/ and .lock would be committed)");
        if fix {
            atomic_write(&gi, GITIGNORE.as_bytes())?;
            c.fixed = true;
        }
        checks.push(c);
    }

    // 3. lock
    match ProjectLock::acquire(store.root(), Duration::from_secs(2)) {
        Ok(l) => {
            drop(l);
            checks.push(check("lock", CheckStatus::Ok, "project lock acquirable"));
        }
        Err(e) => checks.push(check("lock", CheckStatus::Warn, e.message)),
    }

    // 4. leftover temp files (older than a minute)
    let mut temps = Vec::new();
    collect_temp_files(&data_dir, &mut temps);
    if temps.is_empty() {
        checks.push(check("temp_files", CheckStatus::Ok, "no leftover temp files"));
    } else {
        let mut c = check("temp_files", CheckStatus::Warn, format!("{} leftover temp file(s)", temps.len()));
        c.paths = temps.iter().map(|p| p.display().to_string()).collect();
        if fix {
            for p in &temps {
                let _ = std::fs::remove_file(p);
            }
            c.fixed = true;
        }
        checks.push(c);
    }

    // 5. unreadable entity files
    let mut bad = Vec::new();
    for dir in COLLECTION_DIRS {
        scan_collection(&data_dir.join(dir), &mut bad);
    }
    if bad.is_empty() {
        checks.push(check("files", CheckStatus::Ok, "all entity files readable"));
    } else {
        let mut c = check("files", CheckStatus::Error, format!("{} file(s) could not be read", bad.len()));
        c.paths = bad;
        checks.push(c);
    }

    // 6. duplicate issue numbers
    checks.push(duplicate_numbers(store, actor, fix)?);

    let ok = checks.iter().all(|c| c.status != CheckStatus::Error || c.fixed);
    Ok(DoctorReport {
        root: store.root().path.display().to_string(),
        data_dir: data_dir.display().to_string(),
        profile: store.root().profile,
        ok,
        checks,
    })
}

fn collect_temp_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if p.is_dir() {
            collect_temp_files(&p, out);
        } else if name.starts_with('.') && name.ends_with(".tmp") {
            let old = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .map_or(true, |age| age > Duration::from_secs(60));
            if old {
                out.push(p);
            }
        }
    }
}

fn scan_collection(dir: &Path, bad: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || !name.ends_with(".json") {
            continue;
        }
        let p = e.path();
        let stem = &name[..name.len() - 5];
        let problem = match std::fs::read(&p).map(|b| serde_json::from_slice::<serde_json::Value>(&b)) {
            Err(err) => Some(err.to_string()),
            Ok(Err(err)) => Some(format!("invalid JSON: {err}")),
            Ok(Ok(v)) => match (Id::parse(stem), v.get("id").and_then(|i| i.as_str())) {
                (Err(_), _) => Some("file name is not a valid id".into()),
                (Ok(id), Some(inner)) if inner == id.as_str() => None,
                _ => Some("\"id\" field does not match the file name".into()),
            },
        };
        if let Some(problem) = problem {
            bad.push(format!("{}: {problem}", p.display()));
        }
    }
}

fn duplicate_numbers(store: &ProjectStore, actor: &Actor, fix: bool) -> Result<DoctorCheck> {
    let dir = store.data_dir().join("issues");
    let mut by_number: BTreeMap<u64, Vec<PathBuf>> = BTreeMap::new();
    for (path, n) in numbers_in_dir(&dir)? {
        by_number.entry(n).or_default().push(path);
    }
    let dups: Vec<(u64, Vec<PathBuf>)> = by_number.into_iter().filter(|(_, v)| v.len() > 1).collect();
    if dups.is_empty() {
        return Ok(check("issue_numbers", CheckStatus::Ok, "issue numbers are unique"));
    }
    let mut c = check(
        "issue_numbers",
        CheckStatus::Error,
        format!("{} issue number(s) used more than once", dups.len()),
    );
    c.paths = dups.iter().flat_map(|(n, ps)| ps.iter().map(move |p| format!("#{n}: {}", p.display()))).collect();
    if fix {
        store.write(actor, |tx| {
            for (_, mut paths) in dups.clone() {
                // File names are ids (ULIDs sort by creation): keep the oldest.
                paths.sort();
                for p in paths.into_iter().skip(1) {
                    let Some(file) = p.file_name().map(|f| f.to_string_lossy().to_string()) else { continue };
                    let rel = RelPath::new(format!("issues/{file}"))?;
                    let mut v: serde_json::Value = match tx.store().read_json(&rel)? {
                        Some(v) => v,
                        None => continue,
                    };
                    let n = tx.next_counter("issue", Some("issues"))?;
                    v["number"] = serde_json::json!(n);
                    tx.put_json(&rel, &v)?;
                }
            }
            Ok(())
        })?;
        c.fixed = true;
    }
    Ok(c)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempProject;

    #[test]
    fn healthy_project_is_ok() {
        let tp = TempProject::new();
        let r = run(&tp.store, &Actor::system(), false).unwrap();
        assert!(r.ok, "{r:?}");
    }

    #[test]
    fn detects_and_fixes_duplicates_and_temp_files() {
        let tp = TempProject::new();
        let issues = tp.store.data_dir().join("issues");
        std::fs::create_dir_all(&issues).unwrap();
        let (a, b) = (Id::parse("01arz3ndektsv4rrffq69g5fa0").unwrap(), Id::parse("01arz3ndektsv4rrffq69g5fa1").unwrap());
        for id in [&a, &b] {
            std::fs::write(issues.join(format!("{id}.json")), format!(r#"{{"id":"{id}","number":1}}"#)).unwrap();
        }
        std::fs::write(issues.join("garbage.json"), "{").unwrap();
        std::fs::remove_file(tp.store.data_dir().join(".gitignore")).unwrap();

        let r = run(&tp.store, &Actor::system(), false).unwrap();
        assert!(!r.ok);
        let dup = r.checks.iter().find(|c| c.id == "issue_numbers").unwrap();
        assert_eq!(dup.status, CheckStatus::Error);
        assert_eq!(r.checks.iter().find(|c| c.id == "files").unwrap().status, CheckStatus::Error);

        let r = run(&tp.store, &Actor::system(), true).unwrap();
        assert!(r.checks.iter().find(|c| c.id == "issue_numbers").unwrap().fixed);
        let num = |id: &Id| -> u64 {
            let v: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(issues.join(format!("{id}.json"))).unwrap()).unwrap();
            v["number"].as_u64().unwrap()
        };
        assert_eq!(num(&a), 1);
        assert_eq!(num(&b), 2);
        assert!(tp.store.data_dir().join(".gitignore").is_file());
    }
}
