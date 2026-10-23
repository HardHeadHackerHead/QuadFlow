//! `quadflow-plugin.json` types and validation (plugin-system.md §3).
//!
//! Validation = the embedded JSON Schema (§3.2) **plus** semantic checks: every
//! referenced file exists inside the plugin root, `ui.entry` is present when the
//! contributions need a UI module, command references resolve, contribution ids
//! are unique, CLI names are not reserved, settings schemas compile, sidecar /
//! exec binaries exist for the current target, and bare ids are only allowed
//! where the caller says so (official source / bundled / first-party dev).

use super::permissions::{Permission, PermissionKind};
use super::{check_api_version, current_target, is_bare_id, schema, Platform, MANIFEST_FILE, RESERVED_CLI_NAMES};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path};

// ---------------------------------------------------------------------------
// Types (serde camelCase; mirror quadflow-plugin.schema.json)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    #[serde(rename = "$schema", default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<Author>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<Category>,
    pub api_version: String,
    pub platforms: Vec<Platform>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui: Option<UiEntry>,
    #[serde(default = "default_activation")]
    pub activation: Vec<Activation>,
    #[serde(default)]
    pub contributes: Contributes,
    #[serde(default)]
    pub permissions: Vec<Permission>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sidecar: Option<Sidecar>,
}

