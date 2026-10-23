//! Plugin dev mode (plugin-system.md §15.3): unpacked plugin folders listed in the setting
//! `plugins.devPaths`, and a file watcher that reports when a dev plugin's build output changes.
//!
//! - [`add_dev_path`] / [`remove_dev_path`] edit the setting ("Load unpacked…" in Settings →
//!   Plugins). The registry picks dev folders up on its next load (origin `dev`, §4.1).
//! - [`DevWatcher`] watches every dev plugin root (300 ms debounce) and reports, per plugin,
//!   whether the manifest, the UI build output (`dist/**`, the `ui.entry` / `ui.style` files) or
//!   the sidecar (binary for this target, or the Node entry) changed. The shell reloads the UI
//!   module (tile instances keep their persisted `state`) and restarts a running sidecar.
//!   Source files (`src/**`, `sidecar/src/**`, `node_modules/**`) are ignored: the plugin's own
//!   `npm run dev` turns them into build output, which is what is watched.

use super::registry::{PluginOrigin, PluginRegistry, SETTINGS_NAMESPACE, SETTING_DEV_PATHS};
use super::{current_target, Manifest, MANIFEST_FILE};
use crate::domains::app::settings;
use crate::error::{CoreError, Result};
use crate::store::AppDb;
use notify::{RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, FileIdMap};
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Debounce for dev rebuilds: a Vite build writes several files in quick succession.
pub const DEV_DEBOUNCE: Duration = Duration::from_millis(300);

/// The folders in `plugins.devPaths`, as stored.
pub fn dev_paths(db: &AppDb) -> Result<Vec<String>> {
    Ok(settings::get_value(db, SETTINGS_NAMESPACE, SETTING_DEV_PATHS)?
        .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
        .unwrap_or_default())
}

/// `dunce`-canonical form of a path (no `\\?\` prefix on Windows), or the path itself when it
/// does not exist. The form dev paths are stored and compared in.
pub fn canonical(p: &Path) -> PathBuf {
    dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

fn same_path(a: &str, b: &Path) -> bool {
    let (a, b) = (canonical(Path::new(a)), canonical(b));
    if cfg!(windows) {
        a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy())
    } else {
        a == b
    }
}

/// Add an unpacked plugin folder (must contain `quadflow-plugin.json`). Returns the canonical
/// path as stored; adding a folder twice is a no-op.
pub fn add_dev_path(db: &AppDb, dir: &Path) -> Result<PathBuf> {
    let canon = dunce::canonicalize(dir).map_err(|e| CoreError::io(dir, e))?;
    if !canon.is_dir() {
        return Err(CoreError::invalid_input(format!("{} is not a folder", canon.display())));
    }
    if !canon.join(MANIFEST_FILE).is_file() {
        return Err(CoreError::invalid_input(format!(
            "{} has no {MANIFEST_FILE} (pick the plugin's root folder)",
            canon.display()
        )));
    }
    let mut paths = dev_paths(db)?;
    if !paths.iter().any(|p| same_path(p, &canon)) {
        paths.push(canon.display().to_string());
        settings::set(db, SETTINGS_NAMESPACE, SETTING_DEV_PATHS, serde_json::json!(paths))?;
    }
    Ok(canon)
}

/// Remove a folder from `plugins.devPaths`. `Ok(false)` if it was not listed.
pub fn remove_dev_path(db: &AppDb, dir: &Path) -> Result<bool> {
    let mut paths = dev_paths(db)?;
    let before = paths.len();
    paths.retain(|p| !same_path(p, dir));
    if paths.len() == before {
        return Ok(false);
    }
    settings::set(db, SETTINGS_NAMESPACE, SETTING_DEV_PATHS, serde_json::json!(paths))?;
    Ok(true)
}

