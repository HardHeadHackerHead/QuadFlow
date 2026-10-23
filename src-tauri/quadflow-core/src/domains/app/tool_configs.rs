//! Tool configs (data-layer.md §7 `tool_configs`, plugin-system.md §5).
//!
//! A tool config references a plugin contribution (`plugin_id` +
//! `contribution_id`): a tile or toolbar item of an installed plugin. Configs
//! with `auto_created = 1` come from the contribution's manifest
//! `defaultToolConfig` and are kept in step with the plugin registry by
//! [`sync_with_plugins`] (plugin-system.md §5.3); users add more for
//! `instanceMultiple` contributions (several TUI tools, app launchers, …).

use super::{parse_json, to_json, AppPinSection};
use crate::error::{CoreError, Result};
use crate::events::{ChangeKind, Domain};
use crate::ids::{new_id, Id};
use crate::model::{JsonValue, Timestamp};
use crate::plugins::manifest::{DefaultToolConfig, OpenMode, PinDisplay, PinSection};
use crate::plugins::PluginRegistry;
use crate::store::{AppChange, AppDb};
use std::collections::BTreeSet;
use crate::time::now_ms;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum ToolPinDisplay {
    Icon,
    #[default]
    IconAndName,
    Mini,
}

impl ToolPinDisplay {
    fn as_str(self) -> &'static str {
        match self {
            ToolPinDisplay::Icon => "icon",
            ToolPinDisplay::IconAndName => "icon-and-name",
            ToolPinDisplay::Mini => "mini",
        }
    }
    fn parse(s: &str) -> Self {
        match s {
            "icon" => ToolPinDisplay::Icon,
            "mini" => ToolPinDisplay::Mini,
            _ => ToolPinDisplay::IconAndName,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ToolOpenMode {
    #[default]
    Pane,
    Flyout,
}

impl ToolOpenMode {
    fn as_str(self) -> &'static str {
        match self {
            ToolOpenMode::Pane => "pane",
            ToolOpenMode::Flyout => "flyout",
        }
    }
    fn parse(s: &str) -> Self {
        if s == "flyout" { ToolOpenMode::Flyout } else { ToolOpenMode::Pane }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ToolConfig {
    pub id: Id,
    pub plugin_id: String,
    pub contribution_id: String,
    pub name: String,
    pub icon: Option<String>,
    pub color: Option<String>,
    #[specta(type = JsonValue)]
    pub settings: serde_json::Value,
    pub enabled: bool,
    pub pinned: bool,
    pub pin_order: Option<i64>,
    pub pin_section: AppPinSection,
    pub pin_display: ToolPinDisplay,
    pub quick_launch: bool,
    pub open_mode: ToolOpenMode,
    pub flyout_width: Option<i64>,
    pub flyout_height: Option<i64>,
    pub sort_order: i64,
    /// Created by seeding (built-in / manifest default), not by the user.
    pub auto_created: bool,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ToolConfigCreate {
    pub plugin_id: String,
    pub contribution_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<JsonValue>)]
    pub settings: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quick_launch: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_mode: Option<ToolOpenMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin_display: Option<ToolPinDisplay>,
}

/// Patch: absent = unchanged; `null` clears the clearable fields.
#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ToolConfigPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contribution_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<String>)]
    pub icon: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<String>)]
    pub color: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<JsonValue>)]
    pub settings: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<i64>)]
    pub pin_order: Option<Option<i64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin_section: Option<AppPinSection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin_display: Option<ToolPinDisplay>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quick_launch: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_mode: Option<ToolOpenMode>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<i64>)]
    pub flyout_width: Option<Option<i64>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(optional, type = Option<i64>)]
    pub flyout_height: Option<Option<i64>>,
}

/// Which order a reorder call rewrites.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ReorderField {
    /// `sort_order` (tools menu).
    Sort,
    /// `pin_order` (toolbar).
    Pin,
}

const COLS: &str = "id, plugin_id, contribution_id, name, icon, color, settings, enabled, pinned, pin_order, pin_section,
    pin_display, quick_launch, open_mode, flyout_width, flyout_height, sort_order, auto_created, created_at, updated_at";

