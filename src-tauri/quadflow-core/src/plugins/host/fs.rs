//! Scoped file system (plugin-system.md §6.6, §11.3).
//!
//! Paths are relative to a scope root. Resolution rejects `..` segments,
//! absolute paths, drive/stream prefixes (`:`) and NUL, then canonicalizes
//! (`dunce`) the deepest existing ancestor and requires it to stay inside the
//! canonical scope root, so a symlink / junction inside the scope that points
//! outside is rejected. In the `project` scope the project's data directory
//! (`.quadflow/`, `.quadflow-dev/`) is off limits — domain data goes through
//! `data.*` and its permissions.
//!
//! | scope | root | permission |
//! |---|---|---|
//! | `project` | current project root | `fs:read|write:project` (or `:any`) |
//! | `pluginData` | `<appData>/plugin-data/<id>/` | none |
//! | `projectPluginData` | `<project>/.quadflow/plugins/<id>/` | none |
//! | `projectPluginLocal` | `<project>/.quadflow/local/plugins/<id>/` | none |
//! | `home` | the user's home | `fs:read|write:home` (or `:any`) |
//! | `absolute` | — (path is absolute) | `fs:read|write:any`, or a path picked with `ui.pickFile` |

use super::{json, HostCall, HostEnv, MethodSpec, PermReq, Sink, SubscriptionGuard, TopicSpec};
use crate::error::{CoreError, Result};
use crate::paths::ProjectRoot;
use crate::store::atomic_write;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Component, Path, PathBuf};

/// Largest file `readText` / `readBytes` returns.
pub const FS_MAX_READ_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FsScopeName {
    Project,
    PluginData,
    ProjectPluginData,
    ProjectPluginLocal,
    Home,
    Absolute,
}

fn bad_path(msg: impl Into<String>) -> CoreError {
    CoreError::permission_denied(msg.into())
}

/// Resolve `rel` inside `root` (which must exist). See the module docs.
pub fn resolve_in_root(root: &Path, rel: &str) -> Result<PathBuf> {
    if rel.contains('\0') {
        return Err(CoreError::invalid_input("path contains NUL"));
    }
    if Path::new(rel).has_root() || Path::new(rel).is_absolute() {
        return Err(bad_path(format!("path {rel:?} must be relative to its scope")));
    }
    let canon_root = dunce::canonicalize(root).map_err(|e| CoreError::io(root, e))?;
    let mut target = canon_root.clone();
    for seg in rel.split(['/', '\\']) {
        match seg {
            "" | "." => {}
            ".." => return Err(bad_path(format!("path {rel:?} escapes its scope ('..' is not allowed)"))),
            s if s.contains(':') => return Err(bad_path(format!("path {rel:?}: ':' is not allowed in a path segment"))),
            s => target.push(s),
        }
    }
    let resolved = canonical_existing_prefix(&target)?;
    if !resolved.starts_with(&canon_root) {
        return Err(bad_path(format!("path {rel:?} escapes its scope (through a symlink or junction)")));
    }
    Ok(resolved)
}

/// Canonicalize the deepest existing ancestor of `p` and re-append the
/// missing tail (plain names that cannot be links because they do not exist).
fn canonical_existing_prefix(p: &Path) -> Result<PathBuf> {
    let mut existing = p.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while std::fs::symlink_metadata(&existing).is_err() {
        match existing.file_name() {
            Some(name) => tail.push(name.to_os_string()),
            None => break,
        }
        if !existing.pop() {
            break;
        }
    }
    // A dangling link (exists as a link, target missing) fails here → rejected.
    let mut canon = dunce::canonicalize(&existing)
        .map_err(|e| bad_path(format!("cannot resolve {}: {e}", existing.display())))?;
    for name in tail.into_iter().rev() {
        canon.push(name);
    }
    Ok(canon)
}

fn is_write(method: &str) -> bool {
    matches!(method, "fs.writeText" | "fs.writeBytes" | "fs.remove" | "fs.mkdir")
}

fn scope_of(c: &HostCall) -> Result<FsScopeName> {
    Ok(c.opt::<FsScopeName>("scope")?.unwrap_or(FsScopeName::Project))
}

fn path_param(c: &HostCall) -> Result<String> {
    Ok(c.opt::<String>("path")?.unwrap_or_default())
}

fn project_root_of(env: &HostEnv, c: &HostCall) -> Result<ProjectRoot> {
    let root = env.project_root(c)?;
    ProjectRoot::open_with(&root, env.core.profile())
}

fn ensure_dir(p: &Path) -> Result<()> {
    std::fs::create_dir_all(p).map_err(|e| CoreError::io(p, e))
}

