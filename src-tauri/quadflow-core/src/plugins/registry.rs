//! Plugin registry (plugin-system.md §4): discovery in the three origins,
//! resolution, status rules, persisted state (`plugins` table) and the flattened
//! contributions of active plugins.
//!
//! The registry is a snapshot: [`PluginRegistry::load`] rebuilds it from disk +
//! the app DB. Mutations (`set_enabled`, `grant`) write the DB; callers reload.

use super::manifest::{
    validate_dir, AgentContextDoc, Author, Category, CliCommand, Command, ContextMenu, Manifest, ManifestIssue,
    PaletteProviderSpec, SettingsPage, Tile, TitleGeneratorSpec, ToolbarItem, ValidateOptions, ValidationReport,
};
use super::permissions::{self, Permission, Risk};
use super::{host_api_version, is_bare_id, resource_dir, schema, Platform, ENV_RESOURCE_DIR, MANIFEST_FILE};
use crate::error::{CoreError, Result};
use crate::events::{ChangeKind, Domain};
use crate::paths::AppPaths;
use crate::store::{AppChange, AppDb};
use crate::time::now_ms;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// Settings namespace / keys read by the registry (§4.1, §8.1).
pub const SETTINGS_NAMESPACE: &str = "plugins";
pub const SETTING_DEV_PATHS: &str = "devPaths";
pub const SETTING_DEV_TRUSTED: &str = "devTrusted";

/// Build-time facts about a *bundled* copy, written next to its manifest by
/// `scripts/bundle-plugins.mjs` (a property of this repo's build, never of the
/// plugin: it is ignored for installed and dev plugins). The only key is
/// `{"isolation": "sandboxed"}`, which runs a bundled plugin sandboxed — trust
/// can only be lowered (used by the `hello-sandboxed` example, PL-6).
pub const BUNDLE_INFO_FILE: &str = "quadflow-bundle.json";

/// Does the bundled copy at `root` ask to run sandboxed ([`BUNDLE_INFO_FILE`])?
fn bundled_sandboxed(root: &Path) -> bool {
    std::fs::read(root.join(BUNDLE_INFO_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .is_some_and(|v| v.get("isolation").and_then(Value::as_str) == Some("sandboxed"))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum PluginOrigin {
    Bundled,
    Installed,
    Dev,
}

impl PluginOrigin {
    pub fn as_str(self) -> &'static str {
        match self {
            PluginOrigin::Bundled => "bundled",
            PluginOrigin::Installed => "installed",
            PluginOrigin::Dev => "dev",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "bundled" => Some(Self::Bundled),
            "installed" => Some(Self::Installed),
            "dev" => Some(Self::Dev),
            _ => None,
        }
    }
}

/// Decided by the host, never by the manifest (§8.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum Isolation {
    Trusted,
    Sandboxed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PluginStatus {
    Active,
    Disabled,
    NeedsConsent,
    Incompatible { reason: String },
    Failed { reason: String },
    UnsupportedPlatform,
}

impl PluginStatus {
    /// Value of the `plugins.status` column.
    pub fn db_str(&self) -> &'static str {
        match self {
            PluginStatus::Active => "active",
            PluginStatus::Disabled => "disabled",
            PluginStatus::NeedsConsent => "needs_consent",
            PluginStatus::Incompatible { .. } => "incompatible",
            PluginStatus::Failed { .. } => "failed",
            PluginStatus::UnsupportedPlatform => "unsupported_platform",
        }
    }
    pub fn detail(&self) -> Option<&str> {
        match self {
            PluginStatus::Incompatible { reason } | PluginStatus::Failed { reason } => Some(reason),
            _ => None,
        }
    }
    pub fn label(&self) -> String {
        match self {
            PluginStatus::Active => "active".into(),
            PluginStatus::Disabled => "disabled".into(),
            PluginStatus::NeedsConsent => "needs consent".into(),
            PluginStatus::Incompatible { reason } => format!("incompatible: {reason}"),
            PluginStatus::Failed { reason } => format!("failed: {reason}"),
            PluginStatus::UnsupportedPlatform => "unsupported platform".into(),
        }
    }
}

/// A candidate that lost resolution to the winner of the same id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShadowedPlugin {
    pub origin: PluginOrigin,
    pub version: Option<String>,
    pub root: String,
}

#[derive(Clone, Debug)]
pub struct LoadedPlugin {
    pub id: String,
    /// Parsed + validated manifest; `None` when the manifest is unreadable or
    /// fails the schema (status is then `Failed`).
    pub manifest: Option<Manifest>,
    pub root: PathBuf,
    pub origin: PluginOrigin,
    pub isolation: Isolation,
    pub status: PluginStatus,
    pub enabled: bool,
    pub granted: BTreeSet<Permission>,
    pub errors: Vec<ManifestIssue>,
    pub warnings: Vec<ManifestIssue>,
    pub shadowed: Vec<ShadowedPlugin>,
}

impl LoadedPlugin {
    pub fn is_active(&self) -> bool {
        self.status == PluginStatus::Active
    }

    pub fn requested(&self) -> BTreeSet<Permission> {
        self.manifest.as_ref().map(Manifest::requested_permissions).unwrap_or_default()
    }

    pub fn missing_permissions(&self) -> BTreeSet<Permission> {
        permissions::missing(&self.requested(), &self.granted)
    }

    pub fn info(&self) -> PluginInfo {
        let m = self.manifest.as_ref();
        let requested = self.requested();
        let missing = self.missing_permissions();
        PluginInfo {
            id: self.id.clone(),
            name: m.map(|m| m.name.clone()).unwrap_or_else(|| self.id.clone()),
            version: m.map(|m| m.version.clone()),
            description: m.and_then(|m| m.description.clone()),
            author: m.and_then(|m| m.author.clone()),
            icon: m.and_then(|m| m.icon.clone()),
            category: m.and_then(|m| m.category),
            api_version: m.map(|m| m.api_version.clone()),
            platforms: m.map(|m| m.platforms.clone()).unwrap_or_default(),
            origin: self.origin,
            isolation: self.isolation,
            status: self.status.clone(),
            enabled: self.enabled,
            root: self.root.display().to_string(),
            permissions: requested
                .iter()
                .map(|p| PermissionInfo {
                    permission: p.clone(),
                    risk: p.risk(),
                    description: p.describe(),
                    granted: !missing.contains(p),
                })
                .collect(),
            granted_permissions: self.granted.iter().cloned().collect(),
            missing_permissions: missing.into_iter().collect(),
            errors: self.errors.clone(),
            warnings: self.warnings.clone(),
            shadowed: self.shadowed.clone(),
            manifest: self.manifest.clone(),
        }
    }
}

