//! Scripts and script groups (data-layer.md §6.6): `scripts/<id>.json`,
//! `script-groups/<id>.json`.
//!
//! A script names its terminal environment by **name**; [`resolve_command`]
//! resolves that name against this machine's environments (app DB, see
//! [`super::environments`]) and composes the exact command line for the shell.

use super::environments::{self, TargetPlatform, ShellKind, TerminalEnvironment};
use crate::error::{CoreError, Result};
use crate::events::Domain;
use crate::ids::{new_id, Id};
use crate::model::{Actor, Ext, ListResult, Timestamp};
use crate::store::{AppDb, Entity, ProjectStore, Tx};
use crate::time::now_ms;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Component, Path};
use std::sync::OnceLock;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ScriptKind {
    /// Runs and exits.
    #[default]
    Command,
    /// Long-running (dev server); may have a preview URL.
    Server,
    Build,
}

impl ScriptGroupMemberInput {
    pub fn new(script_id: Id) -> Self {
        Self { script_id, order: None, delay_ms: None, auto_open_preview: None }
    }
}

impl ScriptKind {
    pub fn parse(s: &str) -> Result<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "command" => Ok(Self::Command),
            "server" => Ok(Self::Server),
            "build" => Ok(Self::Build),
            o => Err(CoreError::invalid_input(format!("invalid script kind {o:?}: expected command, server or build"))),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ScriptGroupMode {
    /// Start every member (each after its `delayMs`).
    #[default]
    Parallel,
    /// Start each member after the previous one exits.
    Sequential,
}

impl ScriptGroupMode {
    pub fn parse(s: &str) -> Result<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "parallel" => Ok(Self::Parallel),
            "sequential" => Ok(Self::Sequential),
            o => Err(CoreError::invalid_input(format!("invalid group mode {o:?}: expected parallel or sequential"))),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Script {
    pub id: Id,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub command: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub setup_commands: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// Empty = all platforms.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub platforms: Vec<TargetPlatform>,
    /// `None` = the environment's shell, else the platform default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<ShellKind>,
    /// Relative to the project root; never escapes it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,
    /// Terminal environment **name** (resolved per machine).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
    #[serde(default)]
    pub kind: ScriptKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_url: Option<String>,
    #[serde(default)]
    pub auto_open_preview: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub archived: bool,
    pub created_at: Timestamp,
    pub created_by: Actor,
    pub updated_at: Timestamp,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[specta(type = BTreeMap<String, crate::model::JsonValue>)]
    pub ext: Ext,
}

impl Entity for Script {
    const DOMAIN: Domain = Domain::Scripts;
    const DIR: &'static str = "scripts";
    fn id(&self) -> &Id {
        &self.id
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ScriptGroupMember {
    pub script_id: Id,
    /// 0-based position; members are kept sorted and renumbered.
    pub order: u32,
    /// Parallel mode: wait this long before starting this member.
    #[serde(default)]
    pub delay_ms: u32,
    #[serde(default)]
    pub auto_open_preview: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ScriptGroup {
    pub id: Id,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub members: Vec<ScriptGroupMember>,
    #[serde(default)]
    pub mode: ScriptGroupMode,
    pub created_at: Timestamp,
    pub created_by: Actor,
    pub updated_at: Timestamp,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[specta(type = BTreeMap<String, crate::model::JsonValue>)]
    pub ext: Ext,
}

impl Entity for ScriptGroup {
    const DOMAIN: Domain = Domain::ScriptGroups;
    const DIR: &'static str = "script-groups";
    fn id(&self) -> &Id {
        &self.id
    }
}

// ---- inputs -----------------------------------------------------------------

#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ScriptInput {
    pub name: String,
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub setup_commands: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub platforms: Vec<TargetPlatform>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<ShellKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<ScriptKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_url: Option<String>,
    #[serde(default)]
    pub auto_open_preview: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default)]
    pub pinned: bool,
}

/// Absent = unchanged; for `Option<Option<_>>` fields `null` = clear.
#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ScriptPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<String>)]
    pub description: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_commands: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platforms: Option<Vec<TargetPlatform>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<ShellKind>)]
    pub shell: Option<Option<ShellKind>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<String>)]
    pub working_directory: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<String>)]
    pub environment: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<ScriptKind>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<String>)]
    pub preview_url: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_open_preview: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ScriptQuery {
    /// Case-insensitive substring of name / description / command / tags.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    /// Only pinned scripts.
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub include_archived: bool,
    /// Only scripts that run on this platform.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<TargetPlatform>,
}

