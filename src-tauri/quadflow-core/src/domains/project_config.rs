//! `ProjectConfig` — `.quadflow/config.json`, the project marker (data-layer.md §6.1).

use crate::error::{CoreError, Result};
use crate::events::{ChangeKind, Domain, EventBus};
use crate::model::Actor;
use crate::paths::{Profile, ProjectRoot};
use crate::store::{atomic_write, atomic_write_json, ProjectStore, Singleton};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::OnceLock;

pub const FORMAT_VERSION: u32 = 1;
pub const GITIGNORE: &str = "local/\n.lock\n.*.tmp\n";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfig {
    /// `1`. Higher → `incompatible`.
    pub format_version: u32,
    /// Display name, default = folder name.
    pub name: String,
    /// Issue ref prefix, `^[A-Z][A-Z0-9]{1,7}$`.
    pub code: String,
    #[serde(default)]
    pub agent_context: AgentContextConfig,
    /// Plugin ids suggested to collaborators.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recommended_plugins: Vec<String>,
    /// Per-plugin shared project settings.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[specta(type = BTreeMap<String, crate::model::JsonValue>)]
    pub plugins: BTreeMap<String, serde_json::Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentContextConfig {
    /// Enabled context module ids, e.g. `["issues","plans"]`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modules: Vec<String>,
    /// Context files to manage, e.g. `["AGENTS.md"]` (each provider's `contextFile`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
}

impl Default for ProjectConfig {
    fn default() -> Self {
        Self {
            format_version: FORMAT_VERSION,
            name: String::new(),
            code: "PRJ".into(),
            agent_context: AgentContextConfig::default(),
            recommended_plugins: Vec::new(),
            plugins: BTreeMap::new(),
        }
    }
}

impl Singleton for ProjectConfig {
    const DOMAIN: Domain = Domain::ProjectConfig;
    const FILE: &'static str = "config.json";
}

/// Patch: absent = unchanged.
#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfigPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_context: Option<AgentContextConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommended_plugins: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<BTreeMap<String, crate::model::JsonValue>>)]
    pub plugins: Option<BTreeMap<String, serde_json::Value>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InitOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

fn code_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Z][A-Z0-9]{1,7}$").unwrap())
}

pub fn validate_code(code: &str) -> Result<()> {
    if code_re().is_match(code) {
        Ok(())
    } else {
        Err(CoreError::invalid_input(format!(
            "invalid project code {code:?}: expected 2-8 uppercase letters/digits starting with a letter"
        )))
    }
}

/// Folder name → code: alphanumerics, uppercased, first 3 chars; `"PRJ"` if that
/// isn't a valid code (fewer than 2 alphanumerics, or starts with a digit).
pub fn derive_code(folder_name: &str) -> String {
    let code: String = folder_name.chars().filter(|c| c.is_ascii_alphanumeric()).take(3).collect::<String>().to_uppercase();
    if validate_code(&code).is_ok() {
        code
    } else {
        "PRJ".into()
    }
}

fn validate(cfg: &ProjectConfig, path: &Path) -> Result<()> {
    if cfg.format_version > FORMAT_VERSION {
        return Err(CoreError::incompatible(format!(
            "{} has formatVersion {} (this build supports {FORMAT_VERSION}); update QuadFlow",
            path.display(),
            cfg.format_version
        )));
    }
    Ok(())
}

/// Initialize `path` as a project in the current profile.
pub fn init(path: &Path, opts: InitOptions, bus: EventBus) -> Result<ProjectStore> {
    init_with(path, Profile::current(), opts, bus)
}

/// Creates `config.json`, `.gitignore` and `local/`. Fails with `conflict` if
/// the directory already is a project.
pub fn init_with(path: &Path, profile: Profile, opts: InitOptions, bus: EventBus) -> Result<ProjectStore> {
    let root = ProjectRoot::at(path, profile)?;
    if root.config_path().exists() {
        return Err(CoreError::conflict(format!("{} is already a QuadFlow project", root.path.display())));
    }
    let folder = root.path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let code = match opts.code {
        Some(c) => {
            let c = c.trim().to_uppercase();
            validate_code(&c)?;
            c
        }
        None => derive_code(&folder),
    };
    let name = opts.name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| folder.clone());
    let cfg = ProjectConfig { name, code, ..ProjectConfig::default() };

    let dir = root.data_dir();
    let local = dir.join("local");
    std::fs::create_dir_all(&local).map_err(|e| CoreError::io(&local, e))?;
    atomic_write(&dir.join(".gitignore"), GITIGNORE.as_bytes())?;
    // config.json last: it is the marker that makes this a project.
    atomic_write_json(&root.config_path(), &cfg)?;
    let store = ProjectStore::new_unchecked(root, bus);
    store.recent_writes().record_write(&store.root().config_path());
    store.bus().emit(
        crate::events::ChangeScope::Project { root_key: store.root().key.clone() },
        Domain::ProjectConfig,
        ChangeKind::Created,
        vec![],
        crate::events::Origin::Local,
    );
    Ok(store)
}

