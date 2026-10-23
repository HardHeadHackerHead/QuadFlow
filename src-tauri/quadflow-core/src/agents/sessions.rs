//! Generic session-file scanner (agent-providers.md §8.3): expand the
//! provider's `sessions.dir` template, walk `glob` newest-first, derive id and
//! cwd per file. Per-file results are cached by `(path, len, mtime)` so polling
//! re-reads only new or changed files. All times are epoch ms.

use super::detect::ProcessEnv;
use super::spec::{AgentProviderSpec, CwdFrom, IdFormat, IdFrom, JsonlField, SessionStrategy};
use super::validate_session_id;
use crate::error::{CoreError, Result};
use crate::model::Timestamp;
use crate::paths::root_key;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionInfo {
    pub provider_id: String,
    pub id: String,
    pub path: String,
    pub cwd: Option<String>,
    pub created_at: Timestamp,
    pub modified_at: Timestamp,
    pub size_bytes: u64,
    pub title: Option<String>,
}

/// `nonalnum-dash`: every char outside `[A-Za-z0-9]` becomes `-`.
pub fn nonalnum_dash(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// Expand a `sessions.dir` template for `cwd`.
pub fn expand_dir(template: &str, cwd: &Path, env: &ProcessEnv) -> Result<PathBuf> {
    let mut out = String::new();
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let end = rest[start..]
            .find('}')
            .map(|e| e + start)
            .ok_or_else(|| CoreError::invalid_input(format!("unterminated variable in {template:?}")))?;
        let var = &rest[start + 1..end];
        let missing = || CoreError::unsupported(format!("{{{var}}} is not available on this machine"));
        let val = match var {
            "home" => env.home.as_ref().ok_or_else(missing)?.to_string_lossy().to_string(),
            "appData" => env.app_data.as_ref().ok_or_else(missing)?.to_string_lossy().to_string(),
            "localAppData" => env.local_app_data.as_ref().ok_or_else(missing)?.to_string_lossy().to_string(),
            "cwd|nonalnum-dash" => nonalnum_dash(&cwd.to_string_lossy()),
            _ => return Err(CoreError::invalid_input(format!("unknown variable {{{var}}} in {template:?}"))),
        };
        out.push_str(&val);
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    Ok(PathBuf::from(out))
}

/// Where a provider keeps the sessions of *every* project (session search,
/// history across projects): the `sessions.dir` prefix before its first
/// `{cwd…}` segment, walked with one `*` per cwd-dependent segment in front of
/// `sessions.glob`.
#[derive(Clone, Debug)]
pub struct SessionsRoot {
    pub provider_id: String,
    pub root: PathBuf,
    /// Glob relative to `root`.
    pub glob: String,
    /// Leading path segments below `root` that encode the project (0 = none).
    pub cwd_segments: usize,
    matcher: globset::GlobMatcher,
}

impl SessionsRoot {
    pub fn of(spec: &AgentProviderSpec, env: &ProcessEnv) -> Result<Option<Self>> {
        let s = &spec.sessions;
        let (Some(dir), Some(glob)) = (&s.dir, &s.glob) else { return Ok(None) };
        if s.strategy == SessionStrategy::None {
            return Ok(None);
        }
        let segs: Vec<&str> = dir.split(['/', '\\']).collect();
        let (prefix, cwd_segments) = match segs.iter().position(|seg| seg.contains("{cwd")) {
            Some(i) => (segs[..i].join("/"), segs.len() - i),
            None => (dir.clone(), 0),
        };
        let root = expand_dir(&prefix, Path::new(""), env)?;
        let glob = format!("{}{}", "*/".repeat(cwd_segments), glob);
        let matcher = globset::Glob::new(&glob)
            .map_err(|e| CoreError::invalid_input(format!("invalid sessions.glob {glob:?}: {e}")))?
            .compile_matcher();
        Ok(Some(Self { provider_id: spec.id.clone(), root, glob, cwd_segments, matcher }))
    }

    /// `path` is a session file of this provider.
    pub fn matches(&self, path: &Path) -> bool {
        path.strip_prefix(&self.root).is_ok_and(|rel| self.matcher.is_match(rel))
    }

    /// Session files of every project, newest-modified first, at most `max`.
    pub fn files(&self, max: usize) -> Vec<PathBuf> {
        if !self.root.is_dir() {
            return Vec::new();
        }
        let depth = if self.glob.contains("**") { usize::MAX } else { self.glob.matches('/').count() + 1 };
        let mut files: Vec<(PathBuf, Timestamp)> = walkdir::WalkDir::new(&self.root)
            .max_depth(depth)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file() && self.matches(e.path()))
            .map(|e| {
                let m = e.metadata().ok().and_then(|m| to_ms(m.modified())).unwrap_or(0);
                (e.into_path(), m)
            })
            .collect();
        files.sort_by_key(|(_, m)| std::cmp::Reverse(*m));
        files.truncate(max);
        files.into_iter().map(|(p, _)| p).collect()
    }

    /// The project-encoding directory of a session file (`None` when the
    /// provider's dir does not depend on the project).
    pub fn project_of(&self, path: &Path) -> Option<String> {
        if self.cwd_segments == 0 {
            return None;
        }
        let rel = path.strip_prefix(&self.root).ok()?;
        rel.components().next().map(|c| c.as_os_str().to_string_lossy().to_string())
    }
}

