//! Terminal environments (data-layer.md §6.6, §7 `terminal_environments`).
//!
//! Environments are machine state, so they live in the app DB. Scripts refer to
//! an environment by **name** (`Script.environment`), which each machine
//! resolves against its own table: "VS 2022 Community x64" can exist with a
//! different `vcvarsall.bat` path on every developer's machine.
//!
//! [`detect`] scans the machine for shells and toolchains per platform —
//! nothing is hardcoded to `C:\…`; locations come from `PATH`, the standard
//! install-dir environment variables, `vswhere.exe` and `/etc/shells` — and
//! upserts the results as built-in rows keyed by name. Built-ins that are no
//! longer found are kept (scripts may reference them) but marked unavailable.

use crate::error::{CoreError, Result};
use crate::events::{ChangeKind, Domain};
use crate::ids::{new_id, Id};
use crate::model::Timestamp;
use crate::store::{AppChange, AppDb};
use crate::time::now_ms;
use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Operating system a script can run on / detection runs for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TargetPlatform {
    Windows,
    Macos,
    Linux,
}

impl TargetPlatform {
    /// The platform this binary was built for.
    pub fn current() -> TargetPlatform {
        if cfg!(windows) {
            TargetPlatform::Windows
        } else if cfg!(target_os = "macos") {
            TargetPlatform::Macos
        } else {
            TargetPlatform::Linux
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            TargetPlatform::Windows => "windows",
            TargetPlatform::Macos => "macos",
            TargetPlatform::Linux => "linux",
        }
    }

    pub fn parse(s: &str) -> Result<TargetPlatform> {
        match s.trim().to_ascii_lowercase().as_str() {
            "windows" | "win" => Ok(TargetPlatform::Windows),
            "macos" | "mac" | "darwin" => Ok(TargetPlatform::Macos),
            "linux" => Ok(TargetPlatform::Linux),
            other => Err(CoreError::invalid_input(format!(
                "invalid platform {other:?}: expected windows, macos or linux"
            ))),
        }
    }
}

/// A shell a terminal can run.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ShellKind {
    Cmd,
    /// Windows PowerShell 5.1 (`powershell.exe`).
    Powershell,
    /// PowerShell 7+ (`pwsh`).
    Pwsh,
    Bash,
    Zsh,
    Sh,
}

impl ShellKind {
    pub const ALL: [ShellKind; 6] =
        [ShellKind::Cmd, ShellKind::Powershell, ShellKind::Pwsh, ShellKind::Bash, ShellKind::Zsh, ShellKind::Sh];