fn from_row(r: &rusqlite::Row) -> rusqlite::Result<(ToolConfig, String)> {
    let id: String = r.get(0)?;
    Ok((
        ToolConfig {
            id: Id::parse(&id).map_err(|e| rusqlite::Error::InvalidColumnType(0, e.message, rusqlite::types::Type::Text))?,
            plugin_id: r.get(1)?,
            contribution_id: r.get(2)?,
            name: r.get(3)?,
            icon: r.get(4)?,
            color: r.get(5)?,
            settings: serde_json::Value::Null,
            enabled: r.get::<_, i64>(7)? != 0,
            pinned: r.get::<_, i64>(8)? != 0,
            pin_order: r.get(9)?,
            pin_section: AppPinSection::parse(&r.get::<_, String>(10)?),
            pin_display: ToolPinDisplay::parse(&r.get::<_, String>(11)?),
            quick_launch: r.get::<_, i64>(12)? != 0,
            open_mode: ToolOpenMode::parse(&r.get::<_, String>(13)?),
            flyout_width: r.get(14)?,
            flyout_height: r.get(15)?,
            sort_order: r.get(16)?,
            auto_created: r.get::<_, i64>(17)? != 0,
            created_at: r.get(18)?,
            updated_at: r.get(19)?,
        },
        r.get(6)?,
    ))
}

fn finish((mut c, settings): (ToolConfig, String)) -> Result<ToolConfig> {
    c.settings = parse_json("tool_configs", c.id.as_str(), "settings", &settings)?;
    Ok(c)
}

fn query(c: &rusqlite::Connection, tail: &str, params: impl rusqlite::Params) -> rusqlite::Result<Vec<(ToolConfig, String)>> {
    let mut stmt = c.prepare(&format!("SELECT {COLS} FROM tool_configs {tail}"))?;
    let rows = stmt.query_map(params, from_row)?;
    rows.collect()
}

pub fn list(db: &AppDb) -> Result<Vec<ToolConfig>> {
    db.read(|c| query(c, "ORDER BY sort_order, created_at", []))?.into_iter().map(finish).collect()
}

pub fn get(db: &AppDb, id: &Id) -> Result<ToolConfig> {
    db.read(|c| query(c, "WHERE id = ?1", [id.as_str()]))?
        .into_iter()
        .next()
        .map(finish)
        .unwrap_or_else(|| Err(CoreError::not_found(format!("tool config {id}"))))
}

fn validate_ref(field: &str, v: &str) -> Result<String> {
    let v = v.trim();
    if v.is_empty() || v.len() > 128 || v.chars().any(|c| c.is_control()) {
        return Err(CoreError::invalid_input(format!("invalid {field} {v:?}")));
    }
    Ok(v.to_string())
}

fn settings_json(v: &serde_json::Value) -> Result<String> {
    match v {
        serde_json::Value::Object(_) => Ok(to_json(v)),
        serde_json::Value::Null => Ok("{}".into()),
        _ => Err(CoreError::invalid_input("tool config settings must be a JSON object")),
    }
}

pub fn create(db: &AppDb, input: ToolConfigCreate) -> Result<ToolConfig> {
    let plugin_id = validate_ref("plugin id", &input.plugin_id)?;
    let contribution_id = validate_ref("contribution id", &input.contribution_id)?;
    let name = super::non_empty("tool name", &input.name)?;
    let settings = settings_json(input.settings.as_ref().unwrap_or(&serde_json::Value::Null))?;
    let id = new_id();
    db.transact(|tx, ch| {
        let order: i64 = tx.query_row("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tool_configs", [], |r| r.get(0))?;
        let now = now_ms();
        tx.execute(
            "INSERT INTO tool_configs (id, plugin_id, contribution_id, name, icon, color, settings, enabled, pinned,
                quick_launch, open_mode, pin_display, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)",
            rusqlite::params![
                id.as_str(),
                plugin_id,
                contribution_id,
                name,
                input.icon,
                input.color,
                settings,
                input.enabled.unwrap_or(true) as i64,
                input.pinned.unwrap_or(false) as i64,
                input.quick_launch.unwrap_or(false) as i64,
                input.open_mode.unwrap_or_default().as_str(),
                input.pin_display.unwrap_or_default().as_str(),
                order,
                now
            ],
        )?;
        ch.push(AppChange::new(Domain::ToolConfigs, ChangeKind::Created, Some(id.as_str())));
        Ok(())
    })?;
    get(db, &id)
}