/// IPC / CLI view of a plugin.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: Option<String>,
    pub description: Option<String>,
    pub author: Option<Author>,
    pub icon: Option<String>,
    pub category: Option<Category>,
    pub api_version: Option<String>,
    pub platforms: Vec<Platform>,
    pub origin: PluginOrigin,
    pub isolation: Isolation,
    pub status: PluginStatus,
    pub enabled: bool,
    pub root: String,
    /// Requested permissions with risk, description and grant state.
    pub permissions: Vec<PermissionInfo>,
    pub granted_permissions: Vec<Permission>,
    pub missing_permissions: Vec<Permission>,
    pub errors: Vec<ManifestIssue>,
    pub warnings: Vec<ManifestIssue>,
    pub shadowed: Vec<ShadowedPlugin>,
    pub manifest: Option<Manifest>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PermissionInfo {
    pub permission: Permission,
    pub risk: Risk,
    pub description: String,
    pub granted: bool,
}

macro_rules! contribution {
    ($name:ident, $ty:ty) => {
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
        #[serde(rename_all = "camelCase")]
        pub struct $name {
            pub plugin_id: String,
            pub contribution: $ty,
        }
    };
}
contribution!(TileContribution, Tile);
contribution!(ToolbarItemContribution, ToolbarItem);
contribution!(CommandContribution, Command);
contribution!(ContextMenuContribution, ContextMenu);
contribution!(SettingsPageContribution, SettingsPage);
contribution!(CliCommandContribution, CliCommand);
contribution!(AgentContextDocContribution, AgentContextDoc);
contribution!(PaletteProviderContribution, PaletteProviderSpec);
contribution!(TitleGeneratorContribution, TitleGeneratorSpec);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonContribution {
    pub plugin_id: String,
    #[specta(type = crate::model::JsonValue)]
    pub contribution: Value,
}

/// Contributions of active plugins, flattened in plugin-id then manifest order.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Contributions {
    pub tiles: Vec<TileContribution>,
    pub toolbar_items: Vec<ToolbarItemContribution>,
    pub commands: Vec<CommandContribution>,
    pub context_menus: Vec<ContextMenuContribution>,
    pub settings_pages: Vec<SettingsPageContribution>,
    /// `contributes.settings` schemas.
    pub settings: Vec<JsonContribution>,
    pub cli_commands: Vec<CliCommandContribution>,
    pub agent_context_docs: Vec<AgentContextDocContribution>,
    pub palette_providers: Vec<PaletteProviderContribution>,
    pub title_generators: Vec<TitleGeneratorContribution>,
    pub agent_providers: Vec<JsonContribution>,
}

/// Where to look and what host to check against. `from_env` is what the GUI and
/// CLI use; tests set fields explicitly.
#[derive(Clone, Debug)]
pub struct LoadOptions {
    /// Dir containing `plugins/<id>/` of bundled plugins (`None` = no bundled plugins).
    pub resource_dir: Option<PathBuf>,
    /// Dev folders; `None` = read setting `plugins.devPaths`.
    pub dev_paths: Option<Vec<PathBuf>>,
    pub platform: Option<Platform>,
    pub target: Option<String>,
    pub host_api: semver::Version,
}

impl LoadOptions {
    /// `QUADFLOW_RESOURCE_DIR` (via `var`) or the executable-relative resource dir.
    pub fn from_env(var: impl Fn(&str) -> Option<String>) -> Self {
        Self {
            resource_dir: resource_dir(var(ENV_RESOURCE_DIR).as_deref()),
            dev_paths: None,
            platform: Platform::current(),
            target: super::current_target(),
            host_api: host_api_version(),
        }
    }

    fn validate_options(&self, allow_bare_id: bool) -> ValidateOptions {
        ValidateOptions { allow_bare_id, target: self.target.clone(), platform: self.platform }
    }
}

/// A `plugins` table row.
#[derive(Clone, Debug)]
struct PluginRow {
    origin: Option<PluginOrigin>,
    version: String,
    install_path: String,
    enabled: bool,
    status: String,
    status_detail: Option<String>,
    granted: BTreeSet<Permission>,
    granted_raw: String,
    from_builtin_source: bool,
}

struct Candidate {
    origin: PluginOrigin,
    root: PathBuf,
    report: ValidationReport,
    id: String,
}

pub struct PluginRegistry {
    plugins: BTreeMap<String, LoadedPlugin>,
}

impl PluginRegistry {
    /// bundled ∪ installed ∪ dev, with DB state applied (process environment).
    pub fn load(paths: &AppPaths, db: &AppDb) -> Result<Self> {
        Self::load_with(paths, db, &LoadOptions::from_env(|k| std::env::var(k).ok()))
    }