    pub fn as_str(self) -> &'static str {
        match self {
            ShellKind::Cmd => "cmd",
            ShellKind::Powershell => "powershell",
            ShellKind::Pwsh => "pwsh",
            ShellKind::Bash => "bash",
            ShellKind::Zsh => "zsh",
            ShellKind::Sh => "sh",
        }
    }

    pub fn parse(s: &str) -> Result<ShellKind> {
        let l = s.trim().to_ascii_lowercase();
        ShellKind::ALL.into_iter().find(|k| k.as_str() == l).ok_or_else(|| {
            CoreError::invalid_input(format!("invalid shell {s:?}: expected cmd, powershell, pwsh, bash, zsh or sh"))
        })
    }

    /// The shell a terminal uses when nothing else is configured.
    pub fn platform_default(p: TargetPlatform) -> ShellKind {
        match p {
            TargetPlatform::Windows => ShellKind::Cmd,
            TargetPlatform::Macos => ShellKind::Zsh,
            TargetPlatform::Linux => ShellKind::Bash,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum EnvironmentKind {
    /// A plain system shell (cmd, PowerShell, Git Bash, zsh, …).
    SystemShell,
    /// A Visual Studio developer prompt (`vcvarsall.bat`).
    VsDev,
    /// User-defined.
    Custom,
}

impl EnvironmentKind {
    fn as_str(self) -> &'static str {
        match self {
            EnvironmentKind::SystemShell => "system_shell",
            EnvironmentKind::VsDev => "vs_dev",
            EnvironmentKind::Custom => "custom",
        }
    }

    fn parse(s: &str) -> Result<Self> {
        match s {
            "system_shell" => Ok(Self::SystemShell),
            "vs_dev" => Ok(Self::VsDev),
            "custom" => Ok(Self::Custom),
            other => Err(CoreError::internal(format!("unknown environment kind {other:?} in app DB"))),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum VsArch {
    X64,
    X86,
    Arm64,
}

impl VsArch {
    pub fn as_str(self) -> &'static str {
        match self {
            VsArch::X64 => "x64",
            VsArch::X86 => "x86",
            VsArch::Arm64 => "arm64",
        }
    }
}

/// Visual Studio developer-prompt details.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VsInfo {
    /// Product line version, e.g. `"2022"`.
    pub version: String,
    /// e.g. `"Community"`, `"BuildTools"`.
    pub edition: String,
    pub arch: VsArch,
    pub vcvars_path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalEnvironment {
    pub id: Id,
    /// Unique; what scripts reference (`Script.environment`).
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub kind: EnvironmentKind,
    pub shell: ShellKind,
    /// Absolute path of the shell executable, when known (e.g. Git Bash's `bash.exe`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell_path: Option<String>,
    /// Commands run before a script's own setup (e.g. `call "…vcvarsall.bat" x64`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub init_commands: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vs: Option<VsInfo>,
    /// Created by [`detect`] (vs. user-defined).
    #[serde(default)]
    pub built_in: bool,
    /// False when the last detection no longer found it.
    #[serde(default)]
    pub available: bool,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

/// Create (`id` absent) or replace a user-defined environment.
#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<Id>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub shell: ShellKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell_path: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub init_commands: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
}

impl Default for ShellKind {
    fn default() -> Self {
        ShellKind::platform_default(TargetPlatform::current())
    }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const COLUMNS: &str = "id, name, description, kind, shell, shell_path, init_commands, env, vs, \
                       built_in, available, created_at, updated_at";

fn from_row(r: &Row) -> rusqlite::Result<TerminalEnvironment> {
    fn json<T: serde::de::DeserializeOwned>(idx: usize, s: &str) -> rusqlite::Result<T> {
        serde_json::from_str(s)
            .map_err(|e| rusqlite::Error::FromSqlConversionFailure(idx, rusqlite::types::Type::Text, Box::new(e)))
    }
    fn conv(idx: usize, e: CoreError) -> rusqlite::Error {
        rusqlite::Error::FromSqlConversionFailure(idx, rusqlite::types::Type::Text, Box::new(e))
    }
    let id: String = r.get(0)?;
    let kind: String = r.get(3)?;
    let shell: String = r.get(4)?;
    let init: String = r.get(6)?;
    let env: String = r.get(7)?;
    let vs: Option<String> = r.get(8)?;
    Ok(TerminalEnvironment {
        id: Id::parse(&id).map_err(|e| conv(0, e))?,
        name: r.get(1)?,
        description: r.get(2)?,
        kind: EnvironmentKind::parse(&kind).map_err(|e| conv(3, e))?,
        shell: ShellKind::parse(&shell).map_err(|e| conv(4, e))?,
        shell_path: r.get(5)?,
        init_commands: json(6, &init)?,
        env: json(7, &env)?,
        vs: vs.as_deref().map(|s| json(8, s)).transpose()?,
        built_in: r.get(9)?,
        available: r.get(10)?,
        created_at: r.get(11)?,
        updated_at: r.get(12)?,
    })
}

fn to_json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).expect("serialize environment field")
}

fn insert_or_replace(tx: &rusqlite::Transaction, e: &TerminalEnvironment) -> rusqlite::Result<usize> {
    tx.execute(
        &format!("INSERT OR REPLACE INTO terminal_environments ({COLUMNS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)"),
        params![
            e.id.as_str(),
            e.name,
            e.description,
            e.kind.as_str(),
            e.shell.as_str(),
            e.shell_path,
            to_json(&e.init_commands),
            to_json(&e.env),
            e.vs.as_ref().map(to_json),
            e.built_in,
            e.available,
            e.created_at,
            e.updated_at,
        ],
    )
}

/// All environments: available built-ins first (detection order is by name), then custom.
pub fn list(db: &AppDb) -> Result<Vec<TerminalEnvironment>> {
    db.read(|c| {
        let mut stmt = c.prepare(&format!(
            "SELECT {COLUMNS} FROM terminal_environments ORDER BY built_in DESC, available DESC, name COLLATE NOCASE"
        ))?;
        let rows = stmt.query_map([], from_row)?;
        rows.collect()
    })
}

pub fn get(db: &AppDb, id: &Id) -> Result<TerminalEnvironment> {
    db.read(|c| {
        c.query_row(&format!("SELECT {COLUMNS} FROM terminal_environments WHERE id = ?1"), [id.as_str()], from_row)
            .optional()
    })?
    .ok_or_else(|| CoreError::not_found(format!("terminal environment {id} not found")))
}

/// Look up by name (case-insensitive). `None` if this machine has no such environment.
pub fn find_by_name(db: &AppDb, name: &str) -> Result<Option<TerminalEnvironment>> {
    db.read(|c| {
        c.query_row(
            &format!("SELECT {COLUMNS} FROM terminal_environments WHERE name = ?1 COLLATE NOCASE"),
            [name.trim()],
            from_row,
        )
        .optional()
    })
}

/// Resolve an id or a name (CLI convenience).
pub fn get_by_id_or_name(db: &AppDb, key: &str) -> Result<TerminalEnvironment> {
    if let Ok(id) = Id::parse(key) {
        if let Ok(e) = get(db, &id) {
            return Ok(e);
        }
    }
    find_by_name(db, key)?.ok_or_else(|| CoreError::not_found(format!("terminal environment {key:?} not found")))
}

fn validate_input(input: &EnvironmentInput) -> Result<String> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err(CoreError::invalid_input("environment name must not be empty"));
    }
    for k in input.env.keys() {
        crate::domains::scripts::validate_env_key(k)?;
    }
    if let Some(p) = &input.shell_path {
        if !Path::new(p).is_absolute() {
            return Err(CoreError::invalid_input(format!("shellPath {p:?} must be an absolute path")));
        }
    }
    Ok(name)
}