fn to_ms(t: std::io::Result<SystemTime>) -> Option<Timestamp> {
    t.ok().and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok()).map(|d| d.as_millis() as Timestamp)
}

fn dot_path<'a>(v: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.').try_fold(v, |cur, seg| cur.get(seg))
}

/// First line (within `max_lines`) whose top-level fields match, then `path` as a string.
fn jsonl_field(file: &Path, field: &JsonlField, max_lines: usize) -> Option<String> {
    let f = std::fs::File::open(file).ok()?;
    for line in BufReader::new(f).lines().take(max_lines) {
        let Ok(line) = line else { break };
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if field.match_fields.iter().all(|(k, want)| v.get(k).and_then(Value::as_str) == Some(want.as_str())) {
            return dot_path(&v, &field.path).and_then(Value::as_str).map(str::to_string);
        }
    }
    None
}

#[derive(Clone, Debug)]
struct Derived {
    len: u64,
    mtime: Option<Timestamp>,
    id: Option<String>,
    cwd: Option<String>,
}

/// Scanner with the per-file `(path, len, mtime)` cache.
#[derive(Default)]
pub struct SessionScanner {
    cache: Mutex<HashMap<PathBuf, Derived>>,
}

impl SessionScanner {
    pub fn new() -> Self {
        Self::default()
    }

