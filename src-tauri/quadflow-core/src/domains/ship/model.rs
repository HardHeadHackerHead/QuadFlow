//! Ship schemas (data-layer.md §6.7): `ship/config.json` (shared) and
//! `local/ship/runs/<id>.json` (machine-local run records).
//!
//! Everything is camelCase on disk and over IPC; enum values are snake_case.
//! `ShipPhase` is internally tagged by `type` (snake_case variant names) with
//! camelCase variant fields.

use crate::events::Domain;
use crate::ids::Id;
use crate::model::{Actor, Timestamp};
use crate::store::Entity;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// `ShipConfig.formatVersion` this build reads and writes.
pub const SHIP_FORMAT_VERSION: u32 = 1;

// ================================================================== config

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ShipVersionFileKind {
    Json,
    Toml,
}

/// A file that carries the project version. `key` is a dotted path:
/// `version` (package.json), `package.version` (Cargo.toml),
/// `workspace.package.version`, `project.version` (pyproject.toml).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShipVersionFile {
    pub path: String,
    pub kind: ShipVersionFileKind,
    pub key: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ShipChangelogSource {
    #[default]
    GitLog,
    Manual,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShipChangelogConfig {
    #[serde(default)]
    pub source: ShipChangelogSource,
    /// `last_tag` or any git ref.
    #[serde(default = "default_changelog_since")]
    pub since: String,
}

impl Default for ShipChangelogConfig {
    fn default() -> Self {
        Self { source: ShipChangelogSource::GitLog, since: default_changelog_since() }
    }
}

fn default_changelog_since() -> String {
    "last_tag".into()
}

/// `.quadflow/ship/config.json`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShipConfig {
    /// Must be [`SHIP_FORMAT_VERSION`]; a higher value is `incompatible`.
    pub format_version: u32,
    /// Substituted for `{productName}` (default release titles, notes).
    pub product_name: String,
    /// Files bumped by `version_bump`. Empty = the pipeline has no version
    /// files; `{version}` then resolves to the short git commit hash.
    #[serde(default)]
    pub version_files: Vec<ShipVersionFile>,
    pub phases: Vec<ShipPhase>,
    #[serde(default)]
    pub changelog: ShipChangelogConfig,
}

/// What `git_tag` does when the resolved tag already exists locally.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ShipTagConflict {
    /// Mark the phase skipped and continue.
    #[default]
    Skip,
    Fail,
    /// Delete the existing tag and create it again at HEAD.
    Replace,
    /// Try `<tag>-r2`, `<tag>-r3`, … until one is free.
    Suffix,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ShipTagPush {
    None,
    Tags,
    /// `--follow-tags`
    #[default]
    Follow,
}