    pub fn load_with(paths: &AppPaths, db: &AppDb, opts: &LoadOptions) -> Result<Self> {
        let rows = read_rows(db)?;
        let dev_paths = match &opts.dev_paths {
            Some(p) => p.clone(),
            None => read_setting(db, SETTING_DEV_PATHS)?
                .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
                .unwrap_or_default()
                .into_iter()
                .map(PathBuf::from)
                .collect(),
        };
        let dev_trusted = read_setting(db, SETTING_DEV_TRUSTED)?.and_then(|v| v.as_bool()).unwrap_or(false);

        // ---- discovery ----
        let mut cands: Vec<Candidate> = Vec::new();
        if let Some(res) = &opts.resource_dir {
            for dir in subdirs(&res.join("plugins")) {
                if dir.join(MANIFEST_FILE).is_file() {
                    cands.push(candidate(PluginOrigin::Bundled, dir, opts, false));
                }
            }
        }
        let mut installed_seen = BTreeSet::new();
        for id_dir in subdirs(&paths.plugins_dir) {
            let Some(id) = dir_name(&id_dir) else { continue };
            if id.starts_with('.') {
                continue;
            }
            let row = rows.get(&id);
            let chosen = row
                .filter(|r| r.origin == Some(PluginOrigin::Installed))
                .map(|r| PathBuf::from(&r.install_path))
                .filter(|p| p.join(MANIFEST_FILE).is_file())
                .or_else(|| highest_version_dir(&id_dir));
            if let Some(dir) = chosen {
                let official = row.is_some_and(|r| r.from_builtin_source);
                let mut c = candidate(PluginOrigin::Installed, dir, opts, official);
                if c.report.manifest.as_ref().is_some_and(|m| m.id != id) {
                    let mid = c.report.manifest.as_ref().unwrap().id.clone();
                    c.report.errors.push(ManifestIssue::new("/id", format!("manifest id {mid:?} does not match install directory {id:?}")));
                }
                c.id = id.clone();
                installed_seen.insert(id);
                cands.push(c);
            }
        }
        for dir in &dev_paths {
            cands.push(candidate(PluginOrigin::Dev, dir.clone(), opts, false));
        }

        // Rows for installed plugins whose directory vanished.
        let mut missing_installed: Vec<(String, PathBuf)> = Vec::new();
        for (id, r) in &rows {
            if r.origin == Some(PluginOrigin::Installed) && !installed_seen.contains(id) {
                missing_installed.push((id.clone(), PathBuf::from(&r.install_path)));
            }
        }

        // ---- resolution: dev > installed (newer than bundled, valid, compatible) > bundled ----
        let mut by_id: BTreeMap<String, Vec<Candidate>> = BTreeMap::new();
        for c in cands {
            by_id.entry(c.id.clone()).or_default().push(c);
        }
        let mut plugins = BTreeMap::new();
        for (id, mut list) in by_id {
            let winner_idx = pick_winner(&list, opts);
            let winner = list.remove(winner_idx);
            let shadowed = list
                .iter()
                .map(|c| ShadowedPlugin {
                    origin: c.origin,
                    version: c.report.manifest.as_ref().map(|m| m.version.clone()),
                    root: c.root.display().to_string(),
                })
                .collect();
            let p = resolve(&id, winner, shadowed, rows.get(&id), opts, dev_trusted);
            plugins.insert(id, p);
        }
        for (id, root) in missing_installed {
            plugins.entry(id.clone()).or_insert_with(|| {
                let row = rows.get(&id);
                LoadedPlugin {
                    id: id.clone(),
                    manifest: None,
                    root,
                    origin: PluginOrigin::Installed,
                    isolation: Isolation::Sandboxed,
                    status: PluginStatus::Failed { reason: "install directory is missing".into() },
                    enabled: row.is_none_or(|r| r.enabled),
                    granted: row.map(|r| r.granted.clone()).unwrap_or_default(),
                    errors: vec![ManifestIssue::new("", "install directory is missing")],
                    warnings: vec![],
                    shadowed: vec![],
                }
            });
        }

        // ---- CLI name uniqueness across active plugins (first id wins) ----
        let mut cli_owner: BTreeMap<String, String> = BTreeMap::new();
        for p in plugins.values_mut() {
            if !p.is_active() {
                continue;
            }
            let names: Vec<String> = p
                .manifest
                .as_ref()
                .map(|m| m.contributes.cli_commands.iter().map(|c| c.name.clone()).collect())
                .unwrap_or_default();
            if let Some((name, owner)) = names.iter().find_map(|n| cli_owner.get(n).map(|o| (n.clone(), o.clone()))) {
                let reason = format!("CLI command {name:?} is already provided by plugin {owner:?}");
                p.errors.push(ManifestIssue::new("/contributes/cliCommands", reason.clone()));
                p.status = PluginStatus::Failed { reason };
            } else {
                for n in names {
                    cli_owner.insert(n, p.id.clone());
                }
            }
        }

        let reg = Self { plugins };
        reg.persist(db, &rows)?;
        Ok(reg)
    }

    pub fn get(&self, id: &str) -> Option<&LoadedPlugin> {
        self.plugins.get(id)
    }

    pub fn all(&self) -> impl Iterator<Item = &LoadedPlugin> {
        self.plugins.values()
    }

    pub fn active(&self) -> impl Iterator<Item = &LoadedPlugin> {
        self.plugins.values().filter(|p| p.is_active())
    }

    /// Infos; `UnsupportedPlatform` plugins only with `include_unsupported` ("Show incompatible").
    pub fn list(&self, include_unsupported: bool) -> Vec<PluginInfo> {
        self.plugins
            .values()
            .filter(|p| include_unsupported || p.status != PluginStatus::UnsupportedPlatform)
            .map(LoadedPlugin::info)
            .collect()
    }

    pub fn require(&self, id: &str) -> Result<&LoadedPlugin> {
        self.get(id).ok_or_else(|| CoreError::not_found(format!("plugin {id:?} is not installed")))
    }

    pub fn contributions(&self) -> Contributions {
        let mut c = Contributions::default();
        for p in self.active() {
            let Some(m) = &p.manifest else { continue };
            let k = &m.contributes;
            let pid = || p.id.clone();
            c.tiles.extend(k.tiles.iter().map(|x| TileContribution { plugin_id: pid(), contribution: x.clone() }));
            c.toolbar_items
                .extend(k.toolbar_items.iter().map(|x| ToolbarItemContribution { plugin_id: pid(), contribution: x.clone() }));
            c.commands.extend(k.commands.iter().map(|x| CommandContribution { plugin_id: pid(), contribution: x.clone() }));
            c.context_menus
                .extend(k.context_menus.iter().map(|x| ContextMenuContribution { plugin_id: pid(), contribution: x.clone() }));
            c.settings_pages
                .extend(k.settings_pages.iter().map(|x| SettingsPageContribution { plugin_id: pid(), contribution: x.clone() }));
            if let Some(s) = &k.settings {
                c.settings.push(JsonContribution { plugin_id: pid(), contribution: s.clone() });
            }
            c.cli_commands
                .extend(k.cli_commands.iter().map(|x| CliCommandContribution { plugin_id: pid(), contribution: x.clone() }));
            c.agent_context_docs.extend(
                k.agent_context_docs.iter().map(|x| AgentContextDocContribution { plugin_id: pid(), contribution: x.clone() }),
            );
            c.palette_providers.extend(
                k.palette_providers.iter().map(|x| PaletteProviderContribution { plugin_id: pid(), contribution: x.clone() }),
            );
            c.title_generators.extend(
                k.title_generators.iter().map(|x| TitleGeneratorContribution { plugin_id: pid(), contribution: x.clone() }),
            );
            if let Some(a) = &k.agent_provider {
                c.agent_providers.push(JsonContribution { plugin_id: pid(), contribution: a.clone() });
            }
        }
        c
    }

    /// Persist `enabled` for a known plugin.
    pub fn set_enabled(&self, db: &AppDb, id: &str, enabled: bool) -> Result<()> {
        let p = self.require(id)?;
        let now = now_ms();
        db.write(&[AppChange::new(Domain::Plugins, ChangeKind::Updated, Some(id))], |tx| {
            tx.execute(
                "INSERT INTO plugins (id, origin, version, install_path, enabled, status, status_detail, granted_permissions, installed_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
                 ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at",
                rusqlite::params![
                    id,
                    p.origin.as_str(),
                    p.manifest.as_ref().map(|m| m.version.as_str()).unwrap_or("0.0.0"),
                    p.root.display().to_string(),
                    enabled as i64,
                    p.status.db_str(),
                    p.status.detail(),
                    perms_json(&p.granted),
                    now
                ],
            )
        })?;
        Ok(())
    }

