//! Provider scaffold (agent-providers.md §7.3): copy a provider plugin's
//! template dir into the project. Existing files are never overwritten;
//! `jsonMerge` files are merged (arrays unioned, missing keys added).

use super::spec::ScaffoldSpec;
use crate::error::{CoreError, Result};
use crate::store::atomic_write;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Component, Path, PathBuf};

pub const VERSION_FILE: &str = ".quadflow-scaffold-version";

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentScaffoldReport {
    /// Project-relative paths written.
    pub created: Vec<String>,
    pub merged: Vec<String>,
    pub skipped: Vec<String>,
}

fn safe_rel(p: &str) -> Result<PathBuf> {
    let path = Path::new(p);
    if path.is_absolute() || path.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return Err(CoreError::invalid_input(format!("scaffold path {p:?} must stay inside its root")));
    }
    Ok(path.to_path_buf())
}

/// Union arrays, add missing keys; never remove or replace user values.
pub fn merge_json(user: &mut Value, template: &Value) {
    match (user, template) {
        (Value::Object(u), Value::Object(t)) => {
            for (k, tv) in t {
                match u.get_mut(k) {
                    Some(uv) => merge_json(uv, tv),
                    None => {
                        u.insert(k.clone(), tv.clone());
                    }
                }
            }
        }
        (Value::Array(u), Value::Array(t)) => {
            for tv in t {
                if !u.contains(tv) {
                    u.push(tv.clone());
                }
            }
        }
        _ => {}
    }
}

/// Apply `spec` from `plugin_root` into `project_root`.
pub fn apply(project_root: &Path, plugin_root: &Path, spec: &ScaffoldSpec, plugin_version: &str) -> Result<AgentScaffoldReport> {
    let from = plugin_root.join(safe_rel(&spec.from)?);
    let into_rel = safe_rel(&spec.into)?;
    let into = project_root.join(&into_rel);
    if !from.is_dir() {
        return Err(CoreError::not_found(format!("scaffold source {}", from.display())));
    }
    let merge: Vec<PathBuf> = spec.json_merge.iter().map(|m| safe_rel(m)).collect::<Result<_>>()?;
    let mut report = AgentScaffoldReport::default();
    for entry in walkdir::WalkDir::new(&from).follow_links(false).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry.path().strip_prefix(&from).expect("walk stays under from").to_path_buf();
        let target = into.join(&rel);
        let shown = into_rel.join(&rel).to_string_lossy().replace('\\', "/");
        let src = std::fs::read(entry.path()).map_err(|e| CoreError::io(entry.path(), e))?;
        if !target.exists() {
            if let Some(dir) = target.parent() {
                std::fs::create_dir_all(dir).map_err(|e| CoreError::io(dir, e))?;
            }
            atomic_write(&target, &src)?;
            report.created.push(shown);
        } else if merge.iter().any(|m| *m == rel) {
            let cur = std::fs::read(&target).map_err(|e| CoreError::io(&target, e))?;
            let mut user: Value = serde_json::from_slice(&cur).map_err(|e| CoreError::corrupt(&target, e))?;
            let tmpl: Value = serde_json::from_slice(&src).map_err(|e| CoreError::corrupt(entry.path(), e))?;
            let before = user.clone();
            merge_json(&mut user, &tmpl);
            if user != before {
                let mut bytes = serde_json::to_vec_pretty(&user).map_err(|e| CoreError::internal(e.to_string()))?;
                bytes.push(b'\n');
                atomic_write(&target, &bytes)?;
                report.merged.push(shown);
            } else {
                report.skipped.push(shown);
            }
        } else {
            report.skipped.push(shown);
        }
    }
    std::fs::create_dir_all(&into).map_err(|e| CoreError::io(&into, e))?;
    atomic_write(&into.join(VERSION_FILE), plugin_version.as_bytes())?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn copy_skip_and_merge() {
        let plugin = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        let tpl = plugin.path().join("assets/tpl");
        std::fs::create_dir_all(tpl.join("skills/a")).unwrap();
        std::fs::write(tpl.join("skills/a/SKILL.md"), "skill").unwrap();
        std::fs::write(tpl.join("settings.json"), json!({"permissions":{"allow":["Bash(quadflow:*)","Read"]},"new":1}).to_string()).unwrap();
        std::fs::create_dir_all(proj.path().join(".agent")).unwrap();
        std::fs::write(proj.path().join(".agent/settings.json"), json!({"permissions":{"allow":["Read","Mine"]},"new":0}).to_string()).unwrap();
        let spec = ScaffoldSpec { from: "assets/tpl".into(), into: ".agent".into(), json_merge: vec!["settings.json".into()] };
        let r = apply(proj.path(), plugin.path(), &spec, "1.2.3").unwrap();
        assert_eq!(r.created, [".agent/skills/a/SKILL.md"]);
        assert_eq!(r.merged, [".agent/settings.json"]);
        let merged: Value = serde_json::from_slice(&std::fs::read(proj.path().join(".agent/settings.json")).unwrap()).unwrap();
        assert_eq!(merged["permissions"]["allow"], json!(["Read", "Mine", "Bash(quadflow:*)"]));
        assert_eq!(merged["new"], json!(0), "user values win");
        assert_eq!(std::fs::read_to_string(proj.path().join(".agent").join(VERSION_FILE)).unwrap(), "1.2.3");
        // Idempotent.
        let r = apply(proj.path(), plugin.path(), &spec, "1.2.3").unwrap();
        assert!(r.created.is_empty() && r.merged.is_empty());
        // Escapes rejected.
        let bad = ScaffoldSpec { into: "../outside".into(), ..spec.clone() };
        assert!(apply(proj.path(), plugin.path(), &bad, "1").is_err());
    }
}