pub fn update(db: &AppDb, id: &Id, patch: ToolConfigPatch) -> Result<ToolConfig> {
    let name = patch.name.as_deref().map(|n| super::non_empty("tool name", n)).transpose()?;
    let contribution = patch.contribution_id.as_deref().map(|c| validate_ref("contribution id", c)).transpose()?;
    let settings = patch.settings.as_ref().map(settings_json).transpose()?;
    db.transact(|tx, ch| {
        let n = tx.execute("UPDATE tool_configs SET updated_at = ?1 WHERE id = ?2", rusqlite::params![now_ms(), id.as_str()])?;
        if n == 0 {
            return Err(CoreError::not_found(format!("tool config {id}")));
        }
        let set = |col: &str, v: &dyn rusqlite::ToSql| -> Result<()> {
            tx.execute(&format!("UPDATE tool_configs SET {col} = ?1 WHERE id = ?2"), rusqlite::params![v, id.as_str()])?;
            Ok(())
        };
        if let Some(v) = &contribution { set("contribution_id", v)?; }
        if let Some(v) = &name { set("name", v)?; }
        if let Some(v) = &patch.icon { set("icon", v)?; }
        if let Some(v) = &patch.color { set("color", v)?; }
        if let Some(v) = &settings { set("settings", v)?; }
        if let Some(v) = patch.enabled { set("enabled", &(v as i64))?; }
        if let Some(v) = patch.pinned { set("pinned", &(v as i64))?; }
        if let Some(v) = patch.pin_order { set("pin_order", &v)?; }
        if let Some(v) = patch.pin_section { set("pin_section", &v.as_str())?; }
        if let Some(v) = patch.pin_display { set("pin_display", &v.as_str())?; }
        if let Some(v) = patch.quick_launch { set("quick_launch", &(v as i64))?; }
        if let Some(v) = patch.open_mode { set("open_mode", &v.as_str())?; }
        if let Some(v) = patch.flyout_width { set("flyout_width", &v)?; }
        if let Some(v) = patch.flyout_height { set("flyout_height", &v)?; }
        ch.push(AppChange::new(Domain::ToolConfigs, ChangeKind::Updated, Some(id.as_str())));
        Ok(())
    })?;
    get(db, id)
}

/// Delete a user-created config (cascades to its tiles). Seeded configs are
/// refused with `conflict` — hide them (`enabled: false`) instead.
pub fn delete(db: &AppDb, id: &Id) -> Result<()> {
    db.transact(|tx, ch| {
        let auto: Option<i64> =
            tx.query_row("SELECT auto_created FROM tool_configs WHERE id = ?1", [id.as_str()], |r| r.get(0)).optional()?;
        match auto {
            None => return Err(CoreError::not_found(format!("tool config {id}"))),
            Some(1) => return Err(CoreError::conflict("built-in tool configs cannot be deleted")),
            Some(_) => {}
        }
        tx.execute("DELETE FROM tool_configs WHERE id = ?1", [id.as_str()])?;
        ch.push(AppChange::new(Domain::ToolConfigs, ChangeKind::Deleted, Some(id.as_str())));
        Ok(())
    })
}

