//! Plugin system core (plugin-system.md §3, §4, §11, §13): manifest types and
//! validation, permissions, and the registry of bundled / installed / dev plugins.
//!
//! PL-1 scope: no loading or rendering of plugin code here — that is the shell's
//! job (PL-2) on top of [`registry::PluginRegistry`].

pub mod assets;
pub mod cli;
pub mod dev;
pub mod host;
pub mod live;
pub mod manifest;
pub mod permissions;
pub mod registry;
pub mod schema;
pub mod sidecar;
pub mod sources;

pub use manifest::{validate_dir, Manifest, ManifestIssue, ValidationReport};
pub use permissions::{Permission, PermissionKind, Risk};
pub use registry::{
    Contributions, Isolation, LoadOptions, LoadedPlugin, PluginInfo, PluginOrigin, PluginRegistry, PluginStatus,
};

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The `@quadflow/plugin-api` version this host implements (§6.8). Must equal
/// `packages/plugin-api/src/version.ts` (asserted by `tests/plugin_api_version.rs`).
pub const PLUGIN_API_VERSION: &str = "1.4.0";

/// Manifest file name at a plugin root.
pub const MANIFEST_FILE: &str = "quadflow-plugin.json";

/// Env override for the app resource dir (dev: `src-tauri/resources`).
pub const ENV_RESOURCE_DIR: &str = "QUADFLOW_RESOURCE_DIR";

/// Top-level CLI names plugins may not take (§3.2).
pub const RESERVED_CLI_NAMES: &[&str] = &[
    "gui", "init", "doctor", "docs", "context", "plugins", "ideas", "issues", "labels", "epics", "plans",
    "discovery", "scripts", "ship", "chat", "missions", "import-v1", "help", "version",
];

/// `PLUGIN_API_VERSION` parsed.
pub fn host_api_version() -> semver::Version {
    semver::Version::parse(PLUGIN_API_VERSION).expect("PLUGIN_API_VERSION is valid semver")
}

/// The apiVersion rule (§4.2): `apiVersion` parses as a semver requirement that
/// matches `host` **and** its major (every lower-bound/exact comparator) is the host's major. `Err` = the
/// reason the plugin is incompatible (or unparseable).
pub fn check_api_version(api_version: &str, host: &semver::Version) -> Result<(), String> {
    let req = semver::VersionReq::parse(api_version.trim())
        .map_err(|e| format!("apiVersion {api_version:?} is not a semver range: {e}"))?;
    // The requirement's major = the major of its lower-bound / exact comparators
    // (`<2.0.0`-style upper bounds don't name a major).
    use semver::Op;
    let lower: Vec<&semver::Comparator> =
        req.comparators.iter().filter(|c| !matches!(c.op, Op::Less | Op::LessEq)).collect();
    if lower.is_empty() {
        return Err(format!("apiVersion {api_version:?} must name a major version (host implements {}.x)", host.major));
    }
    if let Some(c) = lower.iter().find(|c| c.major != host.major) {
        return Err(format!(
            "apiVersion {api_version:?} targets plugin API major {} but this QuadFlow implements major {}",
            c.major, host.major
        ));
    }
    if !req.matches(host) {
        return Err(format!("apiVersion {api_version:?} is not satisfied by plugin API {host}"));
    }
    Ok(())
}

/// Operating systems a manifest can list (§3.2 `platforms`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Windows,
    Macos,
    Linux,
}

impl Platform {
    /// The OS this binary was built for (`None` on other OSes).
    pub fn current() -> Option<Platform> {
        if cfg!(windows) {
            Some(Platform::Windows)
        } else if cfg!(target_os = "macos") {
            Some(Platform::Macos)
        } else if cfg!(target_os = "linux") {
            Some(Platform::Linux)
        } else {
            None
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Platform::Windows => "windows",
            Platform::Macos => "macos",
            Platform::Linux => "linux",
        }
    }
}

/// `<os>-<arch>` key used by `binaries` maps, e.g. `windows-x86_64`.
pub fn current_target() -> Option<String> {
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        _ => return None,
    };
    Platform::current().map(|p| format!("{}-{arch}", p.as_str()))
}

/// App resource dir (§4.1): `QUADFLOW_RESOURCE_DIR` if set; else derived from the
/// executable (Windows/Linux `<exe dir>/resources`, macOS `<exe>/../Resources`).
/// Debug builds fall back to `src-tauri/resources` of this checkout when the
/// derived dir has no `plugins/` folder.
pub fn resource_dir(env_override: Option<&str>) -> Option<PathBuf> {
    if let Some(dir) = env_override.filter(|d| !d.trim().is_empty()) {
        return Some(PathBuf::from(dir));
    }
    let derived = std::env::current_exe().ok().and_then(|exe| {
        let dir = exe.parent()?.to_path_buf();
        Some(if cfg!(target_os = "macos") { dir.join("../Resources") } else { dir.join("resources") })
    });
    if cfg!(debug_assertions) && !derived.as_ref().is_some_and(|d| d.join("plugins").is_dir()) {
        let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../resources");
        if dev.is_dir() {
            return Some(dev);
        }
    }
    derived
}

/// Is `id` a bare (official) id — no publisher prefix?
pub fn is_bare_id(id: &str) -> bool {
    !id.contains('.')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> semver::Version {
        semver::Version::parse(s).unwrap()
    }

    #[test]
    fn api_version_rule() {
        let host = v("1.2.0");
        assert!(check_api_version("^1.0.0", &host).is_ok());
        assert!(check_api_version("^1.2.0", &host).is_ok());
        assert!(check_api_version("1", &host).is_ok());
        assert!(check_api_version(">=1.0.0, <2.0.0", &host).is_ok());
        // Newer minor than the host implements.
        assert!(check_api_version("^1.3.0", &host).unwrap_err().contains("not satisfied"));
        // Other majors, even when the range would match.
        assert!(check_api_version("^2.0.0", &host).unwrap_err().contains("major 2"));
        assert!(check_api_version(">=0.5.0", &host).unwrap_err().contains("major 0"));
        // No major at all.
        assert!(check_api_version("*", &host).is_err());
        assert!(check_api_version("<2.0.0", &host).is_err());
        // Garbage.
        assert!(check_api_version("one point oh", &host).unwrap_err().contains("not a semver range"));
        // The constant itself is valid and self-compatible.
        assert!(check_api_version(&format!("^{PLUGIN_API_VERSION}"), &host_api_version()).is_ok());
    }

    #[test]
    fn current_platform_and_target() {
        let p = Platform::current().expect("supported test OS");
        let t = current_target().expect("supported arch");
        assert!(t.starts_with(p.as_str()));
    }

    #[test]
    fn resource_dir_override_wins() {
        assert_eq!(resource_dir(Some("/x/res")), Some(PathBuf::from("/x/res")));
        assert!(resource_dir(None).is_some());
    }
}