/// Create or replace a user-defined (`custom`) environment. Built-ins are managed by [`detect`].
pub fn upsert(db: &AppDb, input: EnvironmentInput) -> Result<TerminalEnvironment> {
    let name = validate_input(&input)?;
    let now = now_ms();
    let (id, created_at, kind) = match &input.id {
        Some(id) => {
            let existing = get(db, id)?;
            if existing.built_in {
                return Err(CoreError::invalid_input(format!(
                    "{:?} is a detected environment; create a custom one instead",
                    existing.name
                )));
            }
            (id.clone(), existing.created_at, ChangeKind::Updated)
        }
        None => (new_id(), now, ChangeKind::Created),
    };
    let env = TerminalEnvironment {
        id: id.clone(),
        name,
        description: input.description.filter(|d| !d.trim().is_empty()),
        kind: EnvironmentKind::Custom,
        shell: input.shell,
        shell_path: input.shell_path,
        init_commands: input.init_commands.into_iter().filter(|c| !c.trim().is_empty()).collect(),
        env: input.env,
        vs: None,
        built_in: false,
        available: true,
        created_at,
        updated_at: now,
    };
    let name_taken = find_by_name(db, &env.name)?.filter(|e| e.id != env.id);
    if let Some(other) = name_taken {
        return Err(CoreError::conflict(format!("an environment named {:?} already exists ({})", other.name, other.id)));
    }
    db.write(&[AppChange::new(Domain::Environments, kind, Some(id.as_str()))], |tx| insert_or_replace(tx, &env))?;
    Ok(env)
}

pub fn delete(db: &AppDb, id: &Id) -> Result<()> {
    let n = db.write(&[AppChange::new(Domain::Environments, ChangeKind::Deleted, Some(id.as_str()))], |tx| {
        tx.execute("DELETE FROM terminal_environments WHERE id = ?1", [id.as_str()])
    })?;
    if n == 0 {
        return Err(CoreError::not_found(format!("terminal environment {id} not found")));
    }
    Ok(())
}

/// Scan this machine and upsert the results (built-ins keyed by name). A custom
/// environment with the same name as a detected one wins (the detected one is
/// skipped). Returns the full list afterwards.
pub fn detect(db: &AppDb) -> Result<Vec<TerminalEnvironment>> {
    apply_detected(db, detect_system(&SystemProbe, TargetPlatform::current()))
}

/// Upsert a detection result (separated from [`detect`] for tests).
pub fn apply_detected(db: &AppDb, detected: Vec<DetectedEnvironment>) -> Result<Vec<TerminalEnvironment>> {
    let existing = list(db)?;
    let now = now_ms();
    let mut rows = Vec::new();
    let mut changes = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for d in detected {
        let key = d.name.to_lowercase();
        if !seen.insert(key.clone()) {
            continue;
        }
        let prev = existing.iter().find(|e| e.name.to_lowercase() == key);
        if prev.is_some_and(|p| !p.built_in) {
            continue; // user's custom environment of the same name wins
        }
        let (id, created_at, kind) = match prev {
            Some(p) => (p.id.clone(), p.created_at, ChangeKind::Updated),
            None => (new_id(), now, ChangeKind::Created),
        };
        let row = TerminalEnvironment {
            id,
            name: d.name,
            description: d.description,
            kind: d.kind,
            shell: d.shell,
            shell_path: d.shell_path,
            init_commands: d.init_commands,
            env: BTreeMap::new(),
            vs: d.vs,
            built_in: true,
            available: true,
            created_at,
            updated_at: now,
        };
        if prev.is_some_and(|p| same_detected(p, &row)) {
            continue; // unchanged: no write, no event
        }
        changes.push(AppChange::new(Domain::Environments, kind, Some(row.id.as_str())));
        rows.push(row);
    }
    for e in existing.iter().filter(|e| e.built_in && e.available && !seen.contains(&e.name.to_lowercase())) {
        let mut gone = e.clone();
        gone.available = false;
        gone.updated_at = now;
        changes.push(AppChange::new(Domain::Environments, ChangeKind::Updated, Some(gone.id.as_str())));
        rows.push(gone);
    }
    if !rows.is_empty() {
        db.write(&changes, |tx| {
            for r in &rows {
                insert_or_replace(tx, r)?;
            }
            Ok(())
        })?;
    }
    list(db)
}

