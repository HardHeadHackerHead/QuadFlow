//! `storage.*` (plugin_kv), `settings.*` (namespace `plugin:<id>`, validated
//! against `contributes.settings`) and `secrets.*` (keychain entries
//! `plugin:<id>:<name>`) — plugin-system.md §6.5.

use super::{json, HostCall, HostEnv, MethodSpec, PermReq};
use crate::domains::app::settings;
use crate::error::{CoreError, Result};
use crate::events::{ChangeKind, Domain};
use crate::store::AppChange;
use crate::time::now_ms;
use rusqlite::{params, OptionalExtension};
use serde_json::{Map, Value};

/// Max size of one stored value (serialized JSON).
pub const KV_MAX_VALUE_BYTES: usize = 1024 * 1024;
/// Max total size of a plugin's values (all scopes).
pub const KV_MAX_PLUGIN_BYTES: usize = 50 * 1024 * 1024;

fn validate_kv_key(key: &str) -> Result<()> {
    if key.is_empty() || key.len() > 256 || key.chars().any(char::is_control) {
        return Err(CoreError::invalid_input(format!("invalid storage key {key:?} (1–256 chars, no control characters)")));
    }
    Ok(())
}

/// `"global"` or `"project:<root_key>"`.
fn kv_scope(env: &HostEnv, c: &HostCall) -> Result<String> {
    match c.opt::<String>("scope")?.as_deref() {
        None | Some("global") => Ok("global".into()),
        Some("project") => {
            let root = env.project_root(c)?;
            Ok(format!("project:{}", crate::paths::root_key(&root)))
        }
        Some(other) => Err(CoreError::invalid_input(format!("storage scope {other:?}: expected \"global\" or \"project\""))),
    }
}

fn kv_change(plugin: &str) -> AppChange {
    AppChange::new(Domain::PluginData, ChangeKind::Updated, Some(plugin))
}

pub fn settings_namespace(plugin_id: &str) -> String {
    format!("plugin:{plugin_id}")
}

/// The plugin's `contributes.settings` JSON Schema, if any.
fn settings_schema<'a>(c: &HostCall<'a>) -> Option<&'a Value> {
    c.plugin.manifest.as_ref().and_then(|m| m.contributes.settings.as_ref())
}

/// Stored values merged over the schema's `properties.*.default`s.
fn settings_all(env: &HostEnv, c: &HostCall) -> Result<Map<String, Value>> {
    let mut out = Map::new();
    if let Some(props) = settings_schema(c).and_then(|s| s.get("properties")).and_then(Value::as_object) {
        for (k, p) in props {
            if let Some(d) = p.get("default") {
                out.insert(k.clone(), d.clone());
            }
        }
    }
    let db = env.core.app_db()?;
    for (k, v) in settings::get(&db, &settings_namespace(&c.plugin.id))? {
        out.insert(k, v);
    }
    Ok(out)
}

/// Validate the would-be settings object against the schema (Rust-side, §6.5).
fn validate_settings(c: &HostCall, all: &Map<String, Value>) -> Result<()> {
    let Some(schema) = settings_schema(c) else {
        return Err(CoreError::invalid_input(format!(
            "plugin {:?} declares no settings (contributes.settings)",
            c.plugin.id
        )));
    };
    let validator = jsonschema::draft202012::new(schema)
        .map_err(|e| CoreError::invalid_input(format!("contributes.settings is not a valid JSON Schema: {e}")))?;
    let instance = Value::Object(all.clone());
    let errors: Vec<String> =
        validator.iter_errors(&instance).map(|e| format!("{}: {e}", e.instance_path)).collect();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(CoreError::invalid_input(format!("invalid settings: {}", errors.join("; "))))
    }
}

/// Secret key for a plugin-local name.
fn secret_key(c: &HostCall) -> Result<String> {
    let name: String = c.arg("name")?;
    if name.is_empty() || name.contains(':') {
        return Err(CoreError::invalid_input(format!("invalid secret name {name:?} (no ':')")));
    }
    let key = format!("plugin:{}:{name}", c.plugin.id);
    crate::domains::app::secrets::validate_key(&key)?;
    Ok(key)
}