fn default_activation() -> Vec<Activation> {
    vec![Activation::OnTile, Activation::OnCommand]
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Author {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum Category {
    ProjectManagement,
    Development,
    AiAgents,
    Media,
    System,
    Integrations,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UiEntry {
    pub entry: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum Activation {
    OnStartup,
    OnProject,
    OnTile,
    OnCommand,
    OnCli,
    OnAgentProvider,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Contributes {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tiles: Vec<Tile>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub toolbar_items: Vec<ToolbarItem>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub commands: Vec<Command>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub context_menus: Vec<ContextMenu>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub settings_pages: Vec<SettingsPage>,
    /// JSON Schema (type=object) for the plugin's settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<crate::model::JsonValue>)]
    pub settings: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cli_commands: Vec<CliCommand>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agent_context_docs: Vec<AgentContextDoc>,
    /// Command-palette entity search; implemented by the UI module's `paletteProviders[id]`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub palette_providers: Vec<PaletteProviderSpec>,
    /// Terminal-title generators; implemented by the UI module's `titleGenerators[id]` (API 1.3).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub title_generators: Vec<TitleGeneratorSpec>,
    /// Agent provider spec (agent-providers.md §3); interpreted by `agents::spec`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<crate::model::JsonValue>)]
    pub agent_provider: Option<Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum TileMode {
    Pane,
    Flyout,
}

fn default_modes() -> Vec<TileMode> {
    vec![TileMode::Pane, TileMode::Flyout]
}
fn yes() -> bool {
    true
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Tile {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<Category>,
    #[serde(default = "default_modes")]
    pub modes: Vec<TileMode>,
    #[serde(default)]
    pub singleton: bool,
    #[serde(default)]
    pub requires_project: bool,
    #[serde(default)]
    pub templateable: bool,
    #[serde(default)]
    pub mini_widget: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flyout: Option<FlyoutSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<crate::model::JsonValue>)]
    pub config_schema: Option<Value>,
    #[serde(default = "yes")]
    pub instance_multiple: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_tool_config: Option<DefaultToolConfig>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FlyoutSpec {
    /// `[width, height]`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_size: Option<[u32; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_size: Option<[u32; 2]>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ToolbarItem {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Command id in this plugin, or `<pluginId>/<commandId>`.
    pub command: String,
    /// Menu group (as for tiles); defaults to the plugin's category.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<Category>,
    #[serde(default)]
    pub mini_widget: bool,
    /// Per tool-config settings form (as for tiles); the command receives the
    /// config id and reads its settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<crate::model::JsonValue>)]
    pub config_schema: Option<Value>,
    /// Allow user-created configs of this item (e.g. several window links).
    #[serde(default)]
    pub instance_multiple: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_tool_config: Option<DefaultToolConfig>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum PinSection {
    Left,
    Center,
    #[default]
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum PinDisplay {
    Icon,
    #[default]
    IconAndName,
    Mini,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum OpenMode {
    #[default]
    Pane,
    Flyout,
}

fn default_order() -> i32 {
    100
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DefaultToolConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub pin_section: PinSection,
    #[serde(default)]
    pub pin_display: PinDisplay,
    #[serde(default)]
    pub quick_launch: bool,
    #[serde(default)]
    pub open_mode: OpenMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default = "default_order")]
    pub order: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<crate::model::JsonValue>)]
    pub settings: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shortcut: Option<String>,
    #[serde(default = "yes")]
    pub palette: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
pub enum MenuLocation {
    #[serde(rename = "terminal")]
    Terminal,
    #[serde(rename = "terminal.selection")]
    TerminalSelection,
    #[serde(rename = "tile.header")]
    TileHeader,
    #[serde(rename = "tab")]
    Tab,
    #[serde(rename = "project")]
    Project,
    #[serde(rename = "workspace")]
    Workspace,
    #[serde(rename = "entity.issue")]
    EntityIssue,
    #[serde(rename = "entity.idea")]
    EntityIdea,
    #[serde(rename = "entity.plan")]
    EntityPlan,
    #[serde(rename = "file")]
    File,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ContextMenu {
    pub id: String,
    pub location: MenuLocation,
    pub command: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPage {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// `true`: the UI module exports `settingsPages[id]`; `false`: auto form from `contributes.settings`.
    #[serde(default)]
    pub custom: bool,
}

/// `contributes.paletteProviders[]`: the shell loads the plugin and calls
/// `paletteProviders[id].search(query)` when the palette searches entities.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PaletteProviderSpec {
    pub id: String,
    /// Group label of the results in the palette (e.g. "Ideas").
    pub title: String,
}

/// `contributes.titleGenerators[]`: the shell loads the plugin and calls
/// `titleGenerators[id].generate(request)` when it needs a terminal title
/// (before the agent provider's `sessionTitle` hook and the chat-API fallback).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TitleGeneratorSpec {
    pub id: String,
    /// Shown in Settings → Integrations → Auto Titles (e.g. "Local model (llama.cpp)").
    pub title: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CliCommand {
    pub name: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub docs: Option<String>,
    pub handler: CliHandler,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CliHandler {
    Sidecar,
    Exec { binaries: BTreeMap<String, String> },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentContextDoc {
    pub id: String,
    pub title: String,
    pub file: String,
    #[serde(default)]
    pub default: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum SidecarRuntime {
    Node,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum SidecarActivation {
    #[default]
    OnDemand,
    OnStartup,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum SidecarRestart {
    #[default]
    OnCrash,
    Never,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Sidecar {
    /// `<os>-<arch>` → relative path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binaries: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<SidecarRuntime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub activation: SidecarActivation,
    #[serde(default)]
    pub restart: SidecarRestart,
}

impl Manifest {
    pub fn requested_permissions(&self) -> BTreeSet<Permission> {
        self.permissions.iter().cloned().collect()
    }

    pub fn supports(&self, platform: Platform) -> bool {
        self.platforms.contains(&platform)
    }

    pub fn parsed_version(&self) -> Option<semver::Version> {
        semver::Version::parse(&self.version).ok()
    }

    /// `Err(reason)` if `apiVersion` is not compatible with `host` (§4.2).
    pub fn api_compat(&self, host: &semver::Version) -> Result<(), String> {
        check_api_version(&self.api_version, host)
    }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/// One problem, located by JSON pointer into the manifest (`""` = whole document).
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ManifestIssue {
    pub path: String,
    pub message: String,
}

impl ManifestIssue {
    pub fn new(path: impl Into<String>, message: impl Into<String>) -> Self {
        Self { path: path.into(), message: message.into() }
    }
}

impl std::fmt::Display for ManifestIssue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.path.is_empty() {
            f.write_str(&self.message)
        } else {
            write!(f, "{}: {}", self.path, self.message)
        }
    }
}

/// Inputs to semantic validation that depend on where the plugin comes from.
#[derive(Clone, Debug)]
pub struct ValidateOptions {
    /// Bare ids (no publisher) are allowed: official source, bundled, or first-party dev.
    pub allow_bare_id: bool,
    /// `<os>-<arch>` whose sidecar / exec binaries must exist (`None` = skip).
    pub target: Option<String>,
    /// The OS the binaries are checked for (only when the manifest lists it).
    pub platform: Option<Platform>,
}

impl Default for ValidateOptions {
    fn default() -> Self {
        Self { allow_bare_id: false, target: current_target(), platform: Platform::current() }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ValidationReport {
    /// Parsed manifest; `None` if the file is unreadable or fails the schema.
    pub manifest: Option<Manifest>,
    /// The `id` field as written, when it could be read (even if the rest failed).
    pub raw_id: Option<String>,
    pub errors: Vec<ManifestIssue>,
    pub warnings: Vec<ManifestIssue>,
}

impl ValidationReport {
    pub fn is_valid(&self) -> bool {
        self.errors.is_empty() && self.manifest.is_some()
    }

    /// First error as one line (for `Failed { reason }`).
    pub fn summary(&self) -> String {
        match self.errors.len() {
            0 => String::new(),
            1 => self.errors[0].to_string(),
            n => format!("{} (and {} more)", self.errors[0], n - 1),
        }
    }
}

/// Read and fully validate `<dir>/quadflow-plugin.json`.
pub fn validate_dir(dir: &Path, opts: &ValidateOptions) -> ValidationReport {
    let path = dir.join(MANIFEST_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => {
            return ValidationReport {
                manifest: None,
                raw_id: None,
                errors: vec![ManifestIssue::new("", format!("cannot read {}: {e}", path.display()))],
                warnings: vec![],
            }
        }
    };
    let value: Value = match serde_json::from_str(text.trim_start_matches('\u{feff}')) {
        Ok(v) => v,
        Err(e) => {
            return ValidationReport {
                manifest: None,
                raw_id: None,
                errors: vec![ManifestIssue::new("", format!("{MANIFEST_FILE} is not valid JSON: {e}"))],
                warnings: vec![],
            }
        }
    };
    validate_value(&value, Some(dir), opts)
}

/// Validate a manifest document. `root` = plugin directory for file checks
/// (`None` skips them).
pub fn validate_value(value: &Value, root: Option<&Path>, opts: &ValidateOptions) -> ValidationReport {
    let raw_id = value.get("id").and_then(Value::as_str).map(str::to_string);
    let schema_errors = schema::validate_manifest_json(value);
    if !schema_errors.is_empty() {
        return ValidationReport { manifest: None, raw_id, errors: schema_errors, warnings: vec![] };
    }
    let manifest: Manifest = match serde_json::from_value(value.clone()) {
        Ok(m) => m,
        Err(e) => {
            // The schema and the types disagree (e.g. a permission the parser is
            // stricter about, like an out-of-range port).
            return ValidationReport {
                manifest: None,
                raw_id,
                errors: vec![ManifestIssue::new("", e.to_string())],
                warnings: vec![],
            };
        }
    };
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    semantic(&manifest, root, opts, &mut errors, &mut warnings);
    errors.sort();
    errors.dedup();
    ValidationReport { manifest: Some(manifest), raw_id, errors, warnings }
}

fn semantic(m: &Manifest, root: Option<&Path>, opts: &ValidateOptions, errors: &mut Vec<ManifestIssue>, warnings: &mut Vec<ManifestIssue>) {
    let mut err = |p: String, msg: String| errors.push(ManifestIssue::new(p, msg));

    // Ids
    if is_bare_id(&m.id) && !opts.allow_bare_id {
        err(
            "/id".into(),
            format!("bare id {:?} is reserved for official plugins; use \"<publisher>.{}\"", m.id, m.id),
        );
    }
    if let Err(e) = semver::VersionReq::parse(m.api_version.trim()) {
        err("/apiVersion".into(), format!("not a semver range: {e}"));
    }

    // Files
    let file = |ptr: String, rel: &str, errs: &mut dyn FnMut(String, String)| {
        if let Err(msg) = check_rel_path(rel) {
            errs(ptr, msg);
            return;
        }
        if let Some(root) = root {
            if let Err(msg) = check_file_in_root(root, rel) {
                errs(ptr, msg);
            }
        }
    };
    if let Some(icon) = &m.icon {
        file("/icon".into(), icon, &mut err);
    }
    if let Some(ui) = &m.ui {
        file("/ui/entry".into(), &ui.entry, &mut err);
        if let Some(style) = &ui.style {
            file("/ui/style".into(), style, &mut err);
        }
    }
    let c = &m.contributes;
    for (i, t) in c.tiles.iter().enumerate() {
        if let Some(icon) = &t.icon {
            file(format!("/contributes/tiles/{i}/icon"), icon, &mut err);
        }
        if let Some(s) = &t.config_schema {
            if let Err(msg) = schema::check_object_schema(s) {
                err(format!("/contributes/tiles/{i}/configSchema"), msg);
            }
        }
        if t.modes.is_empty() {
            err(format!("/contributes/tiles/{i}/modes"), "must list at least one of pane, flyout".into());
        }
    }
    for (i, t) in c.toolbar_items.iter().enumerate() {
        if let Some(icon) = &t.icon {
            file(format!("/contributes/toolbarItems/{i}/icon"), icon, &mut err);
        }
    }
    for (i, t) in c.commands.iter().enumerate() {
        if let Some(icon) = &t.icon {
            file(format!("/contributes/commands/{i}/icon"), icon, &mut err);
        }
    }
    for (i, t) in c.settings_pages.iter().enumerate() {
        if let Some(icon) = &t.icon {
            file(format!("/contributes/settingsPages/{i}/icon"), icon, &mut err);
        }
    }
    for (i, d) in c.agent_context_docs.iter().enumerate() {
        file(format!("/contributes/agentContextDocs/{i}/file"), &d.file, &mut err);
    }
    for (i, cc) in c.cli_commands.iter().enumerate() {
        if let Some(docs) = &cc.docs {
            file(format!("/contributes/cliCommands/{i}/docs"), docs, &mut err);
        }
    }
    if let Some(s) = &c.settings {
        if let Err(msg) = schema::check_object_schema(s) {
            err("/contributes/settings".into(), msg);
        }
    }

    // ui.entry required when contributions need the UI module.
    let needs_ui = !c.tiles.is_empty()
        || c.settings_pages.iter().any(|p| p.custom)
        || !c.palette_providers.is_empty()
        || !c.title_generators.is_empty()
        || (!c.commands.is_empty() && m.sidecar.is_none())
        || c.tiles.iter().any(|t| t.mini_widget)
        || c.toolbar_items.iter().any(|t| t.mini_widget);
    if needs_ui && m.ui.is_none() {
        err(
            "/ui".into(),
            "ui.entry is required for tiles, custom settings pages, mini widgets, palette providers, title generators, or commands without a sidecar".into(),
        );
    }

    // Unique contribution ids. Tiles and toolbar items share one namespace
    // (both are targets of tool configs: `<pluginId>/<contributionId>`).
    let dup = |kind: &str, ids: Vec<(String, &str)>, errs: &mut dyn FnMut(String, String)| {
        let mut seen = BTreeSet::new();
        for (ptr, id) in ids {
            if !seen.insert(id.to_string()) {
                errs(ptr, format!("duplicate {kind} id {id:?}"));
            }
        }
    };
    let mut tile_ids: Vec<(String, &str)> =
        c.tiles.iter().enumerate().map(|(i, t)| (format!("/contributes/tiles/{i}/id"), t.id.as_str())).collect();
    tile_ids.extend(
        c.toolbar_items.iter().enumerate().map(|(i, t)| (format!("/contributes/toolbarItems/{i}/id"), t.id.as_str())),
    );
    dup("tile/toolbar item", tile_ids, &mut err);
    dup(
        "command",
        c.commands.iter().enumerate().map(|(i, t)| (format!("/contributes/commands/{i}/id"), t.id.as_str())).collect(),
        &mut err,
    );
    dup(
        "context menu",
        c.context_menus.iter().enumerate().map(|(i, t)| (format!("/contributes/contextMenus/{i}/id"), t.id.as_str())).collect(),
        &mut err,
    );
    dup(
        "settings page",
        c.settings_pages.iter().enumerate().map(|(i, t)| (format!("/contributes/settingsPages/{i}/id"), t.id.as_str())).collect(),
        &mut err,
    );
    dup(
        "agent context doc",
        c.agent_context_docs.iter().enumerate().map(|(i, t)| (format!("/contributes/agentContextDocs/{i}/id"), t.id.as_str())).collect(),
        &mut err,
    );
    dup(
        "palette provider",
        c.palette_providers.iter().enumerate().map(|(i, t)| (format!("/contributes/paletteProviders/{i}/id"), t.id.as_str())).collect(),
        &mut err,
    );
    dup(
        "title generator",
        c.title_generators.iter().enumerate().map(|(i, t)| (format!("/contributes/titleGenerators/{i}/id"), t.id.as_str())).collect(),
        &mut err,
    );
    dup(
        "CLI command",
        c.cli_commands.iter().enumerate().map(|(i, t)| (format!("/contributes/cliCommands/{i}/name"), t.name.as_str())).collect(),
        &mut err,
    );

    // Command references.
    let own: BTreeSet<&str> = c.commands.iter().map(|x| x.id.as_str()).collect();
    let check_ref = |ptr: String, r: &str, errs: &mut dyn FnMut(String, String)| {
        let local = match r.split_once('/') {
            Some((pid, cmd)) if pid == m.id => cmd,
            Some((pid, cmd)) => {
                if pid.is_empty() || cmd.is_empty() {
                    errs(ptr, format!("command reference {r:?} must be <commandId> or <pluginId>/<commandId>"));
                }
                return; // another plugin's or a core command: resolved at runtime
            }
            None => r,
        };
        if !own.contains(local) {
            errs(ptr, format!("command {local:?} is not declared in contributes.commands"));
        }
    };
    for (i, t) in c.toolbar_items.iter().enumerate() {
        check_ref(format!("/contributes/toolbarItems/{i}/command"), &t.command, &mut err);
    }
    for (i, t) in c.context_menus.iter().enumerate() {
        check_ref(format!("/contributes/contextMenus/{i}/command"), &t.command, &mut err);
    }

    // CLI commands.
    let check_target = m.platform_checked(opts);
    for (i, cc) in c.cli_commands.iter().enumerate() {
        if RESERVED_CLI_NAMES.contains(&cc.name.as_str()) {
            err(format!("/contributes/cliCommands/{i}/name"), format!("{:?} is a reserved core command name", cc.name));
        }
        match &cc.handler {
            CliHandler::Sidecar if m.sidecar.is_none() => {
                err(format!("/contributes/cliCommands/{i}/handler"), "handler type \"sidecar\" requires a sidecar".into());
            }
            CliHandler::Sidecar => {}
            CliHandler::Exec { binaries } => {
                check_binaries(&format!("/contributes/cliCommands/{i}/handler/binaries"), binaries, check_target.as_deref(), root, &mut err);
            }
        }
    }

    // Sidecar.
    if let Some(sc) = &m.sidecar {
        if let Some(b) = &sc.binaries {
            check_binaries("/sidecar/binaries", b, check_target.as_deref(), root, &mut err);
        }
        if let Some(entry) = &sc.entry {
            file("/sidecar/entry".into(), entry, &mut err);
        }
        if sc.runtime == Some(SidecarRuntime::Node)
            && !m.permissions.iter().any(|p| p.kind() == PermissionKind::SidecarRuntimeNode)
        {
            err("/permissions".into(), "sidecar runtime \"node\" requires permission sidecar:runtime:node".into());
        }
    }

    // Advisory.
    if !c.agent_context_docs.is_empty() && c.cli_commands.is_empty() {
        warnings.push(ManifestIssue::new(
            "/contributes/agentContextDocs",
            "agent context docs without cliCommands usually document nothing an agent can call",
        ));
    }
}

impl Manifest {
    /// The target whose binaries must exist: only when the manifest supports the platform.
    fn platform_checked(&self, opts: &ValidateOptions) -> Option<String> {
        match (opts.platform, &opts.target) {
            (Some(p), Some(t)) if self.supports(p) => Some(t.clone()),
            _ => None,
        }
    }
}

fn check_binaries(
    ptr: &str,
    binaries: &BTreeMap<String, String>,
    target: Option<&str>,
    root: Option<&Path>,
    err: &mut dyn FnMut(String, String),
) {
    for (k, rel) in binaries {
        if let Err(msg) = check_rel_path(rel) {
            err(format!("{ptr}/{k}"), msg);
        }
    }
    let Some(target) = target else { return };
    match binaries.get(target) {
        None => err(ptr.to_string(), format!("no binary for this platform ({target})")),
        Some(rel) => {
            if let Some(root) = root {
                if check_rel_path(rel).is_ok() {
                    if let Err(msg) = check_file_in_root(root, rel) {
                        err(format!("{ptr}/{target}"), msg);
                    }
                }
            }
        }
    }
}

/// Lexical rules for a plugin-relative path (mirrors `$defs/relPath`): relative,
/// `/`-separated, no `..`, no `\`, no drive or scheme (`:`), no empty name.
pub fn check_rel_path(rel: &str) -> Result<(), String> {
    let ok_chars = rel.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'));
    if rel.is_empty() || !ok_chars || rel.starts_with('/') || rel.contains("..") {
        return Err(format!("{rel:?} must be a relative path inside the plugin ([A-Za-z0-9._/-], no leading /, no ..)"));
    }
    if Path::new(rel).components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return Err(format!("{rel:?} must stay inside the plugin directory"));
    }
    Ok(())
}

/// `root/rel` must be an existing file whose canonical path is inside `root`
/// (rejects symlink escapes).
pub fn check_file_in_root(root: &Path, rel: &str) -> Result<(), String> {
    let p = root.join(rel);
    if !p.is_file() {
        return Err(format!("file {rel:?} does not exist"));
    }
    let canon_root = dunce::canonicalize(root).map_err(|e| format!("plugin root: {e}"))?;
    let canon = dunce::canonicalize(&p).map_err(|e| format!("{rel:?}: {e}"))?;
    if !canon.starts_with(&canon_root) {
        return Err(format!("{rel:?} resolves outside the plugin directory"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn opts() -> ValidateOptions {
        ValidateOptions { allow_bare_id: true, ..Default::default() }
    }

    fn base() -> Value {
        json!({
            "id": "acme.hello",
            "name": "Hello",
            "version": "1.0.0",
            "apiVersion": "^1.0.0",
            "platforms": ["windows", "macos", "linux"],
        })
    }

    fn errs(v: &Value) -> Vec<ManifestIssue> {
        validate_value(v, None, &opts()).errors
    }

    fn has(errs: &[ManifestIssue], path: &str) -> bool {
        errs.iter().any(|e| e.path == path)
    }

    #[test]
    fn minimal_manifest_is_valid_and_defaults_apply() {
        let r = validate_value(&base(), None, &opts());
        assert!(r.is_valid(), "{:?}", r.errors);
        let m = r.manifest.unwrap();
        assert_eq!(m.activation, vec![Activation::OnTile, Activation::OnCommand]);
        assert!(m.permissions.is_empty());
    }

    #[test]
    fn doc_example_is_valid() {
        let doc = include_str!("../../../../docs/architecture/plugin-system.md");
        let start = doc.find("### 3.1 Example").unwrap();
        let block = &doc[start..];
        let json_start = block.find("```json\n").unwrap() + 8;
        let json_end = block[json_start..].find("```").unwrap() + json_start;
        let v: Value = serde_json::from_str(&block[json_start..json_end]).unwrap();
        let r = validate_value(&v, None, &opts());
        assert!(r.is_valid(), "{:?}", r.errors);
        let m = r.manifest.unwrap();
        assert_eq!(m.contributes.tiles[0].flyout.as_ref().unwrap().default_size, Some([780, 600]));
        assert_eq!(m.contributes.context_menus[0].location, MenuLocation::TerminalSelection);
        // Round trip through serde keeps the schema happy.
        let again = serde_json::to_value(&m).unwrap();
        assert!(schema::validate_manifest_json(&again).is_empty(), "{:?}", schema::validate_manifest_json(&again));
    }

    #[test]
    fn bad_ids() {
        for id in ["Hello", "1abc", "acme..x", "acme.", ".x", "a_b", "acme.x.y", "acme-.x", "", &"a".repeat(65)] {
            let mut v = base();
            v["id"] = json!(id);
            assert!(has(&errs(&v), "/id"), "id {id:?} should be rejected");
        }
        for id in ["hello", "acme.hello", "acme-co.hello-world2", "a1.b2"] {
            let mut v = base();
            v["id"] = json!(id);
            assert!(errs(&v).is_empty(), "id {id:?} should be accepted: {:?}", errs(&v));
        }
        // Bare ids only where allowed.
        let mut v = base();
        v["id"] = json!("hello");
        let r = validate_value(&v, None, &ValidateOptions { allow_bare_id: false, ..Default::default() });
        assert!(has(&r.errors, "/id"), "{:?}", r.errors);
        // Bad contribution ids.
        let mut v = base();
        v["ui"] = json!({"entry": "dist/index.js"});
        v["contributes"] = json!({"tiles": [{"id": "Board", "title": "B"}], "commands": [{"id": "-x", "title": "X"}]});
        let e = errs(&v);
        assert!(has(&e, "/contributes/tiles/0/id") && has(&e, "/contributes/commands/0/id"), "{e:?}");
    }

    #[test]
    fn bad_paths() {
        for p in ["/etc/passwd", "../x.svg", "assets/../../x", "assets\\icon.svg", "C:/x.svg", "a/b?.svg", "", "http://x/y.svg"] {
            let mut v = base();
            v["icon"] = json!(p);
            assert!(has(&errs(&v), "/icon"), "path {p:?} should be rejected");
            assert!(check_rel_path(p).is_err(), "{p:?}");
        }
        assert!(check_rel_path("assets/icon.svg").is_ok());
        assert!(check_rel_path("./dist/index.js").is_ok());
        let mut v = base();
        v["ui"] = json!({"entry": "dist/../../evil.js"});
        assert!(has(&errs(&v), "/ui/entry"));
        let mut v = base();
        v["sidecar"] = json!({"binaries": {"windows-x86_64": "../bin/x.exe"}});
        assert!(!errs(&v).is_empty());
    }

    #[test]
    fn bad_permissions() {
        for p in ["data:teams:read", "fs:read:root", "network:*.example.com", "shell:exec:", "terminal", "data:ideas:read:x"] {
            let mut v = base();
            v["permissions"] = json!([p]);
            let e = errs(&v);
            assert!(e.iter().any(|x| x.path.starts_with("/permissions")), "{p:?}: {e:?}");
        }
        // Schema-valid but out-of-range port: rejected by the parser.
        let mut v = base();
        v["permissions"] = json!(["network:example.com:70000"]);
        assert!(!errs(&v).is_empty());
        // Duplicates.
        let mut v = base();
        v["permissions"] = json!(["notifications", "notifications"]);
        assert!(has(&errs(&v), "/permissions"));
        // Node runtime needs its permission.
        let mut v = base();
        v["sidecar"] = json!({"runtime": "node", "entry": "sidecar/index.js"});
        assert!(has(&errs(&v), "/permissions"));
        v["permissions"] = json!(["sidecar:runtime:node"]);
        assert!(errs(&v).is_empty(), "{:?}", errs(&v));
    }

    #[test]
    fn bad_platforms_and_versions() {
        for p in [json!([]), json!(["windows", "windows"]), json!(["win32"]), json!("windows")] {
            let mut v = base();
            v["platforms"] = p.clone();
            assert!(errs(&v).iter().any(|e| e.path.starts_with("/platforms")), "{p}");
        }
        let mut v = base();
        v["version"] = json!("1.0");
        assert!(has(&errs(&v), "/version"));
        let mut v = base();
        v["apiVersion"] = json!("not a range");
        assert!(has(&errs(&v), "/apiVersion"));
        let mut v = base();
        v.as_object_mut().unwrap().remove("apiVersion");
        assert!(!errs(&v).is_empty());
        let mut v = base();
        v["unknownField"] = json!(1);
        assert!(!errs(&v).is_empty());
    }

    #[test]
    fn semantic_rules() {
        // Tiles need ui.entry.
        let mut v = base();
        v["contributes"] = json!({"tiles": [{"id": "board", "title": "Board"}]});
        assert!(has(&errs(&v), "/ui"));
        // Unknown command reference; another plugin's reference is fine.
        let mut v = base();
        v["ui"] = json!({"entry": "dist/index.js"});
        v["contributes"] = json!({
            "commands": [{"id": "go", "title": "Go"}],
            "toolbarItems": [{"id": "t", "title": "T", "command": "nope"}, {"id": "u", "title": "U", "command": "acme.hello/go"},
                             {"id": "w", "title": "W", "command": "core/settings"}],
            "contextMenus": [{"id": "m", "location": "terminal", "command": "go", "title": "M"}]
        });
        let e = errs(&v);
        assert!(has(&e, "/contributes/toolbarItems/0/command"), "{e:?}");
        assert_eq!(e.len(), 1, "{e:?}");
        // Duplicate ids across tiles and toolbar items.
        let mut v = base();
        v["ui"] = json!({"entry": "dist/index.js"});
        v["contributes"] = json!({
            "commands": [{"id": "go", "title": "Go"}],
            "tiles": [{"id": "x", "title": "X"}], "toolbarItems": [{"id": "x", "title": "X", "command": "go"}]
        });
        assert!(has(&errs(&v), "/contributes/toolbarItems/0/id"));
        // Reserved / sidecar-less CLI commands.
        let mut v = base();
        v["contributes"] = json!({"cliCommands": [{"name": "issues", "summary": "s", "handler": {"type": "sidecar"}}]});
        let e = errs(&v);
        assert!(has(&e, "/contributes/cliCommands/0/name") && has(&e, "/contributes/cliCommands/0/handler"), "{e:?}");
        // Settings schema must be an object schema.
        let mut v = base();
        v["contributes"] = json!({"settings": {"type": "array"}});
        assert!(has(&errs(&v), "/contributes/settings"));
        // Shortcut grammar.
        let mut v = base();
        v["ui"] = json!({"entry": "dist/index.js"});
        v["contributes"] = json!({"commands": [{"id": "a", "title": "A", "shortcut": "Ctrl+Shift+K"}, {"id": "b", "title": "B", "shortcut": "F5"},
                                               {"id": "c", "title": "C", "shortcut": "Ctrl+"}]});
        let e = errs(&v);
        assert!(has(&e, "/contributes/commands/2/shortcut") && e.len() == 1, "{e:?}");
    }

    #[test]
    fn files_must_exist_inside_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("p");
        std::fs::create_dir_all(root.join("dist")).unwrap();
        std::fs::write(root.join("dist/index.js"), "export default {}").unwrap();
        let mut v = base();
        v["ui"] = json!({"entry": "dist/index.js", "style": "dist/index.css"});
        v["icon"] = json!("assets/icon.svg");
        let target = current_target().unwrap();
        v["sidecar"] = json!({"binaries": {target.clone(): "bin/sidecar"}});
        let r = validate_value(&v, Some(&root), &opts());
        assert!(has(&r.errors, "/ui/style") && has(&r.errors, "/icon"), "{:?}", r.errors);
        assert!(has(&r.errors, &format!("/sidecar/binaries/{target}")), "{:?}", r.errors);
        assert!(!has(&r.errors, "/ui/entry"));

        // A binary map without this platform's target.
        let mut v2 = base();
        v2["sidecar"] = json!({"binaries": {"plan9-x86_64": "bin/x"}});
        // (schema rejects unknown target keys)
        assert!(!validate_value(&v2, Some(&root), &opts()).errors.is_empty());
        let other = if target.starts_with("windows") { "linux-x86_64" } else { "windows-x86_64" };
        v2["sidecar"] = json!({"binaries": {other: "bin/x"}});
        let r = validate_value(&v2, Some(&root), &opts());
        assert!(has(&r.errors, "/sidecar/binaries"), "{:?}", r.errors);
        // ... unless this platform is not supported anyway.
        let this = Platform::current().unwrap();
        let others: Vec<_> = ["windows", "macos", "linux"].into_iter().filter(|p| *p != this.as_str()).collect();
        v2["platforms"] = json!(others);
        assert!(validate_value(&v2, Some(&root), &opts()).errors.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("p");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(tmp.path().join("secret.js"), "x").unwrap();
        std::os::unix::fs::symlink(tmp.path().join("secret.js"), root.join("index.js")).unwrap();
        assert!(check_file_in_root(&root, "index.js").unwrap_err().contains("outside"));
    }

    #[test]
    fn validate_dir_reports_unreadable_and_bad_json() {
        let tmp = tempfile::tempdir().unwrap();
        let r = validate_dir(tmp.path(), &opts());
        assert!(!r.is_valid() && r.errors[0].message.contains("cannot read"));
        std::fs::write(tmp.path().join(MANIFEST_FILE), "{ nope").unwrap();
        let r = validate_dir(tmp.path(), &opts());
        assert!(r.errors[0].message.contains("not valid JSON"));
        std::fs::write(tmp.path().join(MANIFEST_FILE), format!("\u{feff}{}", base())).unwrap();
        assert!(validate_dir(tmp.path(), &opts()).is_valid());
    }
}
