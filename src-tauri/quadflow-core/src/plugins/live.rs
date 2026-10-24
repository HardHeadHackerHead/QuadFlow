//! Live plugin changes (plugin-system.md §12.4): what identifies the code a plugin runs, and
//! which plugins changed between two registry snapshots.
//!
//! The running app keeps the fingerprints of the last snapshot it saw. When the registry changes
//! — install, update, rollback, uninstall, enable/disable, from the GUI or from the CLI in
//! another process — the diff names exactly the plugins whose UI module and sidecar must be
//! reloaded (or stopped). The shell does the same diff over `PluginInfo` for its UI modules.

use super::registry::{PluginOrigin, PluginRegistry};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// The parts of a plugin that decide which code runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginFingerprint {
    pub active: bool,
    pub origin: PluginOrigin,
    pub version: Option<String>,
    pub root: PathBuf,
}

/// One plugin that changed between two snapshots (`None` = not present).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginLiveChange {
    pub id: String,
    pub before: Option<PluginFingerprint>,
    pub after: Option<PluginFingerprint>,
}

impl PluginLiveChange {
    /// Gone, or no longer active (disabled, needs consent, failed): stop its code.
    pub fn stopped(&self) -> bool {
        !self.after.as_ref().is_some_and(|a| a.active)
    }

    /// Active before and after, but different code (version / root / origin).
    pub fn code_changed(&self) -> bool {
        matches!((&self.before, &self.after), (Some(b), Some(a)) if b.active && a.active && b != a)
    }

    /// Both snapshots are dev folders (the dev watcher handles those rebuilds itself).
    pub fn dev_only(&self) -> bool {
        self.before.as_ref().is_some_and(|b| b.origin == PluginOrigin::Dev)
            && self.after.as_ref().is_some_and(|a| a.origin == PluginOrigin::Dev)
    }
}

impl PluginRegistry {
    /// Fingerprints of every loaded plugin, by id.
    pub fn fingerprints(&self) -> BTreeMap<String, PluginFingerprint> {
        self.all()
            .map(|p| {
                let fp = PluginFingerprint {
                    active: p.is_active(),
                    origin: p.origin,
                    version: p.manifest.as_ref().map(|m| m.version.clone()),
                    root: p.root.clone(),
                };
                (p.id.clone(), fp)
            })
            .collect()
    }
}

/// Plugins whose fingerprint differs between `before` and `after` (added, removed, changed), by id.
pub fn diff(
    before: &BTreeMap<String, PluginFingerprint>,
    after: &BTreeMap<String, PluginFingerprint>,
) -> Vec<PluginLiveChange> {
    let mut ids: Vec<&String> = before.keys().chain(after.keys()).collect();
    ids.sort();
    ids.dedup();
    ids.into_iter()
        .filter_map(|id| {
            let (b, a) = (before.get(id), after.get(id));
            (b != a).then(|| PluginLiveChange { id: id.clone(), before: b.cloned(), after: a.cloned() })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fp(active: bool, version: &str, root: &str) -> PluginFingerprint {
        PluginFingerprint { active, origin: PluginOrigin::Installed, version: Some(version.into()), root: root.into() }
    }

    fn map(items: &[(&str, PluginFingerprint)]) -> BTreeMap<String, PluginFingerprint> {
        items.iter().map(|(id, f)| (id.to_string(), f.clone())).collect()
    }

    #[test]
    fn unchanged_snapshots_have_no_changes() {
        let a = map(&[("x", fp(true, "1.0.0", "/p/x/1.0.0")), ("y", fp(false, "2.0.0", "/p/y/2.0.0"))]);
        assert!(diff(&a, &a.clone()).is_empty());
    }

    #[test]
    fn update_rollback_install_uninstall_disable() {
        let before = map(&[
            ("upd", fp(true, "1.0.0", "/p/upd/1.0.0")),
            ("gone", fp(true, "1.0.0", "/p/gone/1.0.0")),
            ("off", fp(true, "1.0.0", "/p/off/1.0.0")),
            ("same", fp(true, "1.0.0", "/p/same/1.0.0")),
        ]);
        let after = map(&[
            ("upd", fp(true, "1.1.0", "/p/upd/1.1.0")),
            ("new", fp(true, "0.1.0", "/p/new/0.1.0")),
            ("off", fp(false, "1.0.0", "/p/off/1.0.0")),
            ("same", fp(true, "1.0.0", "/p/same/1.0.0")),
        ]);
        let ch = diff(&before, &after);
        let ids: Vec<&str> = ch.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["gone", "new", "off", "upd"], "sorted, unchanged plugins left out");
        let by = |id: &str| ch.iter().find(|c| c.id == id).unwrap();
        assert!(by("upd").code_changed() && !by("upd").stopped());
        assert!(by("gone").stopped() && !by("gone").code_changed());
        assert!(by("off").stopped() && !by("off").code_changed());
        let new = by("new");
        assert!(new.before.is_none() && !new.stopped() && !new.code_changed(), "a new plugin starts fresh");

        // Rollback: back to the previous directory.
        let back = diff(&after, &map(&[("upd", fp(true, "1.0.0", "/p/upd/1.0.0"))]));
        assert!(back.iter().find(|c| c.id == "upd").unwrap().code_changed());
    }

    #[test]
    fn dev_only_changes_are_marked() {
        let mut a = fp(true, "0.1.0", "/dev/x");
        a.origin = PluginOrigin::Dev;
        let mut b = a.clone();
        b.version = Some("0.2.0".into());
        let ch = diff(&map(&[("x", a.clone())]), &map(&[("x", b)]));
        assert!(ch[0].dev_only() && ch[0].code_changed());
        // Installed copy replaced by a dev folder of the same id: not dev-only.
        let ch = diff(&map(&[("x", fp(true, "0.1.0", "/p/x/0.1.0"))]), &map(&[("x", a)]));
        assert!(!ch[0].dev_only() && ch[0].code_changed());
    }
}