/// Rewrite `sort_order` or `pin_order` to the position in `ids` (unknown ids are ignored).
pub fn reorder(db: &AppDb, ids: &[Id], field: ReorderField) -> Result<()> {
    let col = match field {
        ReorderField::Sort => "sort_order",
        ReorderField::Pin => "pin_order",
    };
    db.transact(|tx, ch| {
        let now = now_ms();
        for (i, id) in ids.iter().enumerate() {
            let n = tx.execute(
                &format!("UPDATE tool_configs SET {col} = ?1, updated_at = ?2 WHERE id = ?3"),
                rusqlite::params![i as i64, now, id.as_str()],
            )?;
            if n > 0 {
                ch.push(AppChange::new(Domain::ToolConfigs, ChangeKind::Updated, Some(id.as_str())));
            }
        }
        Ok(())
    })
}

// ---- plugin sync (plugin-system.md §5.3) ----

/// A manifest default: an active plugin's tile or toolbar item with a
/// `defaultToolConfig`.
#[derive(Clone, Debug, PartialEq)]
pub struct ContributionDefault {
    pub plugin_id: String,
    pub contribution_id: String,
    /// Contribution title (the config name when the default has none).
    pub title: String,
    pub config: DefaultToolConfig,
}

/// What [`sync_with_plugins`] changed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ToolConfigSyncReport {
    pub created: usize,
    pub deleted: usize,
}

/// Manifest defaults of every active plugin's tiles and toolbar items.
pub fn defaults_of(registry: &PluginRegistry) -> Vec<ContributionDefault> {
    let c = registry.contributions();
    let tiles = c.tiles.into_iter().filter_map(|t| {
        let d = t.contribution.default_tool_config?;
        Some(ContributionDefault { plugin_id: t.plugin_id, contribution_id: t.contribution.id, title: t.contribution.title, config: d })
    });
    let items = c.toolbar_items.into_iter().filter_map(|t| {
        let d = t.contribution.default_tool_config?;
        Some(ContributionDefault { plugin_id: t.plugin_id, contribution_id: t.contribution.id, title: t.contribution.title, config: d })
    });
    tiles.chain(items).collect()
}

/// `tool_configs_sync_with_plugins` (data-layer.md §7.1): run at startup and
/// after install / uninstall / enable / disable.
/// 1. Every active contribution with a `defaultToolConfig` and no auto-created
///    config gets one from the defaults (user edits of existing ones are kept).
/// 2. Configs of plugins that are no longer installed are deleted (tiles cascade).
/// 3. Configs of disabled / incompatible / unsupported plugins are kept; the
///    shell hides them.
pub fn sync_with_plugins(db: &AppDb, registry: &PluginRegistry) -> Result<ToolConfigSyncReport> {
    let installed: BTreeSet<String> = registry.all().map(|p| p.id.clone()).collect();
    sync_with(db, &defaults_of(registry), &installed)
}

/// [`sync_with_plugins`] over explicit inputs (testable without a registry).
pub fn sync_with(db: &AppDb, defaults: &[ContributionDefault], installed: &BTreeSet<String>) -> Result<ToolConfigSyncReport> {
    db.transact(|tx, ch| {
        let mut report = ToolConfigSyncReport::default();
        let orphans: Vec<String> = {
            let mut stmt = tx.prepare("SELECT id, plugin_id FROM tool_configs")?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
                .into_iter()
                .filter(|(_, plugin)| !installed.contains(plugin))
                .map(|(id, _)| id)
                .collect()
        };
        for id in orphans {
            tx.execute("DELETE FROM tool_configs WHERE id = ?1", [&id])?;
            ch.push(AppChange::new(Domain::ToolConfigs, ChangeKind::Deleted, Some(&id)));
            report.deleted += 1;
        }
        let now = now_ms();
        for d in defaults {
            let exists: Option<i64> = tx
                .query_row(
                    "SELECT 1 FROM tool_configs WHERE plugin_id = ?1 AND contribution_id = ?2 AND auto_created = 1",
                    [&d.plugin_id, &d.contribution_id],
                    |r| r.get(0),
                )
                .optional()?;
            if exists.is_some() {
                continue;
            }
            let id = new_id();
            let c = &d.config;
            tx.execute(
                "INSERT INTO tool_configs (id, plugin_id, contribution_id, name, color, settings, pinned, pin_order,
                    pin_section, pin_display, quick_launch, open_mode, sort_order, auto_created, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 1, ?14, ?14)",
                rusqlite::params![
                    id.as_str(),
                    d.plugin_id,
                    d.contribution_id,
                    default_name(d),
                    c.color,
                    default_settings(c),
                    c.pinned as i64,
                    c.pinned.then_some(c.order as i64),
                    pin_section_str(c.pin_section),
                    pin_display_str(c.pin_display),
                    c.quick_launch as i64,
                    open_mode_str(c.open_mode),
                    c.order as i64,
                    now
                ],
            )?;
            ch.push(AppChange::new(Domain::ToolConfigs, ChangeKind::Created, Some(id.as_str())));
            report.created += 1;
        }
        Ok(report)
    })
}

