//! Workspaces: saved terminal/tile layouts of one project, plus the global
//! workspaces shown beside every project (data-layer.md §7, §7.1).
//!
//! [`save`] replaces a workspace's layout tree, terminals and tiles in ONE
//! SQLite transaction, so a save can never leave a half-written layout.
//! The shell's debounce / switch-generation logic sits on top of it.

use super::settings::{self, SHELL};
use super::{parse_json, parse_json_opt, to_json, validate_opaque_id, AppPinSection};
use crate::error::{CoreError, Result};
use crate::events::{ChangeKind, Domain};
use crate::ids::{new_id, Id};
use crate::model::{JsonValue, Timestamp};
use crate::store::{AppChange, AppDb};
use crate::time::now_ms;
use rusqlite::{OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: Id,
    pub project_id: Id,
    pub name: String,
    /// `MosaicNode<string>` (opaque JSON) or `null`.
    #[specta(type = Option<JsonValue>)]
    pub layout_tree: Option<serde_json::Value>,
    pub pinned: bool,
    pub pin_order: Option<i64>,
    pub pin_section: AppPinSection,
    pub sort_order: i64,
    pub last_active_at: Option<Timestamp>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCreate {
    pub project_id: Id,
    pub name: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<i64>)]
    pub pin_order: Option<Option<i64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin_section: Option<AppPinSection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort_order: Option<i64>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TitleSource {
    #[default]
    Default,
    Auto,
    Manual,
}

impl TitleSource {
    fn as_str(self) -> &'static str {
        match self {
            TitleSource::Default => "default",
            TitleSource::Auto => "auto",
            TitleSource::Manual => "manual",
        }
    }
    fn parse(s: &str) -> Self {
        match s {
            "auto" => TitleSource::Auto,
            "manual" => TitleSource::Manual,
            _ => TitleSource::Default,
        }
    }
}

/// A terminal saved in a workspace.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTerminal {
    /// Terminal (PTY) id; also its layout leaf id.
    pub id: String,
    pub title: String,
    pub title_source: TitleSource,
    pub cwd: String,
    pub environment_id: Option<String>,
    /// Agent running in this terminal (agent-providers.md §5.4); `None` = plain shell.
    pub agent: Option<crate::agents::AgentBinding>,
    /// Shell runtime state (scrollback snapshot, status, …), opaque JSON object.
    #[specta(type = JsonValue)]
    pub state: serde_json::Value,
    pub locked: bool,
    pub minimized: bool,
    pub position: i64,
    pub created_at: Timestamp,
}