/// Open the project at `path`, initializing it first if it isn't one yet.
pub fn open_or_init(path: &Path, profile: Profile, bus: EventBus) -> Result<ProjectStore> {
    match ProjectRoot::open_with(path, profile) {
        Ok(root) => ProjectStore::open(root, bus),
        Err(e) if e.code == crate::error::ErrorCode::ProjectNotFound && path.is_dir() => {
            match init_with(path, profile, InitOptions::default(), bus.clone()) {
                Ok(s) => Ok(s),
                // Lost an init race with another process: just open.
                Err(e) if e.code == crate::error::ErrorCode::Conflict => {
                    ProjectStore::open(ProjectRoot::open_with(path, profile)?, bus)
                }
                Err(e) => Err(e),
            }
        }
        Err(e) => Err(e),
    }
}

pub fn read(store: &ProjectStore) -> Result<ProjectConfig> {
    let cfg: ProjectConfig = store.read_singleton()?;
    validate(&cfg, &store.root().config_path())?;
    Ok(cfg)
}

pub fn update(store: &ProjectStore, actor: &Actor, patch: ProjectConfigPatch) -> Result<ProjectConfig> {
    if let Some(code) = &patch.code {
        validate_code(code)?;
    }
    if let Some(name) = &patch.name {
        if name.trim().is_empty() {
            return Err(CoreError::invalid_input("project name must not be empty"));
        }
    }
    let path = store.root().config_path();
    store.write(actor, |tx| {
        let current: ProjectConfig = tx.read_singleton()?;
        validate(&current, &path)?;
        tx.update_singleton::<ProjectConfig>(|c| {
            if let Some(v) = patch.name {
                c.name = v;
            }
            if let Some(v) = patch.code {
                c.code = v;
            }
            if let Some(v) = patch.agent_context {
                c.agent_context = v;
            }
            if let Some(v) = patch.recommended_plugins {
                c.recommended_plugins = v;
            }
            if let Some(v) = patch.plugins {
                c.plugins = v;
            }
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    #[test]
    fn derive_codes() {
        assert_eq!(derive_code("my-app"), "MYA");
        assert_eq!(derive_code("QuadFlow"), "QUA");
        assert_eq!(derive_code("ab"), "AB");
        assert_eq!(derive_code("x"), "PRJ");
        assert_eq!(derive_code("3dapp"), "PRJ");
        assert_eq!(derive_code("---"), "PRJ");
        assert!(validate_code("QC").is_ok());
        assert!(validate_code("qc").is_err());
        assert!(validate_code("ABCDEFGHI").is_err());
    }

    #[test]
    fn init_read_update() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("web-api");
        std::fs::create_dir(&dir).unwrap();
        let store = init_with(&dir, Profile::Dev, InitOptions::default(), EventBus::new()).unwrap();
        let data = dir.join(".quadflow-dev");
        assert!(data.join("config.json").is_file());
        assert_eq!(std::fs::read_to_string(data.join(".gitignore")).unwrap(), GITIGNORE);
        assert!(data.join("local").is_dir());
        assert!(!dir.join(".quadflow").exists(), "dev profile must not create .quadflow/");

        let cfg = read(&store).unwrap();
        assert_eq!(cfg.name, "web-api");
        assert_eq!(cfg.code, "WEB");
        let raw: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(data.join("config.json")).unwrap()).unwrap();
        assert_eq!(raw["formatVersion"], 1);

        let e = init_with(&dir, Profile::Dev, InitOptions::default(), EventBus::new()).err().unwrap();
        assert_eq!(e.code, ErrorCode::Conflict);

        let cfg = update(&store, &Actor::system(), ProjectConfigPatch { code: Some("API".into()), ..Default::default() }).unwrap();
        assert_eq!(cfg.code, "API");
        let e = update(&store, &Actor::system(), ProjectConfigPatch { code: Some("bad".into()), ..Default::default() }).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidInput);

        std::fs::write(data.join("config.json"), r#"{"formatVersion":2,"name":"x","code":"XX"}"#).unwrap();
        assert_eq!(read(&store).unwrap_err().code, ErrorCode::Incompatible);
    }

    #[test]
    fn open_or_init_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let a = open_or_init(tmp.path(), Profile::Dev, EventBus::new()).unwrap();
        let b = open_or_init(tmp.path(), Profile::Dev, EventBus::new()).unwrap();
        assert_eq!(a.root(), b.root());
    }
}