pub(super) fn methods() -> Vec<MethodSpec> {
    let mut v = Vec::new();

    // ---- storage (no permission: own data only) ----
    v.push(MethodSpec::new("storage.get", PermReq::None, |env: &HostEnv, c: &HostCall| {
        let key: String = c.arg("key")?;
        validate_kv_key(&key)?;
        let scope = kv_scope(env, c)?;
        let db = env.core.app_db()?;
        let raw: Option<String> = db.read(|conn| {
            conn.query_row(
                "SELECT value FROM plugin_kv WHERE plugin_id = ?1 AND scope = ?2 AND key = ?3",
                params![c.plugin.id, scope, key],
                |r| r.get(0),
            )
            .optional()
        })?;
        match raw {
            None => Ok(Value::Null),
            Some(s) => serde_json::from_str(&s)
                .map_err(|e| CoreError::corrupt(db.path(), format!("plugin_kv {}/{scope}/{key}: {e}", c.plugin.id))),
        }
    }));
    v.push(MethodSpec::new("storage.set", PermReq::None, |env: &HostEnv, c: &HostCall| {
        let key: String = c.arg("key")?;
        validate_kv_key(&key)?;
        let scope = kv_scope(env, c)?;
        let value = c.params.get("value").cloned().unwrap_or(Value::Null);
        let text = value.to_string();
        if text.len() > KV_MAX_VALUE_BYTES {
            return Err(CoreError::invalid_input(format!("storage value is larger than {KV_MAX_VALUE_BYTES} bytes")));
        }
        let db = env.core.app_db()?;
        let id = c.plugin.id.clone();
        db.transact(|tx, changes| {
            let others: i64 = tx
                .query_row(
                    "SELECT COALESCE(SUM(LENGTH(value) + LENGTH(key)), 0) FROM plugin_kv
                     WHERE plugin_id = ?1 AND NOT (scope = ?2 AND key = ?3)",
                    params![id, scope, key],
                    |r| r.get(0),
                )
                .map_err(sql)?;
            if others as usize + text.len() + key.len() > KV_MAX_PLUGIN_BYTES {
                return Err(CoreError::invalid_input(format!("plugin storage quota ({KV_MAX_PLUGIN_BYTES} bytes) exceeded")));
            }
            tx.execute(
                "INSERT INTO plugin_kv (plugin_id, scope, key, value, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(plugin_id, scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![id, scope, key, text, now_ms()],
            )
            .map_err(sql)?;
            changes.push(kv_change(&id));
            Ok(())
        })?;
        Ok(Value::Null)
    }));
    v.push(MethodSpec::new("storage.delete", PermReq::None, |env: &HostEnv, c: &HostCall| {
        let key: String = c.arg("key")?;
        validate_kv_key(&key)?;
        let scope = kv_scope(env, c)?;
        let db = env.core.app_db()?;
        db.write(&[kv_change(&c.plugin.id)], |tx| {
            tx.execute(
                "DELETE FROM plugin_kv WHERE plugin_id = ?1 AND scope = ?2 AND key = ?3",
                params![c.plugin.id, scope, key],
            )
        })?;
        Ok(Value::Null)
    }));
    v.push(MethodSpec::new("storage.keys", PermReq::None, |env: &HostEnv, c: &HostCall| {
        let prefix: String = c.arg_or_default("prefix")?;
        let scope = kv_scope(env, c)?;
        let db = env.core.app_db()?;
        let keys: Vec<String> = db.read(|conn| {
            let mut st = conn.prepare("SELECT key FROM plugin_kv WHERE plugin_id = ?1 AND scope = ?2 ORDER BY key")?;
            let rows = st.query_map(params![c.plugin.id, scope], |r| r.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })?;
        json(keys.into_iter().filter(|k| k.starts_with(&prefix)).collect::<Vec<_>>())
    }));

    // ---- settings (no permission: own namespace only) ----
    v.push(MethodSpec::new("settings.getAll", PermReq::None, |env: &HostEnv, c: &HostCall| {
        Ok(Value::Object(settings_all(env, c)?))
    }));
    v.push(MethodSpec::new("settings.set", PermReq::None, |env: &HostEnv, c: &HostCall| {
        let key: String = c.arg("key")?;
        settings::validate_key(&key)?;
        let value = c.params.get("value").cloned().unwrap_or(Value::Null);
        let mut all = settings_all(env, c)?;
        all.insert(key.clone(), value.clone());
        validate_settings(c, &all)?;
        let db = env.core.app_db()?;
        settings::set(&db, &settings_namespace(&c.plugin.id), &key, value)?;
        Ok(Value::Object(all))
    }));

    // ---- secrets (permission `secrets`) ----
    v.push(MethodSpec::new("secrets.get", PermReq::One("secrets"), |env: &HostEnv, c: &HostCall| {
        json(env.secrets.get(&secret_key(c)?)?)
    }));
    // The keystore cannot enumerate entries: names are indexed in setting
    // `plugins.secrets/<id>` so uninstall (PL-9) can remove them.
    v.push(MethodSpec::new("secrets.set", PermReq::One("secrets"), |env: &HostEnv, c: &HostCall| {
        let key = secret_key(c)?;
        env.secrets.set(&key, &c.arg::<String>("value")?)?;
        let name: String = c.arg("name")?;
        crate::plugins::sources::install::record_plugin_secret(&*env.core.app_db()?, &c.plugin.id, &name)?;
        Ok(Value::Null)
    }));
    v.push(MethodSpec::new("secrets.delete", PermReq::One("secrets"), |env: &HostEnv, c: &HostCall| {
        env.secrets.delete(&secret_key(c)?)?;
        let name: String = c.arg("name")?;
        crate::plugins::sources::install::forget_plugin_secret(&*env.core.app_db()?, &c.plugin.id, &name)?;
        Ok(Value::Null)
    }));

    v
}

fn sql(e: rusqlite::Error) -> CoreError {
    CoreError::from(e)
}
