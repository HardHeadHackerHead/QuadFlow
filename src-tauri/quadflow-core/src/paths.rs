//! App paths, build profiles, project roots and discovery (data-layer.md §3.1, §3.2).
//!
//! ## Profiles (dev-build isolation)
//!
//! A dev build must never read or write a real installation's data. Every path
//! decision therefore goes through a [`Profile`]:
//!
//! | | `Release` | `Dev` |
//! |---|---|---|
//! | app data dir | `<data>/io.quadslab.quadflow` | `<data>/io.quadslab.quadflow.dev` |
//! | project folder | `.quadflow/` | `.quadflow-dev/` |
//!
//! `Dev` is selected when the crate is compiled with `debug_assertions` or when
//! `QUADFLOW_PROFILE=dev`; `QUADFLOW_PROFILE=release` forces `Release` (tests).
//! `QUADFLOW_DATA_DIR` overrides the app data dir for either profile (tests, GUI harness).

use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

/// App identifier of release builds (= app-data folder name = Tauri identifier).
pub const APP_ID_RELEASE: &str = "io.quadslab.quadflow";
/// App identifier of dev builds.
pub const APP_ID_DEV: &str = "io.quadslab.quadflow.dev";

pub const ENV_PROFILE: &str = "QUADFLOW_PROFILE";
pub const ENV_DATA_DIR: &str = "QUADFLOW_DATA_DIR";
pub const ENV_PROJECT_DIR: &str = "QUADFLOW_PROJECT_DIR";

/// Project marker file inside the project folder.
pub const CONFIG_FILE: &str = "config.json";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum Profile {
    Release,
    Dev,
}

impl Profile {
    /// Pure resolution rule: an explicit `QUADFLOW_PROFILE` value wins, otherwise
    /// debug builds are `Dev` and release builds are `Release`.
    pub fn resolve(env_value: Option<&str>, debug_build: bool) -> Profile {
        match env_value.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
            Some("dev") => Profile::Dev,
            Some("release") => Profile::Release,
            _ if debug_build => Profile::Dev,
            _ => Profile::Release,
        }
    }

    /// The profile of this process.
    pub fn current() -> Profile {
        Profile::resolve(std::env::var(ENV_PROFILE).ok().as_deref(), cfg!(debug_assertions))
    }

    /// App identifier; also the app-data folder name (matches the Tauri identifier).
    pub fn app_identifier(self) -> &'static str {
        match self {
            Profile::Release => APP_ID_RELEASE,
            Profile::Dev => APP_ID_DEV,
        }
    }

    /// Per-project data folder name.
    pub fn project_dir_name(self) -> &'static str {
        match self {
            Profile::Release => ".quadflow",
            Profile::Dev => ".quadflow-dev",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Profile::Release => "release",
            Profile::Dev => "dev",
        }
    }
}

// ---------------------------------------------------------------------------
// App paths
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AppPaths {
    pub profile: Profile,
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub cache_dir: PathBuf,
    pub logs_dir: PathBuf,
    /// Installed plugins.
    pub plugins_dir: PathBuf,
    /// Per-plugin private data.
    pub plugin_data_dir: PathBuf,
}

impl AppPaths {
    /// Resolve for this process: `QUADFLOW_DATA_DIR` if set, else
    /// `dirs::data_dir()/<profile identifier>`.
    ///
    /// In this crate's unit tests it panics unless `QUADFLOW_DATA_DIR` is set, so
    /// no test can touch a real user data dir.
    pub fn resolve() -> Result<Self> {
        let override_dir = std::env::var_os(ENV_DATA_DIR).filter(|v| !v.is_empty()).map(PathBuf::from);
        #[cfg(test)]
        if override_dir.is_none() {
            panic!("AppPaths::resolve() called in a test without {ENV_DATA_DIR}; use AppPaths::under()");
        }
        Self::resolve_with(Profile::current(), override_dir, dirs::data_dir())
    }

    /// Pure resolution (tested): override wins; otherwise `<base>/<identifier>`.
    pub fn resolve_with(profile: Profile, override_dir: Option<PathBuf>, base_data_dir: Option<PathBuf>) -> Result<Self> {
        let data_dir = match override_dir {
            Some(dir) => dir,
            None => base_data_dir
                .ok_or_else(|| CoreError::unsupported("could not determine the platform data directory"))?
                .join(profile.app_identifier()),
        };
        Ok(Self::build(profile, data_dir))
    }

    /// Paths rooted at an explicit directory (tests).
    pub fn under(root: &Path) -> Self {
        Self::build(Profile::current(), root.to_path_buf())
    }