    /// Sessions of `cwd`, newest-modified first. `since_ms` keeps sessions
    /// created at or after that time.
    pub fn list(&self, spec: &AgentProviderSpec, cwd: &Path, since_ms: Option<Timestamp>, env: &ProcessEnv) -> Result<Vec<AgentSessionInfo>> {
        let s = &spec.sessions;
        if s.strategy == SessionStrategy::None {
            return Ok(Vec::new());
        }
        let (Some(dir_t), Some(glob), Some(id_from)) = (&s.dir, &s.glob, &s.id_from) else {
            return Ok(Vec::new());
        };
        let dir = expand_dir(dir_t, cwd, env)?;
        if !dir.is_dir() {
            return Ok(Vec::new());
        }
        let matcher = globset::Glob::new(glob)
            .map_err(|e| CoreError::invalid_input(format!("invalid sessions.glob {glob:?}: {e}")))?
            .compile_matcher();
        let depth = if glob.contains("**") { usize::MAX } else { glob.matches('/').count() + 1 };
        let mut files: Vec<(PathBuf, std::fs::Metadata)> = walkdir::WalkDir::new(&dir)
            .max_depth(depth)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .filter(|e| e.path().strip_prefix(&dir).is_ok_and(|rel| matcher.is_match(rel)))
            .filter_map(|e| e.metadata().ok().map(|m| (e.into_path(), m)))
            .collect();
        files.sort_by_key(|(_, m)| std::cmp::Reverse(to_ms(m.modified()).unwrap_or(0)));
        files.truncate(s.max_files);

        let want_key = root_key(cwd);
        let mut out = Vec::new();
        let mut cache = self.cache.lock();
        for (path, meta) in files {
            let modified = to_ms(meta.modified()).unwrap_or(0);
            let created = to_ms(meta.created()).unwrap_or(modified);
            if since_ms.is_some_and(|since| created < since) {
                continue;
            }
            let fresh = cache.get(&path).is_some_and(|d| d.len == meta.len() && d.mtime == Some(modified));
            if !fresh {
                let id = match id_from {
                    IdFrom::FileStem(_) => path.file_stem().map(|s| s.to_string_lossy().to_string()),
                    IdFrom::FileStemRegex(re) => path.file_stem().and_then(|stem| {
                        regex::Regex::new(re).ok()?.captures(&stem.to_string_lossy())?.get(1).map(|m| m.as_str().to_string())
                    }),
                    IdFrom::Jsonl(f) => jsonl_field(&path, f, s.header_lines),
                };
                let cwd_v = match &s.cwd_from {
                    Some(CwdFrom::Jsonl(f)) => jsonl_field(&path, f, s.header_lines),
                    _ => None,
                };
                cache.insert(path.clone(), Derived { len: meta.len(), mtime: Some(modified), id, cwd: cwd_v });
            }
            let d = &cache[&path];
            let Some(id) = d.id.clone().filter(|id| validate_session_id(id, s.id_format).is_ok()) else {
                tracing::debug!("session file {} skipped: no usable id", path.display());
                continue;
            };
            let session_cwd = match &s.cwd_from {
                Some(CwdFrom::Jsonl(_)) => match &d.cwd {
                    Some(c) if root_key(Path::new(c)) == want_key => Some(c.clone()),
                    Some(_) => continue,
                    None => {
                        tracing::debug!("session file {} skipped: no cwd", path.display());
                        continue;
                    }
                },
                // The dir is derived from cwd: every file in it belongs to cwd.
                _ => Some(cwd.to_string_lossy().to_string()),
            };
            out.push(AgentSessionInfo {
                provider_id: spec.id.clone(),
                id,
                path: path.to_string_lossy().to_string(),
                cwd: session_cwd,
                created_at: created,
                modified_at: modified,
                size_bytes: meta.len(),
                title: None,
            });
        }
        Ok(out)
    }

    pub fn exists(&self, spec: &AgentProviderSpec, cwd: &Path, id: &str, env: &ProcessEnv) -> bool {
        if validate_session_id(id, spec.sessions.id_format).is_err() && spec.sessions.id_format == IdFormat::Uuid {
            return false;
        }
        self.list(spec, cwd, None, env).map(|l| l.iter().any(|s| s.id == id)).unwrap_or(false)
    }

    /// Drop cached entries of files that no longer exist (bounded memory).
    pub fn prune(&self) {
        self.cache.lock().retain(|p, _| p.exists());
    }
}

#[cfg(test)]
pub(crate) mod test_util {
    use std::path::Path;

    /// Write a discover-style rollout file `<dir>/<date>/rollout-<id>.jsonl`.
    pub fn write_rollout(sessions_dir: &Path, id: &str, cwd: &Path) -> std::path::PathBuf {
        let day = sessions_dir.join("2026").join("10").join("22");
        std::fs::create_dir_all(&day).unwrap();
        let p = day.join(format!("rollout-2026-10-22T10-00-00-{id}.jsonl"));
        let meta = serde_json::json!({"type":"session_meta","payload":{"id": id, "cwd": cwd.to_string_lossy()}});
        std::fs::write(&p, format!("{{\"type\":\"noise\"}}\n{meta}\n")).unwrap();
        p
    }
}

#[cfg(test)]
mod tests {
    use super::test_util::write_rollout;
    use super::*;
    use crate::agents::spec::{fixtures, parse_spec};

    #[test]
    fn nonalnum_dash_encodes_dots() {
        assert_eq!(nonalnum_dash(r"C:\Users\me\proj.worktrees\a_b"), "C--Users-me-proj-worktrees-a-b");
        assert_eq!(nonalnum_dash("/home/me/.x"), "-home-me--x");
    }

