//! Common model types shared by every domain (data-layer.md §5).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Epoch milliseconds, UTC.
pub type Timestamp = i64;

/// Plugin-owned extension data on any entity, keyed by plugin id. Core never interprets it.
/// Fields of this type crossing IPC need `#[specta(type = BTreeMap<String, JsonValue>)]`.
pub type Ext = BTreeMap<String, serde_json::Value>;

/// TypeScript shape of `serde_json::Value` (data-layer.md §9: exports as `JsonValue`).
///
/// Type-only: never constructed. specta =2.0.0-rc.25 exports `serde_json::Value`
/// as an *inline* recursive type, which specta-typescript refuses
/// ("infinitely recursive inline named reference"). A derived enum is a *named*
/// type, so the recursion goes through a reference. Annotate every
/// `serde_json::Value` field crossing IPC with `#[specta(type = JsonValue)]`
/// (or `Option<JsonValue>`, `BTreeMap<String, JsonValue>`).
#[allow(dead_code)]
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(untagged)]
pub enum JsonValue {
    Null(()),
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<JsonValue>),
    Object(BTreeMap<String, JsonValue>),
}

/// Who performed a change.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Actor {
    pub kind: ActorKind,
    /// "David", "<provider> agent", "issues" (plugin id)
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ActorKind {
    Human,
    Agent,
    Plugin,
    System,
}

impl Actor {
    fn simple(kind: ActorKind, name: impl Into<String>) -> Self {
        Self { kind, name: name.into(), plugin_id: None, provider_id: None, session_id: None }
    }

    pub fn human(name: impl Into<String>) -> Self {
        Self::simple(ActorKind::Human, name)
    }

    pub fn system() -> Self {
        Self::simple(ActorKind::System, "quadflow")
    }

    pub fn plugin(plugin_id: impl Into<String>) -> Self {
        let id = plugin_id.into();
        Self { plugin_id: Some(id.clone()), ..Self::simple(ActorKind::Plugin, id) }
    }

    /// The OS user name, for GUI-originated changes (setting `user.displayName` overrides; DL-10).
    pub fn os_user() -> Self {
        let name = std::env::var("USERNAME")
            .or_else(|_| std::env::var("USER"))
            .unwrap_or_else(|_| "user".to_string());
        Self::human(name)
    }

    /// CLI actor from `QUADFLOW_ACTOR_KIND` / `QUADFLOW_ACTOR_NAME` / `QUADFLOW_PROVIDER_ID` /
    /// `QUADFLOW_SESSION_ID` (exported by the GUI into agent PTYs). Default `{agent, "cli"}`.
    pub fn from_cli_env(get: impl Fn(&str) -> Option<String>) -> Self {
        let non_empty = |k: &str| get(k).filter(|v| !v.trim().is_empty());
        let kind = match non_empty("QUADFLOW_ACTOR_KIND").as_deref() {
            Some("human") => ActorKind::Human,
            Some("plugin") => ActorKind::Plugin,
            Some("system") => ActorKind::System,
            _ => ActorKind::Agent,
        };
        Self {
            kind,
            name: non_empty("QUADFLOW_ACTOR_NAME").unwrap_or_else(|| "cli".to_string()),
            plugin_id: None,
            provider_id: non_empty("QUADFLOW_PROVIDER_ID"),
            session_id: non_empty("QUADFLOW_SESSION_ID"),
        }
    }
}

/// A file that exists but could not be read/parsed. Lists report these instead of skipping.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CorruptEntry {
    pub path: String,
    pub message: String,
}

/// A list of entities plus the files that could not be parsed.
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ListResult<T> {
    pub items: Vec<T>,
    #[serde(default)]
    pub errors: Vec<CorruptEntry>,
}

impl<T> Default for ListResult<T> {
    fn default() -> Self {
        Self { items: Vec::new(), errors: Vec::new() }
    }
}

impl<T> ListResult<T> {
    pub fn map<U>(self, f: impl FnMut(T) -> U) -> ListResult<U> {
        ListResult { items: self.items.into_iter().map(f).collect(), errors: self.errors }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actor_from_env() {
        let a = Actor::from_cli_env(|_| None);
        assert_eq!(a.kind, ActorKind::Agent);
        assert_eq!(a.name, "cli");
        let a = Actor::from_cli_env(|k| match k {
            "QUADFLOW_ACTOR_KIND" => Some("human".into()),
            "QUADFLOW_ACTOR_NAME" => Some("David".into()),
            "QUADFLOW_SESSION_ID" => Some("abc".into()),
            _ => None,
        });
        assert_eq!(a.kind, ActorKind::Human);
        assert_eq!(a.name, "David");
        assert_eq!(a.session_id.as_deref(), Some("abc"));
        let v = serde_json::to_value(&a).unwrap();
        assert_eq!(v, serde_json::json!({"kind":"human","name":"David","sessionId":"abc"}));
    }
}