    /// Set the granted permissions of a non-bundled plugin to exactly `perms`
    /// (consent / revoke). Each must be declared by the manifest; sandboxed
    /// plugins can never hold `native:*`, `terminal:io`, `fs:*:any`.
    pub fn grant(&self, db: &AppDb, id: &str, perms: &[String]) -> Result<()> {
        let p = self.require(id)?;
        if p.origin == PluginOrigin::Bundled {
            return Err(CoreError::invalid_input("bundled plugins' permissions are granted automatically"));
        }
        let Some(m) = &p.manifest else {
            return Err(CoreError::invalid_input(format!("plugin {id:?} has no valid manifest")));
        };
        let requested = m.requested_permissions();
        let mut set = BTreeSet::new();
        for s in perms {
            let perm = Permission::parse(s).map_err(CoreError::invalid_input)?;
            if !requested.contains(&perm) {
                return Err(CoreError::invalid_input(format!("plugin {id:?} does not declare permission {perm}")));
            }
            if p.isolation == Isolation::Sandboxed && perm.forbidden_for_sandbox() {
                return Err(CoreError::permission_denied(format!("sandboxed plugins may not hold {perm}")));
            }
            set.insert(perm);
        }
        let now = now_ms();
        db.write(&[AppChange::new(Domain::Plugins, ChangeKind::Updated, Some(id))], |tx| {
            tx.execute(
                "INSERT INTO plugins (id, origin, version, install_path, enabled, status, status_detail, granted_permissions, installed_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, ?8, ?8)
                 ON CONFLICT(id) DO UPDATE SET granted_permissions = excluded.granted_permissions, updated_at = excluded.updated_at",
                rusqlite::params![
                    id,
                    p.origin.as_str(),
                    m.version,
                    p.root.display().to_string(),
                    p.status.db_str(),
                    p.status.detail(),
                    perms_json(&set),
                    now
                ],
            )
        })?;
        Ok(())
    }

    /// Write back first-load bundled grants and changed statuses (only rows that differ).
    fn persist(&self, db: &AppDb, rows: &BTreeMap<String, PluginRow>) -> Result<()> {
        struct W {
            id: String,
            insert: bool,
            origin: &'static str,
            version: String,
            root: String,
            status: &'static str,
            detail: Option<String>,
            granted: String,
        }
        let mut writes = Vec::new();
        for p in self.plugins.values() {
            let granted = perms_json(&p.granted);
            let version = p.manifest.as_ref().map(|m| m.version.clone());
            match rows.get(&p.id) {
                None if p.origin == PluginOrigin::Bundled && p.manifest.is_some() => writes.push(W {
                    id: p.id.clone(),
                    insert: true,
                    origin: p.origin.as_str(),
                    version: version.unwrap_or_default(),
                    root: p.root.display().to_string(),
                    status: p.status.db_str(),
                    detail: p.status.detail().map(str::to_string),
                    granted,
                }),
                None => {}
                Some(r) => {
                    let bundled_grant_changed = p.origin == PluginOrigin::Bundled && r.granted_raw != granted;
                    let status_changed = r.status != p.status.db_str() || r.status_detail.as_deref() != p.status.detail();
                    let version_changed = p.origin == PluginOrigin::Bundled
                        && r.origin == Some(PluginOrigin::Bundled)
                        && version.as_ref().is_some_and(|v| *v != r.version);
                    if bundled_grant_changed || status_changed || version_changed {
                        writes.push(W {
                            id: p.id.clone(),
                            insert: false,
                            origin: p.origin.as_str(),
                            version: if version_changed { version.unwrap_or_default() } else { r.version.clone() },
                            root: r.install_path.clone(),
                            status: p.status.db_str(),
                            detail: p.status.detail().map(str::to_string),
                            granted: if p.origin == PluginOrigin::Bundled { granted } else { r.granted_raw.clone() },
                        });
                    }
                }
            }
        }
        if writes.is_empty() {
            return Ok(());
        }
        let changes: Vec<AppChange> =
            writes.iter().map(|w| AppChange::new(Domain::Plugins, ChangeKind::Updated, Some(w.id.clone()))).collect();
        let now = now_ms();
        db.write(&changes, |tx| {
            for w in &writes {
                if w.insert {
                    tx.execute(
                        "INSERT INTO plugins (id, origin, version, install_path, enabled, status, status_detail, granted_permissions, installed_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, ?8, ?8)
                         ON CONFLICT(id) DO NOTHING", // a concurrent load (GUI/CLI) inserted the same first-seen row
                        rusqlite::params![w.id, w.origin, w.version, w.root, w.status, w.detail, w.granted, now],
                    )?;
                } else {
                    tx.execute(
                        "UPDATE plugins SET version = ?2, status = ?3, status_detail = ?4, granted_permissions = ?5, updated_at = ?6 WHERE id = ?1",
                        rusqlite::params![w.id, w.version, w.status, w.detail, w.granted, now],
                    )?;
                }
            }
            Ok(())
        })?;
        Ok(())
    }
}

/// Validate a plugin folder as the registry would for `origin` (CLI `plugins validate`).
/// `official_source`: installed from the built-in source (bare ids allowed).
pub fn validate_plugin_dir(dir: &Path, origin: PluginOrigin, official_source: bool, opts: &LoadOptions) -> ValidationReport {
    candidate(origin, dir.to_path_buf(), opts, official_source).report
}

fn candidate(origin: PluginOrigin, root: PathBuf, opts: &LoadOptions, official_source: bool) -> Candidate {
    let mut report = validate_dir(&root, &opts.validate_options(true));
    if let Some(m) = &report.manifest {
        if is_bare_id(&m.id) && !bare_id_allowed(origin, &root, &m.id, official_source) {
            report.errors.push(ManifestIssue::new(
                "/id",
                format!(
                    "bare id {:?} is reserved for official plugins (bundled, official source, or plugins/{} in a QuadFlow checkout); use \"<publisher>.{}\"",
                    m.id, m.id, m.id
                ),
            ));
        }
    }
    let id = report
        .manifest
        .as_ref()
        .map(|m| m.id.clone())
        .or_else(|| report.raw_id.clone().filter(|i| schema::manifest_id_pattern().is_match(i)))
        .or_else(|| dir_name(&root))
        .unwrap_or_else(|| root.display().to_string());
    Candidate { origin, root, report, id }
}

fn bare_id_allowed(origin: PluginOrigin, root: &Path, id: &str, official_source: bool) -> bool {
    match origin {
        PluginOrigin::Bundled => true,
        PluginOrigin::Installed => official_source,
        PluginOrigin::Dev => first_party_checkout_dir(root, id),
    }
}

/// `<checkout>/plugins/<id>` where `<checkout>/packages/plugin-api` exists (§8.1).
pub fn first_party_checkout_dir(root: &Path, id: &str) -> bool {
    let root = dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let named = dir_name(&root).as_deref() == Some(id);
    let parent = root.parent();
    let in_plugins = parent.and_then(dir_name).as_deref() == Some("plugins");
    let checkout = parent.and_then(Path::parent).is_some_and(|c| c.join("packages").join("plugin-api").is_dir());
    named && in_plugins && checkout
}