/// A copy of a dev plugin's sidecar binary under `<cache>/dev-sidecars/<id>/`, named after the
/// source's mtime and size (reused while those match). The sidecar runs from the copy, so the
/// plugin's `npm run dev` can overwrite the original while the process runs — Windows locks a
/// running executable. Older copies are removed when they are no longer in use.
pub fn shadow_copy(cache_dir: &Path, plugin_id: &str, src: &Path) -> Result<PathBuf> {
    let meta = std::fs::metadata(src).map_err(|e| CoreError::io(src, e))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "sidecar".into());
    let ext = src.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let dir = cache_dir.join("dev-sidecars").join(plugin_id);
    std::fs::create_dir_all(&dir).map_err(|e| CoreError::io(&dir, e))?;
    let dest = dir.join(format!("{stem}-{mtime}-{}{ext}", meta.len()));
    if !dest.is_file() {
        let tmp = dir.join(format!(".{stem}-{}.partial", std::process::id()));
        std::fs::copy(src, &tmp).map_err(|e| CoreError::io(src, e))?;
        std::fs::rename(&tmp, &dest).map_err(|e| CoreError::io(&dest, e))?;
    }
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            if e.path() != dest {
                // Fails for a copy that is still running; it goes next time.
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    Ok(dest)
}

/// One watched dev plugin.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DevWatchTarget {
    pub plugin_id: String,
    /// Canonical plugin root.
    pub root: PathBuf,
    /// Root-relative files of the UI module outside `dist/` (`ui.entry`, `ui.style`).
    pub ui_files: BTreeSet<String>,
    /// Root-relative sidecar files for this target (binary, or Node entry).
    pub sidecar_files: BTreeSet<String>,
}

impl DevWatchTarget {
    pub fn from_manifest(plugin_id: &str, root: &Path, manifest: Option<&Manifest>) -> Self {
        let root = dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        let norm = |s: &str| s.trim_start_matches("./").replace('\\', "/");
        let mut ui_files = BTreeSet::new();
        let mut sidecar_files = BTreeSet::new();
        if let Some(m) = manifest {
            if let Some(ui) = &m.ui {
                ui_files.insert(norm(&ui.entry));
                if let Some(style) = &ui.style {
                    ui_files.insert(norm(style));
                }
            }
            if let Some(sc) = &m.sidecar {
                if let Some(entry) = &sc.entry {
                    sidecar_files.insert(norm(entry));
                }
                if let (Some(bins), Some(target)) = (&sc.binaries, current_target()) {
                    if let Some(bin) = bins.get(&target) {
                        sidecar_files.insert(norm(bin));
                    }
                }
            }
        }
        Self { plugin_id: plugin_id.to_string(), root, ui_files, sidecar_files }
    }

    /// What a set of changed paths means for this plugin (`None` = nothing relevant).
    pub fn classify<'a>(&self, paths: impl IntoIterator<Item = &'a Path>) -> Option<DevChange> {
        let mut change = DevChange { plugin_id: self.plugin_id.clone(), manifest: false, ui: false, sidecar: false, paths: vec![] };
        for path in paths {
            let canon;
            let path = if path.starts_with(&self.root) {
                path
            } else {
                // Events may name a path through another spelling (8.3 names, symlinks).
                canon = dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
                &canon
            };
            let Ok(rel) = path.strip_prefix(&self.root) else { continue };
            let rel = rel.to_string_lossy().replace('\\', "/");
            if rel.is_empty() || rel == "dist/.integrity.json" || rel.ends_with('~') || rel.ends_with(".tmp") {
                continue;
            }
            let hit = if rel == MANIFEST_FILE {
                change.manifest = true;
                true
            } else if self.sidecar_files.contains(&rel) {
                change.sidecar = true;
                true
            } else if rel.starts_with("dist/") || self.ui_files.contains(&rel) {
                change.ui = true;
                true
            } else {
                false
            };
            if hit && !change.paths.contains(&rel) {
                change.paths.push(rel);
            }
        }
        (change.manifest || change.ui || change.sidecar).then_some(change)
    }
}