/// A tool tile in a workspace or a global workspace.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TileInstance {
    /// Tile id; also its layout leaf id.
    pub id: String,
    pub tool_config_id: Id,
    pub title: String,
    /// Plugin instance state (opaque JSON object).
    #[specta(type = JsonValue)]
    pub state: serde_json::Value,
    pub locked: bool,
    pub minimized: bool,
    /// `{x, y, width, height}` or `null`.
    #[specta(type = Option<JsonValue>)]
    pub floating: Option<serde_json::Value>,
    pub created_at: Timestamp,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceState {
    #[specta(type = Option<JsonValue>)]
    pub layout_tree: Option<serde_json::Value>,
    pub terminals: Vec<WorkspaceTerminal>,
    pub tiles: Vec<TileInstance>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    /// Tiles not saved because their tool config no longer exists.
    pub skipped_tiles: Vec<String>,
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

const WS_COLS: &str =
    "id, project_id, name, layout_tree, pinned, pin_order, pin_section, sort_order, last_active_at, created_at, updated_at";

fn parse_id(s: String, col: usize) -> rusqlite::Result<Id> {
    Id::parse(&s).map_err(|e| rusqlite::Error::InvalidColumnType(col, e.message, rusqlite::types::Type::Text))
}

fn ws_from_row(r: &rusqlite::Row) -> rusqlite::Result<(Workspace, Option<String>)> {
    Ok((
        Workspace {
            id: parse_id(r.get(0)?, 0)?,
            project_id: parse_id(r.get(1)?, 1)?,
            name: r.get(2)?,
            layout_tree: None,
            pinned: r.get::<_, i64>(4)? != 0,
            pin_order: r.get(5)?,
            pin_section: AppPinSection::parse(&r.get::<_, String>(6)?),
            sort_order: r.get(7)?,
            last_active_at: r.get(8)?,
            created_at: r.get(9)?,
            updated_at: r.get(10)?,
        },
        r.get(3)?,
    ))
}

fn ws_finish((mut w, tree): (Workspace, Option<String>)) -> Result<Workspace> {
    w.layout_tree = parse_json_opt("workspaces", w.id.as_str(), "layout_tree", tree)?;
    Ok(w)
}

fn ws_query(c: &rusqlite::Connection, tail: &str, params: impl rusqlite::Params) -> rusqlite::Result<Vec<(Workspace, Option<String>)>> {
    let mut stmt = c.prepare(&format!("SELECT {WS_COLS} FROM workspaces {tail}"))?;
    let rows = stmt.query_map(params, ws_from_row)?;
    rows.collect()
}

/// Workspaces of one project (or all), most recently active first.
pub fn list(db: &AppDb, project_id: Option<&Id>) -> Result<Vec<Workspace>> {
    const ORDER: &str = "ORDER BY COALESCE(last_active_at, updated_at) DESC, created_at DESC";
    let rows = db.read(|c| match project_id {
        Some(p) => ws_query(c, &format!("WHERE project_id = ?1 {ORDER}"), [p.as_str()]),
        None => ws_query(c, ORDER, []),
    })?;
    rows.into_iter().map(ws_finish).collect()
}

pub fn get(db: &AppDb, id: &Id) -> Result<Workspace> {
    let rows = db.read(|c| ws_query(c, "WHERE id = ?1", [id.as_str()]))?;
    rows.into_iter().next().map(ws_finish).unwrap_or_else(|| Err(CoreError::not_found(format!("workspace {id}"))))
}

pub fn create(db: &AppDb, input: WorkspaceCreate) -> Result<Workspace> {
    let name = super::non_empty("workspace name", &input.name)?;
    let id = new_id();
    db.transact(|tx, ch| {
        let exists: Option<i64> =
            tx.query_row("SELECT 1 FROM projects WHERE id = ?1", [input.project_id.as_str()], |r| r.get(0)).optional()?;
        if exists.is_none() {
            return Err(CoreError::not_found(format!("project {}", input.project_id)));
        }
        let now = now_ms();
        let order: i64 = tx.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM workspaces WHERE project_id = ?1",
            [input.project_id.as_str()],
            |r| r.get(0),
        )?;
        tx.execute(
            "INSERT INTO workspaces (id, project_id, name, sort_order, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            rusqlite::params![id.as_str(), input.project_id.as_str(), name, order, now],
        )?;
        ch.push(AppChange::new(Domain::Workspaces, ChangeKind::Created, Some(id.as_str())));
        Ok(())
    })?;
    get(db, &id)
}

pub fn update(db: &AppDb, id: &Id, patch: WorkspacePatch) -> Result<Workspace> {
    let name = patch.name.as_deref().map(|n| super::non_empty("workspace name", n)).transpose()?;
    db.transact(|tx, ch| {
        let n = tx.execute("UPDATE workspaces SET updated_at = ?1 WHERE id = ?2", rusqlite::params![now_ms(), id.as_str()])?;
        if n == 0 {
            return Err(CoreError::not_found(format!("workspace {id}")));
        }
        let set = |col: &str, v: &dyn rusqlite::ToSql| -> Result<()> {
            tx.execute(&format!("UPDATE workspaces SET {col} = ?1 WHERE id = ?2"), rusqlite::params![v, id.as_str()])?;
            Ok(())
        };
        if let Some(v) = &name {
            set("name", v)?;
        }
        if let Some(v) = patch.pinned {
            set("pinned", &(v as i64))?;
        }
        if let Some(v) = patch.pin_order {
            set("pin_order", &v)?;
        }
        if let Some(v) = patch.pin_section {
            set("pin_section", &v.as_str())?;
        }
        if let Some(v) = patch.sort_order {
            set("sort_order", &v)?;
        }
        ch.push(AppChange::new(Domain::Workspaces, ChangeKind::Updated, Some(id.as_str())));
        Ok(())
    })?;
    get(db, id)
}