fn pick_winner(list: &[Candidate], opts: &LoadOptions) -> usize {
    if let Some(i) = list.iter().position(|c| c.origin == PluginOrigin::Dev) {
        return i;
    }
    let bundled = list.iter().position(|c| c.origin == PluginOrigin::Bundled);
    let installed = list.iter().position(|c| c.origin == PluginOrigin::Installed);
    match (installed, bundled) {
        (Some(i), None) => i,
        (None, Some(b)) => b,
        (Some(i), Some(b)) => {
            let usable = |c: &Candidate| {
                c.report.is_valid() && c.report.manifest.as_ref().is_some_and(|m| m.api_compat(&opts.host_api).is_ok())
            };
            let ver = |c: &Candidate| c.report.manifest.as_ref().and_then(Manifest::parsed_version);
            let newer = match (ver(&list[i]), ver(&list[b])) {
                (Some(iv), Some(bv)) => iv > bv,
                (Some(_), None) => true,
                _ => false,
            };
            if usable(&list[i]) && (newer || !list[b].report.is_valid()) {
                i
            } else {
                b
            }
        }
        (None, None) => 0,
    }
}

fn resolve(
    id: &str,
    c: Candidate,
    shadowed: Vec<ShadowedPlugin>,
    row: Option<&PluginRow>,
    opts: &LoadOptions,
    dev_trusted: bool,
) -> LoadedPlugin {
    let enabled = row.is_none_or(|r| r.enabled);
    let isolation = match c.origin {
        PluginOrigin::Bundled if bundled_sandboxed(&c.root) => Isolation::Sandboxed,
        PluginOrigin::Bundled => Isolation::Trusted,
        PluginOrigin::Installed if is_bare_id(id) && row.is_some_and(|r| r.from_builtin_source) => Isolation::Trusted,
        PluginOrigin::Installed => Isolation::Sandboxed,
        PluginOrigin::Dev if dev_trusted && first_party_checkout_dir(&c.root, id) => Isolation::Trusted,
        PluginOrigin::Dev => Isolation::Sandboxed,
    };
    let mut errors = c.report.errors.clone();
    let requested = c.report.manifest.as_ref().map(Manifest::requested_permissions).unwrap_or_default();
    // Bundled: auto-granted. Others: stored grants, restricted to what is still
    // declared (removed permissions are revoked automatically, §11.2).
    let granted: BTreeSet<Permission> = if c.origin == PluginOrigin::Bundled {
        requested.clone()
    } else {
        row.map(|r| r.granted.iter().filter(|g| requested.iter().any(|q| g.satisfies(q))).cloned().collect())
            .unwrap_or_default()
    };

    let status = match &c.report.manifest {
        _ if !errors.is_empty() || c.report.manifest.is_none() => {
            PluginStatus::Failed { reason: summary(&errors).unwrap_or_else(|| "invalid manifest".into()) }
        }
        Some(m) => {
            let forbidden: Vec<String> = if isolation == Isolation::Sandboxed {
                requested.iter().filter(|p| p.forbidden_for_sandbox()).map(|p| p.to_string()).collect()
            } else {
                vec![]
            };
            if !opts.platform.is_some_and(|p| m.supports(p)) {
                PluginStatus::UnsupportedPlatform
            } else if let Err(reason) = m.api_compat(&opts.host_api) {
                PluginStatus::Incompatible { reason }
            } else if !forbidden.is_empty() {
                let reason = format!("sandboxed plugins may not hold {}", forbidden.join(", "));
                errors.push(ManifestIssue::new("/permissions", reason.clone()));
                PluginStatus::Failed { reason }
            } else if !enabled {
                PluginStatus::Disabled
            } else if !permissions::missing(&requested, &granted).is_empty() {
                PluginStatus::NeedsConsent
            } else {
                PluginStatus::Active
            }
        }
        None => unreachable!(),
    };
    LoadedPlugin {
        id: id.to_string(),
        manifest: c.report.manifest,
        root: c.root,
        origin: c.origin,
        isolation,
        status,
        enabled,
        granted,
        errors,
        warnings: c.report.warnings,
        shadowed,
    }
}

fn summary(errors: &[ManifestIssue]) -> Option<String> {
    match errors.len() {
        0 => None,
        1 => Some(errors[0].to_string()),
        n => Some(format!("{} (and {} more)", errors[0], n - 1)),
    }
}

fn perms_json(p: &BTreeSet<Permission>) -> String {
    serde_json::to_string(&p.iter().map(Permission::as_str).collect::<Vec<_>>()).unwrap_or_else(|_| "[]".into())
}

fn read_rows(db: &AppDb) -> Result<BTreeMap<String, PluginRow>> {
    db.read(|c| {
        let mut stmt = c.prepare(
            "SELECT p.id, p.origin, p.version, p.install_path, p.enabled, p.status, p.status_detail, p.granted_permissions,
                    COALESCE(s.builtin, 0)
             FROM plugins p LEFT JOIN plugin_sources s ON s.id = p.source_id",
        )?;
        let rows = stmt.query_map([], |r| {
            let granted_raw: String = r.get(7)?;
            let granted = serde_json::from_str::<Vec<String>>(&granted_raw)
                .unwrap_or_default()
                .iter()
                .filter_map(|s| Permission::parse(s).ok())
                .collect();
            Ok((
                r.get::<_, String>(0)?,
                PluginRow {
                    origin: PluginOrigin::parse(&r.get::<_, String>(1)?),
                    version: r.get(2)?,
                    install_path: r.get(3)?,
                    enabled: r.get::<_, i64>(4)? != 0,
                    status: r.get(5)?,
                    status_detail: r.get(6)?,
                    granted,
                    granted_raw,
                    from_builtin_source: r.get::<_, i64>(8)? != 0,
                },
            ))
        })?;
        rows.collect()
    })
}

/// A `plugins.*` setting (JSON value), if set.
fn read_setting(db: &AppDb, key: &str) -> Result<Option<Value>> {
    let raw: Option<String> = db.read(|c| {
        c.query_row(
            "SELECT value FROM settings WHERE namespace = ?1 AND key = ?2",
            rusqlite::params![SETTINGS_NAMESPACE, key],
            |r| r.get(0),
        )
        .optional()
    })?;
    Ok(raw.and_then(|s| serde_json::from_str(&s).ok()))
}

fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_dir()).collect())
        .unwrap_or_default();
    out.sort();
    out
}

fn dir_name(p: &Path) -> Option<String> {
    p.file_name().map(|n| n.to_string_lossy().to_string())
}

