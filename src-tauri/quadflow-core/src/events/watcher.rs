//! `ProjectWatcher`: turns external changes under `<root>/.quadflow/` (CLI,
//! agents, `git pull`) into `Origin::External` change events (data-layer.md §8.2).
//!
//! Writes made by this process are recorded in [`RecentWrites`] and dropped here,
//! because the store already published a `Local` event for them.

use super::{ChangeKind, ChangeScope, Domain, EventBus, Origin};
use crate::error::{CoreError, Result};
use crate::paths::ProjectRoot;
use crate::store::RecentWrites;
use notify_debouncer_full::notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, FileIdMap};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const DEBOUNCE: Duration = Duration::from_millis(150);

/// Map a path relative to the project folder (`/`-separated) to the domain it
/// belongs to and the entity id it names (if any). `None` = not a data file
/// (dotfiles, `.lock`, temp files, counters, unknown files).
pub fn classify_rel_path(rel: &str) -> Option<(Domain, Option<String>)> {
    let segs: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
    if segs.is_empty() || segs.iter().any(|s| s.starts_with('.')) {
        return None;
    }
    let json_stem = |s: &str| s.strip_suffix(".json").map(str::to_string);
    match segs.as_slice() {
        ["config.json"] => Some((Domain::ProjectConfig, None)),
        ["labels.json"] => Some((Domain::Labels, None)),
        ["ship", "config.json"] => Some((Domain::Ship, None)),
        ["local", "state.json"] => None,
        ["local", "ship", "runs", f] => json_stem(f).map(|id| (Domain::ShipRuns, Some(id))),
        ["local", "missions", id] => Some((Domain::Missions, Some(id.to_string()))),
        ["local", "missions", id, "messages.jsonl"] => Some((Domain::MissionMessages, Some(id.to_string()))),
        ["local", "missions", id, "activity.jsonl"] => Some((Domain::MissionActivity, Some(id.to_string()))),
        ["local", "missions", id, _] => Some((Domain::Missions, Some(id.to_string()))),
        ["plugins", pid, ..] | ["local", "plugins", pid, ..] => Some((Domain::PluginData, Some(pid.to_string()))),
        [dir] => Domain::for_collection_dir(dir).map(|d| (d, None)),
        [dir, f] => {
            let domain = Domain::for_collection_dir(dir)?;
            json_stem(f).map(|id| (domain, Some(id)))
        }
        _ => None,
    }
}

/// Watches one project folder; stops when dropped.
pub struct ProjectWatcher {
    _debouncer: Debouncer<RecommendedWatcher, FileIdMap>,
    root_key: String,
}

impl ProjectWatcher {
    pub fn start(root: &ProjectRoot, bus: EventBus, recent: RecentWrites) -> Result<ProjectWatcher> {
        let data_dir = root.data_dir();
        let scope = ChangeScope::Project { root_key: root.key.clone() };
        let base = data_dir.clone();
        // File states already reported: a write can surface in two debounce
        // batches; each resulting file state is published once.
        let published = RecentWrites::new();
        let handler = move |result: DebounceEventResult| {
            let batch = match result {
                Ok(events) => {
                    let mut batch: BTreeMap<(Domain, ChangeKind), BTreeSet<String>> = BTreeMap::new();
                    let mut invalidate = false;
                    for ev in events {
                        if ev.need_rescan() {
                            invalidate = true;
                            continue;
                        }
                        if !matches!(ev.kind, EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)) {
                            continue;
                        }
                        for path in &ev.paths {
                            if let Some((domain, kind, id)) = map_event_path(&base, path, &recent, &published) {
                                let ids = batch.entry((domain, kind)).or_default();
                                if let Some(id) = id {
                                    ids.insert(id);
                                }
                            }
                        }
                    }
                    if invalidate {
                        invalidate_all()
                    } else {
                        batch
                    }
                }
                Err(errors) => {
                    tracing::warn!("project watcher error(s): {errors:?}; invalidating");
                    invalidate_all()
                }
            };
            for ((domain, kind), ids) in batch {
                bus.emit(scope.clone(), domain, kind, ids.into_iter().collect(), Origin::External);
            }
        };
        let mut debouncer = new_debouncer(DEBOUNCE, None, handler)
            .map_err(|e| CoreError::internal(format!("start watcher: {e}")))?;
        debouncer
            .watcher()
            .watch(&data_dir, RecursiveMode::Recursive)
            .map_err(|e| CoreError::io(&data_dir, e))?;
        debouncer.cache().add_root(&data_dir, RecursiveMode::Recursive);
        Ok(ProjectWatcher { _debouncer: debouncer, root_key: root.key.clone() })
    }

    pub fn root_key(&self) -> &str {
        &self.root_key
    }
}