pub fn delete(db: &AppDb, id: &Id) -> Result<()> {
    db.transact(|tx, ch| {
        let project: Option<String> =
            tx.query_row("SELECT project_id FROM workspaces WHERE id = ?1", [id.as_str()], |r| r.get(0)).optional()?;
        let Some(project) = project else { return Err(CoreError::not_found(format!("workspace {id}"))) };
        tx.execute("DELETE FROM workspaces WHERE id = ?1", [id.as_str()])?;
        ch.push(AppChange::new(Domain::Workspaces, ChangeKind::Deleted, Some(id.as_str())));
        let key = settings::active_workspace_key(&project);
        let active: Option<String> = tx
            .query_row("SELECT value FROM settings WHERE namespace = ?1 AND key = ?2", [SHELL, key.as_str()], |r| r.get(0))
            .optional()?;
        if active.as_deref() == Some(&to_json(&serde_json::Value::String(id.to_string()))) {
            settings::delete_in_tx(tx, SHELL, &key)?;
            ch.push(AppChange::new(Domain::Settings, ChangeKind::Deleted, Some(format!("{SHELL}/{key}"))));
        }
        Ok(())
    })
}

/// Make `id` the active workspace of its project (`shell.activeWorkspace:<projectId>`).
pub fn activate(db: &AppDb, id: &Id) -> Result<Workspace> {
    db.transact(|tx, ch| {
        let project: Option<String> =
            tx.query_row("SELECT project_id FROM workspaces WHERE id = ?1", [id.as_str()], |r| r.get(0)).optional()?;
        let Some(project) = project else { return Err(CoreError::not_found(format!("workspace {id}"))) };
        tx.execute("UPDATE workspaces SET last_active_at = ?1 WHERE id = ?2", rusqlite::params![now_ms(), id.as_str()])?;
        let key = settings::active_workspace_key(&project);
        settings::set_in_tx(tx, SHELL, &key, &serde_json::Value::String(id.to_string()))?;
        ch.push(AppChange::new(Domain::Workspaces, ChangeKind::Updated, Some(id.as_str())));
        ch.push(AppChange::new(Domain::Settings, ChangeKind::Updated, Some(format!("{SHELL}/{key}"))));
        Ok(())
    })?;
    get(db, id)
}

/// The active workspace of a project, if set and still present.
pub fn active_for_project(db: &AppDb, project_id: &Id) -> Result<Option<Workspace>> {
    let Some(id) = settings::get_string(db, SHELL, &settings::active_workspace_key(project_id.as_str()))? else {
        return Ok(None);
    };
    let Ok(id) = Id::parse(&id) else { return Ok(None) };
    match get(db, &id) {
        Ok(w) if &w.project_id == project_id => Ok(Some(w)),
        Ok(_) => Ok(None),
        Err(e) if e.code == crate::error::ErrorCode::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

// ---------------------------------------------------------------------------
// Workspace state (layout + terminals + tiles)
// ---------------------------------------------------------------------------

fn load_terminals(c: &rusqlite::Connection, ws: &str) -> Result<Vec<WorkspaceTerminal>> {
    type Raw = (String, String, String, String, Option<String>, Option<String>, String, i64, i64, i64, i64);
    let raw: Vec<Raw> = {
        let mut stmt = c.prepare(
            "SELECT id, title, title_source, cwd, environment_id, agent, state, locked, minimized, position, created_at
             FROM workspace_terminals WHERE workspace_id = ?1 ORDER BY position, created_at",
        )?;
        let rows = stmt.query_map([ws], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?, r.get(10)?))
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    raw.into_iter()
        .map(|(id, title, ts, cwd, env, agent, state, locked, minimized, position, created_at)| {
            Ok(WorkspaceTerminal {
                agent: parse_binding(&id, agent)?,
                state: parse_json("workspace_terminals", &id, "state", &state)?,
                id,
                title,
                title_source: TitleSource::parse(&ts),
                cwd,
                environment_id: env,
                locked: locked != 0,
                minimized: minimized != 0,
                position,
                created_at,
            })
        })
        .collect()
}

fn load_tiles(c: &rusqlite::Connection, column: &str, owner: &str) -> Result<Vec<(String, TileInstance)>> {
    type Raw = (String, String, String, String, String, i64, i64, Option<String>, i64);
    let raw: Vec<Raw> = {
        let mut stmt = c.prepare(&format!(
            "SELECT {column}, id, tool_config_id, title, state, locked, minimized, floating, created_at
             FROM tile_instances WHERE {column} {} ORDER BY created_at, id",
            if owner.is_empty() { "IS NOT NULL" } else { "= ?1" }
        ))?;
        let map = |r: &rusqlite::Row| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?))
        };
        let rows = if owner.is_empty() { stmt.query_map([], map)? } else { stmt.query_map([owner], map)? };
        rows.collect::<rusqlite::Result<_>>()?
    };
    raw.into_iter()
        .map(|(owner, id, cfg, title, state, locked, minimized, floating, created_at)| {
            Ok((
                owner,
                TileInstance {
                    tool_config_id: Id::parse(&cfg)?,
                    state: parse_json("tile_instances", &id, "state", &state)?,
                    floating: parse_json_opt("tile_instances", &id, "floating", floating)?,
                    id,
                    title,
                    locked: locked != 0,
                    minimized: minimized != 0,
                    created_at,
                },
            ))
        })
        .collect()
}