/// `<plugins_dir>/<id>/<version>/` with the highest semver name (staging / download dirs skipped).
fn highest_version_dir(id_dir: &Path) -> Option<PathBuf> {
    subdirs(id_dir)
        .into_iter()
        .filter_map(|d| {
            let v = semver::Version::parse(&dir_name(&d)?).ok()?;
            d.join(MANIFEST_FILE).is_file().then_some((v, d))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, d)| d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempApp;
    use serde_json::json;

    struct Env {
        app: TempApp,
        res: tempfile::TempDir,
        dev: tempfile::TempDir,
    }

    impl Env {
        fn new() -> Self {
            Self { app: TempApp::new(), res: tempfile::tempdir().unwrap(), dev: tempfile::tempdir().unwrap() }
        }
        fn opts(&self) -> LoadOptions {
            LoadOptions {
                resource_dir: Some(self.res.path().to_path_buf()),
                dev_paths: None,
                platform: Platform::current(),
                target: crate::plugins::current_target(),
                host_api: semver::Version::parse("1.2.0").unwrap(),
            }
        }
        fn load(&self) -> PluginRegistry {
            PluginRegistry::load_with(&self.app.paths, &self.app.db, &self.opts()).unwrap()
        }
        fn load_dev(&self, dev: Vec<PathBuf>) -> PluginRegistry {
            let mut o = self.opts();
            o.dev_paths = Some(dev);
            PluginRegistry::load_with(&self.app.paths, &self.app.db, &o).unwrap()
        }
        fn bundled(&self, id: &str, extra: Value) -> PathBuf {
            write_plugin(&self.res.path().join("plugins").join(id), id, extra)
        }
        fn installed(&self, id: &str, version: &str, extra: Value) -> PathBuf {
            let mut e = extra;
            e["version"] = json!(version);
            write_plugin(&self.app.paths.plugins_dir.join(id).join(version), id, e)
        }
    }

    fn manifest(id: &str, extra: Value) -> Value {
        let mut v = json!({
            "id": id, "name": id, "version": "1.0.0", "apiVersion": "^1.0.0",
            "platforms": ["windows", "macos", "linux"],
        });
        for (k, val) in extra.as_object().cloned().unwrap_or_default() {
            v[k] = val;
        }
        v
    }

    fn write_plugin(dir: &Path, id: &str, extra: Value) -> PathBuf {
        std::fs::create_dir_all(dir.join("dist")).unwrap();
        std::fs::write(dir.join("dist/index.js"), "export default {}").unwrap();
        std::fs::write(dir.join(MANIFEST_FILE), serde_json::to_string_pretty(&manifest(id, extra)).unwrap()).unwrap();
        dir.to_path_buf()
    }

    fn status(reg: &PluginRegistry, id: &str) -> PluginStatus {
        reg.get(id).unwrap_or_else(|| panic!("{id} not loaded")).status.clone()
    }

    /// Live reload (§12.4): disabling, re-enabling and removing a plugin show up in the diff.
    #[test]
    fn fingerprints_follow_enable_disable_and_removal() {
        let env = Env::new();
        let root = env.bundled("p1", json!({}));
        env.bundled("p2", json!({}));
        let first = env.load().fingerprints();
        assert!(first["p1"].active && first["p1"].version.as_deref() == Some("1.0.0"));
        assert!(first["p1"].root.ends_with("p1") && root.ends_with("p1"));
        env.load().set_enabled(&env.app.db, "p1", false).unwrap();
        let off = env.load().fingerprints();
        let ch = crate::plugins::live::diff(&first, &off);
        assert_eq!(ch.len(), 1);
        assert!(ch[0].id == "p1" && ch[0].stopped());
        env.load().set_enabled(&env.app.db, "p1", true).unwrap();
        assert!(crate::plugins::live::diff(&first, &env.load().fingerprints()).is_empty(), "back to the same code");
        std::fs::remove_dir_all(env.res.path().join("plugins").join("p2")).unwrap();
        let ch = crate::plugins::live::diff(&first, &env.load().fingerprints());
        assert!(ch.len() == 1 && ch[0].id == "p2" && ch[0].after.is_none() && ch[0].stopped());
    }

    /// The GUI loads the registry from parallel commands (`plugins_list` +
    /// `plugins_contributions`): first-load inserts must not collide.
    #[test]
    fn concurrent_first_loads_do_not_conflict() {
        let env = Env::new();
        for i in 0..4 {
            env.bundled(&format!("p{i}"), json!({}));
        }
        std::thread::scope(|s| {
            let handles: Vec<_> = (0..8)
                .map(|_| s.spawn(|| PluginRegistry::load_with(&env.app.paths, &env.app.db, &env.opts()).map(|_| ())))
                .collect();
            for h in handles {
                h.join().unwrap().expect("concurrent load");
            }
        });
        assert_eq!(status(&env.load(), "p0"), PluginStatus::Active);
    }

    #[test]
    fn palette_providers_are_contributions_and_need_a_ui_entry() {
        let env = Env::new();
        env.bundled("ideas", json!({"ui": {"entry": "dist/index.js"},
            "contributes": {"paletteProviders": [{"id": "ideas", "title": "Ideas"}]}}));
        env.bundled("no-ui", json!({"contributes": {"paletteProviders": [{"id": "x", "title": "X"}]}}));
        env.bundled("dup", json!({"ui": {"entry": "dist/index.js"},
            "contributes": {"paletteProviders": [{"id": "x", "title": "X"}, {"id": "x", "title": "Y"}]}}));
        let reg = env.load();
        let c = reg.contributions();
        assert_eq!(c.palette_providers.len(), 1);
        assert_eq!(c.palette_providers[0].plugin_id, "ideas");
        assert_eq!(c.palette_providers[0].contribution.title, "Ideas");
        assert!(matches!(status(&reg, "no-ui"), PluginStatus::Failed { .. }));
        assert!(matches!(status(&reg, "dup"), PluginStatus::Failed { .. }));
    }

    #[test]
    fn title_generators_are_contributions_and_need_a_ui_entry() {
        let env = Env::new();
        env.bundled("local-titles", json!({"ui": {"entry": "dist/index.js"},
            "contributes": {"titleGenerators": [{"id": "llama", "title": "Local model"}]}}));
        env.bundled("no-ui", json!({"contributes": {"titleGenerators": [{"id": "x", "title": "X"}]}}));
        env.bundled("dup", json!({"ui": {"entry": "dist/index.js"},
            "contributes": {"titleGenerators": [{"id": "x", "title": "X"}, {"id": "x", "title": "Y"}]}}));
        let reg = env.load();
        let c = reg.contributions();
        assert_eq!(c.title_generators.len(), 1);
        assert_eq!(c.title_generators[0].plugin_id, "local-titles");
        assert_eq!(c.title_generators[0].contribution.id, "llama");
        assert!(matches!(status(&reg, "no-ui"), PluginStatus::Failed { .. }));
        assert!(matches!(status(&reg, "dup"), PluginStatus::Failed { .. }));
    }

    #[test]
    fn bundle_info_can_only_lower_trust_of_bundled_copies() {
        let env = Env::new();
        let root = env.bundled("hello-sandboxed", json!({"permissions": ["data:issues:read"]}));
        std::fs::write(root.join(BUNDLE_INFO_FILE), r#"{"isolation":"sandboxed"}"#).unwrap();
        let native = env.bundled("hello-native", json!({"permissions": ["native:windows"]}));
        std::fs::write(native.join(BUNDLE_INFO_FILE), r#"{"isolation":"sandboxed"}"#).unwrap();
        let other = env.bundled("hello-trusted", json!({}));
        std::fs::write(other.join(BUNDLE_INFO_FILE), r#"{"isolation":"trusted"}"#).unwrap();
        let reg = env.load();
        let p = reg.get("hello-sandboxed").unwrap();
        assert_eq!(p.isolation, Isolation::Sandboxed);
        assert_eq!(p.status, PluginStatus::Active, "bundled: auto-granted");
        // Sandbox restrictions apply as to any sandboxed plugin.
        assert!(matches!(status(&reg, "hello-native"), PluginStatus::Failed { reason } if reason.contains("native:windows")));
        assert_eq!(reg.get("hello-trusted").unwrap().isolation, Isolation::Trusted);
        // Ignored for installed copies (a downloaded archive cannot change its isolation either way).
        let env = Env::new();
        let dir = env.installed("acme.x", "1.0.0", json!({}));
        std::fs::write(dir.join(BUNDLE_INFO_FILE), r#"{"isolation":"trusted"}"#).unwrap();
        assert_eq!(env.load().get("acme.x").unwrap().isolation, Isolation::Sandboxed);
    }

    #[test]
    fn bundled_plugins_load_active_with_auto_grant() {
        let env = Env::new();
        env.bundled("issues", json!({"permissions": ["data:issues:write", "terminal:spawn"], "ui": {"entry": "dist/index.js"},
            "contributes": {"tiles": [{"id": "board", "title": "Issues"}], "commands": [{"id": "new-issue", "title": "New"}]}}));
        let reg = env.load();
        let p = reg.get("issues").unwrap();
        assert_eq!(p.status, PluginStatus::Active, "{:?}", p.errors);
        assert_eq!(p.origin, PluginOrigin::Bundled);
        assert_eq!(p.isolation, Isolation::Trusted);
        assert_eq!(p.granted.len(), 2);
        let c = reg.contributions();
        assert_eq!(c.tiles.len(), 1);
        assert_eq!(c.tiles[0].plugin_id, "issues");
        assert_eq!(c.commands[0].contribution.id, "new-issue");
        // Row written on first load.
        let (origin, granted): (String, String) = env
            .app
            .db
            .read(|c| c.query_row("SELECT origin, granted_permissions FROM plugins WHERE id='issues'", [], |r| Ok((r.get(0)?, r.get(1)?))))
            .unwrap();
        assert_eq!(origin, "bundled");
        assert!(granted.contains("terminal:spawn"));
        // A second load writes nothing new.
        let before: i64 = env.app.db.read(|c| c.query_row("SELECT COUNT(*) FROM app_changes", [], |r| r.get(0))).unwrap();
        env.load();
        let after: i64 = env.app.db.read(|c| c.query_row("SELECT COUNT(*) FROM app_changes", [], |r| r.get(0))).unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn platform_filtering() {
        let env = Env::new();
        let this = Platform::current().unwrap();
        let others: Vec<&str> = ["windows", "macos", "linux"].into_iter().filter(|p| *p != this.as_str()).collect();
        env.bundled("elsewhere", json!({"platforms": others}));
        env.bundled("here", json!({"platforms": [this.as_str()]}));
        let reg = env.load();
        assert_eq!(status(&reg, "elsewhere"), PluginStatus::UnsupportedPlatform);
        assert_eq!(status(&reg, "here"), PluginStatus::Active);
        let visible: Vec<String> = reg.list(false).into_iter().map(|p| p.id).collect();
        assert_eq!(visible, vec!["here".to_string()]);
        assert_eq!(reg.list(true).len(), 2);
        // Unsupported plugins contribute nothing.
        assert!(reg.active().all(|p| p.id == "here"));
        // A platform-less host supports nothing.
        let mut o = env.opts();
        o.platform = None;
        let reg = PluginRegistry::load_with(&env.app.paths, &env.app.db, &o).unwrap();
        assert_eq!(status(&reg, "here"), PluginStatus::UnsupportedPlatform);
    }

    #[test]
    fn incompatible_api_version_detected() {
        let env = Env::new();
        env.bundled("old-major", json!({"apiVersion": "^0.9.0"}));
        env.bundled("next-major", json!({"apiVersion": "^2.0.0"}));
        env.bundled("newer-minor", json!({"apiVersion": "^1.3.0"}));
        env.bundled("ok-minor", json!({"apiVersion": "^1.2.0"}));
        env.bundled("any-major", json!({"apiVersion": "*"}));
        env.bundled("garbage", json!({"apiVersion": "latest"}));
        let reg = env.load();
        for id in ["old-major", "next-major", "newer-minor", "any-major"] {
            assert!(matches!(status(&reg, id), PluginStatus::Incompatible { .. }), "{id}: {:?}", status(&reg, id));
        }
        assert_eq!(status(&reg, "ok-minor"), PluginStatus::Active);
        assert!(matches!(status(&reg, "garbage"), PluginStatus::Failed { .. }));
        let info = reg.get("next-major").unwrap().info();
        assert!(info.status.detail().unwrap().contains("major 2"));
        let db_status: String =
            env.app.db.read(|c| c.query_row("SELECT status FROM plugins WHERE id='next-major'", [], |r| r.get(0))).unwrap();
        assert_eq!(db_status, "incompatible");
    }

    #[test]
    fn invalid_manifests_fail_but_are_listed() {
        let env = Env::new();
        env.bundled("bad-perm", json!({"permissions": ["fs:read:root"]}));
        env.bundled("bad-path", json!({"icon": "../outside.svg"}));
        let d = env.res.path().join("plugins").join("broken-json");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(MANIFEST_FILE), "{").unwrap();
        let reg = env.load();
        for id in ["bad-perm", "bad-path", "broken-json"] {
            assert!(matches!(status(&reg, id), PluginStatus::Failed { .. }), "{id}");
        }
        assert!(!reg.get("bad-perm").unwrap().errors.is_empty());
        assert!(reg.contributions().tiles.is_empty());
    }

    #[test]
    fn enable_disable_round_trip() {
        let env = Env::new();
        env.bundled("issues", json!({}));
        let reg = env.load();
        reg.set_enabled(&env.app.db, "issues", false).unwrap();
        let reg = env.load();
        assert_eq!(status(&reg, "issues"), PluginStatus::Disabled);
        assert!(!reg.get("issues").unwrap().enabled);
        reg.set_enabled(&env.app.db, "issues", true).unwrap();
        assert_eq!(status(&env.load(), "issues"), PluginStatus::Active);
        assert_eq!(reg.set_enabled(&env.app.db, "nope", true).unwrap_err().code, crate::ErrorCode::NotFound);
    }

    #[test]
    fn dev_plugins_need_consent_and_shadow_bundled() {
        let env = Env::new();
        env.bundled("acme.tool", json!({"version": "1.0.0"}));
        let dev = write_plugin(&env.dev.path().join("tool"), "acme.tool", json!({"version": "0.1.0", "permissions": ["notifications", "native:webview"]}));
        let reg = env.load_dev(vec![dev.clone()]);
        let p = reg.get("acme.tool").unwrap();
        assert_eq!(p.origin, PluginOrigin::Dev);
        assert_eq!(p.isolation, Isolation::Sandboxed);
        assert_eq!(p.shadowed.len(), 1);
        assert_eq!(p.shadowed[0].origin, PluginOrigin::Bundled);
        // Sandboxed + native:* → refused.
        assert!(matches!(&p.status, PluginStatus::Failed { reason } if reason.contains("native:webview")), "{:?}", p.status);

        std::fs::write(
            dev.join(MANIFEST_FILE),
            serde_json::to_string(&manifest("acme.tool", json!({"permissions": ["notifications", "data:ideas:write"]}))).unwrap(),
        )
        .unwrap();
        let reg = env.load_dev(vec![dev.clone()]);
        assert_eq!(status(&reg, "acme.tool"), PluginStatus::NeedsConsent);
        assert_eq!(reg.get("acme.tool").unwrap().missing_permissions().len(), 2);
        // Undeclared / unknown permissions are refused.
        assert!(reg.grant(&env.app.db, "acme.tool", &["secrets".into()]).is_err());
        assert!(reg.grant(&env.app.db, "acme.tool", &["bogus".into()]).is_err());
        reg.grant(&env.app.db, "acme.tool", &["notifications".into()]).unwrap();
        assert_eq!(status(&env.load_dev(vec![dev.clone()]), "acme.tool"), PluginStatus::NeedsConsent);
        reg.grant(&env.app.db, "acme.tool", &["notifications".into(), "data:ideas:write".into()]).unwrap();
        assert_eq!(status(&env.load_dev(vec![dev.clone()]), "acme.tool"), PluginStatus::Active);
        // Without the dev path the bundled one is back.
        assert_eq!(env.load_dev(vec![]).get("acme.tool").unwrap().origin, PluginOrigin::Bundled);
        // Bundled grants are automatic.
        assert!(env.load_dev(vec![]).grant(&env.app.db, "acme.tool", &[]).is_err());
    }

    #[test]
    fn dev_paths_come_from_settings_and_bare_ids_need_first_party_layout() {
        let env = Env::new();
        let bare = write_plugin(&env.dev.path().join("somewhere"), "hello", json!({}));
        let checkout = env.dev.path().join("repo");
        std::fs::create_dir_all(checkout.join("packages/plugin-api")).unwrap();
        let first_party = write_plugin(&checkout.join("plugins").join("hello2"), "hello2", json!({}));
        let paths = json!([bare.display().to_string(), first_party.display().to_string()]).to_string();
        env.app
            .db
            .write(&[], |tx| {
                tx.execute(
                    "INSERT INTO settings (namespace, key, value, updated_at) VALUES ('plugins', 'devPaths', ?1, 0)",
                    [paths],
                )
            })
            .unwrap();
        let reg = env.load();
        assert!(matches!(status(&reg, "hello"), PluginStatus::Failed { reason } if reason.contains("bare id")));
        assert_eq!(status(&reg, "hello2"), PluginStatus::Active);
        assert_eq!(reg.get("hello2").unwrap().isolation, Isolation::Sandboxed);
        env.app
            .db
            .write(&[], |tx| tx.execute("INSERT INTO settings (namespace, key, value, updated_at) VALUES ('plugins', 'devTrusted', 'true', 0)", []))
            .unwrap();
        assert_eq!(env.load().get("hello2").unwrap().isolation, Isolation::Trusted);
    }

    #[test]
    fn installed_resolution_against_bundled() {
        let env = Env::new();
        env.bundled("acme.x", json!({"version": "1.0.0"}));
        env.installed("acme.x", "1.1.0", json!({}));
        let reg = env.load();
        let p = reg.get("acme.x").unwrap();
        assert_eq!(p.origin, PluginOrigin::Installed);
        assert_eq!(p.manifest.as_ref().unwrap().version, "1.1.0");
        assert_eq!(p.isolation, Isolation::Sandboxed);

        // An installed version that is not newer, or incompatible, loses to bundled.
        let env = Env::new();
        env.bundled("acme.y", json!({"version": "2.0.0"}));
        env.installed("acme.y", "1.5.0", json!({}));
        env.bundled("acme.z", json!({"version": "1.0.0"}));
        env.installed("acme.z", "3.0.0", json!({"apiVersion": "^2.0.0"}));
        let reg = env.load();
        assert_eq!(reg.get("acme.y").unwrap().origin, PluginOrigin::Bundled);
        assert_eq!(reg.get("acme.z").unwrap().origin, PluginOrigin::Bundled);

        // Highest version dir wins without a DB row; bare installed ids need the official source.
        let env = Env::new();
        env.installed("acme.w", "1.0.0", json!({}));
        env.installed("acme.w", "1.10.0", json!({}));
        let d = env.app.paths.plugins_dir.join("acme.w").join("2.0.0.staging");
        write_plugin(&d, "acme.w", json!({"version": "2.0.0"}));
        env.installed("issues", "1.0.0", json!({}));
        let reg = env.load();
        assert_eq!(reg.get("acme.w").unwrap().manifest.as_ref().unwrap().version, "1.10.0");
        assert!(matches!(status(&reg, "issues"), PluginStatus::Failed { reason } if reason.contains("bare id")));
    }

    #[test]
    fn cli_name_conflicts_fail_the_later_plugin() {
        let env = Env::new();
        let cli = json!({"sidecar": {"binaries": {crate::plugins::current_target().unwrap(): "bin/s"}},
                         "contributes": {"cliCommands": [{"name": "hello", "summary": "s", "handler": {"type": "sidecar"}}]}});
        let a = env.bundled("alpha", cli.clone());
        let b = env.bundled("beta", cli);
        for d in [&a, &b] {
            std::fs::create_dir_all(d.join("bin")).unwrap();
            std::fs::write(d.join("bin/s"), "").unwrap();
        }
        let reg = env.load();
        assert_eq!(status(&reg, "alpha"), PluginStatus::Active, "{:?}", reg.get("alpha").unwrap().errors);
        assert!(matches!(status(&reg, "beta"), PluginStatus::Failed { reason } if reason.contains("alpha")));
        assert_eq!(reg.contributions().cli_commands.len(), 1);
    }
}