/// A relevant change in a dev plugin's folder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginDevChange {
    pub plugin_id: String,
    /// `quadflow-plugin.json` changed (contributions may differ: reload the registry).
    pub manifest: bool,
    /// UI build output changed (re-import the module, remount its tiles).
    pub ui: bool,
    /// The sidecar binary / entry changed (restart the sidecar if it runs).
    pub sidecar: bool,
    /// Root-relative paths that changed (for logs).
    pub paths: Vec<String>,
}
pub type DevChange = PluginDevChange;

/// The dev plugins of a registry snapshot (any status: a dev plugin that fails to load is
/// still watched, so fixing its manifest or build brings it back).
pub fn dev_targets(reg: &PluginRegistry) -> Vec<DevWatchTarget> {
    reg.all()
        .filter(|p| p.origin == PluginOrigin::Dev)
        .map(|p| DevWatchTarget::from_manifest(&p.id, &p.root, p.manifest.as_ref()))
        .collect()
}

type Callback = Arc<dyn Fn(DevChange) + Send + Sync>;

/// Watches the dev plugin roots; [`DevWatcher::set_targets`] replaces the watched set.
pub struct DevWatcher {
    debouncer: Debouncer<notify::RecommendedWatcher, FileIdMap>,
    targets: Arc<Mutex<Vec<DevWatchTarget>>>,
    watched: Vec<PathBuf>,
}

impl DevWatcher {
    pub fn new(callback: impl Fn(DevChange) + Send + Sync + 'static) -> Result<Self> {
        let callback: Callback = Arc::new(callback);
        let targets: Arc<Mutex<Vec<DevWatchTarget>>> = Arc::new(Mutex::new(Vec::new()));
        let t2 = Arc::clone(&targets);
        let handler = move |res: DebounceEventResult| {
            let events = match res {
                Ok(events) => events,
                Err(errors) => {
                    tracing::warn!("plugin dev watcher error(s): {errors:?}");
                    return;
                }
            };
            let paths: Vec<PathBuf> = events.iter().flat_map(|e| e.event.paths.iter().cloned()).collect();
            let targets = t2.lock().map(|t| t.clone()).unwrap_or_default();
            for t in &targets {
                if let Some(change) = t.classify(paths.iter().map(PathBuf::as_path)) {
                    tracing::info!("plugin dev change {}: {:?}", change.plugin_id, change.paths);
                    callback(change);
                }
            }
        };
        let debouncer = new_debouncer(DEV_DEBOUNCE, None, handler)
            .map_err(|e| CoreError::internal(format!("start plugin dev watcher: {e}")))?;
        Ok(Self { debouncer, targets, watched: Vec::new() })
    }

    /// Watch exactly these plugins (roots that vanished are skipped with a warning).
    pub fn set_targets(&mut self, targets: Vec<DevWatchTarget>) {
        let want: Vec<PathBuf> = targets.iter().map(|t| t.root.clone()).collect();
        for old in self.watched.clone() {
            if !want.contains(&old) {
                let _ = self.debouncer.watcher().unwatch(&old);
                self.debouncer.cache().remove_root(&old);
                self.watched.retain(|p| p != &old);
            }
        }
        for root in &want {
            if self.watched.contains(root) {
                continue;
            }
            match self.debouncer.watcher().watch(root, RecursiveMode::Recursive) {
                Ok(()) => {
                    self.debouncer.cache().add_root(root, RecursiveMode::Recursive);
                    self.watched.push(root.clone());
                }
                Err(e) => tracing::warn!("plugin dev watcher: cannot watch {}: {e}", root.display()),
            }
        }
        if let Ok(mut t) = self.targets.lock() {
            *t = targets;
        }
    }