fn same_detected(a: &TerminalEnvironment, b: &TerminalEnvironment) -> bool {
    a.available
        && a.description == b.description
        && a.kind == b.kind
        && a.shell == b.shell
        && a.shell_path == b.shell_path
        && a.init_commands == b.init_commands
        && a.vs == b.vs
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/// One environment found on this machine.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DetectedEnvironment {
    pub name: String,
    pub description: Option<String>,
    pub kind: EnvironmentKind,
    pub shell: ShellKind,
    pub shell_path: Option<String>,
    pub init_commands: Vec<String>,
    pub vs: Option<VsInfo>,
}

/// What detection needs from the OS (injectable for tests).
pub trait Probe {
    fn var(&self, key: &str) -> Option<String>;
    fn is_file(&self, path: &Path) -> bool;
    /// Child directory names of `dir` (empty if missing).
    fn list_dirs(&self, dir: &Path) -> Vec<String>;
    fn read_to_string(&self, path: &Path) -> Option<String>;
    /// stdout of `vswhere.exe -all -products * -format json -utf8`.
    fn vswhere(&self, exe: &Path) -> Option<String>;
}

/// The real machine.
pub struct SystemProbe;

impl Probe for SystemProbe {
    fn var(&self, key: &str) -> Option<String> {
        std::env::var(key).ok().filter(|v| !v.trim().is_empty())
    }
    fn is_file(&self, path: &Path) -> bool {
        path.is_file()
    }
    fn list_dirs(&self, dir: &Path) -> Vec<String> {
        let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
        let mut v: Vec<String> = rd
            .flatten()
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        v.sort();
        v
    }
    fn read_to_string(&self, path: &Path) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }
    fn vswhere(&self, exe: &Path) -> Option<String> {
        let mut cmd = std::process::Command::new(exe);
        cmd.args(["-all", "-products", "*", "-format", "json", "-utf8", "-nologo"]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let out = cmd.output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).to_string())
    }
}

/// Join path segments with the target platform's separator (detection can run
/// for another platform in tests).
fn join(platform: TargetPlatform, base: &str, segs: &[&str]) -> PathBuf {
    let sep = if platform == TargetPlatform::Windows { '\\' } else { '/' };
    let mut s = base.trim_end_matches(['\\', '/']).to_string();
    for seg in segs {
        s.push(sep);
        s.push_str(seg);
    }
    PathBuf::from(s)
}

fn parent_str(platform: TargetPlatform, p: &str) -> Option<String> {
    let seps: &[char] = if platform == TargetPlatform::Windows { &['\\', '/'] } else { &['/'] };
    let t = p.trim_end_matches(seps);
    let i = t.rfind(seps)?;
    let parent = &t[..i];
    (!parent.is_empty()).then(|| parent.to_string())
}

/// Find `name` on `PATH` (with `PATHEXT` on Windows).
pub fn which(probe: &dyn Probe, platform: TargetPlatform, name: &str) -> Option<PathBuf> {
    let path = probe.var("PATH").or_else(|| probe.var("Path"))?;
    let sep = if platform == TargetPlatform::Windows { ';' } else { ':' };
    let exts: Vec<String> = if platform == TargetPlatform::Windows {
        let pathext = probe.var("PATHEXT").unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".into());
        let mut v: Vec<String> = pathext.split(';').filter(|e| !e.is_empty()).map(|e| e.to_ascii_lowercase()).collect();
        if !v.iter().any(|e| e == ".exe") {
            v.push(".exe".into());
        }
        v
    } else {
        vec![String::new()]
    };
    for dir in path.split(sep).map(str::trim).filter(|d| !d.is_empty()) {
        let dir = dir.trim_matches('"');
        for ext in &exts {
            let cand = join(platform, dir, &[&format!("{name}{ext}")]);
            if probe.is_file(&cand) {
                return Some(cand);
            }
        }
    }
    None
}

fn first_file(probe: &dyn Probe, cands: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    cands.into_iter().find(|p| probe.is_file(p))
}

fn path_string(p: PathBuf) -> String {
    p.to_string_lossy().to_string()
}

