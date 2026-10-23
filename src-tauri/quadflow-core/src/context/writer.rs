//! Managed region of the provider context files (agent-providers.md §7.2),
//! e.g. `AGENTS.md` at the project root, driven by
//! `ProjectConfig.agentContext`. Content outside the markers is preserved
//! byte-for-byte; a start marker without an end marker is `corrupt`.

use super::registry::{ContextRegistry, BASE_MODULE};
use crate::domains::project_config::{self, AgentContextConfig};
use crate::error::{CoreError, Result};
use crate::model::Actor;
use crate::store::{atomic_write, ProjectStore};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::OnceLock;

pub const MARKER_START: &str = "<!-- quadflow:context:start — managed by QuadFlow, do not edit -->";
pub const MARKER_END: &str = "<!-- quadflow:context:end -->";

fn file_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z0-9._-]+\.md$").unwrap())
}

/// Context file names are plain root-level `*.md` names.
pub fn validate_file_name(name: &str) -> Result<()> {
    if file_re().is_match(name) && !name.starts_with('.') && name.len() <= 64 {
        Ok(())
    } else {
        Err(CoreError::invalid_input(format!("invalid context file name {name:?}: expected <name>.md (letters, digits, . _ -)")))
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ContextFileResult {
    pub file: String,
    /// `true` if the file was written (created or region changed).
    pub changed: bool,
    pub created: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ContextSyncReport {
    pub files: Vec<ContextFileResult>,
    /// Enabled modules no registered doc exists for (e.g. plugin disabled).
    pub unknown_modules: Vec<String>,
}

/// The managed region (markers included, trailing newline).
pub fn render_region(registry: &ContextRegistry, modules: &[String]) -> String {
    let mut s = format!("{MARKER_START}\n## QuadFlow\n\n");
    if let Some(base) = registry.get(BASE_MODULE) {
        push_doc(&mut s, &base.markdown);
    }
    let enabled: Vec<&str> = modules.iter().map(String::as_str).filter(|m| *m != BASE_MODULE && registry.get(m).is_some()).collect();
    let others: Vec<_> = registry.list().iter().filter(|m| !m.info.implicit && !enabled.contains(&m.info.id.as_str())).collect();
    if !others.is_empty() {
        s.push_str("More reference modules (not included here):\n\n");
        for m in others {
            s.push_str(&format!("- {} — `quadflow docs {}`\n", m.info.title, m.info.id));
        }
        s.push('\n');
    }
    for id in enabled {
        push_doc(&mut s, &registry.get(id).expect("filtered").markdown);
    }
    s.push_str(MARKER_END);
    s.push('\n');
    s
}

fn push_doc(s: &mut String, md: &str) {
    s.push_str(md.trim_end());
    s.push_str("\n\n");
}

/// Replace (or append) the region in `current`. `repair` truncates a dangling
/// start marker instead of failing.
pub fn apply_region(current: &str, region: &str, file: &Path, repair: bool) -> Result<String> {
    let start = current.find(MARKER_START);
    let end = start.and_then(|s| current[s..].find(MARKER_END).map(|e| s + e));
    Ok(match (start, end) {
        (Some(s), Some(e)) => {
            let after = &current[e + MARKER_END.len()..];
            let after = after.strip_prefix("\r\n").or_else(|| after.strip_prefix('\n')).unwrap_or(after);
            format!("{}{region}{after}", &current[..s])
        }
        (Some(s), None) => {
            if !repair {
                return Err(CoreError::corrupt(
                    file,
                    "QuadFlow context start marker without end marker; fix the file or run `quadflow context sync --repair`",
                ));
            }
            format!("{}{region}", &current[..s])
        }
        _ => {
            let mut s = current.to_string();
            if !s.is_empty() {
                if !s.ends_with('\n') {
                    s.push('\n');
                }
                s.push('\n');
            }
            s.push_str(region);
            s
        }
    })
}

/// Rewrite the managed region of every configured context file, under the project lock.
pub fn sync(project: &ProjectStore, registry: &ContextRegistry, actor: &Actor, repair: bool) -> Result<ContextSyncReport> {
    let root = project.root().path.clone();
    project.write(actor, |tx| {
        let cfg: project_config::ProjectConfig = tx.read_singleton()?;
        sync_files(&root, &cfg.agent_context, registry, repair)
    })
}

fn sync_files(root: &Path, ac: &AgentContextConfig, registry: &ContextRegistry, repair: bool) -> Result<ContextSyncReport> {
    let region = render_region(registry, &ac.modules);
    let mut report = ContextSyncReport {
        unknown_modules: ac.modules.iter().filter(|m| registry.get(m).is_none()).cloned().collect(),
        ..Default::default()
    };
    for name in &ac.files {
        validate_file_name(name)?;
        let path = root.join(name);
        let existing = match std::fs::read(&path) {
            Ok(b) => Some(String::from_utf8(b).map_err(|_| CoreError::corrupt(&path, "not UTF-8"))?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(CoreError::io(&path, e)),
        };
        let next = apply_region(existing.as_deref().unwrap_or(""), &region, &path, repair)?;
        let changed = existing.as_deref() != Some(next.as_str());
        if changed {
            atomic_write(&path, next.as_bytes())?;
        }
        report.files.push(ContextFileResult { file: name.clone(), changed, created: existing.is_none() });
    }
    Ok(report)
}

/// Update `agentContext` (validated) and sync.
pub fn update_config(
    project: &ProjectStore,
    registry: &ContextRegistry,
    actor: &Actor,
    f: impl FnOnce(&mut AgentContextConfig) -> Result<()>,
) -> Result<(AgentContextConfig, ContextSyncReport)> {
    let mut ac = project_config::read(project)?.agent_context;
    f(&mut ac)?;
    for m in &ac.modules {
        if m == BASE_MODULE {
            return Err(CoreError::invalid_input("the quadflow base module is always enabled"));
        }
    }
    let mut seen = std::collections::HashSet::new();
    ac.modules.retain(|m| seen.insert(m.clone()));
    let mut seen = std::collections::HashSet::new();
    for f in &ac.files {
        validate_file_name(f)?;
    }
    ac.files.retain(|f| seen.insert(f.to_lowercase()));
    project_config::update(
        project,
        actor,
        project_config::ProjectConfigPatch { agent_context: Some(ac.clone()), ..Default::default() },
    )?;
    let report = sync(project, registry, actor, false)?;
    Ok((ac, report))
}

pub fn enable_module(project: &ProjectStore, registry: &ContextRegistry, actor: &Actor, id: &str) -> Result<ContextSyncReport> {
    if id == BASE_MODULE {
        return Err(CoreError::invalid_input("the quadflow base module is always enabled"));
    }
    if registry.get(id).is_none() {
        return Err(unknown_module(registry, id));
    }
    update_config(project, registry, actor, |ac| {
        if !ac.modules.iter().any(|m| m == id) {
            ac.modules.push(id.to_string());
        }
        Ok(())
    })
    .map(|(_, r)| r)
}

pub fn disable_module(project: &ProjectStore, registry: &ContextRegistry, actor: &Actor, id: &str) -> Result<ContextSyncReport> {
    update_config(project, registry, actor, |ac| {
        let before = ac.modules.len();
        ac.modules.retain(|m| m != id);
        if before == ac.modules.len() && registry.get(id).is_none() {
            return Err(unknown_module(registry, id));
        }
        Ok(())
    })
    .map(|(_, r)| r)
}

pub fn unknown_module(registry: &ContextRegistry, id: &str) -> CoreError {
    CoreError::not_found(format!("unknown context module {id:?}; known: {}", registry.optional_ids().join(", ")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempProject;

    /// Builtin registry + a test doc `gamma` (no domain doc is core-bundled anymore).
    fn reg() -> ContextRegistry {
        let mut r = ContextRegistry::builtin();
        r.add("gamma", "Gamma", "test", false, "# Gamma\n\nGamma docs.\n");
        r
    }

    fn files(p: &TempProject, names: &[&str]) {
        update_config(&p.store, &reg(), &Actor::human("tester"), |ac| {
            ac.files = names.iter().map(|s| s.to_string()).collect();
            Ok(())
        })
        .unwrap();
    }

    fn read(p: &TempProject, name: &str) -> String {
        std::fs::read_to_string(p.store.root().path.join(name)).unwrap()
    }

    #[test]
    fn region_layout() {
        // Own test docs: which docs are core-bundled changes as tools move into plugins.
        let mut registry = reg();
        registry.add("alpha", "Alpha", "test", false, "# Alpha\n\nAlpha docs.\n");
        registry.add("beta", "Beta", "test", false, "# Beta\n\nBeta docs.\n");
        let r = render_region(&registry, &["alpha".into(), "gone".into()]);
        assert!(r.starts_with(MARKER_START) && r.ends_with(&format!("{MARKER_END}\n")));
        assert!(r.contains("## QuadFlow"));
        assert!(r.contains("`quadflow docs beta`"), "not-enabled module hint");
        assert!(!r.contains("`quadflow docs alpha`"), "enabled module has no hint line");
        assert!(r.contains("# Alpha"));
        let base = r.find("quadflow docs --list").unwrap();
        assert!(base < r.find("# Alpha").unwrap(), "base first");
    }

    #[test]
    fn creates_preserves_and_is_idempotent() {
        let p = TempProject::new();
        let root = p.store.root().path.clone();
        std::fs::write(root.join("ALPHA.md"), "# Mine\r\n\r\nKeep me.\r\n").unwrap();
        files(&p, &["ALPHA.md", "AGENTS.md"]);
        let alpha = read(&p, "ALPHA.md");
        assert!(alpha.starts_with("# Mine\r\n\r\nKeep me.\r\n\n"));
        assert!(read(&p, "AGENTS.md").starts_with(MARKER_START), "created with only the region");

        enable_module(&p.store, &reg(), &Actor::human("tester"), "gamma").unwrap();
        let with = read(&p, "ALPHA.md");
        assert!(with.contains("# Gamma"));
        std::fs::write(root.join("ALPHA.md"), format!("{with}trailer\n")).unwrap();
        let rep = disable_module(&p.store, &reg(), &Actor::human("tester"), "gamma").unwrap();
        assert!(rep.files.iter().all(|f| f.changed));
        let without = read(&p, "ALPHA.md");
        assert!(without.starts_with("# Mine\r\n\r\nKeep me.\r\n") && without.ends_with("trailer\n"));
        assert!(!without.contains("# Gamma"));
        // No change → no write.
        let rep = sync(&p.store, &reg(), &Actor::human("tester"), false).unwrap();
        assert!(rep.files.iter().all(|f| !f.changed));
        assert_eq!(project_config::read(&p.store).unwrap().agent_context.files, ["ALPHA.md", "AGENTS.md"]);
    }

    #[test]
    fn dangling_marker_is_corrupt_until_repaired() {
        let p = TempProject::new();
        let root = p.store.root().path.clone();
        std::fs::write(root.join("AGENTS.md"), format!("top\n{MARKER_START}\nhalf")).unwrap();
        let err = update_config(&p.store, &reg(), &Actor::human("tester"), |ac| {
            ac.files = vec!["AGENTS.md".into()];
            Ok(())
        })
        .unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::Corrupt);
        assert!(err.message.contains("AGENTS.md") || format!("{err:?}").contains("AGENTS.md"));
        sync(&p.store, &reg(), &Actor::human("tester"), true).unwrap();
        let s = read(&p, "AGENTS.md");
        assert!(s.starts_with("top\n") && s.ends_with(&format!("{MARKER_END}\n")) && !s.contains("half"));
    }

    #[test]
    fn validation() {
        let p = TempProject::new();
        for bad in ["../x.md", "a/b.md", "x.txt", ".hidden.md", "a b.md"] {
            assert!(validate_file_name(bad).is_err(), "{bad}");
        }
        assert!(enable_module(&p.store, &reg(), &Actor::human("tester"), "nope").is_err());
        assert!(enable_module(&p.store, &reg(), &Actor::human("tester"), BASE_MODULE).is_err());
    }
}