#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ScriptGroupMemberInput {
    pub script_id: Id,
    /// Position (default: append).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_open_preview: Option<bool>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ScriptGroupInput {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<ScriptGroupMode>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub members: Vec<ScriptGroupMemberInput>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ScriptGroupPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<String>)]
    pub description: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<ScriptGroupMode>,
    /// Replaces the member list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub members: Option<Vec<ScriptGroupMemberInput>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ScriptResolveOptions {
    /// Default: the platform this process runs on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<TargetPlatform>,
    /// Environment name used when the script names none (GUI default environment).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_environment: Option<String>,
}

/// Everything needed to run a script in a terminal on this machine.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ScriptResolvedCommand {
    pub script_id: Id,
    pub script_name: String,
    pub platform: TargetPlatform,
    pub shell: ShellKind,
    /// Absolute shell executable when the environment knows it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<TerminalEnvironment>,
    /// Absolute working directory.
    pub cwd: String,
    /// Environment init commands, then the script's setup commands.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub setup: Vec<String>,
    pub command: String,
    /// Environment's env merged with the script's (script wins).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// The command line for `shell`: env assignments, setup, command (no trailing
    /// newline). For cmd with env vars the `set`s come first on their own line.
    pub full_command: String,
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

fn env_key_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*$").unwrap())
}

pub fn validate_env_key(k: &str) -> Result<()> {
    if env_key_re().is_match(k) {
        Ok(())
    } else {
        Err(CoreError::invalid_input(format!("invalid environment variable name {k:?}")))
    }
}

fn required(field: &str, v: &str) -> Result<String> {
    let t = v.trim();
    if t.is_empty() {
        Err(CoreError::invalid_input(format!("{field} must not be empty")))
    } else {
        Ok(t.to_string())
    }
}