fn shell_env(name: &str, desc: &str, shell: ShellKind, path: PathBuf) -> DetectedEnvironment {
    DetectedEnvironment {
        name: name.into(),
        description: Some(desc.into()),
        kind: EnvironmentKind::SystemShell,
        shell,
        shell_path: Some(path_string(path)),
        init_commands: Vec::new(),
        vs: None,
    }
}

/// Scan for shells and toolchains on `platform`.
pub fn detect_system(probe: &dyn Probe, platform: TargetPlatform) -> Vec<DetectedEnvironment> {
    match platform {
        TargetPlatform::Windows => detect_windows(probe),
        TargetPlatform::Macos | TargetPlatform::Linux => detect_unix(probe, platform),
    }
}

fn detect_windows(probe: &dyn Probe) -> Vec<DetectedEnvironment> {
    let w = TargetPlatform::Windows;
    let mut out = Vec::new();
    let system_root = probe.var("SystemRoot").or_else(|| probe.var("windir"));
    let sys32 = |segs: &[&str]| system_root.as_deref().map(|r| join(w, r, &[&["System32"], segs].concat()));

    // Command Prompt
    let cmd = first_file(
        probe,
        [probe.var("ComSpec").map(PathBuf::from), sys32(&["cmd.exe"])].into_iter().flatten(),
    )
    .or_else(|| which(probe, w, "cmd"));
    if let Some(p) = cmd {
        out.push(shell_env("Command Prompt", "Windows Command Prompt (cmd.exe)", ShellKind::Cmd, p));
    }

    // Windows PowerShell 5.1
    let ps = first_file(probe, sys32(&["WindowsPowerShell", "v1.0", "powershell.exe"])).or_else(|| which(probe, w, "powershell"));
    if let Some(p) = ps {
        out.push(shell_env("Windows PowerShell", "Windows PowerShell 5.1 (powershell.exe)", ShellKind::Powershell, p));
    }

    // PowerShell 7+
    let pwsh = which(probe, w, "pwsh").or_else(|| {
        let mut c = Vec::new();
        for var in ["ProgramFiles", "ProgramW6432"] {
            if let Some(pf) = probe.var(var) {
                let base = join(w, &pf, &["PowerShell"]);
                let base_s = path_string(base.clone());
                let mut versions = probe.list_dirs(&base);
                versions.sort_by(|a, b| b.cmp(a)); // newest major first
                for v in versions {
                    c.push(join(w, &base_s, &[&v, "pwsh.exe"]));
                }
            }
        }
        first_file(probe, c)
    });
    if let Some(p) = pwsh {
        out.push(shell_env("PowerShell 7", "PowerShell 7+ (pwsh.exe)", ShellKind::Pwsh, p));
    }

    // Git Bash: next to git.exe on PATH, else the standard install locations.
    if let Some(p) = find_git_bash(probe) {
        out.push(shell_env("Git Bash", "Git for Windows Bash", ShellKind::Bash, p));
    }

    // Visual Studio developer prompts
    out.extend(detect_visual_studio(probe));
    out
}