/// The canonical scope root (created for the plugin-private scopes).
fn scope_root(env: &HostEnv, c: &HostCall, scope: FsScopeName) -> Result<PathBuf> {
    let id = &c.plugin.id;
    let p = match scope {
        FsScopeName::Project => project_root_of(env, c)?.path,
        FsScopeName::PluginData => {
            let p = env.core.paths.plugin_data_dir.join(id);
            ensure_dir(&p)?;
            p
        }
        FsScopeName::ProjectPluginData => {
            let p = project_root_of(env, c)?.data_dir().join("plugins").join(id);
            ensure_dir(&p)?;
            p
        }
        FsScopeName::ProjectPluginLocal => {
            let p = project_root_of(env, c)?.data_dir().join("local").join("plugins").join(id);
            ensure_dir(&p)?;
            p
        }
        FsScopeName::Home => dirs::home_dir().ok_or_else(|| CoreError::unsupported("no home directory"))?,
        FsScopeName::Absolute => return Err(CoreError::internal("absolute scope has no root")),
    };
    dunce::canonicalize(&p).map_err(|e| CoreError::io(&p, e))
}

/// Resolve the call's `(path, scope)` to a checked absolute path.
fn resolve(env: &HostEnv, c: &HostCall) -> Result<(PathBuf, FsScopeName)> {
    let scope = scope_of(c)?;
    let rel = path_param(c)?;
    if scope == FsScopeName::Absolute {
        return Ok((resolve_absolute(&rel)?, scope));
    }
    let root = scope_root(env, c, scope)?;
    let p = resolve_in_root(&root, &rel)?;
    if scope == FsScopeName::Project {
        let names = [crate::paths::Profile::Release.project_dir_name(), crate::paths::Profile::Dev.project_dir_name()];
        if names.iter().any(|n| p.starts_with(root.join(n))) {
            return Err(bad_path(format!(
                "{rel:?} is inside the project's QuadFlow data directory; use the data.* API (or the projectPluginData scope)"
            )));
        }
    }
    Ok((p, scope))
}

fn resolve_absolute(path: &str) -> Result<PathBuf> {
    if path.contains('\0') {
        return Err(CoreError::invalid_input("path contains NUL"));
    }
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err(CoreError::invalid_input(format!("absolute scope needs an absolute path, got {path:?}")));
    }
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(bad_path(format!("path {path:?}: '..' is not allowed")));
    }
    canonical_existing_prefix(p)
}