    pub fn watched_roots(&self) -> &[PathBuf] {
        &self.watched
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn target(root: &Path) -> DevWatchTarget {
        DevWatchTarget {
            plugin_id: "acme.x".into(),
            root: dunce::canonicalize(root).unwrap(),
            ui_files: ["dist/index.js".to_string(), "dist/index.css".to_string()].into(),
            sidecar_files: ["bin/x.exe".to_string(), "bin/sidecar.mjs".to_string()].into(),
        }
    }

    #[test]
    fn classify_only_build_output_and_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let t = target(dir.path());
        let r = &t.root;
        assert_eq!(t.classify([r.join("src/index.tsx").as_path(), r.join("node_modules/a/b.js").as_path()]), None);
        assert_eq!(t.classify([r.join("dist/.integrity.json").as_path()]), None);
        let c = t.classify([r.join("dist/index.js").as_path(), r.join("dist/assets/a.png").as_path()]).unwrap();
        assert!(c.ui && !c.sidecar && !c.manifest);
        assert_eq!(c.paths, vec!["dist/index.js", "dist/assets/a.png"]);
        let c = t.classify([r.join("bin/x.exe").as_path()]).unwrap();
        assert!(c.sidecar && !c.ui);
        assert!(t.classify([r.join("bin/other.exe").as_path()]).is_none());
        let c = t.classify([r.join(MANIFEST_FILE).as_path()]).unwrap();
        assert!(c.manifest);
        assert!(t.classify([Path::new("/elsewhere/dist/index.js")]).is_none());
    }

    #[test]
    fn dev_paths_add_remove_dedupe() {
        let app = crate::testing::TempApp::new();
        let db = &app.db;
        let dir = tempfile::tempdir().unwrap();
        assert!(add_dev_path(db, dir.path()).is_err(), "no manifest");
        std::fs::write(dir.path().join(MANIFEST_FILE), "{}").unwrap();
        let canon = add_dev_path(db, dir.path()).unwrap();
        add_dev_path(db, dir.path()).unwrap();
        assert_eq!(dev_paths(db).unwrap(), vec![canon.display().to_string()]);
        assert!(remove_dev_path(db, dir.path()).unwrap());
        assert!(!remove_dev_path(db, dir.path()).unwrap());
        assert!(dev_paths(db).unwrap().is_empty());
    }

    #[test]
    fn shadow_copy_follows_rebuilds() {
        let dir = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let src = dir.path().join("x.exe");
        std::fs::write(&src, b"v1").unwrap();
        let a = shadow_copy(cache.path(), "acme.x", &src).unwrap();
        assert_eq!(shadow_copy(cache.path(), "acme.x", &src).unwrap(), a, "reused while unchanged");
        assert_eq!(std::fs::read(&a).unwrap(), b"v1");
        std::fs::write(&src, b"v2-longer").unwrap();
        let b = shadow_copy(cache.path(), "acme.x", &src).unwrap();
        assert_ne!(a, b);
        assert_eq!(std::fs::read(&b).unwrap(), b"v2-longer");
        assert!(!a.exists(), "the old copy is cleaned up");
        assert_eq!(b.extension().unwrap(), "exe");
    }

    #[test]
    fn watcher_reports_rebuilds() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("dist")).unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        let (tx, rx) = mpsc::channel();
        let mut w = DevWatcher::new(move |c| {
            let _ = tx.send(c);
        })
        .unwrap();
        w.set_targets(vec![target(dir.path())]);
        assert_eq!(w.watched_roots().len(), 1);
        std::thread::sleep(Duration::from_millis(100));
        std::fs::write(dir.path().join("src/index.tsx"), "x").unwrap();
        std::fs::write(dir.path().join("dist/index.js"), "export default {}").unwrap();
        let c = rx.recv_timeout(Duration::from_secs(10)).expect("a dev change");
        assert!(c.ui);
        assert!(c.paths.iter().all(|p| p.starts_with("dist/")), "{:?}", c.paths);
        w.set_targets(vec![]);
        assert!(w.watched_roots().is_empty());
    }
}
