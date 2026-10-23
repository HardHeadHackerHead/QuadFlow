//! Namespaced key/value settings (data-layer.md §7.2). Values are JSON.
//!
//! Namespaces used by the shell: `shell` (active ids, global frame, toolbar,
//! session, layout presets, default workspace, workspace templates),
//! `appearance`, `terminal`, `editor`, `agents`, `notifications`, `chat`,
//! `cache`, and `plugin:<id>` for plugin settings.
//!
//! Change events carry ids of the form `"<namespace>/<key>"`.

use crate::error::{CoreError, Result};
use crate::events::{ChangeKind, Domain};
use crate::store::{AppChange, AppDb};
use crate::time::now_ms;
use regex::Regex;
use rusqlite::OptionalExtension;
use std::collections::BTreeMap;
use std::sync::OnceLock;

pub const SHELL: &str = "shell";
pub const KEY_ACTIVE_PROJECT: &str = "activeProjectId";

/// `shell` key holding the active workspace of one project.
pub fn active_workspace_key(project_id: &str) -> String {
    format!("activeWorkspace:{project_id}")
}

/// One setting value over IPC (any JSON; exports as `JsonValue`).
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(transparent)]
pub struct SettingValue(#[specta(type = crate::model::JsonValue)] pub serde_json::Value);

fn ns_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-z][a-zA-Z0-9_.:-]{0,99}$").unwrap())
}

pub fn validate_namespace(ns: &str) -> Result<()> {
    if ns_re().is_match(ns) {
        Ok(())
    } else {
        Err(CoreError::invalid_input(format!("invalid settings namespace {ns:?}")))
    }
}

pub fn validate_key(key: &str) -> Result<()> {
    if key.is_empty() || key.len() > 200 || key.chars().any(char::is_control) {
        return Err(CoreError::invalid_input(format!("invalid settings key {key:?}")));
    }
    Ok(())
}

/// Values that end up in agent argv are validated on save (agent-providers.md §6.4).
fn validate_value(ns: &str, key: &str, value: &serde_json::Value) -> Result<()> {
    if ns != crate::agents::models::SETTINGS_NS || value.is_null() {
        return Ok(());
    }
    if key.starts_with("customModels.") {
        crate::agents::models::validate_custom_models(value)?;
    } else if key.starts_with("defaultModel.") {
        match value.as_str() {
            Some(m) if m == crate::agents::SYSTEM_DEFAULT_MODEL => {}
            Some(m) => crate::agents::validate_model_id(m)?,
            None => return Err(CoreError::invalid_input(format!("{ns}/{key} must be a model id string"))),
        }
    } else if key == crate::agents::catalog::SETTING_CATALOG_URL {
        crate::agents::catalog::catalog_url(None, Some(value.as_str().unwrap_or("not a string")))?;
    }
    Ok(())
}

fn change(ns: &str, key: &str, op: ChangeKind) -> AppChange {
    AppChange::new(Domain::Settings, op, Some(format!("{ns}/{key}")))
}