/// Permission alternatives for the call (§11.1), computed before the handler.
fn fs_perm(env: &HostEnv, c: &HostCall) -> Result<Vec<String>> {
    let access = if is_write(c.method) { "write" } else { "read" };
    let scope = scope_of(c)?;
    let any = format!("fs:{access}:any");
    let alts = |s: &str| {
        let mut v = vec![format!("fs:{access}:{s}"), any.clone()];
        if access == "read" {
            v.push(format!("fs:write:{s}"));
            v.push("fs:write:any".into());
        }
        v
    };
    Ok(match scope {
        FsScopeName::PluginData | FsScopeName::ProjectPluginData | FsScopeName::ProjectPluginLocal => vec![],
        FsScopeName::Project => alts("project"),
        FsScopeName::Home => alts("home"),
        FsScopeName::Absolute => {
            let p = resolve_absolute(&path_param(c)?)?;
            if env.session.is_allowed(&c.plugin.id, &p) {
                vec![]
            } else {
                let mut v = vec![any.clone()];
                if access == "read" {
                    v.push("fs:write:any".into());
                }
                v
            }
        }
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FsEntryOut {
    name: String,
    kind: &'static str,
    size: u64,
    modified_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FsStatOut {
    kind: &'static str,
    size: u64,
    modified_at: i64,
}

fn mtime(m: &std::fs::Metadata) -> i64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn kind(m: &std::fs::Metadata) -> &'static str {
    if m.is_dir() {
        "dir"
    } else {
        "file"
    }
}

fn read_checked(p: &Path) -> Result<Vec<u8>> {
    let meta = std::fs::metadata(p).map_err(|e| io_err(p, e))?;
    if meta.is_dir() {
        return Err(CoreError::invalid_input(format!("{} is a directory", p.display())));
    }
    if meta.len() > FS_MAX_READ_BYTES {
        return Err(CoreError::invalid_input(format!("{} is larger than {FS_MAX_READ_BYTES} bytes", p.display())));
    }
    std::fs::read(p).map_err(|e| io_err(p, e))
}

fn io_err(p: &Path, e: std::io::Error) -> CoreError {
    if e.kind() == std::io::ErrorKind::NotFound {
        CoreError::not_found(format!("{} does not exist", p.display()))
    } else {
        CoreError::io(p, e)
    }
}

fn write_checked(p: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = p.parent() {
        ensure_dir(parent)?;
    }
    atomic_write(p, bytes)
}

pub(super) fn methods() -> Vec<MethodSpec> {
    let mut v = Vec::new();
    let perm = || PermReq::Fn(fs_perm);

    v.push(MethodSpec::new("fs.readText", perm(), |env: &HostEnv, c: &HostCall| {
        let (p, _) = resolve(env, c)?;
        let bytes = read_checked(&p)?;
        let text = String::from_utf8(bytes).map_err(|_| CoreError::invalid_input(format!("{} is not UTF-8", p.display())))?;
        Ok(Value::String(text))
    }));
    v.push(MethodSpec::new("fs.readBytes", perm(), |env: &HostEnv, c: &HostCall| {
        let (p, _) = resolve(env, c)?;
        Ok(Value::String(base64::engine::general_purpose::STANDARD.encode(read_checked(&p)?)))
    }));
    v.push(MethodSpec::new("fs.writeText", perm(), |env: &HostEnv, c: &HostCall| {
        let (p, _) = resolve(env, c)?;
        write_checked(&p, c.arg::<String>("content")?.as_bytes())?;
        Ok(Value::Null)
    }));
    v.push(MethodSpec::new("fs.writeBytes", perm(), |env: &HostEnv, c: &HostCall| {
        let (p, _) = resolve(env, c)?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(c.arg::<String>("contentBase64")?)
            .map_err(|e| CoreError::invalid_input(format!("fs.writeBytes: contentBase64: {e}")))?;
        write_checked(&p, &bytes)?;
        Ok(Value::Null)
    }));
    v.push(MethodSpec::new("fs.list", perm(), |env: &HostEnv, c: &HostCall| {
        let (p, _) = resolve(env, c)?;
        let rd = std::fs::read_dir(&p).map_err(|e| io_err(&p, e))?;
        let mut out = Vec::new();
        for entry in rd.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            out.push(FsEntryOut {
                name: entry.file_name().to_string_lossy().to_string(),
                kind: kind(&meta),
                size: if meta.is_dir() { 0 } else { meta.len() },
                modified_at: mtime(&meta),
            });
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        json(out)
    }));
    v.push(MethodSpec::new("fs.stat", perm(), |env: &HostEnv, c: &HostCall| {
        let (p, _) = resolve(env, c)?;
        match std::fs::metadata(&p) {
            Ok(m) => json(FsStatOut { kind: kind(&m), size: if m.is_dir() { 0 } else { m.len() }, modified_at: mtime(&m) }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
            Err(e) => Err(CoreError::io(&p, e)),
        }
    }));
    v.push(MethodSpec::new("fs.remove", perm(), |env: &HostEnv, c: &HostCall| {
        let (p, scope) = resolve(env, c)?;
        if scope != FsScopeName::Absolute && path_param(c)?.split(['/', '\\']).all(|s| s.is_empty() || s == ".") {
            return Err(CoreError::invalid_input("fs.remove: refusing to remove the scope root"));
        }
        let recursive: bool = c.arg_or_default("recursive")?;
        let meta = std::fs::symlink_metadata(&p).map_err(|e| io_err(&p, e))?;
        let res = if meta.is_dir() {
            if recursive {
                std::fs::remove_dir_all(&p)
            } else {
                std::fs::remove_dir(&p)
            }
        } else {
            std::fs::remove_file(&p)
        };
        res.map_err(|e| CoreError::io(&p, e))?;
        Ok(Value::Null)
    }));
    // The checked absolute path (for host-side helpers such as
    // `shell.revealInFileManager`; read permission of the scope).
    v.push(MethodSpec::new("fs.resolve", perm(), |env: &HostEnv, c: &HostCall| {
        let (p, _) = resolve(env, c)?;
        Ok(Value::String(p.display().to_string()))
    }));
    v.push(MethodSpec::new("fs.mkdir", perm(), |env: &HostEnv, c: &HostCall| {
        let (p, _) = resolve(env, c)?;
        ensure_dir(&p)?;
        Ok(Value::Null)
    }));
    v
}

pub(super) fn topics() -> Vec<TopicSpec> {
    vec![TopicSpec::new("fs.watch", PermReq::Fn(fs_perm), |env: &HostEnv, c: &HostCall, sink: Sink| {
        use notify::{RecursiveMode, Watcher};
        let (p, _) = resolve(env, c)?;
        if !p.exists() {
            return Err(CoreError::not_found(format!("{} does not exist", p.display())));
        }
        let base = p.clone();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let Ok(ev) = res else { return };
            let paths: Vec<String> = ev
                .paths
                .iter()
                .map(|x| x.strip_prefix(&base).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default())
                .collect();
            if !paths.is_empty() {
                sink(serde_json::json!({ "paths": paths }));
            }
        })
        .map_err(|e| CoreError::internal(format!("fs.watch: {e}")))?;
        watcher
            .watch(&p, RecursiveMode::Recursive)
            .map_err(|e| CoreError::internal(format!("fs.watch {}: {e}", p.display())))?;
        Ok(SubscriptionGuard::new(watcher))
    })]
}