    fn build(profile: Profile, data_dir: PathBuf) -> Self {
        Self {
            profile,
            db_path: data_dir.join("quadflow.db"),
            cache_dir: data_dir.join("cache"),
            logs_dir: data_dir.join("logs"),
            plugins_dir: data_dir.join("plugins"),
            plugin_data_dir: data_dir.join("plugin-data"),
            data_dir,
        }
    }
}

/// The profile-aware app data dir, created if missing. Convenience for modules
/// that keep their own files there (plugin-owned DBs until they move to plugin storage).
pub fn app_data_dir() -> Result<PathBuf> {
    let dir = AppPaths::resolve()?.data_dir;
    std::fs::create_dir_all(&dir).map_err(|e| CoreError::io(&dir, e))?;
    Ok(dir)
}

/// The working directory the GUI should default to when no project is open yet.
///
/// * `QUADFLOW_PROJECT_DIR` wins in every profile (the GUI test harness points it
///   at a scratch project).
/// * Dev profile without it: `<data dir>/scratch-project` — never the real home dir.
/// * Release without it: `None` (the shell keeps its own default, the home dir).
pub fn default_working_dir(profile: Profile, env_project_dir: Option<&str>, data_dir: &Path) -> Option<PathBuf> {
    if let Some(dir) = env_project_dir.filter(|d| !d.trim().is_empty()) {
        return Some(PathBuf::from(dir));
    }
    match profile {
        Profile::Dev => Some(data_dir.join("scratch-project")),
        Profile::Release => None,
    }
}

// ---------------------------------------------------------------------------
// Project roots
// ---------------------------------------------------------------------------

/// A QuadFlow project: a directory containing `<project folder>/config.json`.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ProjectRoot {
    /// Canonical path (no `\\?\` prefix on Windows).
    pub path: PathBuf,
    /// [`root_key`] of `path`.
    pub key: String,
    pub profile: Profile,
}

impl ProjectRoot {
    /// Open an existing project at exactly `path` (current profile).
    pub fn open(path: &Path) -> Result<Self> {
        Self::open_with(path, Profile::current())
    }

    pub fn open_with(path: &Path, profile: Profile) -> Result<Self> {
        let root = Self::at(path, profile)?;
        if !root.config_path().is_file() {
            return Err(CoreError::project_not_found(format!(
                "{} is not a QuadFlow project (no {}/{CONFIG_FILE})",
                root.path.display(),
                profile.project_dir_name()
            ))
            .with_details(serde_json::json!({ "hint": "run \"quadflow init\" here or pass --project" })));
        }
        Ok(root)
    }

    /// A root for an existing directory, without requiring the project marker (used by init).
    pub fn at(path: &Path, profile: Profile) -> Result<Self> {
        let canon = dunce::canonicalize(path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                CoreError::project_not_found(format!("{} does not exist", path.display()))
            } else {
                CoreError::io(path, e)
            }
        })?;
        if !canon.is_dir() {
            return Err(CoreError::invalid_input(format!("{} is not a directory", canon.display())));
        }
        Ok(Self { key: key_of_canonical(&canon), path: canon, profile })
    }

    /// `<root>/.quadflow` (or `.quadflow-dev` in the dev profile).
    pub fn data_dir(&self) -> PathBuf {
        self.path.join(self.profile.project_dir_name())
    }

    pub fn config_path(&self) -> PathBuf {
        self.data_dir().join(CONFIG_FILE)
    }

    pub fn lock_path(&self) -> PathBuf {
        self.data_dir().join(".lock")
    }
}

/// Normalized key for path comparison: canonicalized, `/` separators, no trailing
/// `/`, lowercase on Windows and macOS. `C:\Foo` and `c:/foo/` give the same key.
/// Paths that don't exist are normalized lexically.
pub fn root_key(path: &Path) -> String {
    let canon = dunce::canonicalize(path).unwrap_or_else(|_| lexical_normalize(path));
    key_of_canonical(&canon)
}

fn key_of_canonical(canon: &Path) -> String {
    let mut s = canon.to_string_lossy().replace('\\', "/");
    while s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    if cfg!(any(windows, target_os = "macos")) {
        s = s.to_lowercase();
    }
    s
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().map(|c| c.join(path)).unwrap_or_else(|_| path.to_path_buf())
    };
    let mut out = PathBuf::new();
    for c in abs.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Walk `start`, `start.parent()`, … to the filesystem root; the first directory
/// containing `<project folder>/config.json` (current profile) wins.
pub fn find_project_root(start: &Path) -> Option<ProjectRoot> {
    find_project_root_with(start, Profile::current())
}