/// Reset auto-created configs to their manifest defaults (name, order, color,
/// visibility, pinning, display, open mode, settings) and re-create missing
/// ones. User-created configs are untouched.
pub fn reset_defaults(db: &AppDb, registry: &PluginRegistry) -> Result<()> {
    let defaults = defaults_of(registry);
    db.transact(|tx, ch| {
        let now = now_ms();
        for d in &defaults {
            let ids: Vec<String> = {
                let mut stmt =
                    tx.prepare("SELECT id FROM tool_configs WHERE plugin_id = ?1 AND contribution_id = ?2 AND auto_created = 1")?;
                let rows = stmt.query_map([&d.plugin_id, &d.contribution_id], |r| r.get(0))?;
                rows.collect::<rusqlite::Result<_>>()?
            };
            let c = &d.config;
            for id in ids {
                tx.execute(
                    "UPDATE tool_configs SET name = ?1, icon = NULL, color = ?2, settings = ?3, enabled = 1, pinned = ?4,
                        pin_order = ?5, pin_section = ?6, pin_display = ?7, quick_launch = ?8, open_mode = ?9,
                        sort_order = ?10, flyout_width = NULL, flyout_height = NULL, updated_at = ?11 WHERE id = ?12",
                    rusqlite::params![
                        default_name(d),
                        c.color,
                        default_settings(c),
                        c.pinned as i64,
                        c.pinned.then_some(c.order as i64),
                        pin_section_str(c.pin_section),
                        pin_display_str(c.pin_display),
                        c.quick_launch as i64,
                        open_mode_str(c.open_mode),
                        c.order as i64,
                        now,
                        id
                    ],
                )?;
                ch.push(AppChange::new(Domain::ToolConfigs, ChangeKind::Updated, Some(&id)));
            }
        }
        Ok(())
    })?;
    sync_with_plugins(db, registry)?;
    Ok(())
}

fn default_name(d: &ContributionDefault) -> String {
    d.config.name.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| d.title.clone())
}

fn default_settings(c: &DefaultToolConfig) -> String {
    match &c.settings {
        Some(v @ serde_json::Value::Object(_)) => to_json(v),
        _ => "{}".into(),
    }
}

fn pin_section_str(p: PinSection) -> &'static str {
    match p {
        PinSection::Left => "left",
        PinSection::Center => "center",
        PinSection::Right => "right",
    }
}

fn pin_display_str(p: PinDisplay) -> &'static str {
    match p {
        PinDisplay::Icon => "icon",
        PinDisplay::IconAndName => "icon-and-name",
        PinDisplay::Mini => "mini",
    }
}