/// One typed pipeline step. String fields accept tokens: `{version}`,
/// `{prev_version}`, `{staging_dir}`, `{productName}` and any var stored by an
/// earlier phase (e.g. `{signature}`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ShipPhase {
    /// Pre-flight checks (see `checks::KNOWN_CHECKS`). Fails on any `fail`-level check.
    Checks {
        name: String,
        #[serde(default)]
        checks: Vec<String>,
    },
    /// Create (or recreate) a staging directory; stored as `{staging_dir}`.
    EnsureStagingDir {
        name: String,
        #[serde(default = "default_staging_path")]
        path: String,
        /// Wipe an existing directory first.
        #[serde(default = "default_true")]
        clean: bool,
    },
    /// Read a file's trimmed contents into an env var inherited by later
    /// command-running phases (e.g. `TAURI_SIGNING_PRIVATE_KEY`).
    LoadEnvFromFile {
        name: String,
        var: String,
        file: String,
        #[serde(default)]
        required: bool,
    },
    /// Patch a `tauri.conf.json` (snapshot to `<file>.ship-bak` first; restored
    /// by `restore_tauri_conf`, on failure, and by the next ship invocation).
    PatchTauriConf {
        name: String,
        /// Default `src-tauri/tauri.conf.json`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        before_bundle_command: Option<String>,
        /// `bundle.windows.signCommand` — Tauri signs the app and the installer
        /// with it. `{file}` (or `%1`) is the file to sign.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        windows_sign_command: Option<String>,
        /// `downloadBootstrapper` | `embedBootstrapper` | `offlineInstaller` | `skip`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        webview_install_mode: Option<String>,
    },
    /// Restore a `tauri.conf.json` from its `.ship-bak` (no-op without one).
    RestoreTauriConf {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
    },
    /// Bump every version file (bump kind comes from the run mode).
    VersionBump { name: String },
    /// The build command. Skipped by `--skip-build` / `--reuse-build`.
    Build {
        name: String,
        command: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        working_directory: Option<String>,
        /// Run in a real terminal tile in the GUI (falls back to embedded output
        /// when no host terminal is available, e.g. the CLI).
        #[serde(default)]
        external_terminal: bool,
    },
    /// Windows: fail unless `Get-AuthenticodeSignature` reports `Valid`.
    VerifyAuthenticode { name: String, file: String },
    /// Run a signing command on each matching file. `tool` has no default:
    /// e.g. `signtool sign /fd sha256 /a {file}` or `osslsigncode sign … {file}`.
    /// Without `{file}` the quoted path is appended.
    SignAuthenticode {
        name: String,
        files: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool: Option<String>,
    },
    /// Copy the first match of `sourceGlob` into the staging dir as `destName`.
    StageArtifact { name: String, source_glob: String, dest_name: String },
    /// Read a Tauri updater `.sig` into var `storeAs` (default `signature`).
    ReadUpdaterSig {
        name: String,
        source_glob: String,
        #[serde(default = "default_signature_var")]
        store_as: String,
    },
    /// Write a Tauri `latest.json` updater manifest; merges other platforms from
    /// the manifest already on the GitHub release.
    BuildLatestJson {
        name: String,
        repo: String,
        /// e.g. `windows-x86_64`, `darwin-aarch64`.
        platform: String,
        bundle_name: String,
        #[serde(default = "default_tag")]
        tag: String,
        #[serde(default = "default_signature_var")]
        sig_var: String,
        #[serde(default = "default_latest_json_dest")]
        dest: String,
        #[serde(default = "default_release_text")]
        notes: String,
    },
    /// Create the GitHub release if missing (`gh`), then upload `files` with `--clobber`.
    GhRelease {
        name: String,
        repo: String,
        #[serde(default = "default_tag")]
        tag: String,
        #[serde(default = "default_release_text")]
        title: String,
        #[serde(default = "default_release_text")]
        notes: String,
        /// Release notes from a file (`gh release create --notes-file`), e.g. one
        /// an earlier `shell` phase wrote. Takes precedence over `notes`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        notes_file: Option<String>,
        #[serde(default = "default_true")]
        draft: bool,
        files: Vec<String>,
    },
    /// macOS: `codesign --force --deep --options runtime`.
    CodesignMacos {
        name: String,
        app_bundle: String,
        identity: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        entitlements: Option<String>,
    },
    /// macOS: `xcrun notarytool submit --wait`.
    Notarize { name: String, artifact: String, keychain_profile: String },
    /// macOS: `xcrun stapler staple`.
    StapleNotarization { name: String, artifact: String },
    /// macOS: `create-dmg`, falling back to `hdiutil`.
    CreateDmg {
        name: String,
        app_bundle: String,
        dest: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        volume_name: Option<String>,
    },
    /// Escape hatch: any shell command.
    Shell {
        name: String,
        command: String,
        /// With `skipFlag: "skip-build"`, `--skip-build` skips this phase.
        #[serde(default)]
        skippable: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        skip_flag: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        working_directory: Option<String>,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        env: BTreeMap<String, String>,
        #[serde(default)]
        external_terminal: bool,
    },
    /// `git add` + `git commit`. "nothing to commit" is a skip, not a failure.
    GitCommit {
        name: String,
        message: String,
        /// Paths to add (default: `git add -A`).
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        paths: Vec<String>,
        #[serde(default)]
        sign: bool,
    },
    /// Annotated (or signed) tag.
    GitTag {
        name: String,
        tag: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(default)]
        sign: bool,
        #[serde(default)]
        if_exists: ShipTagConflict,
    },
    /// Push the current branch (and tags per `tagStrategy`).
    GitPush {
        name: String,
        #[serde(default = "default_remote")]
        remote: String,
        #[serde(default)]
        tag_strategy: ShipTagPush,
    },
    /// Write `content` to `path`.
    WriteFile {
        name: String,
        path: String,
        content: String,
        #[serde(default = "default_true")]
        overwrite: bool,
    },
    /// Children run concurrently, each with its own copy of the context;
    /// artifacts/vars/env are merged back afterwards.
    Parallel { name: String, children: Vec<ShipPhase> },
    /// Children run in order sharing the context.
    Sequence { name: String, children: Vec<ShipPhase> },
}