    #[test]
    fn expand_templates() {
        let env = ProcessEnv { home: Some("/h".into()), ..Default::default() };
        assert_eq!(expand_dir("{home}/.a/{cwd|nonalnum-dash}", Path::new("/w/p.q"), &env).unwrap(), PathBuf::from("/h/.a/-w-p-q"));
        assert!(expand_dir("{appData}/x", Path::new("/"), &env).is_err());
        assert!(expand_dir("{evil}/x", Path::new("/"), &env).is_err());
    }

    #[test]
    fn all_projects_root_from_dir_template() {
        let home = tempfile::tempdir().unwrap();
        let env = ProcessEnv { home: Some(home.path().into()), ..Default::default() };
        let pre = parse_spec(&fixtures::preassign()).unwrap();
        let r = SessionsRoot::of(&pre, &env).unwrap().unwrap();
        assert_eq!(r.root, home.path().join(".alpha/projects"));
        assert_eq!((r.glob.as_str(), r.cwd_segments), ("*/*.jsonl", 1));
        let dir = r.root.join("-w-p");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("0f8fad5b-d9cb-469f-a165-70867728950e.jsonl");
        std::fs::write(&f, "{}\n").unwrap();
        std::fs::write(r.root.join("top.jsonl"), "{}\n").unwrap();
        assert_eq!(r.files(10), [f.clone()]);
        assert_eq!(r.project_of(&f).as_deref(), Some("-w-p"));
        let disc = parse_spec(&fixtures::discover()).unwrap();
        let d = SessionsRoot::of(&disc, &env).unwrap().unwrap();
        assert_eq!(d.cwd_segments, 0);
        let p = write_rollout(&home.path().join(".beta/sessions"), "11111111-1111-4111-8111-111111111111", home.path());
        assert!(d.matches(&p));
        assert_eq!(d.files(10).len(), 1);
        assert!(d.project_of(&p).is_none());
    }

    #[test]
    fn preassign_scan_by_file_stem() {
        let home = tempfile::tempdir().unwrap();
        let cwd = Path::new("/work/my.repo");
        let spec = parse_spec(&fixtures::preassign()).unwrap();
        let env = ProcessEnv { home: Some(home.path().into()), ..Default::default() };
        let dir = home.path().join(".alpha/projects").join(nonalnum_dash(&cwd.to_string_lossy()));
        std::fs::create_dir_all(&dir).unwrap();
        let id = "0f8fad5b-d9cb-469f-a165-70867728950e";
        std::fs::write(dir.join(format!("{id}.jsonl")), "{}\n").unwrap();
        std::fs::write(dir.join("not-a-uuid.jsonl"), "{}\n").unwrap();
        std::fs::write(dir.join("other.txt"), "").unwrap();
        let sc = SessionScanner::new();
        let l = sc.list(&spec, cwd, None, &env).unwrap();
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].id, id);
        assert!(l[0].created_at > 1_600_000_000_000, "ms, not seconds: {}", l[0].created_at);
        assert!(sc.exists(&spec, cwd, id, &env));
        assert!(!sc.exists(&spec, cwd, "0f8fad5b-d9cb-469f-a165-000000000000", &env));
    }

    #[test]
    fn discover_scan_filters_cwd_and_since() {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let spec = parse_spec(&fixtures::discover()).unwrap();
        let env = ProcessEnv { home: Some(home.path().into()), ..Default::default() };
        let sdir = home.path().join(".beta/sessions");
        let a = "11111111-1111-4111-8111-111111111111";
        let b = "22222222-2222-4222-8222-222222222222";
        write_rollout(&sdir, a, proj.path());
        write_rollout(&sdir, b, other.path());
        let sc = SessionScanner::new();
        let l = sc.list(&spec, proj.path(), None, &env).unwrap();
        assert_eq!(l.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), [a]);
        // Path spelled differently (trailing slash, case on Windows) still matches.
        let alt = PathBuf::from(format!("{}/", proj.path().display()));
        assert_eq!(sc.list(&spec, &alt, None, &env).unwrap().len(), 1);
        let future = crate::time::now_ms() + 60_000;
        assert!(sc.list(&spec, proj.path(), Some(future), &env).unwrap().is_empty());
        // Missing dir → empty, not an error.
        let env2 = ProcessEnv { home: Some(proj.path().into()), ..Default::default() };
        assert!(sc.list(&spec, proj.path(), None, &env2).unwrap().is_empty());
    }
}