fn open_mode_str(m: OpenMode) -> &'static str {
    match m {
        OpenMode::Pane => "pane",
        OpenMode::Flyout => "flyout",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domains::app::test_util::app;
    use crate::error::ErrorCode;
    use serde_json::json;

    fn dflt(plugin: &str, id: &str, title: &str, cfg: serde_json::Value) -> ContributionDefault {
        ContributionDefault {
            plugin_id: plugin.into(),
            contribution_id: id.into(),
            title: title.into(),
            config: serde_json::from_value(cfg).unwrap(),
        }
    }

    fn ids(v: &[&str]) -> BTreeSet<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn sync_seeds_defaults_idempotently_and_reset_restores() {
        let a = app();
        let defaults = vec![
            dflt("core", "terminal", "Terminal", json!({"pinned": true, "order": -1, "color": "#06b6d4"})),
            dflt("core", "ai-agent", "AI Agent", json!({"name": "AI Agent", "pinned": true, "order": 0, "settings": {"provider": "both"}})),
            dflt("ideas", "ideas", "Ideas", json!({"order": 2, "color": "#ec4899", "openMode": "flyout", "pinSection": "left", "pinDisplay": "icon"})),
        ];
        let installed = ids(&["core", "ideas"]);
        assert_eq!(sync_with(&a.db, &defaults, &installed).unwrap(), ToolConfigSyncReport { created: 3, deleted: 0 });
        assert_eq!(sync_with(&a.db, &defaults, &installed).unwrap(), ToolConfigSyncReport::default());
        let all = list(&a.db).unwrap();
        assert_eq!(all.len(), 3);
        assert!(all.iter().all(|c| installed.contains(&c.plugin_id) && c.auto_created));
        assert_eq!(all[0].contribution_id, "terminal", "sorted by manifest order");
        let agent = all.iter().find(|c| c.contribution_id == "ai-agent").unwrap();
        assert!(agent.pinned);
        assert_eq!(agent.pin_order, Some(0));
        assert_eq!(agent.settings, json!({"provider": "both"}));
        let ideas = all.iter().find(|c| c.contribution_id == "ideas").unwrap();
        assert_eq!((ideas.name.as_str(), ideas.open_mode, ideas.pin_section, ideas.pin_display, ideas.pin_order),
            ("Ideas", ToolOpenMode::Flyout, AppPinSection::Left, ToolPinDisplay::Icon, None));

        // User edits survive a sync; deleting an auto-created config is refused.
        let u = update(&a.db, &ideas.id, ToolConfigPatch { name: Some("My Ideas".into()), enabled: Some(false), color: Some(None), ..Default::default() }).unwrap();
        assert_eq!((u.name.as_str(), u.enabled, u.color.clone()), ("My Ideas", false, None));
        sync_with(&a.db, &defaults, &installed).unwrap();
        assert_eq!(get(&a.db, &ideas.id).unwrap().name, "My Ideas");
        assert_eq!(delete(&a.db, &ideas.id).unwrap_err().code, ErrorCode::Conflict);

        // A plugin that is no longer installed loses its configs (user-created too).
        let mine = create(&a.db, serde_json::from_value(json!({"pluginId": "gone", "contributionId": "tile", "name": "x"})).unwrap()).unwrap();
        let r = sync_with(&a.db, &defaults, &installed).unwrap();
        assert_eq!(r, ToolConfigSyncReport { created: 0, deleted: 1 });
        assert_eq!(get(&a.db, &mine.id).unwrap_err().code, ErrorCode::NotFound);
        // A disabled plugin contributes no defaults but keeps its configs.
        assert_eq!(sync_with(&a.db, &[], &installed).unwrap(), ToolConfigSyncReport::default());
        assert_eq!(list(&a.db).unwrap().len(), 3);
    }

    #[test]
    fn sync_and_reset_from_a_real_registry() {
        let t = crate::testing::TempApp::new();
        let res = tempfile::tempdir().unwrap();
        let dir = res.path().join("plugins").join("demo");
        std::fs::create_dir_all(dir.join("dist")).unwrap();
        std::fs::write(dir.join("dist/index.js"), "export default {}").unwrap();
        let manifest = json!({
            "id": "demo", "name": "Demo", "version": "1.0.0", "apiVersion": "^1.0.0",
            "platforms": ["windows", "macos", "linux"],
            "ui": { "entry": "dist/index.js" },
            "contributes": {
                "tiles": [
                    { "id": "board", "title": "Board", "defaultToolConfig": { "order": 3, "color": "#123456" } },
                    { "id": "extra", "title": "Extra", "instanceMultiple": true }
                ],
                "commands": [{ "id": "go", "title": "Go" }],
                "toolbarItems": [{ "id": "launch", "title": "Launch", "command": "go",
                    "configSchema": { "type": "object", "properties": { "shell": { "type": "string" } } },
                    "defaultToolConfig": { "pinned": true, "order": 1, "settings": { "shell": "bash" } } }]
            }
        });
        std::fs::write(dir.join(crate::plugins::MANIFEST_FILE), serde_json::to_string(&manifest).unwrap()).unwrap();
        let opts = crate::plugins::LoadOptions {
            resource_dir: Some(res.path().to_path_buf()),
            dev_paths: None,
            platform: crate::plugins::Platform::current(),
            target: crate::plugins::current_target(),
            host_api: crate::plugins::host_api_version(),
        };
        let reg = PluginRegistry::load_with(&t.paths, &t.db, &opts).unwrap();
        assert!(reg.get("demo").unwrap().is_active(), "{:?}", reg.get("demo").unwrap().errors);
        assert_eq!(sync_with_plugins(&t.db, &reg).unwrap(), ToolConfigSyncReport { created: 2, deleted: 0 });
        let all = list(&t.db).unwrap();
        let launch = all.iter().find(|c| c.contribution_id == "launch").unwrap();
        assert_eq!((launch.name.as_str(), launch.pinned, launch.settings.clone()), ("Launch", true, json!({"shell": "bash"})));
        let board = all.iter().find(|c| c.contribution_id == "board").unwrap();
        update(&t.db, &board.id, ToolConfigPatch { name: Some("Renamed".into()), flyout_width: Some(Some(900)), ..Default::default() }).unwrap();
        reset_defaults(&t.db, &reg).unwrap();
        let b = get(&t.db, &board.id).unwrap();
        assert_eq!((b.name.as_str(), b.color.as_deref(), b.flyout_width), ("Board", Some("#123456"), None));
    }
    #[test]
    fn crud_and_reorder() {
        let a = app();
        let c = create(&a.db, ToolConfigCreate {
            plugin_id: "tui".into(), contribution_id: "tui".into(), name: "htop".into(), icon: None, color: Some("#fff".into()),
            settings: Some(json!({"executablePath": "htop"})), enabled: None, pinned: Some(true), quick_launch: None, open_mode: Some(ToolOpenMode::Flyout), pin_display: Some(ToolPinDisplay::Icon),
        }).unwrap();
        assert!(!c.auto_created && c.pinned && c.enabled);
        assert_eq!((c.open_mode, c.pin_display), (ToolOpenMode::Flyout, ToolPinDisplay::Icon));
        let patch: ToolConfigPatch = serde_json::from_str(r#"{"flyoutWidth": 500, "pinOrder": 4}"#).unwrap();
        let u = update(&a.db, &c.id, patch).unwrap();
        assert_eq!((u.flyout_width, u.pin_order), (Some(500), Some(4)));
        let patch: ToolConfigPatch = serde_json::from_str(r#"{"flyoutWidth": null}"#).unwrap();
        assert_eq!(update(&a.db, &c.id, patch).unwrap().flyout_width, None);
        assert_eq!(update(&a.db, &c.id, ToolConfigPatch { settings: Some(json!([1])), ..Default::default() }).unwrap_err().code, ErrorCode::InvalidInput);

        let d = create(&a.db, ToolConfigCreate { name: "two".into(), ..serde_json::from_value(json!({"pluginId":"tui","contributionId":"tui","name":"x"})).unwrap() }).unwrap();
        reorder(&a.db, &[d.id.clone(), c.id.clone()], ReorderField::Sort).unwrap();
        let l = list(&a.db).unwrap();
        assert_eq!(l[0].id, d.id);
        reorder(&a.db, &[c.id.clone()], ReorderField::Pin).unwrap();
        assert_eq!(get(&a.db, &c.id).unwrap().pin_order, Some(0));
        delete(&a.db, &c.id).unwrap();
        assert_eq!(get(&a.db, &c.id).unwrap_err().code, ErrorCode::NotFound);
        assert_eq!(serde_json::to_value(ToolPinDisplay::IconAndName).unwrap(), json!("icon-and-name"));
    }
}