fn default_staging_path() -> String {
    "release/v{version}".into()
}
fn default_true() -> bool {
    true
}
fn default_signature_var() -> String {
    "signature".into()
}
fn default_latest_json_dest() -> String {
    "{staging_dir}/latest.json".into()
}
fn default_tag() -> String {
    "v{version}".into()
}
fn default_release_text() -> String {
    "{productName} v{version}".into()
}
fn default_remote() -> String {
    "origin".into()
}

impl ShipPhase {
    pub fn name(&self) -> &str {
        match self {
            ShipPhase::Checks { name, .. }
            | ShipPhase::EnsureStagingDir { name, .. }
            | ShipPhase::LoadEnvFromFile { name, .. }
            | ShipPhase::PatchTauriConf { name, .. }
            | ShipPhase::RestoreTauriConf { name, .. }
            | ShipPhase::VersionBump { name }
            | ShipPhase::Build { name, .. }
            | ShipPhase::VerifyAuthenticode { name, .. }
            | ShipPhase::SignAuthenticode { name, .. }
            | ShipPhase::StageArtifact { name, .. }
            | ShipPhase::ReadUpdaterSig { name, .. }
            | ShipPhase::BuildLatestJson { name, .. }
            | ShipPhase::GhRelease { name, .. }
            | ShipPhase::CodesignMacos { name, .. }
            | ShipPhase::Notarize { name, .. }
            | ShipPhase::StapleNotarization { name, .. }
            | ShipPhase::CreateDmg { name, .. }
            | ShipPhase::Shell { name, .. }
            | ShipPhase::GitCommit { name, .. }
            | ShipPhase::GitTag { name, .. }
            | ShipPhase::GitPush { name, .. }
            | ShipPhase::WriteFile { name, .. }
            | ShipPhase::Parallel { name, .. }
            | ShipPhase::Sequence { name, .. } => name,
        }
    }

    /// The `type` tag value.
    pub fn kind(&self) -> &'static str {
        match self {
            ShipPhase::Checks { .. } => "checks",
            ShipPhase::EnsureStagingDir { .. } => "ensure_staging_dir",
            ShipPhase::LoadEnvFromFile { .. } => "load_env_from_file",
            ShipPhase::PatchTauriConf { .. } => "patch_tauri_conf",
            ShipPhase::RestoreTauriConf { .. } => "restore_tauri_conf",
            ShipPhase::VersionBump { .. } => "version_bump",
            ShipPhase::Build { .. } => "build",
            ShipPhase::VerifyAuthenticode { .. } => "verify_authenticode",
            ShipPhase::SignAuthenticode { .. } => "sign_authenticode",
            ShipPhase::StageArtifact { .. } => "stage_artifact",
            ShipPhase::ReadUpdaterSig { .. } => "read_updater_sig",
            ShipPhase::BuildLatestJson { .. } => "build_latest_json",
            ShipPhase::GhRelease { .. } => "gh_release",
            ShipPhase::CodesignMacos { .. } => "codesign_macos",
            ShipPhase::Notarize { .. } => "notarize",
            ShipPhase::StapleNotarization { .. } => "staple_notarization",
            ShipPhase::CreateDmg { .. } => "create_dmg",
            ShipPhase::Shell { .. } => "shell",
            ShipPhase::GitCommit { .. } => "git_commit",
            ShipPhase::GitTag { .. } => "git_tag",
            ShipPhase::GitPush { .. } => "git_push",
            ShipPhase::WriteFile { .. } => "write_file",
            ShipPhase::Parallel { .. } => "parallel",
            ShipPhase::Sequence { .. } => "sequence",
        }
    }

    pub fn children(&self) -> &[ShipPhase] {
        match self {
            ShipPhase::Parallel { children, .. } | ShipPhase::Sequence { children, .. } => children,
            _ => &[],
        }
    }
}

