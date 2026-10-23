//! Settings: one JSON document in the sidecar DB (non-secret fields) plus the
//! secret fields, which live in the OS keystore through the host's
//! `secrets.*` API (`SECRET_FIELDS`). The UI only ever sees masked secrets.

use crate::error::{Result, YouTubeLiveError};
use quadflow_sidecar::{json, Host, Value};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

/// `(settings field, secret name)` for every field that is stored as a secret.
pub const SECRET_FIELDS: [(&str, &str); 6] = [
    ("api_key", "youtube.apiKey"),
    ("oauth_client_id", "oauth.clientId"),
    ("oauth_client_secret", "oauth.clientSecret"),
    ("oauth_access_token", "oauth.accessToken"),
    ("oauth_refresh_token", "oauth.refreshToken"),
    ("openai_api_key", "openai.apiKey"),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct YouTubeSettings {
    // ---- secret fields (keystore; masked towards the UI) ----
    pub api_key: Option<String>,
    /// OpenAI key for TTS announcements and AI-generated polls.
    pub openai_api_key: Option<String>,
    pub tts_voice: String,
    pub tts_model: String,
    /// Chat model for AI-generated polls.
    pub ai_model: String,
    pub credentials_file: Option<String>,
    pub channel_id: Option<String>,
    pub poll_interval_ms: i64,
    pub command_prefix: String,
    pub max_daily_quota: i64,
    pub quota_warning_pct: i64,
    pub auto_connect: bool,
    pub tts_enabled: bool,
    pub tts_mode: String,
    pub slot_enabled: bool,
    pub slot_command_prefix: String,
    pub ideas_enabled: bool,
    pub goals_enabled: bool,
    pub tab_auto_cycle: bool,
    pub tab_cycle_interval_secs: i64,
    pub cycle_auto_resume_secs: i64,
    pub idea_cooldown_secs: i64,
    pub slot_cooldown_secs: i64,
    pub slot_pull_cost: i64,
    pub slot_jackpot_bonus: i64,
    pub idea_points_reward: i64,
    pub starting_points: i64,
    pub chat_xp_enabled: bool,
    pub chat_xp_amount: i64,
    pub chat_xp_cooldown_secs: i64,
    pub alerts_enabled: bool,
    pub alert_duration_secs: i64,
    pub video_stats_enabled: bool,
    pub video_stats_interval_secs: i64,
    pub channel_stats_enabled: bool,
    pub channel_stats_interval_secs: i64,
    pub idea_approve_bonus: i64,
    pub subscribers_enabled: bool,
    pub subscribers_poll_interval_secs: i64,
    pub oauth_access_token: Option<String>,
    pub oauth_refresh_token: Option<String>,
    pub oauth_client_id: Option<String>,
    pub oauth_client_secret: Option<String>,
    pub oauth_token_expiry: Option<i64>,
    // Adaptive polling settings for API efficiency
    pub adaptive_polling_enabled: bool,
    pub idle_threshold_polls: i64,        // Polls with 0 messages before slowing interval (default: 5)
    pub very_idle_threshold_polls: i64,   // Polls before skipping video stats (default: 10)
    pub channel_skip_threshold: i64,      // Unchanged polls before skipping channel stats (default: 5)
    pub max_poll_interval_ms: i64,        // Max interval when idle (default: 60000)
    // YouTube Live Polls settings
    pub yt_poll_enabled: bool,            // Enable YouTube native polls feature
    pub yt_poll_default_duration_secs: i64, // Default poll duration (default: 60)
    pub yt_poll_results_interval_secs: i64, // How often to poll for results (default: 5)
    pub yt_poll_auto_enabled: bool,       // Auto-generate polls at intervals
    pub yt_poll_auto_interval_secs: i64,  // Auto-poll interval (default: 900 = 15 min)
    pub yt_poll_auto_use_chat_context: bool, // Use chat context for AI poll generation
    pub yt_poll_auto_use_ide_context: bool,  // Use IDE context for AI poll generation
    pub yt_poll_tts_announce: bool,       // TTS announcement for poll start/results
    // Progressive jackpot settings
    pub progressive_jackpot_enabled: bool,
    pub progressive_contribution_pct: i64,
    pub progressive_seed_amount: i64,
    // Stats panel
    pub slot_stats_enabled: bool,
    // Symbol of the day
    pub slot_symbol_of_day_enabled: bool,
    pub slot_symbol_of_day_multiplier: i64,
    // Lucky hour
    pub slot_lucky_hour_enabled: bool,
    pub slot_lucky_hour_start: String,
    pub slot_lucky_hour_end: String,
    pub slot_lucky_hour_boost: i64,
}

impl Default for YouTubeSettings {
    fn default() -> Self {
        Self {
            api_key: None,
            openai_api_key: None,
            tts_voice: "alloy".to_string(),
            tts_model: "tts-1".to_string(),
            ai_model: "gpt-4o-mini".to_string(),
            credentials_file: None,
            channel_id: None,
            poll_interval_ms: 5000,
            command_prefix: "!idea".to_string(),
            max_daily_quota: 10000,
            quota_warning_pct: 80,
            auto_connect: false,
            tts_enabled: false,
            tts_mode: "name_only".to_string(),
            slot_enabled: true,
            slot_command_prefix: "!pull".to_string(),
            ideas_enabled: true,
            goals_enabled: true,
            tab_auto_cycle: false,
            tab_cycle_interval_secs: 15,
            cycle_auto_resume_secs: 30,
            idea_cooldown_secs: 0,
            slot_cooldown_secs: 30,
            slot_pull_cost: 10,
            slot_jackpot_bonus: 50, // multiplier of pull cost (50x)
            idea_points_reward: 5,
            starting_points: 100,
            chat_xp_enabled: true,
            chat_xp_amount: 1,
            chat_xp_cooldown_secs: 30,
            alerts_enabled: true,
            alert_duration_secs: 5,
            video_stats_enabled: true,
            video_stats_interval_secs: 60,
            channel_stats_enabled: true,
            channel_stats_interval_secs: 300,
            idea_approve_bonus: 50,
            subscribers_enabled: false,
            subscribers_poll_interval_secs: 60,
            oauth_access_token: None,
            oauth_refresh_token: None,
            oauth_client_id: None,
            oauth_client_secret: None,
            oauth_token_expiry: None,
            // Adaptive polling defaults
            adaptive_polling_enabled: true,
            idle_threshold_polls: 5,
            very_idle_threshold_polls: 10,
            channel_skip_threshold: 5,
            max_poll_interval_ms: 60000,
            // YouTube Live Polls defaults
            yt_poll_enabled: true,
            yt_poll_default_duration_secs: 60,
            yt_poll_results_interval_secs: 5,
            yt_poll_auto_enabled: false,
            yt_poll_auto_interval_secs: 900,
            yt_poll_auto_use_chat_context: true,
            yt_poll_auto_use_ide_context: false,
            yt_poll_tts_announce: true,
            // Progressive jackpot defaults
            progressive_jackpot_enabled: false,
            progressive_contribution_pct: 10,
            progressive_seed_amount: 100,
            // Stats panel
            slot_stats_enabled: true,
            // Symbol of the day
            slot_symbol_of_day_enabled: false,
            slot_symbol_of_day_multiplier: 2,
            // Lucky hour
            slot_lucky_hour_enabled: false,
            slot_lucky_hour_start: "20:00".to_string(),
            slot_lucky_hour_end: "21:00".to_string(),
            slot_lucky_hour_boost: 50,
        }
    }
}

impl YouTubeSettings {
    /// The secret field `name` (see `SECRET_FIELDS`).
    fn secret_mut(&mut self, field: &str) -> Option<&mut Option<String>> {
        Some(match field {
            "api_key" => &mut self.api_key,
            "oauth_client_id" => &mut self.oauth_client_id,
            "oauth_client_secret" => &mut self.oauth_client_secret,
            "oauth_access_token" => &mut self.oauth_access_token,
            "oauth_refresh_token" => &mut self.oauth_refresh_token,
            "openai_api_key" => &mut self.openai_api_key,
            _ => return None,
        })
    }

    fn secret(&self, field: &str) -> Option<&str> {
        match field {
            "api_key" => self.api_key.as_deref(),
            "oauth_client_id" => self.oauth_client_id.as_deref(),
            "oauth_client_secret" => self.oauth_client_secret.as_deref(),
            "oauth_access_token" => self.oauth_access_token.as_deref(),
            "oauth_refresh_token" => self.oauth_refresh_token.as_deref(),
            "openai_api_key" => self.openai_api_key.as_deref(),
            _ => None,
        }
    }

    /// The document stored in the DB: every secret field stripped.
    pub fn persisted(&self) -> Value {
        let mut s = self.clone();
        for (field, _) in SECRET_FIELDS {
            if let Some(f) = s.secret_mut(field) {
                *f = None;
            }
        }
        serde_json::to_value(&s).unwrap_or_else(|_| json!({}))
    }

    /// What the UI sees: secrets masked (the client id is not a credential and
    /// is shown in full so the user can recognise it).
    pub fn masked(&self) -> Self {
        let mut s = self.clone();
        for (field, _) in SECRET_FIELDS {
            if field == "oauth_client_id" {
                continue;
            }
            if let Some(f) = s.secret_mut(field) {
                if let Some(v) = f.as_deref() {
                    *f = Some(mask_secret(v));
                }
            }
        }
        s
    }

    /// Apply an `UpdateYouTubeSettingsRequest`-shaped patch: every known field
    /// that is present and not null is replaced; `clear_<field>: true` sets an
    /// optional field to null. Unknown keys are ignored; a wrongly typed value
    /// is an error (nothing is applied).
    pub fn patched(&self, patch: &Value) -> Result<Self> {
        let obj = patch
            .as_object()
            .ok_or_else(|| YouTubeLiveError::Json("settings update must be an object".into()))?;
        let mut cur = serde_json::to_value(self)?;
        let fields = cur.as_object_mut().expect("settings serialize to an object");
        for (k, v) in obj {
            if let Some(field) = k.strip_prefix("clear_") {
                if v.as_bool() == Some(true) && fields.contains_key(field) {
                    fields.insert(field.to_string(), Value::Null);
                }
                continue;
            }
            if v.is_null() || !fields.contains_key(k) {
                continue;
            }
            fields.insert(k.clone(), v.clone());
        }
        let mut next: Self =
            serde_json::from_value(cur).map_err(|e| YouTubeLiveError::Json(format!("invalid settings value: {e}")))?;
        // Empty strings clear a secret instead of storing "".
        for (field, _) in SECRET_FIELDS {
            if let Some(f) = next.secret_mut(field) {
                if f.as_deref().is_some_and(|v| v.trim().is_empty()) {
                    *f = None;
                }
            }
        }
        Ok(next)
    }
}

/// Mask a secret for display: `abcd...wxyz` for long values, `****` otherwise.
/// Counts characters, not bytes, so a non-ASCII value never panics (the old
/// command sliced bytes).
pub fn mask_secret(v: &str) -> String {
    let chars: Vec<char> = v.chars().collect();
    if chars.len() > 8 {
        let head: String = chars[..4].iter().collect();
        let tail: String = chars[chars.len() - 4..].iter().collect();
        format!("{head}...{tail}")
    } else if chars.is_empty() {
        String::new()
    } else {
        "****".to_string()
    }
}

/// Secret values through the host keystore (`secrets.get/set/delete`, permission
/// `secrets`), cached in memory. Without a host (unit tests) only the cache is used.
pub struct SecretStore {
    host: Option<Host>,
    cache: Mutex<HashMap<String, Option<String>>>,
}

impl SecretStore {
    pub fn new(host: Option<Host>) -> Self {
        Self { host, cache: Mutex::new(HashMap::new()) }
    }

    pub fn get(&self, name: &str) -> Option<String> {
        if let Some(v) = self.cache.lock().unwrap_or_else(|e| e.into_inner()).get(name) {
            return v.clone();
        }
        let value = match &self.host {
            Some(h) => match h.call("secrets.get", json!({ "name": name })) {
                Ok(v) => v.as_str().map(str::to_string),
                Err(e) => {
                    h.log("warn", format!("secrets.get {name}: {e}"));
                    // Not cached: a later call may succeed (e.g. after a grant).
                    return None;
                }
            },
            None => None,
        };
        self.cache.lock().unwrap_or_else(|e| e.into_inner()).insert(name.to_string(), value.clone());
        value
    }

    pub fn set(&self, name: &str, value: Option<&str>) -> Result<()> {
        if let Some(h) = &self.host {
            match value {
                Some(v) => h.call("secrets.set", json!({ "name": name, "value": v }))?,
                None => h.call("secrets.delete", json!({ "name": name }))?,
            };
        }
        self.cache.lock().unwrap_or_else(|e| e.into_inner()).insert(name.to_string(), value.map(str::to_string));
        Ok(())
    }

    /// Fill the secret fields of `s` from the store.
    pub fn overlay(&self, s: &mut YouTubeSettings) {
        for (field, name) in SECRET_FIELDS {
            let v = self.get(name);
            if let Some(f) = s.secret_mut(field) {
                *f = v;
            }
        }
    }

    /// Write every secret field that differs between `old` and `new`.
    pub fn store_changes(&self, old: &YouTubeSettings, new: &YouTubeSettings) -> Result<()> {
        for (field, name) in SECRET_FIELDS {
            if old.secret(field) != new.secret(field) {
                self.set(name, new.secret(field))?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_counts_chars_not_bytes() {
        assert_eq!(mask_secret("AIzaSyABCDEFGH"), "AIza...EFGH");
        assert_eq!(mask_secret("short"), "****");
        assert_eq!(mask_secret(""), "");
        // Multi-byte characters around the cut points must not panic.
        assert_eq!(mask_secret("ééééxxxxéééé"), "éééé...éééé");
        assert_eq!(mask_secret("🔑🔑🔑🔑🔑🔑🔑🔑🔑"), "🔑🔑🔑🔑...🔑🔑🔑🔑");
    }

    #[test]
    fn persisted_strips_secrets_and_masked_hides_them() {
        let s = YouTubeSettings {
            api_key: Some("AIzaSyABCDEFGHIJ".into()),
            oauth_client_id: Some("client.apps.googleusercontent.com".into()),
            oauth_client_secret: Some("GOCSPX-secretvalue".into()),
            ..Default::default()
        };
        let p = s.persisted();
        for (field, _) in SECRET_FIELDS {
            assert!(p[field].is_null(), "{field} must not be persisted");
        }
        let m = s.masked();
        assert_eq!(m.api_key.as_deref(), Some("AIza...GHIJ"));
        assert_eq!(m.oauth_client_secret.as_deref(), Some("GOCS...alue"));
        assert_eq!(m.oauth_client_id, s.oauth_client_id);
    }

    #[test]
    fn patch_applies_known_fields_and_clears() {
        let s = YouTubeSettings { channel_id: Some("UC1".into()), ..Default::default() };
        let n = s
            .patched(&json!({ "poll_interval_ms": 9000, "clear_channel_id": true, "unknown": 1, "tts_enabled": null }))
            .unwrap();
        assert_eq!(n.poll_interval_ms, 9000);
        assert_eq!(n.channel_id, None);
        assert_eq!(n.tts_enabled, s.tts_enabled);
        assert!(s.patched(&json!({ "poll_interval_ms": "fast" })).is_err());
        let n = s.patched(&json!({ "api_key": "  " })).unwrap();
        assert_eq!(n.api_key, None);
    }

    #[test]
    fn defaults_fill_missing_fields() {
        let s: YouTubeSettings = serde_json::from_value(json!({ "command_prefix": "!sug" })).unwrap();
        assert_eq!(s.command_prefix, "!sug");
        assert_eq!(s.poll_interval_ms, 5000);
        assert_eq!(s.slot_command_prefix, "!pull");
    }
}