fn non_empty(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Relative, inside the project: no absolute paths, drive letters or `..`.
pub fn validate_working_directory(wd: &str) -> Result<Option<String>> {
    let t = wd.trim().replace('\\', "/");
    let t = t.trim_end_matches('/');
    if t.is_empty() || t == "." {
        return Ok(None);
    }
    let bad = || CoreError::invalid_input(format!("workingDirectory {wd:?} must be a path inside the project (relative, no \"..\")"));
    if t.starts_with('/') || t.chars().nth(1) == Some(':') {
        return Err(bad());
    }
    for c in Path::new(t).components() {
        match c {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err(bad()),
        }
    }
    if t.split('/').any(|s| s == "..") {
        return Err(bad());
    }
    Ok(Some(t.to_string()))
}

fn clean_list(v: Vec<String>) -> Vec<String> {
    v.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
}

fn clean_tags(v: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in v {
        let t = t.trim().to_lowercase();
        if !t.is_empty() && !out.contains(&t) {
            out.push(t);
        }
    }
    out
}

fn clean_platforms(mut v: Vec<TargetPlatform>) -> Vec<TargetPlatform> {
    v.sort();
    v.dedup();
    if v.len() == 3 {
        v.clear(); // all = empty
    }
    v
}

fn validate_env(env: &BTreeMap<String, String>) -> Result<()> {
    env.keys().try_for_each(|k| validate_env_key(k))
}

fn validate_script(s: &Script) -> Result<()> {
    required("name", &s.name)?;
    required("command", &s.command)?;
    validate_env(&s.env)?;
    if let Some(wd) = &s.working_directory {
        validate_working_directory(wd)?;
    }
    if s.environment.as_deref().is_some_and(|e| e.trim().is_empty()) {
        return Err(CoreError::invalid_input("environment must not be empty"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

fn matches(s: &Script, q: &ScriptQuery) -> bool {
    if s.archived && !q.include_archived {
        return false;
    }
    if q.pinned && !s.pinned {
        return false;
    }
    if let Some(tag) = q.tag.as_deref().map(|t| t.trim().to_lowercase()).filter(|t| !t.is_empty()) {
        if !s.tags.contains(&tag) {
            return false;
        }
    }
    if let Some(p) = q.platform {
        if !s.platforms.is_empty() && !s.platforms.contains(&p) {
            return false;
        }
    }
    if let Some(text) = q.text.as_deref().map(|t| t.trim().to_lowercase()).filter(|t| !t.is_empty()) {
        let hay = [Some(&s.name), s.description.as_ref(), Some(&s.command)];
        let hit = hay.iter().flatten().any(|f| f.to_lowercase().contains(&text)) || s.tags.iter().any(|t| t.contains(&text));
        if !hit {
            return false;
        }
    }
    true
}

/// Matching scripts: pinned first, then by name.
pub fn list(store: &ProjectStore, q: &ScriptQuery) -> Result<ListResult<Script>> {
    let mut all = store.list::<Script>()?;
    all.items.retain(|s| matches(s, q));
    all.items.sort_by(|a, b| b.pinned.cmp(&a.pinned).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(all)
}

pub fn get(store: &ProjectStore, id: &Id) -> Result<Script> {
    store.get(id)
}

pub fn create(store: &ProjectStore, actor: &Actor, input: ScriptInput) -> Result<Script> {
    let now = now_ms();
    let s = Script {
        id: new_id(),
        name: required("name", &input.name)?,
        description: non_empty(input.description),
        command: required("command", &input.command)?,
        setup_commands: clean_list(input.setup_commands),
        env: input.env,
        platforms: clean_platforms(input.platforms),
        shell: input.shell,
        working_directory: input.working_directory.as_deref().map(validate_working_directory).transpose()?.flatten(),
        environment: non_empty(input.environment),
        kind: input.kind.unwrap_or_default(),
        preview_url: non_empty(input.preview_url),
        auto_open_preview: input.auto_open_preview,
        tags: clean_tags(input.tags),
        pinned: input.pinned,
        archived: false,
        created_at: now,
        created_by: actor.clone(),
        updated_at: now,
        ext: Ext::new(),
    };
    validate_script(&s)?;
    store.write(actor, |tx| {
        tx.put(&s)?;
        Ok(s.clone())
    })
}

pub fn update(store: &ProjectStore, actor: &Actor, id: &Id, patch: ScriptPatch) -> Result<Script> {
    store.write(actor, |tx| {
        let mut s: Script = tx.get(id)?;
        if let Some(v) = patch.name {
            s.name = required("name", &v)?;
        }
        if let Some(v) = patch.command {
            s.command = required("command", &v)?;
        }
        if let Some(v) = patch.description {
            s.description = non_empty(v);
        }
        if let Some(v) = patch.setup_commands {
            s.setup_commands = clean_list(v);
        }
        if let Some(v) = patch.env {
            s.env = v;
        }
        if let Some(v) = patch.platforms {
            s.platforms = clean_platforms(v);
        }
        if let Some(v) = patch.shell {
            s.shell = v;
        }
        if let Some(v) = patch.working_directory {
            s.working_directory = v.as_deref().map(validate_working_directory).transpose()?.flatten();
        }
        if let Some(v) = patch.environment {
            s.environment = non_empty(v);
        }
        if let Some(v) = patch.kind {
            s.kind = v;
        }
        if let Some(v) = patch.preview_url {
            s.preview_url = non_empty(v);
        }
        if let Some(v) = patch.auto_open_preview {
            s.auto_open_preview = v;
        }
        if let Some(v) = patch.tags {
            s.tags = clean_tags(v);
        }
        if let Some(v) = patch.pinned {
            s.pinned = v;
        }
        if let Some(v) = patch.archived {
            s.archived = v;
        }
        validate_script(&s)?;
        s.updated_at = now_ms();
        tx.put(&s)?;
        Ok(s)
    })
}

/// Delete a script and remove it from every group.
pub fn delete(store: &ProjectStore, actor: &Actor, id: &Id) -> Result<()> {
    store.write(actor, |tx| {
        tx.delete::<Script>(id)?;
        for mut g in tx.list::<ScriptGroup>()?.items {
            let before = g.members.len();
            g.members.retain(|m| &m.script_id != id);
            if g.members.len() != before {
                renumber(&mut g.members);
                g.updated_at = now_ms();
                tx.put(&g)?;
            }
        }
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

fn renumber(members: &mut [ScriptGroupMember]) {
    members.sort_by_key(|m| m.order);
    for (i, m) in members.iter_mut().enumerate() {
        m.order = i as u32;
    }
}

/// Insert a member at `input.order` (default: end), shifting later members.
fn add_member_in(tx: &Tx, members: &mut Vec<ScriptGroupMember>, input: ScriptGroupMemberInput) -> Result<()> {
    let _: Script = tx.get(&input.script_id).map_err(|e| {
        if e.code == crate::ErrorCode::NotFound {
            CoreError::not_found(format!("script {} not found", input.script_id))
        } else {
            e
        }
    })?;
    if members.iter().any(|m| m.script_id == input.script_id) {
        return Err(CoreError::conflict(format!("script {} is already in this group", input.script_id)));
    }
    renumber(members);
    let pos = input.order.map(|o| (o as usize).min(members.len())).unwrap_or(members.len());
    members.insert(
        pos,
        ScriptGroupMember {
            script_id: input.script_id,
            order: 0,
            delay_ms: input.delay_ms.unwrap_or(0),
            auto_open_preview: input.auto_open_preview.unwrap_or(false),
        },
    );
    for (i, m) in members.iter_mut().enumerate() {
        m.order = i as u32;
    }
    Ok(())
}

pub fn groups_list(store: &ProjectStore) -> Result<ListResult<ScriptGroup>> {
    let mut all = store.list::<ScriptGroup>()?;
    all.items.sort_by_key(|g| g.name.to_lowercase());
    Ok(all)
}

pub fn group_get(store: &ProjectStore, id: &Id) -> Result<ScriptGroup> {
    store.get(id)
}

pub fn group_create(store: &ProjectStore, actor: &Actor, input: ScriptGroupInput) -> Result<ScriptGroup> {
    let name = required("name", &input.name)?;
    store.write(actor, |tx| {
        let now = now_ms();
        let mut members = Vec::new();
        for m in input.members {
            add_member_in(tx, &mut members, m)?;
        }
        let g = ScriptGroup {
            id: new_id(),
            name,
            description: non_empty(input.description),
            members,
            mode: input.mode.unwrap_or_default(),
            created_at: now,
            created_by: tx.actor().clone(),
            updated_at: now,
            ext: Ext::new(),
        };
        tx.put(&g)?;
        Ok(g)
    })
}

pub fn group_update(store: &ProjectStore, actor: &Actor, id: &Id, patch: ScriptGroupPatch) -> Result<ScriptGroup> {
    store.write(actor, |tx| {
        let mut g: ScriptGroup = tx.get(id)?;
        if let Some(v) = patch.name {
            g.name = required("name", &v)?;
        }
        if let Some(v) = patch.description {
            g.description = non_empty(v);
        }
        if let Some(v) = patch.mode {
            g.mode = v;
        }
        if let Some(list) = patch.members {
            let mut members = Vec::new();
            for m in list {
                add_member_in(tx, &mut members, m)?;
            }
            g.members = members;
        }
        g.updated_at = now_ms();
        tx.put(&g)?;
        Ok(g)
    })
}

pub fn group_delete(store: &ProjectStore, actor: &Actor, id: &Id) -> Result<()> {
    store.write(actor, |tx| tx.delete::<ScriptGroup>(id))
}

pub fn group_add_member(store: &ProjectStore, actor: &Actor, group_id: &Id, input: ScriptGroupMemberInput) -> Result<ScriptGroup> {
    store.write(actor, |tx| {
        let mut g: ScriptGroup = tx.get(group_id)?;
        add_member_in(tx, &mut g.members, input)?;
        g.updated_at = now_ms();
        tx.put(&g)?;
        Ok(g)
    })
}

pub fn group_remove_member(store: &ProjectStore, actor: &Actor, group_id: &Id, script_id: &Id) -> Result<ScriptGroup> {
    store.write(actor, |tx| {
        let mut g: ScriptGroup = tx.get(group_id)?;
        let before = g.members.len();
        g.members.retain(|m| &m.script_id != script_id);
        if g.members.len() == before {
            return Err(CoreError::not_found(format!("script {script_id} is not in group {group_id}")));
        }
        renumber(&mut g.members);
        g.updated_at = now_ms();
        tx.put(&g)?;
        Ok(g)
    })
}

// ---------------------------------------------------------------------------
// Command resolution
// ---------------------------------------------------------------------------

/// Resolve a script for running on this machine. `db` is needed only when an
/// environment is named (by the script or `opts.default_environment`).
pub fn resolve_command(store: &ProjectStore, db: Option<&AppDb>, id: &Id, opts: &ScriptResolveOptions) -> Result<ScriptResolvedCommand> {
    let s: Script = store.get(id)?;
    let platform = opts.platform.unwrap_or_else(TargetPlatform::current);
    if !s.platforms.is_empty() && !s.platforms.contains(&platform) {
        let list: Vec<&str> = s.platforms.iter().map(|p| p.as_str()).collect();
        return Err(CoreError::unsupported(format!(
            "script {:?} runs on {} only, not {}",
            s.name,
            list.join(", "),
            platform.as_str()
        )));
    }

    let env_name = s.environment.clone().or_else(|| non_empty(opts.default_environment.clone()));
    let environment = match &env_name {
        None => None,
        Some(name) => {
            let db = db.ok_or_else(|| CoreError::internal("resolve_command: app DB required to resolve an environment"))?;
            let e = environments::find_by_name(db, name)?.ok_or_else(|| {
                CoreError::not_found(format!("terminal environment {name:?} is not configured on this machine"))
                    .with_details(serde_json::json!({ "hint": "run \"quadflow scripts env-detect\" or create it in Settings → Environments" }))
            })?;
            if !e.available {
                return Err(CoreError::unsupported(format!(
                    "terminal environment {name:?} was not found by the last detection on this machine"
                ))
                .with_details(serde_json::json!({ "hint": "run \"quadflow scripts env-detect\"" })));
            }
            Some(e)
        }
    };

    let shell = s.shell.or(environment.as_ref().map(|e| e.shell)).unwrap_or(ShellKind::platform_default(platform));
    // A shell path only applies when the shell is the environment's.
    let shell_path = environment.as_ref().filter(|e| e.shell == shell).and_then(|e| e.shell_path.clone());

    let root = &store.root().path;
    let cwd = match &s.working_directory {
        Some(wd) => {
            let rel = validate_working_directory(wd)?.unwrap_or_default();
            rel.split('/').fold(root.clone(), |p, seg| p.join(seg))
        }
        None => root.clone(),
    };

    let mut setup: Vec<String> = environment.as_ref().map(|e| e.init_commands.clone()).unwrap_or_default();
    setup.extend(s.setup_commands.iter().cloned());
    let mut env = environment.as_ref().map(|e| e.env.clone()).unwrap_or_default();
    env.extend(s.env.clone());
    let full_command = compose(shell, &env, &setup, &s.command);

    Ok(ScriptResolvedCommand {
        script_id: s.id,
        script_name: s.name,
        platform,
        shell,
        shell_path,
        environment,
        cwd: cwd.display().to_string(),
        setup,
        command: s.command,
        env,
        full_command,
    })
}

fn sh_quote(v: &str) -> String {
    format!("'{}'", v.replace('\'', r"'\''"))
}

fn ps_quote(v: &str) -> String {
    format!("'{}'", v.replace('\'', "''"))
}

/// One command line for `shell`: env assignments, then setup, then the command.
pub fn compose(shell: ShellKind, env: &BTreeMap<String, String>, setup: &[String], command: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    for (k, v) in env {
        parts.push(match shell {
            ShellKind::Cmd => format!("set \"{k}={v}\""),
            ShellKind::Powershell | ShellKind::Pwsh => format!("$env:{k} = {}", ps_quote(v)),
            ShellKind::Bash | ShellKind::Zsh | ShellKind::Sh => format!("export {k}={}", sh_quote(v)),
        });
    }
    // cmd expands `%VAR%` when a line is parsed, so variables set on the same
    // line are invisible to the command: put the `set`s on their own line.
    let env_line = if shell == ShellKind::Cmd && !parts.is_empty() {
        Some(std::mem::take(&mut parts).join(" && "))
    } else {
        None
    };
    parts.extend(setup.iter().cloned());
    parts.push(command.to_string());
    // Windows PowerShell 5.1 has no `&&`.
    let sep = if shell == ShellKind::Powershell { "; " } else { " && " };
    let line = parts.join(sep);
    match env_line {
        Some(env) => format!("{env}\n{line}"),
        None => line,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::ChangeKind;
    use crate::testing::{TempApp, TempProject};
    use std::sync::{Arc, Mutex};

    fn input(name: &str, command: &str) -> ScriptInput {
        ScriptInput { name: name.into(), command: command.into(), ..Default::default() }
    }

    #[test]
    fn script_crud_patch_and_query() {
        let tp = TempProject::new();
        let a = Actor::system();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s2 = seen.clone();
        tp.store.bus().subscribe(move |e| s2.lock().unwrap().push((e.domain, e.kind, e.ids.clone())));

        let s = create(
            &tp.store,
            &a,
            ScriptInput {
                description: Some("  dev server ".into()),
                tags: vec!["Web".into(), "web".into(), " ".into()],
                working_directory: Some("app\\web\\".into()),
                platforms: vec![TargetPlatform::Linux, TargetPlatform::Windows, TargetPlatform::Macos],
                ..input("Dev", "npm run dev")
            },
        )
        .unwrap();
        assert_eq!(s.description.as_deref(), Some("dev server"));
        assert_eq!(s.tags, vec!["web"]);
        assert_eq!(s.working_directory.as_deref(), Some("app/web"));
        assert!(s.platforms.is_empty(), "all three = empty");
        assert_eq!(get(&tp.store, &s.id).unwrap(), s);
        assert_eq!(seen.lock().unwrap()[0], (Domain::Scripts, ChangeKind::Created, vec![s.id.to_string()]));

        // Patch set + clear.
        let patch: ScriptPatch =
            serde_json::from_value(serde_json::json!({"description": null, "shell": "bash", "pinned": true})).unwrap();
        let u = update(&tp.store, &a, &s.id, patch).unwrap();
        assert_eq!(u.description, None);
        assert_eq!(u.shell, Some(ShellKind::Bash));
        assert!(u.pinned);
        let u = update(&tp.store, &a, &s.id, ScriptPatch { shell: Some(None), ..Default::default() }).unwrap();
        assert_eq!(u.shell, None);
        assert!(u.pinned, "absent = unchanged");

        // Validation.
        for bad in ["../x", "/abs", "C:\\x", "a/../../b"] {
            let e = update(&tp.store, &a, &s.id, ScriptPatch { working_directory: Some(Some(bad.into())), ..Default::default() })
                .unwrap_err();
            assert_eq!(e.code, crate::ErrorCode::InvalidInput, "{bad}");
        }
        assert_eq!(create(&tp.store, &a, input(" ", "x")).unwrap_err().code, crate::ErrorCode::InvalidInput);
        let mut bad_env = input("x", "y");
        bad_env.env.insert("BAD-KEY".into(), "1".into());
        assert_eq!(create(&tp.store, &a, bad_env).unwrap_err().code, crate::ErrorCode::InvalidInput);

        // Query.
        let w = create(&tp.store, &a, ScriptInput { platforms: vec![TargetPlatform::Windows], ..input("Win only", "dir") }).unwrap();
        update(&tp.store, &a, &w.id, ScriptPatch { archived: Some(true), ..Default::default() }).unwrap();
        assert_eq!(list(&tp.store, &ScriptQuery::default()).unwrap().items.len(), 1);
        let q = ScriptQuery { include_archived: true, platform: Some(TargetPlatform::Linux), ..Default::default() };
        assert_eq!(list(&tp.store, &q).unwrap().items.len(), 1);
        let q = ScriptQuery { include_archived: true, text: Some("DIR".into()), ..Default::default() };
        assert_eq!(list(&tp.store, &q).unwrap().items[0].id, w.id);
        let q = ScriptQuery { tag: Some("WEB".into()), pinned: true, ..Default::default() };
        assert_eq!(list(&tp.store, &q).unwrap().items.len(), 1);

        // Invalid / missing ids.
        assert_eq!(Id::parse("../etc").unwrap_err().code, crate::ErrorCode::InvalidInput);
        assert_eq!(get(&tp.store, &new_id()).unwrap_err().code, crate::ErrorCode::NotFound);
    }

    #[test]
    fn groups_on_a_fresh_project_and_delete_cascade() {
        let tp = TempProject::new();
        let a = Actor::system();
        assert!(!tp.store.data_dir().join("script-groups").exists());
        assert!(groups_list(&tp.store).unwrap().items.is_empty());

        let s1 = create(&tp.store, &a, input("api", "cargo run")).unwrap();
        let s2 = create(&tp.store, &a, input("web", "npm run dev")).unwrap();
        let s3 = create(&tp.store, &a, input("docs", "mdbook serve")).unwrap();
        let g = group_create(
            &tp.store,
            &a,
            ScriptGroupInput {
                name: "Stack".into(),
                members: vec![ScriptGroupMemberInput::new(s1.id.clone())],
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(g.mode, ScriptGroupMode::Parallel);
        assert!(tp.store.data_dir().join("script-groups").join(format!("{}.json", g.id)).is_file());

        let g = group_add_member(
            &tp.store,
            &a,
            &g.id,
            ScriptGroupMemberInput { delay_ms: Some(500), ..ScriptGroupMemberInput::new(s2.id.clone()) },
        )
        .unwrap();
        let g = group_add_member(&tp.store, &a, &g.id, ScriptGroupMemberInput { order: Some(0), ..ScriptGroupMemberInput::new(s3.id.clone()) })
            .unwrap();
        let order: Vec<&Id> = g.members.iter().map(|m| &m.script_id).collect();
        assert_eq!(order, vec![&s3.id, &s1.id, &s2.id]);
        assert_eq!(g.members.iter().map(|m| m.order).collect::<Vec<_>>(), vec![0, 1, 2]);
        assert_eq!(g.members[2].delay_ms, 500);

        let e = group_add_member(&tp.store, &a, &g.id, ScriptGroupMemberInput::new(s1.id.clone())).unwrap_err();
        assert_eq!(e.code, crate::ErrorCode::Conflict);
        let e = group_add_member(&tp.store, &a, &g.id, ScriptGroupMemberInput::new(new_id())).unwrap_err();
        assert_eq!(e.code, crate::ErrorCode::NotFound);

        // Deleting a script removes it from groups.
        delete(&tp.store, &a, &s3.id).unwrap();
        let g = group_get(&tp.store, &g.id).unwrap();
        assert_eq!(g.members.iter().map(|m| (&m.script_id, m.order)).collect::<Vec<_>>(), vec![(&s1.id, 0), (&s2.id, 1)]);

        let g = group_remove_member(&tp.store, &a, &g.id, &s1.id).unwrap();
        assert_eq!(g.members.len(), 1);
        assert_eq!(group_remove_member(&tp.store, &a, &g.id, &s1.id).unwrap_err().code, crate::ErrorCode::NotFound);

        let g = group_update(
            &tp.store,
            &a,
            &g.id,
            serde_json::from_value(serde_json::json!({"mode": "sequential", "description": "x"})).unwrap(),
        )
        .unwrap();
        assert_eq!(g.mode, ScriptGroupMode::Sequential);
        group_delete(&tp.store, &a, &g.id).unwrap();
        assert!(groups_list(&tp.store).unwrap().items.is_empty());
    }

    #[test]
    fn corrupt_script_is_reported_not_skipped() {
        let tp = TempProject::new();
        let dir = tp.store.data_dir().join("scripts");
        std::fs::create_dir_all(&dir).unwrap();
        let id = new_id();
        std::fs::write(dir.join(format!("{id}.json")), "{oops").unwrap();
        let l = list(&tp.store, &ScriptQuery::default()).unwrap();
        assert!(l.items.is_empty());
        assert_eq!(l.errors.len(), 1);
        let e = update(&tp.store, &Actor::system(), &id, ScriptPatch { pinned: Some(true), ..Default::default() }).unwrap_err();
        assert_eq!(e.code, crate::ErrorCode::Corrupt);
        assert_eq!(std::fs::read_to_string(dir.join(format!("{id}.json"))).unwrap(), "{oops");
    }

    #[test]
    fn resolve_by_environment_name_per_machine() {
        let tp = TempProject::new();
        let a = Actor::system();
        let mut env = BTreeMap::new();
        env.insert("RUST_LOG".to_string(), "it's debug".to_string());
        let s = create(
            &tp.store,
            &a,
            ScriptInput {
                environment: Some("VS Dev".into()),
                setup_commands: vec!["cd sub".into()],
                env,
                working_directory: Some("sub/dir".into()),
                ..input("build", "cargo build")
            },
        )
        .unwrap();

        // Machine A: no such environment.
        let app_a = TempApp::new();
        let e = resolve_command(&tp.store, Some(&app_a.db), &s.id, &ScriptResolveOptions::default()).unwrap_err();
        assert_eq!(e.code, crate::ErrorCode::NotFound);

        // Machine B: defines "VS Dev" with its own vcvars path.
        let app_b = TempApp::new();
        environments::upsert(
            &app_b.db,
            environments::EnvironmentInput {
                name: "vs dev".into(),
                shell: ShellKind::Cmd,
                init_commands: vec![r#"call "D:\VS\vcvarsall.bat" x64"#.into()],
                ..Default::default()
            },
        )
        .unwrap();
        let r = resolve_command(&tp.store, Some(&app_b.db), &s.id, &ScriptResolveOptions { platform: Some(TargetPlatform::Windows), ..Default::default() })
            .unwrap();
        assert_eq!(r.shell, ShellKind::Cmd);
        assert_eq!(r.environment.as_ref().unwrap().name, "vs dev");
        assert_eq!(r.setup, vec![r#"call "D:\VS\vcvarsall.bat" x64"#, "cd sub"]);
        assert_eq!(r.full_command, "set \"RUST_LOG=it's debug\"\ncall \"D:\\VS\\vcvarsall.bat\" x64 && cd sub && cargo build");
        assert_eq!(std::path::PathBuf::from(&r.cwd), tp.store.root().path.join("sub").join("dir"));

        // Shell override + platform restriction + default environment.
        let u = update(&tp.store, &a, &s.id, ScriptPatch { shell: Some(Some(ShellKind::Bash)), environment: Some(None), ..Default::default() })
            .unwrap();
        let r = resolve_command(&tp.store, None, &u.id, &ScriptResolveOptions::default()).unwrap();
        assert_eq!(r.full_command, r#"export RUST_LOG='it'\''s debug' && cd sub && cargo build"#);
        let r = resolve_command(
            &tp.store,
            Some(&app_b.db),
            &u.id,
            &ScriptResolveOptions { default_environment: Some("VS Dev".into()), ..Default::default() },
        )
        .unwrap();
        assert_eq!(r.shell, ShellKind::Bash, "script shell wins over the environment's");
        assert_eq!(r.setup.len(), 2);
        update(&tp.store, &a, &s.id, ScriptPatch { platforms: Some(vec![TargetPlatform::Macos]), ..Default::default() }).unwrap();
        let e = resolve_command(&tp.store, None, &s.id, &ScriptResolveOptions { platform: Some(TargetPlatform::Linux), ..Default::default() }).unwrap_err();
        assert_eq!(e.code, crate::ErrorCode::Unsupported);
    }

    #[test]
    fn compose_per_shell() {
        let mut env = BTreeMap::new();
        env.insert("A".to_string(), "x y".to_string());
        assert_eq!(compose(ShellKind::Powershell, &env, &["s".into()], "c"), "$env:A = 'x y'; s; c");
        assert_eq!(compose(ShellKind::Pwsh, &BTreeMap::new(), &[], "c"), "c");
        assert_eq!(compose(ShellKind::Zsh, &BTreeMap::new(), &["s".into()], "c"), "s && c");
    }
}
