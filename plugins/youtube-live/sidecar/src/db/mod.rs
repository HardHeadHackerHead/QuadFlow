//! The sidecar's own SQLite database (`<plugin data dir>/youtube_live.db`),
//! split by area: streams, chat ideas, slot machine, quota, viewers/points,
//! goals, subscribers, polls. Settings live here as one JSON document (secrets
//! excluded, see `settings.rs`).

mod goals;
mod ideas;
mod polls;
mod quota;
mod slots;
mod streams;
mod subscribers;
mod users;

use crate::error::Result;
use crate::settings::{SecretStore, YouTubeSettings};
use rusqlite::Connection;
use std::path::Path;

const SCHEMA: &str = include_str!("schema.sql");

pub struct YouTubeLiveDatabase {
    conn: Connection,
    secrets: SecretStore,
}

impl YouTubeLiveDatabase {
    pub fn open(path: &Path, secrets: SecretStore) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| crate::error::YouTubeLiveError::Sqlite(e.to_string()))?;
        }
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
        Self::init(conn, secrets)
    }

    pub fn open_in_memory(secrets: SecretStore) -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        Self::init(conn, secrets)
    }

    fn init(conn: Connection, secrets: SecretStore) -> Result<Self> {
        conn.execute_batch(SCHEMA)?;
        let db = Self { conn, secrets };
        db.seed_default_symbols();
        db.seed_default_paytable();
        db.seed_default_poll_templates();
        Ok(db)
    }

    // ---- Settings ----

    /// Settings with secrets filled in from the keystore (never send these to
    /// the UI unmasked: use `YouTubeSettings::masked`).
    pub fn get_settings(&self) -> Result<YouTubeSettings> {
        let raw: String = self.conn.query_row("SELECT json FROM youtube_settings WHERE id = 1", [], |r| r.get(0))?;
        let mut s: YouTubeSettings = serde_json::from_str(&raw).unwrap_or_default();
        self.secrets.overlay(&mut s);
        Ok(s)
    }

    /// Apply a settings patch (see `YouTubeSettings::patched`); secrets go to the
    /// keystore, the rest to the DB.
    pub fn update_settings(&self, patch: &serde_json::Value) -> Result<YouTubeSettings> {
        let old = self.get_settings()?;
        let new = old.patched(patch)?;
        self.secrets.store_changes(&old, &new)?;
        self.conn.execute(
            "UPDATE youtube_settings SET json = ?1 WHERE id = 1",
            [serde_json::to_string(&new.persisted())?],
        )?;
        self.get_settings()
    }

    /// Save OAuth tokens and expiry timestamp after a successful token exchange or refresh.
    pub fn save_oauth_tokens(&self, access_token: &str, refresh_token: Option<&str>, expiry: i64) -> Result<()> {
        let mut patch = serde_json::json!({ "oauth_access_token": access_token, "oauth_token_expiry": expiry });
        if let Some(rt) = refresh_token {
            patch["oauth_refresh_token"] = serde_json::Value::String(rt.to_string());
        }
        self.update_settings(&patch).map(|_| ())
    }

    /// Clear all OAuth tokens (access, refresh, expiry) — used on disconnect.
    pub fn clear_oauth_tokens(&self) -> Result<()> {
        self.update_settings(&serde_json::json!({
            "clear_oauth_access_token": true,
            "clear_oauth_refresh_token": true,
            "clear_oauth_token_expiry": true,
        }))
        .map(|_| ())
    }
}

#[cfg(test)]
pub(crate) fn test_db() -> YouTubeLiveDatabase {
    YouTubeLiveDatabase::open_in_memory(SecretStore::new(None)).expect("in-memory db")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_seeds_and_settings_roundtrip() {
        let db = test_db();
        assert!(!db.list_slot_symbols().unwrap().is_empty());
        assert!(!db.list_paytable_entries().unwrap().is_empty());
        assert!(!db.list_poll_templates(None).unwrap().is_empty());

        let s = db
            .update_settings(&serde_json::json!({ "command_prefix": "!sug", "api_key": "AIzaSyABCDEFGHIJ" }))
            .unwrap();
        assert_eq!(s.command_prefix, "!sug");
        assert_eq!(s.api_key.as_deref(), Some("AIzaSyABCDEFGHIJ"));
        // The key is not in the DB document.
        let raw: String = db.conn.query_row("SELECT json FROM youtube_settings", [], |r| r.get(0)).unwrap();
        assert!(!raw.contains("AIzaSy"), "{raw}");

        db.save_oauth_tokens("tok", Some("refresh"), 42).unwrap();
        let s = db.get_settings().unwrap();
        assert_eq!(s.oauth_access_token.as_deref(), Some("tok"));
        assert_eq!(s.oauth_token_expiry, Some(42));
        db.clear_oauth_tokens().unwrap();
        let s = db.get_settings().unwrap();
        assert_eq!(s.oauth_access_token, None);
        assert_eq!(s.oauth_refresh_token, None);
        assert_eq!(s.oauth_token_expiry, None);
    }
}
