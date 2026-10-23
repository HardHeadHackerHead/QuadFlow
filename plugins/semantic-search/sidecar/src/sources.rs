//! Where session transcripts are found: session roots, each a folder plus a
//! glob relative to it and the agent provider that owns it.
//!
//! Roots come from two places (see `main.rs`): the host's
//! `agents.sessionRoots` (every active provider's manifest `sessions.dir` /
//! `sessions.glob`, when the host has that method) and the plugin setting
//! `sessionDirs` (folders the user added). Nothing here knows a specific agent.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Upper bound of files read per root in one scan.
pub const MAX_FILES_PER_ROOT: usize = 5000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionRootSpec {
    /// Agent provider id ("" = unknown).
    #[serde(default)]
    pub provider_id: String,
    pub root: String,
    /// Glob relative to `root` (default `**/*.jsonl`).
    #[serde(default)]
    pub glob: Option<String>,
    /// Leading path segments below `root` that encode the project (0 = none).
    #[serde(default)]
    pub cwd_segments: usize,
    /// `provider` (host) or `setting` (user folder).
    #[serde(default)]
    pub origin: String,
}

#[derive(Clone, Debug)]
pub struct SessionRoot {
    pub spec: SessionRootSpec,
    root: PathBuf,
    glob: String,
    matcher: globset::GlobMatcher,
}

impl SessionRoot {
    pub fn new(spec: SessionRootSpec) -> Result<Self, String> {
        let glob = spec.glob.clone().filter(|g| !g.trim().is_empty()).unwrap_or_else(|| "**/*.jsonl".into());
        let matcher = globset::GlobBuilder::new(&glob)
            .literal_separator(true)
            .build()
            .map_err(|e| format!("invalid glob {glob:?}: {e}"))?
            .compile_matcher();
        Ok(Self { root: PathBuf::from(&spec.root), spec, glob, matcher })
    }

    pub fn provider_id(&self) -> &str {
        &self.spec.provider_id
    }

    fn rel<'a>(&self, path: &'a Path) -> Option<std::borrow::Cow<'a, str>> {
        let rel = path.strip_prefix(&self.root).ok()?;
        let s = rel.to_string_lossy();
        Some(if s.contains('\\') { std::borrow::Cow::Owned(s.replace('\\', "/")) } else { s })
    }

    /// `path` is a session file of this root.
    pub fn matches(&self, path: &Path) -> bool {
        self.rel(path).is_some_and(|r| self.matcher.is_match(r.as_ref()))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Session files, newest-modified first, at most `max`.
    pub fn files(&self, max: usize) -> Vec<PathBuf> {
        if !self.root.is_dir() {
            return Vec::new();
        }
        let depth = if self.glob.contains("**") { usize::MAX } else { self.glob.matches('/').count() + 1 };
        let mut files: Vec<(PathBuf, u64)> = walkdir::WalkDir::new(&self.root)
            .max_depth(depth)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file() && self.matches(e.path()))
            .map(|e| {
                let m = e.metadata().ok().and_then(|m| m.modified().ok()).map(to_ms).unwrap_or(0);
                (e.into_path(), m)
            })
            .collect();
        files.sort_by_key(|(_, m)| std::cmp::Reverse(*m));
        files.truncate(max);
        files.into_iter().map(|(p, _)| p).collect()
    }

    /// Project grouping of a session file: the provider's project-encoding
    /// directory when it has one, else the file's parent directory name.
    pub fn project_of(&self, path: &Path) -> String {
        if self.spec.cwd_segments > 0 {
            if let Some(first) = path.strip_prefix(&self.root).ok().and_then(|r| r.components().next()) {
                return first.as_os_str().to_string_lossy().to_string();
            }
        }
        parent_name(path)
    }
}

pub fn parent_name(path: &Path) -> String {
    path.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

pub fn to_ms(t: std::time::SystemTime) -> u64 {
    t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_and_lists_with_project_segment() {
        let dir = std::env::temp_dir().join(format!("qf-semantic-sources-{}", std::process::id()));
        let proj = dir.join("proj-a");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::write(proj.join("s1.jsonl"), "{}\n").unwrap();
        std::fs::write(proj.join("notes.txt"), "x").unwrap();
        let r = SessionRoot::new(SessionRootSpec {
            provider_id: "p".into(),
            root: dir.display().to_string(),
            glob: Some("*/*.jsonl".into()),
            cwd_segments: 1,
            origin: "provider".into(),
        })
        .unwrap();
        let files = r.files(10);
        assert_eq!(files.len(), 1);
        assert!(r.matches(&files[0]));
        assert_eq!(r.project_of(&files[0]), "proj-a");
        assert!(!r.matches(&proj.join("notes.txt")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