fn invalidate_all() -> BTreeMap<(Domain, ChangeKind), BTreeSet<String>> {
    Domain::PROJECT.iter().map(|d| ((*d, ChangeKind::Invalidated), BTreeSet::new())).collect()
}

fn map_event_path(
    base: &Path,
    path: &Path,
    recent: &RecentWrites,
    published: &RecentWrites,
) -> Option<(Domain, ChangeKind, Option<String>)> {
    let rel: PathBuf = path.strip_prefix(base).ok()?.to_path_buf();
    let rel_str = rel.to_string_lossy().replace('\\', "/");
    let (domain, id) = classify_rel_path(&rel_str)?;
    // Directory creation / "child changed" notifications carry no data change;
    // the file events inside them do. Only a removed directory matters.
    if path.is_dir() {
        return None;
    }
    if recent.is_own(path) || published.is_own(path) {
        return None;
    }
    if path.exists() {
        published.record_write(path);
    } else {
        published.record_delete(path);
    }
    let is_file_entity = id.is_some() && rel_str.contains('.');
    let kind = if path.exists() {
        ChangeKind::Updated
    } else if is_file_entity && domain != Domain::MissionMessages && domain != Domain::MissionActivity {
        ChangeKind::Deleted
    } else if id.is_some() && !rel_str.contains('.') {
        // A whole entity directory (e.g. a mission) went away.
        ChangeKind::Deleted
    } else {
        ChangeKind::Updated
    };
    // A collection directory or singleton without ids: consumers refetch.
    let kind = if id.is_none() && kind == ChangeKind::Deleted { ChangeKind::Invalidated } else { kind };
    Some((domain, kind, id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classification() {
        let id = "01arz3ndektsv4rrffq69g5fav";
        assert_eq!(classify_rel_path(&format!("issues/{id}.json")), Some((Domain::Issues, Some(id.into()))));
        assert_eq!(classify_rel_path(&format!("script-groups/{id}.json")), Some((Domain::ScriptGroups, Some(id.into()))));
        assert_eq!(classify_rel_path("labels.json"), Some((Domain::Labels, None)));
        assert_eq!(classify_rel_path("config.json"), Some((Domain::ProjectConfig, None)));
        assert_eq!(classify_rel_path("ship/config.json"), Some((Domain::Ship, None)));
        assert_eq!(classify_rel_path(&format!("local/ship/runs/{id}.json")), Some((Domain::ShipRuns, Some(id.into()))));
        assert_eq!(
            classify_rel_path(&format!("local/missions/{id}/messages.jsonl")),
            Some((Domain::MissionMessages, Some(id.into())))
        );
        assert_eq!(classify_rel_path("local/plugins/github/x/y.json"), Some((Domain::PluginData, Some("github".into()))));
        assert_eq!(classify_rel_path("plugins/github/kv.json"), Some((Domain::PluginData, Some("github".into()))));
        assert_eq!(classify_rel_path("issues"), Some((Domain::Issues, None)));
        for ignored in [".lock", "issues/.abc.tmp", "local/state.json", ".gitignore", "random.txt", "issues/a/b.json"] {
            assert_eq!(classify_rel_path(ignored), None, "{ignored}");
        }
    }
}