pub fn find_project_root_with(start: &Path, profile: Profile) -> Option<ProjectRoot> {
    let start = dunce::canonicalize(start).ok()?;
    let marker = Path::new(profile.project_dir_name()).join(CONFIG_FILE);
    start
        .ancestors()
        .find(|dir| dir.join(&marker).is_file())
        .and_then(|dir| ProjectRoot::at(dir, profile).ok())
}

/// CLI resolution order (§3.2): `--project` flag → `QUADFLOW_PROJECT_DIR` → walk up
/// from `cwd` → `project_not_found`. Flag and env name the project root exactly.
pub fn resolve_cli_project(
    flag: Option<&Path>,
    env_project_dir: Option<&str>,
    cwd: &Path,
    profile: Profile,
) -> Result<ProjectRoot> {
    if let Some(p) = flag {
        return ProjectRoot::open_with(p, profile);
    }
    if let Some(dir) = env_project_dir.filter(|d| !d.trim().is_empty()) {
        return ProjectRoot::open_with(Path::new(dir), profile);
    }
    find_project_root_with(cwd, profile).ok_or_else(|| {
        CoreError::project_not_found(format!(
            "no QuadFlow project found in {} or any parent directory",
            cwd.display()
        ))
        .with_details(serde_json::json!({ "hint": "run \"quadflow init\" here or pass --project" }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_resolution() {
        assert_eq!(Profile::resolve(None, true), Profile::Dev);
        assert_eq!(Profile::resolve(None, false), Profile::Release);
        assert_eq!(Profile::resolve(Some("dev"), false), Profile::Dev);
        assert_eq!(Profile::resolve(Some(" DEV "), false), Profile::Dev);
        assert_eq!(Profile::resolve(Some("release"), true), Profile::Release);
        assert_eq!(Profile::resolve(Some(""), true), Profile::Dev);
        assert_eq!(Profile::resolve(Some("bogus"), false), Profile::Release);
        // This crate's tests are debug builds.
        if std::env::var(ENV_PROFILE).is_err() {
            assert_eq!(Profile::current(), if cfg!(debug_assertions) { Profile::Dev } else { Profile::Release });
        }
    }

    #[test]
    fn profile_names() {
        assert_eq!(Profile::Release.app_identifier(), "io.quadslab.quadflow");
        assert_eq!(Profile::Dev.app_identifier(), "io.quadslab.quadflow.dev");
        assert_eq!(Profile::Release.project_dir_name(), ".quadflow");
        assert_eq!(Profile::Dev.project_dir_name(), ".quadflow-dev");
    }

    #[test]
    fn app_paths_per_profile() {
        let base = PathBuf::from("/base");
        let rel = AppPaths::resolve_with(Profile::Release, None, Some(base.clone())).unwrap();
        assert_eq!(rel.data_dir, base.join(APP_ID_RELEASE));
        assert_eq!(rel.db_path, base.join(APP_ID_RELEASE).join("quadflow.db"));
        let dev = AppPaths::resolve_with(Profile::Dev, None, Some(base.clone())).unwrap();
        assert_eq!(dev.data_dir, base.join(APP_ID_DEV));
        assert_eq!(dev.plugins_dir, base.join(APP_ID_DEV).join("plugins"));
        assert_ne!(rel.data_dir, dev.data_dir);
        // Override wins for both profiles.
        let o = PathBuf::from("/tmp/qf-test");
        assert_eq!(AppPaths::resolve_with(Profile::Release, Some(o.clone()), Some(base.clone())).unwrap().data_dir, o);
        assert_eq!(AppPaths::resolve_with(Profile::Dev, Some(o.clone()), None).unwrap().data_dir, o);
        assert!(AppPaths::resolve_with(Profile::Dev, None, None).is_err());
    }

    #[test]
    fn dev_profile_never_resolves_into_release_data() {
        let base = PathBuf::from("C:/Users/u/AppData/Roaming");
        let names = |p: &Path| -> Vec<String> {
            p.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect()
        };
        for profile in [Profile::Dev, Profile::Release] {
            let ap = AppPaths::resolve_with(profile, None, Some(base.clone())).unwrap();
            for p in [&ap.data_dir, &ap.db_path, &ap.cache_dir, &ap.logs_dir, &ap.plugins_dir, &ap.plugin_data_dir] {
                let s = p.to_string_lossy();
                // The currently installed old build's data dir is never used by either profile.
                assert!(!s.contains("com.quadflow.app") && !s.contains("com.quadflow.dev"), "{s}");
                if profile == Profile::Dev {
                    assert!(!names(p).iter().any(|n| n == APP_ID_RELEASE), "dev path {s} points into the release data dir");
                    assert!(names(p).iter().any(|n| n == APP_ID_DEV), "{s}");
                }
            }
        }
        let dev = AppPaths::resolve_with(Profile::Dev, None, Some(base.clone())).unwrap();
        assert_eq!(Profile::Dev.project_dir_name(), ".quadflow-dev");
        // Default working dir in dev is a scratch dir under the dev data dir, never home.
        let wd = default_working_dir(Profile::Dev, None, &dev.data_dir).unwrap();
        assert!(wd.starts_with(&dev.data_dir));
        if let Some(home) = dirs::home_dir() {
            assert_ne!(wd, home);
        }
        assert_eq!(default_working_dir(Profile::Dev, Some("/scratch"), &dev.data_dir), Some(PathBuf::from("/scratch")));
        assert_eq!(default_working_dir(Profile::Release, None, &dev.data_dir), None);
        assert_eq!(default_working_dir(Profile::Release, Some(" "), &dev.data_dir), None);
    }

    #[test]
    #[should_panic(expected = "QUADFLOW_DATA_DIR")]
    fn resolve_panics_in_tests_without_override() {
        if std::env::var_os(ENV_DATA_DIR).is_some() {
            panic!("QUADFLOW_DATA_DIR is set in this environment; skipping guard check");
        }
        let _ = AppPaths::resolve();
    }

    #[test]
    fn root_key_normalizes() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("Foo");
        std::fs::create_dir(&p).unwrap();
        let a = root_key(&p);
        let b = root_key(&PathBuf::from(format!("{}/", p.display())));
        assert_eq!(a, b);
        assert!(!a.ends_with('/'));
        assert!(!a.contains('\\'));
        if cfg!(any(windows, target_os = "macos")) {
            let upper = PathBuf::from(p.display().to_string().to_uppercase());
            assert_eq!(root_key(&upper), a);
            assert_eq!(a, a.to_lowercase());
        }
        // Non-existent paths normalize lexically.
        let ghost = tmp.path().join("x").join("..").join("ghost");
        assert!(root_key(&ghost).ends_with("/ghost"));
    }

    fn make_project(dir: &Path, profile: Profile) {
        let d = dir.join(profile.project_dir_name());
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(CONFIG_FILE), "{}").unwrap();
    }

    #[test]
    fn walk_up_finds_profile_folder_only() {
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("proj");
        let sub = proj.join("a").join("b");
        std::fs::create_dir_all(&sub).unwrap();
        make_project(&proj, Profile::Release);

        let found = find_project_root_with(&sub, Profile::Release).unwrap();
        assert_eq!(found.path, dunce::canonicalize(&proj).unwrap());
        assert_eq!(found.data_dir(), found.path.join(".quadflow"));
        // A release project is invisible to the dev profile.
        assert!(find_project_root_with(&sub, Profile::Dev).is_none());

        make_project(&proj, Profile::Dev);
        let dev = find_project_root_with(&sub, Profile::Dev).unwrap();
        assert_eq!(dev.data_dir(), dev.path.join(".quadflow-dev"));

        // A folder without config.json is not a project.
        // (An ancestor of the temp dir may itself be a project on a dev machine,
        // so "not found" means "nothing inside tmp".)
        let bare = tmp.path().join("bare");
        std::fs::create_dir_all(bare.join(".quadflow")).unwrap();
        let canon_tmp = dunce::canonicalize(tmp.path()).unwrap();
        assert!(find_project_root_with(&bare, Profile::Release).map_or(true, |r| !r.path.starts_with(&canon_tmp)));
    }

    #[test]
    fn cli_resolution_order() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        make_project(&a, Profile::Release);
        make_project(&b, Profile::Release);
        let ca = dunce::canonicalize(&a).unwrap();
        let cb = dunce::canonicalize(&b).unwrap();

        let r = resolve_cli_project(Some(&a), Some(b.to_str().unwrap()), &b, Profile::Release).unwrap();
        assert_eq!(r.path, ca);
        let r = resolve_cli_project(None, Some(a.to_str().unwrap()), &b, Profile::Release).unwrap();
        assert_eq!(r.path, ca);
        let r = resolve_cli_project(None, Some(""), &b, Profile::Release).unwrap();
        assert_eq!(r.path, cb);
        let canon_tmp = dunce::canonicalize(tmp.path()).unwrap();
        match resolve_cli_project(None, None, tmp.path(), Profile::Release) {
            Err(e) => assert_eq!(e.code, crate::error::ErrorCode::ProjectNotFound),
            Ok(r) => assert!(!r.path.starts_with(&canon_tmp)), // ancestor project on a dev machine
        }
        let e = resolve_cli_project(Some(tmp.path()), None, &a, Profile::Release).unwrap_err();
        assert_eq!(e.code, crate::error::ErrorCode::ProjectNotFound);
    }
}