pub fn load(db: &AppDb, id: &Id) -> Result<WorkspaceState> {
    let ws = get(db, id)?;
    let (terminals, tiles) = db.read(|c| Ok((load_terminals(c, id.as_str()), load_tiles(c, "workspace_id", id.as_str()))))?;
    Ok(WorkspaceState {
        layout_tree: ws.layout_tree,
        terminals: terminals?,
        tiles: tiles?.into_iter().map(|(_, t)| t).collect(),
    })
}

/// A stored binding that no longer parses or validates is `corrupt` (never guessed).
fn parse_binding(id: &str, raw: Option<String>) -> Result<Option<crate::agents::AgentBinding>> {
    let Some(v) = parse_json_opt("workspace_terminals", id, "agent", raw)? else { return Ok(None) };
    let b: crate::agents::AgentBinding = serde_json::from_value(v).map_err(|e| {
        CoreError::new(crate::error::ErrorCode::Corrupt, format!("workspace_terminals {id}: invalid agent binding: {e}"))
    })?;
    b.validate().map_err(|e| CoreError::new(crate::error::ErrorCode::Corrupt, format!("workspace_terminals {id}: {}", e.message)))?;
    Ok(Some(b))
}

fn validate_state(state: &WorkspaceState) -> Result<()> {
    let mut seen = std::collections::HashSet::new();
    for t in &state.terminals {
        validate_opaque_id("terminal", &t.id)?;
        if let Some(a) = &t.agent {
            a.validate().map_err(|e| CoreError::invalid_input(format!("terminal {:?}: {}", t.id, e.message)))?;
        }
        if !seen.insert(t.id.as_str()) {
            return Err(CoreError::invalid_input(format!("duplicate terminal id {:?}", t.id)));
        }
    }
    for t in &state.tiles {
        validate_opaque_id("tile", &t.id)?;
        if !seen.insert(t.id.as_str()) {
            return Err(CoreError::invalid_input(format!("duplicate tile id {:?}", t.id)));
        }
    }
    Ok(())
}