fn find_git_bash(probe: &dyn Probe) -> Option<PathBuf> {
    let w = TargetPlatform::Windows;
    let mut cands = Vec::new();
    if let Some(git) = which(probe, w, "git") {
        // <Git>\cmd\git.exe, <Git>\bin\git.exe, <Git>\mingw64\bin\git.exe
        let mut dir = parent_str(w, &path_string(git));
        for _ in 0..3 {
            let Some(d) = dir.clone() else { break };
            if let Some(up) = parent_str(w, &d) {
                cands.push(join(w, &up, &["bin", "bash.exe"]));
            }
            dir = parent_str(w, &d);
        }
    }
    for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Some(pf) = probe.var(var) {
            cands.push(join(w, &pf, &["Git", "bin", "bash.exe"]));
        }
    }
    if let Some(la) = probe.var("LOCALAPPDATA") {
        cands.push(join(w, &la, &["Programs", "Git", "bin", "bash.exe"]));
    }
    if let Some(home) = probe.var("USERPROFILE") {
        cands.push(join(w, &home, &["scoop", "apps", "git", "current", "bin", "bash.exe"]));
    }
    // Never pick WSL's System32\bash.exe.
    let wsl = probe.var("SystemRoot").map(|r| path_string(join(w, &r, &["System32", "bash.exe"])).to_lowercase());
    cands.retain(|c| Some(path_string(c.clone()).to_lowercase()) != wsl);
    first_file(probe, cands)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VsWhereEntry {
    installation_path: String,
    #[serde(default)]
    product_id: Option<String>,
    #[serde(default)]
    catalog: Option<VsWhereCatalog>,
    #[serde(default)]
    installation_version: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VsWhereCatalog {
    #[serde(default)]
    product_line_version: Option<String>,
}

struct VsInstall {
    version: String,
    edition: String,
    vcvars: PathBuf,
}

fn detect_visual_studio(probe: &dyn Probe) -> Vec<DetectedEnvironment> {
    let w = TargetPlatform::Windows;
    let mut installs: Vec<VsInstall> = Vec::new();
    let vcvars_in = |root: &str| join(w, root, &["VC", "Auxiliary", "Build", "vcvarsall.bat"]);

    // 1. vswhere (ships with every VS 2017+ installer).
    let pf86 = probe.var("ProgramFiles(x86)");
    if let Some(pf86) = &pf86 {
        let exe = join(w, pf86, &["Microsoft Visual Studio", "Installer", "vswhere.exe"]);
        if probe.is_file(&exe) {
            if let Some(json) = probe.vswhere(&exe) {
                if let Ok(entries) = serde_json::from_str::<Vec<VsWhereEntry>>(&json) {
                    for e in entries {
                        let vcvars = vcvars_in(&e.installation_path);
                        if !probe.is_file(&vcvars) {
                            continue;
                        }
                        let version = e
                            .catalog
                            .and_then(|c| c.product_line_version)
                            .or_else(|| e.installation_version.and_then(|v| v.split('.').next().map(str::to_string)))
                            .unwrap_or_else(|| "?".into());
                        let edition = e
                            .product_id
                            .as_deref()
                            .and_then(|p| p.rsplit('.').next())
                            .map(str::to_string)
                            .or_else(|| e.installation_path.rsplit(['\\', '/']).next().map(str::to_string))
                            .unwrap_or_else(|| "VS".into());
                        installs.push(VsInstall { version, edition, vcvars });
                    }
                }
            }
        }
    }

    // 2. Fallback: scan "<ProgramFiles*>\Microsoft Visual Studio\<version>\<edition>".
    if installs.is_empty() {
        for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            let Some(pf) = probe.var(var) else { continue };
            let base = join(w, &pf, &["Microsoft Visual Studio"]);
            let base_s = path_string(base.clone());
            for version in probe.list_dirs(&base) {
                if version == "Installer" || version == "Shared" {
                    continue;
                }
                let vdir = join(w, &base_s, &[&version]);
                for edition in probe.list_dirs(&vdir) {
                    let root = path_string(join(w, &base_s, &[&version, &edition]));
                    let vcvars = vcvars_in(&root);
                    let dup = installs.iter().any(|i| path_string(i.vcvars.clone()).eq_ignore_ascii_case(&path_string(vcvars.clone())));
                    if !dup && probe.is_file(&vcvars) {
                        installs.push(VsInstall { version: version.clone(), edition, vcvars });
                    }
                }
            }
        }
    }

    installs.sort_by(|a, b| b.version.cmp(&a.version).then(a.edition.cmp(&b.edition)));
    let host_arm = probe
        .var("PROCESSOR_ARCHITECTURE")
        .is_some_and(|a| a.eq_ignore_ascii_case("ARM64"));
    let arches: &[VsArch] = if host_arm { &[VsArch::Arm64, VsArch::X64] } else { &[VsArch::X64, VsArch::X86] };
    let mut out = Vec::new();
    for i in installs {
        let vcvars = path_string(i.vcvars);
        for arch in arches {
            out.push(DetectedEnvironment {
                name: format!("VS {} {} {}", i.version, i.edition, arch.as_str()),
                description: Some(format!("Visual Studio {} {} developer prompt ({})", i.version, i.edition, arch.as_str())),
                kind: EnvironmentKind::VsDev,
                shell: ShellKind::Cmd,
                shell_path: None,
                init_commands: vec![format!("call \"{vcvars}\" {}", arch.as_str())],
                vs: Some(VsInfo {
                    version: i.version.clone(),
                    edition: i.edition.clone(),
                    arch: *arch,
                    vcvars_path: vcvars.clone(),
                }),
            });
        }
    }
    out
}