// ================================================================== runs

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type, clap::ValueEnum)]
#[serde(rename_all = "snake_case")]
pub enum ShipBumpType {
    Patch,
    Minor,
    Major,
}

/// What a run does to the version: bump it, or (`deploy`) re-ship the
/// current version (skips `version_bump`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type, clap::ValueEnum)]
#[serde(rename_all = "snake_case")]
pub enum ShipRunMode {
    Patch,
    Minor,
    Major,
    Deploy,
}

impl ShipRunMode {
    pub fn bump(self) -> Option<ShipBumpType> {
        match self {
            ShipRunMode::Patch => Some(ShipBumpType::Patch),
            ShipRunMode::Minor => Some(ShipBumpType::Minor),
            ShipRunMode::Major => Some(ShipBumpType::Major),
            ShipRunMode::Deploy => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShipRunOptions {
    pub mode: ShipRunMode,
    /// Resolve and print the plan; nothing is executed or persisted.
    #[serde(default)]
    pub dry_run: bool,
    /// Skip `build` phases and `shell` phases with `skipFlag: "skip-build"`.
    #[serde(default)]
    pub skip_build: bool,
    /// Skip `build` phases and reuse existing artifacts.
    #[serde(default)]
    pub reuse_build: bool,
    /// Force `--draft` on every `gh_release`.
    #[serde(default)]
    pub draft: bool,
}

impl ShipRunOptions {
    pub fn new(mode: ShipRunMode) -> Self {
        Self { mode, dry_run: false, skip_build: false, reuse_build: false, draft: false }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ShipPhaseStatus {
    Pending,
    Running,
    Passed,
    Failed,
    Skipped,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ShipRunStatus {
    InProgress,
    Completed,
    Failed,
    Aborted,
    DryRun,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShipPhaseResult {
    pub name: String,
    /// The phase `type`.
    pub kind: String,
    pub status: ShipPhaseStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// The resolved command line, for command-running phases.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// A URL the phase produced (release page of `gh_release`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<String>,
    /// Results of `parallel` / `sequence` children.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<ShipPhaseResult>,
}

impl ShipPhaseResult {
    pub fn pending(phase: &ShipPhase) -> Self {
        Self {
            name: phase.name().to_string(),
            kind: phase.kind().to_string(),
            status: ShipPhaseStatus::Pending,
            started_at: None,
            completed_at: None,
            duration_ms: None,
            detail: None,
            command: None,
            exit_code: None,
            stdout: None,
            stderr: None,
            error: None,
            url: None,
            artifacts: Vec::new(),
            children: Vec::new(),
        }
    }
}

/// One pipeline execution: `.quadflow/local/ship/runs/<id>.json`. Every run has
/// a fresh id, so runs of the same version never overwrite each other.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShipRun {
    pub id: Id,
    /// The version this run shipped (after the bump).
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_version: Option<String>,
    pub mode: ShipRunMode,
    pub status: ShipRunStatus,
    #[serde(default)]
    pub dry_run: bool,
    pub started_at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<Timestamp>,
    pub started_by: Actor,
    #[serde(default)]
    pub phases: Vec<ShipPhaseResult>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changelog: Option<String>,
}

impl Entity for ShipRun {
    const DOMAIN: Domain = Domain::ShipRuns;
    const DIR: &'static str = "local/ship/runs";
    fn id(&self) -> &Id {
        &self.id
    }
}

impl ShipRun {
    /// The first failed top-level phase, if any.
    pub fn failed_phase(&self) -> Option<&ShipPhaseResult> {
        self.phases.iter().find(|p| p.status == ShipPhaseStatus::Failed)
    }
}

// ================================================================== streaming

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ShipLineStream {
    Stdout,
    Stderr,
    /// Lines the pipeline itself prints (notices, `$ command` echoes).
    Meta,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShipLineEvent {
    /// Run id, or `fix:<checkId>` for a readiness fix.
    pub run_id: String,
    pub phase: String,
    pub stream: ShipLineStream,
    pub line: String,
    pub ts: Timestamp,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShipPhaseEvent {
    pub run_id: Id,
    pub index: u32,
    pub total: u32,
    pub phase: ShipPhaseResult,
}

/// The host is asked to run `command` in a real terminal (GUI tile) and report
/// back with [`ShipExternalResult`] under `requestId`. Phases that need extra
/// env vars (e.g. a key from `load_env_from_file`) never go to a terminal: a
/// tile cannot receive them without echoing them, so those run embedded.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShipExternalRequest {
    pub request_id: String,
    pub run_id: Id,
    pub phase: String,
    pub command: String,
    pub cwd: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShipExternalResult {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// What a [`super::ShipSink`] did with an external request.
#[derive(Clone, Debug, PartialEq)]
pub enum ShipExternalOutcome {
    /// The host ran the command.
    Done(ShipExternalResult),
    /// No host terminal: run the command embedded instead.
    Unavailable,
}

/// Everything the GUI receives over the `ship_run` channel.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ShipRunEvent {
    /// The run record was created (all phases pending).
    Started { run: ShipRun },
    Phase { event: ShipPhaseEvent },
    Line { event: ShipLineEvent },
    ExternalRequest { request: ShipExternalRequest },
    /// Orphan `.ship-bak` files from an earlier crashed run were restored.
    RestoredBackups { files: Vec<String> },
}

// ================================================================== reports

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShipVersionStatus {
    pub file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShipStatus {
    pub in_sync: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical_version: Option<String>,
    pub version_files: Vec<ShipVersionStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run: Option<ShipRun>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_clean: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShipValidation {
    pub valid: bool,
    pub errors: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShipBumpResult {
    pub from: String,
    pub to: String,
    pub dry_run: bool,
    pub files: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShipConfigDeleteResult {
    pub deleted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ShipProjectKind {
    /// `src-tauri/tauri.conf.json`
    Tauri,
    /// `Cargo.toml`
    Cargo,
    /// `package.json`
    Npm,
    /// `pyproject.toml`
    Python,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShipDiagnostics {
    pub project_dir: String,
    pub config_path: String,
    pub config_exists: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_size_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_parse_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_phase_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_check_count: Option<u32>,
    /// `null` when the project shape is not recognized.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_kind: Option<ShipProjectKind>,
    pub runs_dir: String,
    pub run_count: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ShipCheckLevel {
    Pass,
    /// Shown, but does not block a run.
    Warn,
    /// Blocks the `checks` phase.
    Fail,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShipReadinessCheck {
    pub id: String,
    pub label: String,
    pub level: ShipCheckLevel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    /// A non-interactive command that may fix the check (`ship_run_fix`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fix_command: Option<String>,
    /// Declared in the config's first `checks` phase (vs. derived from phases).
    #[serde(default)]
    pub from_config: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ShipTemplateOs {
    Any,
    Windows,
    Macos,
    Linux,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ShipTemplateParamKind {
    Text,
    /// `true|false` (also yes/no, 1/0, on/off).
    Bool,
    /// Comma-separated list.
    List,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShipTemplateParam {
    pub key: String,
    pub label: String,
    pub placeholder: String,
    pub required: bool,
    pub kind: ShipTemplateParamKind,
    /// Value used when the param is omitted (`null` = detected or none).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShipTemplateInfo {
    pub id: String,
    pub label: String,
    pub description: String,
    pub params: Vec<ShipTemplateParam>,
    pub os: ShipTemplateOs,
}

/// `ship init` input.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShipInitOptions {
    /// Template id (`ship templates`); default `minimal`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    /// Template params (`key → value`). Unknown keys are `invalid_input`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, String>,
    /// Overwrite an existing config.
    #[serde(default)]
    pub force: bool,
}

/// `ship detect`: what is installed and what the project looks like.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShipEnvDetection {
    pub project_dir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_kind: Option<ShipProjectKind>,
    /// Name `init` would use for `productName`.
    pub product_name: String,
    pub host_os: ShipTemplateOs,
    /// Tool → on PATH.
    pub tools: BTreeMap<String, bool>,
    pub version_files: Vec<ShipVersionFile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tauri_bundle_targets: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tauri_product_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tauri_main_binary_name: Option<String>,
    pub existing_signing_keys: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gh_user: Option<String>,
    pub gh_release_repos: Vec<String>,
    pub macos_codesign_identities: Vec<String>,
}