/// Insert tiles owned by `column = owner`; tiles whose tool config is gone are
/// skipped and returned. `INSERT OR REPLACE`: a tile id is unique app-wide, so
/// saving a tile that moved here from another workspace moves its row.
fn insert_tiles(tx: &Transaction, column: &str, owner: &str, tiles: &[TileInstance]) -> Result<Vec<String>> {
    let mut skipped = Vec::new();
    for t in tiles {
        let cfg_exists: Option<i64> = tx
            .query_row("SELECT 1 FROM tool_configs WHERE id = ?1", [t.tool_config_id.as_str()], |r| r.get(0))
            .optional()?;
        if cfg_exists.is_none() {
            tracing::warn!("workspace save: tile {} references missing tool config {}", t.id, t.tool_config_id);
            skipped.push(t.id.clone());
            continue;
        }
        let state = if t.state.is_null() { "{}".to_string() } else { to_json(&t.state) };
        tx.execute(
            &format!(
                "INSERT OR REPLACE INTO tile_instances
                   (id, {column}, tool_config_id, title, state, locked, minimized, floating, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
            ),
            rusqlite::params![
                t.id,
                owner,
                t.tool_config_id.as_str(),
                t.title,
                state,
                t.locked as i64,
                t.minimized as i64,
                t.floating.as_ref().filter(|v| !v.is_null()).map(to_json),
                t.created_at,
            ],
        )?;
    }
    Ok(skipped)
}

/// Replace the workspace's layout tree, terminals and tiles in ONE transaction.
pub fn save(db: &AppDb, id: &Id, state: WorkspaceState) -> Result<SaveResult> {
    validate_state(&state)?;
    db.transact(|tx, ch| {
        let tree = state.layout_tree.as_ref().filter(|v| !v.is_null()).map(to_json);
        let n = tx.execute(
            "UPDATE workspaces SET layout_tree = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![tree, now_ms(), id.as_str()],
        )?;
        if n == 0 {
            return Err(CoreError::not_found(format!("workspace {id}")));
        }
        tx.execute("DELETE FROM workspace_terminals WHERE workspace_id = ?1", [id.as_str()])?;
        for t in &state.terminals {
            let st = if t.state.is_null() { "{}".to_string() } else { to_json(&t.state) };
            tx.execute(
                "INSERT INTO workspace_terminals
                   (workspace_id, id, title, title_source, cwd, environment_id, agent, state, locked, minimized, position, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                rusqlite::params![
                    id.as_str(),
                    t.id,
                    t.title,
                    t.title_source.as_str(),
                    t.cwd,
                    t.environment_id,
                    t.agent.as_ref().map(|a| serde_json::to_string(a).expect("binding serializes")),
                    st,
                    t.locked as i64,
                    t.minimized as i64,
                    t.position,
                    t.created_at,
                ],
            )?;
        }
        tx.execute("DELETE FROM tile_instances WHERE workspace_id = ?1", [id.as_str()])?;
        let skipped_tiles = insert_tiles(tx, "workspace_id", id.as_str(), &state.tiles)?;
        ch.push(AppChange::new(Domain::Workspaces, ChangeKind::Updated, Some(id.as_str())));
        Ok(SaveResult { skipped_tiles })
    })
}

// ---------------------------------------------------------------------------
// Global workspaces
// ---------------------------------------------------------------------------

/// `shell` key holding the global frame (`{frameTree, globallyEnabled}`).
pub const KEY_GLOBAL_FRAME: &str = "globalFrame";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GlobalWorkspace {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub minimized: bool,
    #[specta(type = Option<JsonValue>)]
    pub layout_tree: Option<serde_json::Value>,
    pub display_order: i64,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

/// Create-or-update input. `id` is shell-generated.
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GlobalWorkspaceInput {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub minimized: bool,
    #[specta(type = Option<JsonValue>)]
    pub layout_tree: Option<serde_json::Value>,
    pub display_order: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GlobalTile {
    pub global_workspace_id: String,
    pub tile: TileInstance,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GlobalWorkspacesState {
    pub workspaces: Vec<GlobalWorkspace>,
    pub tiles: Vec<GlobalTile>,
}

pub fn global_list(db: &AppDb) -> Result<GlobalWorkspacesState> {
    type Raw = (String, String, i64, i64, Option<String>, i64, i64, i64);
    let (raw, tiles) = db.read(|c| {
        let raw: Vec<Raw> = {
            let mut stmt = c.prepare(
                "SELECT id, name, enabled, minimized, layout_tree, display_order, created_at, updated_at
                 FROM global_workspaces ORDER BY display_order, created_at",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?))
            })?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        Ok((raw, load_tiles(c, "global_workspace_id", "")))
    })?;
    let workspaces = raw
        .into_iter()
        .map(|(id, name, enabled, minimized, tree, display_order, created_at, updated_at)| {
            Ok(GlobalWorkspace {
                layout_tree: parse_json_opt("global_workspaces", &id, "layout_tree", tree)?,
                id,
                name,
                enabled: enabled != 0,
                minimized: minimized != 0,
                display_order,
                created_at,
                updated_at,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let tiles = tiles?.into_iter().map(|(global_workspace_id, tile)| GlobalTile { global_workspace_id, tile }).collect();
    Ok(GlobalWorkspacesState { workspaces, tiles })
}

pub fn global_upsert(db: &AppDb, input: GlobalWorkspaceInput) -> Result<GlobalWorkspace> {
    validate_opaque_id("global workspace", &input.id)?;
    let name = super::non_empty("global workspace name", &input.name)?;
    let id = input.id.clone();
    db.transact(|tx, ch| {
        let now = now_ms();
        let existed: Option<i64> =
            tx.query_row("SELECT 1 FROM global_workspaces WHERE id = ?1", [input.id.as_str()], |r| r.get(0)).optional()?;
        tx.execute(
            "INSERT INTO global_workspaces (id, name, enabled, minimized, layout_tree, display_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, enabled = excluded.enabled,
               minimized = excluded.minimized, layout_tree = excluded.layout_tree,
               display_order = excluded.display_order, updated_at = excluded.updated_at",
            rusqlite::params![
                input.id,
                name,
                input.enabled as i64,
                input.minimized as i64,
                input.layout_tree.as_ref().filter(|v| !v.is_null()).map(to_json),
                input.display_order,
                now
            ],
        )?;
        let kind = if existed.is_some() { ChangeKind::Updated } else { ChangeKind::Created };
        ch.push(AppChange::new(Domain::Workspaces, kind, Some(format!("global:{}", input.id))));
        Ok(())
    })?;
    global_list(db)?
        .workspaces
        .into_iter()
        .find(|w| w.id == id)
        .ok_or_else(|| CoreError::internal("global workspace vanished after upsert"))
}

pub fn global_delete(db: &AppDb, id: &str) -> Result<()> {
    validate_opaque_id("global workspace", id)?;
    db.transact(|tx, ch| {
        let n = tx.execute("DELETE FROM global_workspaces WHERE id = ?1", [id])?;
        if n == 0 {
            return Err(CoreError::not_found(format!("global workspace {id}")));
        }
        ch.push(AppChange::new(Domain::Workspaces, ChangeKind::Deleted, Some(format!("global:{id}"))));
        Ok(())
    })
}

/// Replace every global-workspace tile in one transaction. Tiles whose global
/// workspace or tool config no longer exists are skipped and returned.
pub fn global_save_tiles(db: &AppDb, tiles: Vec<GlobalTile>) -> Result<SaveResult> {
    let mut seen = std::collections::HashSet::new();
    for t in &tiles {
        validate_opaque_id("tile", &t.tile.id)?;
        if !seen.insert(t.tile.id.as_str()) {
            return Err(CoreError::invalid_input(format!("duplicate tile id {:?}", t.tile.id)));
        }
    }
    db.transact(|tx, ch| {
        tx.execute("DELETE FROM tile_instances WHERE global_workspace_id IS NOT NULL", [])?;
        let mut skipped_tiles = Vec::new();
        for t in &tiles {
            let ws_exists: Option<i64> = tx
                .query_row("SELECT 1 FROM global_workspaces WHERE id = ?1", [t.global_workspace_id.as_str()], |r| r.get(0))
                .optional()?;
            if ws_exists.is_none() {
                skipped_tiles.push(t.tile.id.clone());
                continue;
            }
            skipped_tiles.extend(insert_tiles(tx, "global_workspace_id", &t.global_workspace_id, std::slice::from_ref(&t.tile))?);
        }
        ch.push(AppChange::new(Domain::Workspaces, ChangeKind::Updated, Some("global".to_string())));
        Ok(SaveResult { skipped_tiles })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domains::app::projects;
    use crate::domains::app::test_util::app;
    use crate::domains::app::tool_configs;
    use crate::error::ErrorCode;
    use crate::paths::Profile;
    use serde_json::json;

    fn project(a: &crate::domains::app::test_util::App, name: &str) -> projects::Project {
        let d = a.dir.path().join(name);
        std::fs::create_dir_all(&d).unwrap();
        projects::open(&a.db, &d, Profile::Dev, false).unwrap()
    }

    fn term(id: &str, pos: i64) -> WorkspaceTerminal {
        WorkspaceTerminal {
            id: id.into(),
            title: format!("T {id}"),
            title_source: TitleSource::Manual,
            cwd: "/tmp".into(),
            environment_id: None,
            agent: if pos == 0 {
                Some(crate::agents::AgentBinding {
                    session_id: Some("abc".into()),
                    ..crate::agents::AgentBinding::new("alpha", 5)
                })
            } else {
                None
            },
            state: json!({"bufferContent": "hello"}),
            locked: pos == 1,
            minimized: false,
            position: pos,
            created_at: 1,
        }
    }

    fn seed_config(a: &crate::domains::app::test_util::App) {
        let input = serde_json::from_value(json!({"pluginId": "ideas", "contributionId": "ideas", "name": "Ideas"})).unwrap();
        tool_configs::create(&a.db, input).unwrap();
    }

    fn tile(id: &str, cfg: &Id) -> TileInstance {
        TileInstance {
            id: id.into(),
            tool_config_id: cfg.clone(),
            title: "Ideas".into(),
            state: json!({"metadata": {"filePath": "a.txt"}}),
            locked: true,
            minimized: false,
            floating: None,
            created_at: 2,
        }
    }

    #[test]
    fn crud_activate_and_save_round_trip() {
        let a = app();
        let p = project(&a, "proj");
        let w1 = create(&a.db, WorkspaceCreate { project_id: p.id.clone(), name: "One".into() }).unwrap();
        let w2 = create(&a.db, WorkspaceCreate { project_id: p.id.clone(), name: "Two".into() }).unwrap();
        assert_eq!(w2.sort_order, 1);
        assert_eq!(list(&a.db, Some(&p.id)).unwrap().len(), 2);
        assert!(active_for_project(&a.db, &p.id).unwrap().is_none());
        // Timestamps are ms; make sure activation is strictly later than creation.
        std::thread::sleep(std::time::Duration::from_millis(5));
        activate(&a.db, &w2.id).unwrap();
        assert_eq!(active_for_project(&a.db, &p.id).unwrap().unwrap().id, w2.id);
        assert_eq!(list(&a.db, Some(&p.id)).unwrap()[0].id, w2.id, "most recently active first");

        seed_config(&a);
        let cfg = tool_configs::list(&a.db).unwrap().into_iter().find(|c| c.contribution_id == "ideas").unwrap();
        let tree = json!({"direction": "row", "first": "t1", "second": "tool:x:1"});
        let state = WorkspaceState {
            layout_tree: Some(tree.clone()),
            terminals: vec![term("t1", 0), term("t2", 1)],
            tiles: vec![tile("tool:x:1", &cfg.id)],
        };
        assert!(save(&a.db, &w1.id, state.clone()).unwrap().skipped_tiles.is_empty());
        let loaded = load(&a.db, &w1.id).unwrap();
        assert_eq!(loaded, state);
        assert!(loaded.terminals[1].locked, "isLocked persists");
        // The other workspace is untouched.
        assert_eq!(load(&a.db, &w2.id).unwrap(), WorkspaceState::default());

        // Save replaces (not appends).
        let s2 = WorkspaceState { layout_tree: Some(json!("t2")), terminals: vec![term("t2", 0)], tiles: vec![] };
        save(&a.db, &w1.id, s2.clone()).unwrap();
        assert_eq!(load(&a.db, &w1.id).unwrap(), s2);

        // Same terminal id may be saved in two workspaces.
        save(&a.db, &w2.id, s2.clone()).unwrap();
        assert_eq!(load(&a.db, &w1.id).unwrap().terminals.len(), 1);

        let w = update(&a.db, &w1.id, WorkspacePatch { name: Some("Uno".into()), pinned: Some(true), pin_order: Some(Some(3)), pin_section: Some(AppPinSection::Left), ..Default::default() }).unwrap();
        assert!(w.pinned);
        assert_eq!((w.name.as_str(), w.pin_order, w.pin_section), ("Uno", Some(3), AppPinSection::Left));
        let patch: WorkspacePatch = serde_json::from_str(r#"{"pinOrder":null}"#).unwrap();
        assert_eq!(update(&a.db, &w1.id, patch).unwrap().pin_order, None);

        delete(&a.db, &w2.id).unwrap();
        assert!(active_for_project(&a.db, &p.id).unwrap().is_none());
        assert_eq!(load(&a.db, &w2.id).unwrap_err().code, ErrorCode::NotFound);
        assert_eq!(save(&a.db, &w2.id, s2).unwrap_err().code, ErrorCode::NotFound);
    }

    #[test]
    fn agent_binding_is_typed_and_validated() {
        let a = app();
        let p = project(&a, "proj");
        let w = create(&a.db, WorkspaceCreate { project_id: p.id.clone(), name: "W".into() }).unwrap();
        let mut t = term("t1", 0);
        t.agent.as_mut().unwrap().model = Some("x; rm -rf ~".into());
        let bad = WorkspaceState { layout_tree: None, terminals: vec![t], tiles: vec![] };
        assert_eq!(save(&a.db, &w.id, bad).unwrap_err().code, ErrorCode::InvalidInput);
        // A tampered row is corrupt, not silently accepted.
        save(&a.db, &w.id, WorkspaceState { layout_tree: None, terminals: vec![term("t1", 0)], tiles: vec![] }).unwrap();
        a.db.write(&[], |tx| tx.execute(r#"UPDATE workspace_terminals SET agent = '{"providerId":"alpha","model":"$(id)"}'"#, [])).unwrap();
        assert_eq!(load(&a.db, &w.id).unwrap_err().code, ErrorCode::Corrupt);
    }

    #[test]
    fn save_is_one_transaction() {
        let a = app();
        let p = project(&a, "proj");
        let w = create(&a.db, WorkspaceCreate { project_id: p.id.clone(), name: "W".into() }).unwrap();
        let good = WorkspaceState { layout_tree: Some(json!("t1")), terminals: vec![term("t1", 0)], tiles: vec![] };
        save(&a.db, &w.id, good.clone()).unwrap();
        a.take_events();

        // A failure in the middle (duplicate terminal primary key slips past
        // validation only if we bypass it) must leave the previous state intact.
        let bad_tile = WorkspaceState {
            layout_tree: Some(json!("nope")),
            terminals: vec![term("a", 0), term("b", 1)],
            tiles: vec![TileInstance { id: "b".into(), ..tile("b", &new_id()) }],
        };
        assert_eq!(save(&a.db, &w.id, bad_tile).unwrap_err().code, ErrorCode::InvalidInput);
        assert_eq!(load(&a.db, &w.id).unwrap(), good);

        // Force a SQL failure after the deletes: a terminal row violating NOT NULL
        // via a trigger-free trick — an id that is too long is rejected up front,
        // so instead drop the tile table temporarily to make the tile insert fail.
        a.db.write(&[], |tx| tx.execute_batch("ALTER TABLE tile_instances RENAME TO tile_instances_x")).unwrap();
        seed_config(&a);
        let cfg = tool_configs::list(&a.db).unwrap()[0].id.clone();
        let later = WorkspaceState { layout_tree: Some(json!("t9")), terminals: vec![term("t9", 0)], tiles: vec![tile("tool:z", &cfg)] };
        assert!(save(&a.db, &w.id, later).is_err());
        a.db.write(&[], |tx| tx.execute_batch("ALTER TABLE tile_instances_x RENAME TO tile_instances")).unwrap();
        assert_eq!(load(&a.db, &w.id).unwrap(), good, "rolled back: layout and terminals unchanged");
        assert!(a.take_events().iter().all(|e| e.domain != Domain::Workspaces), "no event for a rolled-back save");
    }

    #[test]
    fn missing_tool_configs_are_skipped_not_fatal() {
        let a = app();
        let p = project(&a, "proj");
        let w = create(&a.db, WorkspaceCreate { project_id: p.id.clone(), name: "W".into() }).unwrap();
        let ghost = new_id();
        let r = save(&a.db, &w.id, WorkspaceState { layout_tree: None, terminals: vec![], tiles: vec![tile("tool:g", &ghost)] }).unwrap();
        assert_eq!(r.skipped_tiles, vec!["tool:g".to_string()]);
    }

    #[test]
    fn global_workspaces() {
        let a = app();
        seed_config(&a);
        let cfg = tool_configs::list(&a.db).unwrap()[0].id.clone();
        let gw = global_upsert(&a.db, GlobalWorkspaceInput { id: "ws_1_abc".into(), name: "Dock".into(), enabled: true, minimized: false, layout_tree: Some(json!("tool:a")), display_order: 0 }).unwrap();
        assert_eq!(gw.name, "Dock");
        global_upsert(&a.db, GlobalWorkspaceInput { id: "ws_1_abc".into(), name: "Dock 2".into(), enabled: false, minimized: true, layout_tree: None, display_order: 1 }).unwrap();
        let r = global_save_tiles(&a.db, vec![
            GlobalTile { global_workspace_id: "ws_1_abc".into(), tile: tile("tool:a", &cfg) },
            GlobalTile { global_workspace_id: "ws_gone".into(), tile: tile("tool:b", &cfg) },
        ]).unwrap();
        assert_eq!(r.skipped_tiles, vec!["tool:b".to_string()]);
        let st = global_list(&a.db).unwrap();
        assert_eq!(st.workspaces.len(), 1);
        assert_eq!(st.workspaces[0].name, "Dock 2");
        assert!(!st.workspaces[0].enabled && st.workspaces[0].minimized);
        assert_eq!(st.tiles.len(), 1);
        assert_eq!(st.tiles[0].global_workspace_id, "ws_1_abc");
        global_delete(&a.db, "ws_1_abc").unwrap();
        let st = global_list(&a.db).unwrap();
        assert!(st.workspaces.is_empty() && st.tiles.is_empty(), "tiles cascade");
        assert_eq!(global_delete(&a.db, "ws_1_abc").unwrap_err().code, ErrorCode::NotFound);
    }
}