/// All keys of a namespace. A stored value that is not valid JSON is `corrupt`.
pub fn get(db: &AppDb, ns: &str) -> Result<BTreeMap<String, serde_json::Value>> {
    validate_namespace(ns)?;
    let rows: Vec<(String, String)> = db.read(|c| {
        let mut stmt = c.prepare_cached("SELECT key, value FROM settings WHERE namespace = ?1 ORDER BY key")?;
        let rows = stmt.query_map([ns], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    })?;
    rows.into_iter()
        .map(|(k, v)| {
            let parsed = super::parse_json("settings", &format!("{ns}/{k}"), "value", &v)?;
            Ok((k, parsed))
        })
        .collect()
}

/// One value, `None` when unset.
pub fn get_value(db: &AppDb, ns: &str, key: &str) -> Result<Option<serde_json::Value>> {
    validate_namespace(ns)?;
    validate_key(key)?;
    let raw: Option<String> = db.read(|c| {
        c.query_row("SELECT value FROM settings WHERE namespace = ?1 AND key = ?2", [ns, key], |r| r.get(0))
            .optional()
    })?;
    raw.map(|v| super::parse_json("settings", &format!("{ns}/{key}"), "value", &v)).transpose()
}

/// A string value (`None` when unset or not a string).
pub fn get_string(db: &AppDb, ns: &str, key: &str) -> Result<Option<String>> {
    Ok(get_value(db, ns, key)?.and_then(|v| v.as_str().map(str::to_string)))
}

pub(crate) fn set_in_tx(tx: &rusqlite::Transaction, ns: &str, key: &str, value: &serde_json::Value) -> Result<()> {
    tx.execute(
        "INSERT INTO settings (namespace, key, value, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        rusqlite::params![ns, key, super::to_json(value), now_ms()],
    )?;
    Ok(())
}

pub(crate) fn delete_in_tx(tx: &rusqlite::Transaction, ns: &str, key: &str) -> Result<bool> {
    Ok(tx.execute("DELETE FROM settings WHERE namespace = ?1 AND key = ?2", [ns, key])? > 0)
}

pub fn set(db: &AppDb, ns: &str, key: &str, value: serde_json::Value) -> Result<()> {
    validate_namespace(ns)?;
    validate_key(key)?;
    validate_value(ns, key, &value)?;
    db.transact(|tx, ch| {
        set_in_tx(tx, ns, key, &value)?;
        ch.push(change(ns, key, ChangeKind::Updated));
        Ok(())
    })
}

/// Set several keys of one namespace in one transaction. A `null` value deletes the key.
pub fn set_many(db: &AppDb, ns: &str, entries: BTreeMap<String, serde_json::Value>) -> Result<()> {
    validate_namespace(ns)?;
    for (k, v) in &entries {
        validate_key(k)?;
        validate_value(ns, k, v)?;
    }
    if entries.is_empty() {
        return Ok(());
    }
    db.transact(|tx, ch| {
        for (k, v) in &entries {
            if v.is_null() {
                if delete_in_tx(tx, ns, k)? {
                    ch.push(change(ns, k, ChangeKind::Deleted));
                }
            } else {
                set_in_tx(tx, ns, k, v)?;
                ch.push(change(ns, k, ChangeKind::Updated));
            }
        }
        Ok(())
    })
}

pub fn delete(db: &AppDb, ns: &str, key: &str) -> Result<()> {
    validate_namespace(ns)?;
    validate_key(key)?;
    db.transact(|tx, ch| {
        if delete_in_tx(tx, ns, key)? {
            ch.push(change(ns, key, ChangeKind::Deleted));
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domains::app::test_util::app;
    use crate::error::ErrorCode;
    use serde_json::json;

    #[test]
    fn round_trip_and_events() {
        let a = app();
        assert!(get(&a.db, "appearance").unwrap().is_empty());
        set(&a.db, "appearance", "mode", json!("light")).unwrap();
        set(&a.db, "appearance", "uiScale", json!(110)).unwrap();
        set(&a.db, "terminal", "fontSize", json!(13)).unwrap();
        let m = get(&a.db, "appearance").unwrap();
        assert_eq!(m.len(), 2);
        assert_eq!(m["mode"], json!("light"));
        assert_eq!(get_value(&a.db, "terminal", "fontSize").unwrap(), Some(json!(13)));
        assert_eq!(get_string(&a.db, "appearance", "mode").unwrap().as_deref(), Some("light"));
        let ev = a.take_events();
        assert_eq!(ev.len(), 3);
        assert!(ev.iter().all(|e| e.domain == Domain::Settings));
        assert_eq!(ev[0].ids, vec!["appearance/mode".to_string()]);

        // Overwrite, batch with a null delete.
        set_many(&a.db, "appearance", BTreeMap::from([("mode".into(), json!("dark")), ("uiScale".into(), json!(null))])).unwrap();
        let m = get(&a.db, "appearance").unwrap();
        assert_eq!(m.len(), 1);
        assert_eq!(m["mode"], json!("dark"));
        delete(&a.db, "appearance", "mode").unwrap();
        assert!(get(&a.db, "appearance").unwrap().is_empty());
        // Deleting a missing key is a no-op without events.
        a.take_events();
        delete(&a.db, "appearance", "mode").unwrap();
        assert!(a.take_events().is_empty());
    }

    #[test]
    fn validation_and_corruption() {
        let a = app();
        for bad in ["", "Shell", "a/b", "1x", &"x".repeat(101)] {
            assert_eq!(set(&a.db, bad, "k", json!(1)).unwrap_err().code, ErrorCode::InvalidInput, "{bad:?}");
        }
        assert!(set(&a.db, "plugin:my-plugin", "k", json!(1)).is_ok());
        assert_eq!(set(&a.db, "shell", "", json!(1)).unwrap_err().code, ErrorCode::InvalidInput);
        a.db.write(&[], |tx| tx.execute("INSERT INTO settings VALUES ('shell','bad','{nope',0)", [])).unwrap();
        assert_eq!(get(&a.db, "shell").unwrap_err().code, ErrorCode::Corrupt);
    }
}