fn detect_unix(probe: &dyn Probe, platform: TargetPlatform) -> Vec<DetectedEnvironment> {
    let login = probe.var("SHELL");
    let etc_shells: Vec<String> = probe
        .read_to_string(Path::new("/etc/shells"))
        .map(|s| {
            s.lines()
                .map(str::trim)
                .filter(|l| !l.is_empty() && !l.starts_with('#'))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let base = |p: &str| p.rsplit('/').next().unwrap_or(p).to_string();
    let kinds: [(ShellKind, &str, &str); 4] = [
        (ShellKind::Zsh, "zsh", "Zsh"),
        (ShellKind::Bash, "bash", "Bash"),
        (ShellKind::Sh, "sh", "POSIX sh"),
        (ShellKind::Pwsh, "pwsh", "PowerShell 7"),
    ];
    let mut out = Vec::new();
    for (kind, bin, name) in kinds {
        let from_login = login.as_deref().filter(|l| base(l) == bin && probe.is_file(Path::new(l))).map(PathBuf::from);
        let found = from_login
            .clone()
            .or_else(|| which(probe, platform, bin))
            .or_else(|| first_file(probe, etc_shells.iter().filter(|s| base(s) == bin).map(PathBuf::from)));
        if let Some(p) = found {
            let desc = if from_login.is_some() { format!("{name} (login shell)") } else { name.to_string() };
            out.push(shell_env(name, &desc, kind, p));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempApp;
    use std::collections::{BTreeSet, HashMap};

    #[derive(Default)]
    struct FakeProbe {
        vars: HashMap<String, String>,
        files: BTreeSet<String>,
        vswhere: Option<String>,
    }
    impl FakeProbe {
        fn var(mut self, k: &str, v: &str) -> Self {
            self.vars.insert(k.into(), v.into());
            self
        }
        fn file(mut self, p: &str) -> Self {
            self.files.insert(p.to_string());
            self
        }
    }
    impl Probe for FakeProbe {
        fn var(&self, key: &str) -> Option<String> {
            self.vars.get(key).cloned()
        }
        fn is_file(&self, path: &Path) -> bool {
            let p = path.to_string_lossy().to_lowercase();
            self.files.iter().any(|f| f.to_lowercase() == p)
        }
        fn list_dirs(&self, dir: &Path) -> Vec<String> {
            let prefix = format!("{}\\", dir.to_string_lossy().to_lowercase());
            let mut set = BTreeSet::new();
            for f in &self.files {
                if f.to_lowercase().starts_with(&prefix) {
                    let rest = &f[prefix.len()..];
                    if let Some((first, _)) = rest.split_once('\\') {
                        set.insert(first.to_string());
                    }
                }
            }
            set.into_iter().collect()
        }
        fn read_to_string(&self, path: &Path) -> Option<String> {
            self.vars.get(&format!("file:{}", path.display())).cloned()
        }
        fn vswhere(&self, _exe: &Path) -> Option<String> {
            self.vswhere.clone()
        }
    }

    fn names(v: &[DetectedEnvironment]) -> Vec<&str> {
        v.iter().map(|d| d.name.as_str()).collect()
    }

    #[test]
    fn windows_detection_uses_env_vars_and_path() {
        let p = FakeProbe::default()
            .var("SystemRoot", r"D:\Win")
            .var("ComSpec", r"D:\Win\System32\cmd.exe")
            .var("ProgramFiles", r"E:\Apps")
            .var("ProgramFiles(x86)", r"E:\Apps86")
            .var("PATH", r"D:\Win\System32;F:\Tools\Git\cmd")
            .var("PATHEXT", ".COM;.EXE")
            .file(r"D:\Win\System32\cmd.exe")
            .file(r"D:\Win\System32\WindowsPowerShell\v1.0\powershell.exe")
            .file(r"D:\Win\System32\bash.exe") // WSL: must be ignored
            .file(r"F:\Tools\Git\cmd\git.exe")
            .file(r"F:\Tools\Git\bin\bash.exe")
            .file(r"E:\Apps\PowerShell\7\pwsh.exe")
            .file(r"E:\Apps\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat");
        let d = detect_system(&p, TargetPlatform::Windows);
        assert_eq!(
            names(&d),
            vec![
                "Command Prompt",
                "Windows PowerShell",
                "PowerShell 7",
                "Git Bash",
                "VS 2022 BuildTools x64",
                "VS 2022 BuildTools x86"
            ]
        );
        let bash = &d[3];
        assert_eq!(bash.shell, ShellKind::Bash);
        assert_eq!(bash.shell_path.as_deref(), Some(r"F:\Tools\Git\bin\bash.exe"));
        let vs = &d[4];
        assert_eq!(
            vs.init_commands,
            vec![r#"call "E:\Apps\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" x64"#]
        );
        assert_eq!(vs.vs.as_ref().unwrap().edition, "BuildTools");
    }

    #[test]
    fn windows_vswhere_and_missing_git() {
        let p = FakeProbe {
            vswhere: Some(
                r#"[{"installationPath":"G:\\VS\\Pro","productId":"Microsoft.VisualStudio.Product.Professional","catalog":{"productLineVersion":"2026"}},
                    {"installationPath":"G:\\VS\\Gone","productId":"Microsoft.VisualStudio.Product.Community"}]"#
                    .into(),
            ),
            ..Default::default()
        }
        .var("ProgramFiles(x86)", r"E:\Apps86")
        .var("PROCESSOR_ARCHITECTURE", "ARM64")
        .file(r"E:\Apps86\Microsoft Visual Studio\Installer\vswhere.exe")
        .file(r"G:\VS\Pro\VC\Auxiliary\Build\vcvarsall.bat");
        let d = detect_system(&p, TargetPlatform::Windows);
        assert_eq!(names(&d), vec!["VS 2026 Professional arm64", "VS 2026 Professional x64"]);
    }

    #[test]
    fn unix_detection() {
        let p = FakeProbe::default()
            .var("SHELL", "/opt/homebrew/bin/zsh")
            .var("PATH", "/usr/local/bin:/usr/bin:/bin")
            .var("file:/etc/shells", "# comment\n/bin/sh\n/bin/bash\n/opt/homebrew/bin/zsh\n")
            .file("/opt/homebrew/bin/zsh")
            .file("/bin/bash")
            .file("/bin/sh");
        let d = detect_system(&p, TargetPlatform::Macos);
        assert_eq!(names(&d), vec!["Zsh", "Bash", "POSIX sh"]);
        assert_eq!(d[0].description.as_deref(), Some("Zsh (login shell)"));
        assert_eq!(d[0].shell_path.as_deref(), Some("/opt/homebrew/bin/zsh"));
        assert_eq!(d[1].shell_path.as_deref(), Some("/bin/bash"));
    }

    fn detected(name: &str, shell: ShellKind) -> DetectedEnvironment {
        DetectedEnvironment {
            name: name.into(),
            description: None,
            kind: EnvironmentKind::SystemShell,
            shell,
            shell_path: None,
            init_commands: vec![],
            vs: None,
        }
    }

    #[test]
    fn crud_and_apply_detected() {
        let app = TempApp::new();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let s2 = seen.clone();
        app.db.bus().subscribe(move |e| s2.lock().unwrap().push(e.clone()));

        let all = apply_detected(&app.db, vec![detected("Bash", ShellKind::Bash), detected("Zsh", ShellKind::Zsh)]).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().all(|e| e.built_in && e.available));
        let bash_id = all.iter().find(|e| e.name == "Bash").unwrap().id.clone();
        assert_eq!(seen.lock().unwrap().len(), 1);

        // Unchanged re-detect writes nothing.
        apply_detected(&app.db, vec![detected("Bash", ShellKind::Bash), detected("Zsh", ShellKind::Zsh)]).unwrap();
        assert_eq!(seen.lock().unwrap().len(), 1);

        // Custom env; duplicate name → conflict; same name as a detected one wins over detection.
        let custom = upsert(
            &app.db,
            EnvironmentInput { name: "Node 20".into(), shell: ShellKind::Bash, init_commands: vec!["nvm use 20".into()], ..Default::default() },
        )
        .unwrap();
        assert_eq!(custom.kind, EnvironmentKind::Custom);
        let e = upsert(&app.db, EnvironmentInput { name: "node 20".into(), shell: ShellKind::Sh, ..Default::default() }).unwrap_err();
        assert_eq!(e.code, crate::ErrorCode::Conflict);
        let e = upsert(&app.db, EnvironmentInput { id: Some(bash_id.clone()), name: "Bash".into(), shell: ShellKind::Sh, ..Default::default() })
            .unwrap_err();
        assert_eq!(e.code, crate::ErrorCode::InvalidInput);

        // Zsh disappears → unavailable (kept, same id); Bash keeps its id.
        let all = apply_detected(&app.db, vec![detected("Bash", ShellKind::Bash), detected("Node 20", ShellKind::Zsh)]).unwrap();
        let zsh = all.iter().find(|e| e.name == "Zsh").unwrap();
        assert!(!zsh.available);
        assert_eq!(all.iter().find(|e| e.name == "Bash").unwrap().id, bash_id);
        let node = find_by_name(&app.db, "NODE 20").unwrap().unwrap();
        assert_eq!(node.kind, EnvironmentKind::Custom);
        assert_eq!(node.init_commands, vec!["nvm use 20"]);

        assert_eq!(get_by_id_or_name(&app.db, custom.id.as_str()).unwrap().name, "Node 20");
        delete(&app.db, &custom.id).unwrap();
        assert_eq!(delete(&app.db, &custom.id).unwrap_err().code, crate::ErrorCode::NotFound);
        assert!(find_by_name(&app.db, "Node 20").unwrap().is_none());
    }

    #[test]
    fn real_machine_detection_finds_a_shell() {
        let d = detect_system(&SystemProbe, TargetPlatform::current());
        assert!(!d.is_empty(), "no shell detected on this machine");
        for e in &d {
            if let Some(p) = &e.shell_path {
                assert!(Path::new(p).is_file(), "{p}");
            }
        }
    }
}
