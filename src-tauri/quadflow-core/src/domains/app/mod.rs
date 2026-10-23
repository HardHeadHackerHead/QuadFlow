//! App domain (data-layer.md §7, §7.1, §7.2): everything that lives in the app
//! SQLite DB and belongs to the shell — the working-dir project registry,
//! workspaces (layout + terminals + tiles), global workspaces, tool configs,
//! settings, stored prompts and custom agent definitions.
//!
//! Every function takes the [`AppDb`](crate::store::AppDb) explicitly; there is
//! no implicit active project in the backend (§0 rule 5) — "active" ids are
//! plain settings rows in the `shell` namespace.

pub mod agent_definitions;
pub mod projects;
pub mod prompts;
pub mod secrets;
pub mod settings;
pub mod tool_configs;
pub mod workspaces;

use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};

/// Toolbar section a pinned item lives in.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum AppPinSection {
    Left,
    Center,
    #[default]
    Right,
}

impl AppPinSection {
    pub fn as_str(self) -> &'static str {
        match self {
            AppPinSection::Left => "left",
            AppPinSection::Center => "center",
            AppPinSection::Right => "right",
        }
    }

    pub fn parse(s: &str) -> AppPinSection {
        match s {
            "left" => AppPinSection::Left,
            "center" => AppPinSection::Center,
            _ => AppPinSection::Right,
        }
    }
}

/// Serialize a JSON column value.
pub(crate) fn to_json(v: &serde_json::Value) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "null".into())
}

/// Parse a JSON column written by this crate; a value that does not parse is
/// reported as `corrupt` (never silently replaced).
pub(crate) fn parse_json(table: &str, id: &str, column: &str, raw: &str) -> Result<serde_json::Value> {
    serde_json::from_str(raw).map_err(|e| {
        CoreError::new(crate::error::ErrorCode::Corrupt, format!("{table} {id}: column {column} is not valid JSON: {e}"))
    })
}

pub(crate) fn parse_json_opt(table: &str, id: &str, column: &str, raw: Option<String>) -> Result<Option<serde_json::Value>> {
    match raw {
        None => Ok(None),
        Some(s) => parse_json(table, id, column, &s).map(|v| if v.is_null() { None } else { Some(v) }),
    }
}

/// Validate an opaque, shell-generated identifier (terminal ids, tile ids,
/// global-workspace ids): 1–200 chars, no control characters, no path separators.
pub(crate) fn validate_opaque_id(kind: &str, id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 200 || id.chars().any(|c| c.is_control() || c == '/' || c == '\\') {
        return Err(CoreError::invalid_input(format!("invalid {kind} id {id:?}")));
    }
    Ok(())
}

pub(crate) fn non_empty(field: &str, v: &str) -> Result<String> {
    let t = v.trim();
    if t.is_empty() {
        return Err(CoreError::invalid_input(format!("{field} must not be empty")));
    }
    Ok(t.to_string())
}

#[cfg(test)]
pub(crate) mod test_util {
    use crate::events::{ChangeEvent, EventBus};
    use crate::store::AppDb;
    use std::sync::{Arc, Mutex};

    pub struct App {
        pub db: AppDb,
        pub events: Arc<Mutex<Vec<ChangeEvent>>>,
        pub dir: tempfile::TempDir,
    }

    pub fn app() -> App {
        let dir = tempfile::Builder::new().prefix("qf-app-").tempdir().unwrap();
        let bus = EventBus::new();
        let events = Arc::new(Mutex::new(Vec::new()));
        let e2 = events.clone();
        bus.subscribe(move |e| e2.lock().unwrap().push(e.clone()));
        let db = AppDb::open(&crate::paths::AppPaths::under(dir.path()), bus).unwrap();
        App { db, events, dir }
    }

    impl App {
        pub fn take_events(&self) -> Vec<ChangeEvent> {
            std::mem::take(&mut *self.events.lock().unwrap())
        }
    }
}
