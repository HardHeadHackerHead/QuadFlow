//! The YouTube Data API key: a credentials file (path in settings) or the key itself (keystore).

use crate::error::{Result, YouTubeLiveError};
use crate::settings::YouTubeSettings;

pub fn read_api_key_from_file(path: &str) -> Result<String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| YouTubeLiveError::NotConfigured(format!("Cannot read credentials file: {}", e)))?;

    let content = content.trim();

    // Try JSON parsing
    if content.starts_with('{') {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(content) {
            // Detect Google OAuth 2.0 client_secret JSON (wrong credential type)
            if json.get("installed").is_some() || json.get("web").is_some() {
                return Err(YouTubeLiveError::NotConfigured(
                    "This is a Google OAuth 2.0 client secret file, not an API key file. \
                     In Google Cloud Console go to Credentials > API Keys, copy your key, \
                     and save it as: { \"key\": \"YOUR_API_KEY\" }".into(),
                ));
            }

            // Detect Google service account key JSON (wrong credential type)
            if json.get("type").and_then(|v| v.as_str()) == Some("service_account") {
                return Err(YouTubeLiveError::NotConfigured(
                    "This is a Google service account key file, not an API key file. \
                     In Google Cloud Console go to Credentials > API Keys, copy your key, \
                     and save it as: { \"key\": \"YOUR_API_KEY\" }".into(),
                ));
            }

            // Try common field names for API key
            for field in &["key", "api_key", "apiKey", "youtube_api_key"] {
                if let Some(val) = json.get(field).and_then(|v| v.as_str()) {
                    if !val.is_empty() {
                        return Ok(val.to_string());
                    }
                }
            }

            return Err(YouTubeLiveError::NotConfigured(
                "Credentials file does not contain a 'key' field. \
                 Expected format: { \"key\": \"YOUR_API_KEY\" }".into(),
            ));
        }
    }

    // Fall back: treat whole file as the key (plain text)
    if !content.is_empty() && content.len() < 200 && !content.contains('\n') {
        return Ok(content.to_string());
    }

    Err(YouTubeLiveError::NotConfigured(
        "Could not read API key from credentials file".into(),
    ))
}

/// Resolve the effective API key from settings.
/// Credentials file takes priority over a direct api_key.
pub fn get_effective_api_key(settings: &YouTubeSettings) -> Result<String> {
    // Try credentials file first
    if let Some(ref path) = settings.credentials_file {
        if !path.is_empty() {
            return read_api_key_from_file(path);
        }
    }

    // Fall back to direct api_key
    if let Some(ref key) = settings.api_key {
        if !key.is_empty() {
            return Ok(key.clone());
        }
    }

    Err(YouTubeLiveError::NotConfigured(
        "No API key configured. Add a credentials file in settings.".into(),
    ))
}

