//! Google OAuth 2.0 (authorization code + loopback redirect) for the
//! subscriber feed and live polls. Client id/secret and tokens are secrets
//! (keystore through the host); the token endpoint is called with `http.fetch`.

use crate::error::{Result, YouTubeLiveError};
use crate::http::Http;
use crate::state::{App, YouTubeLiveState};
use quadflow_sidecar::json;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

pub const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
/// `youtube.readonly` for subscribers + `youtube.force-ssl` to post polls to the live chat.
pub const YOUTUBE_OAUTH_SCOPE: &str = "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.force-ssl";
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Deserialize)]
pub struct OAuthTokenResponse {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct OAuthStatus {
    pub is_connected: bool,
    pub has_refresh_token: bool,
    pub token_expires_at: Option<i64>,
    pub is_token_expired: bool,
}

fn token_request(http: &Http, form: &[(&str, &str)], what: &str) -> Result<OAuthTokenResponse> {
    let resp = http.post_form(GOOGLE_TOKEN_URL, form)?;
    if !resp.is_success() {
        return Err(YouTubeLiveError::Api(format!("Token {} failed: {}", what, resp.text())));
    }
    resp.json()
}

/// Exchange an authorization code for access + refresh tokens.
pub fn exchange_code_for_tokens(http: &Http, client_id: &str, client_secret: &str, code: &str, redirect_uri: &str) -> Result<OAuthTokenResponse> {
    token_request(
        http,
        &[
            ("code", code),
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("redirect_uri", redirect_uri),
            ("grant_type", "authorization_code"),
        ],
        "exchange",
    )
}

/// Refresh an expired access token using the stored refresh token.
pub fn refresh_access_token(http: &Http, client_id: &str, client_secret: &str, refresh_token: &str) -> Result<OAuthTokenResponse> {
    token_request(
        http,
        &[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ],
        "refresh",
    )
}

/// Expired (or expiring within 60 seconds)? No expiry recorded counts as expired.
pub fn is_token_expired(expiry: Option<i64>) -> bool {
    match expiry {
        Some(exp) => chrono::Utc::now().timestamp() >= exp - 60,
        None => true,
    }
}

pub fn status(state: &YouTubeLiveState) -> Result<OAuthStatus> {
    let s = state.get_db().get_settings()?;
    Ok(OAuthStatus {
        is_connected: s.oauth_access_token.as_ref().is_some_and(|t| !t.is_empty()),
        has_refresh_token: s.oauth_refresh_token.as_ref().is_some_and(|t| !t.is_empty()),
        token_expires_at: s.oauth_token_expiry,
        is_token_expired: is_token_expired(s.oauth_token_expiry),
    })
}

/// A valid access token, refreshed (and saved) when expired. The DB lock is not
/// held during the network call.
pub fn ensure_valid_token(app: &App) -> Result<String> {
    let settings = app.state().get_db().get_settings()?;
    let access_token = settings
        .oauth_access_token
        .filter(|t| !t.is_empty())
        .ok_or_else(|| YouTubeLiveError::NotConfigured("No OAuth access token".to_string()))?;
    if !is_token_expired(settings.oauth_token_expiry) {
        return Ok(access_token);
    }
    let refresh_token = settings
        .oauth_refresh_token
        .filter(|t| !t.is_empty())
        .ok_or_else(|| YouTubeLiveError::NotConfigured("No refresh token available to auto-refresh".to_string()))?;
    let client_id = settings
        .oauth_client_id
        .filter(|t| !t.is_empty())
        .ok_or_else(|| YouTubeLiveError::NotConfigured("No OAuth client ID configured".to_string()))?;
    let client_secret = settings
        .oauth_client_secret
        .filter(|t| !t.is_empty())
        .ok_or_else(|| YouTubeLiveError::NotConfigured("No OAuth client secret configured".to_string()))?;

    app.log("info", "OAuth access token expired, refreshing...");
    let token = refresh_access_token(app.http(), &client_id, &client_secret, &refresh_token)?;
    let expiry = chrono::Utc::now().timestamp() + token.expires_in;
    app.state().get_db().save_oauth_tokens(&token.access_token, token.refresh_token.as_deref(), expiry)?;
    Ok(token.access_token)
}

/// The query parameters of the loopback request (`GET /?code=…&state=… HTTP/1.1`).
pub fn parse_callback(request: &str) -> (Option<String>, Option<String>, Option<String>) {
    let first_line = request.lines().next().unwrap_or("");
    let path = first_line.split_whitespace().nth(1).unwrap_or("");
    let query = path.split('?').nth(1).unwrap_or("");
    let (mut code, mut state, mut error) = (None, None, None);
    for param in query.split('&') {
        let mut parts = param.splitn(2, '=');
        let key = parts.next().unwrap_or("");
        let value = urlencoding::decode(parts.next().unwrap_or("")).map(|v| v.into_owned()).unwrap_or_default();
        match key {
            "code" => code = Some(value),
            "state" => state = Some(value),
            "error" => error = Some(value),
            _ => {}
        }
    }
    (code, state, error)
}

fn emit_status(app: &App, status: &str, message: impl Into<String>) {
    app.emit("youtube:oauth-status", &json!({ "status": status, "message": message.into() }));
}

/// Wait for the browser's redirect on `listener` (non-blocking accept until the deadline).
fn wait_for_callback(listener: &TcpListener) -> std::result::Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + CALLBACK_TIMEOUT;
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).map_err(|e| format!("Read failed: {e}"))?;
                let request = String::from_utf8_lossy(&buf[..n]).into_owned();
                let ok = !request.contains("error=");
                let body = if ok {
                    "<html><body style=\"font-family:system-ui;text-align:center;padding:60px\"><h2>Authorization Successful!</h2><p>You can close this tab and return to QuadFlow.</p></body></html>"
                } else {
                    "<html><body style=\"font-family:system-ui;text-align:center;padding:60px\"><h2>Authorization Failed</h2><p>You can close this tab.</p></body></html>"
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
                return Ok(request);
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err("timeout".into());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(format!("Connection failed: {e}")),
        }
    }
}

/// Open the consent page and wait for the redirect. The browser is opened with
/// the host's `shell.openExternal`; if that is unavailable the UI gets an
/// `open-url` event and opens it itself.
pub fn start_flow(app: &App) -> std::result::Result<(), String> {
    let settings = app.state().get_db().get_settings().map_err(|e| e.to_string())?;
    let client_id = settings
        .oauth_client_id
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "OAuth Client ID is not configured. Please enter it in YouTube Settings first.".to_string())?;
    let client_secret = settings
        .oauth_client_secret
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "OAuth Client Secret is not configured. Please enter it in YouTube Settings first.".to_string())?;

    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("Failed to bind localhost listener: {e}"))?;
    let port = listener.local_addr().map_err(|e| format!("Failed to get local address: {e}"))?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}");
    let csrf_state = uuid::Uuid::new_v4().to_string();
    let auth_url = format!(
        "{}?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent&state={}",
        GOOGLE_AUTH_URL,
        urlencoding::encode(&client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(YOUTUBE_OAUTH_SCOPE),
        urlencoding::encode(&csrf_state),
    );

    let opened = app.host().map(|h| h.call("shell.openExternal", json!({ "url": auth_url })).is_ok()).unwrap_or(false);
    if !opened {
        app.emit("youtube:open-url", &json!({ "url": auth_url }));
    }
    emit_status(app, "waiting", "Waiting for authorization...");

    let request = match wait_for_callback(&listener) {
        Ok(r) => r,
        Err(e) if e == "timeout" => {
            emit_status(app, "error", "Authorization timed out (120s)");
            return Err("OAuth callback timed out after 120 seconds".to_string());
        }
        Err(e) => {
            emit_status(app, "error", e.clone());
            return Err(format!("Accept failed: {e}"));
        }
    };
    let (code, state, error) = parse_callback(&request);
    if let Some(err) = error {
        emit_status(app, "error", format!("Authorization denied: {err}"));
        return Err(format!("OAuth authorization denied: {err}"));
    }
    if state.as_deref() != Some(csrf_state.as_str()) {
        emit_status(app, "error", "State mismatch — possible CSRF attack");
        return Err("State parameter mismatch".to_string());
    }
    let code = code.ok_or_else(|| "No authorization code received".to_string())?;

    emit_status(app, "exchanging", "Exchanging authorization code...");
    let token = exchange_code_for_tokens(app.http(), &client_id, &client_secret, &code, &redirect_uri).map_err(|e| {
        emit_status(app, "error", format!("Token exchange failed: {e}"));
        e.to_string()
    })?;
    let expiry = chrono::Utc::now().timestamp() + token.expires_in;
    let settings = {
        let db = app.state().get_db();
        db.save_oauth_tokens(&token.access_token, token.refresh_token.as_deref(), expiry).map_err(|e| e.to_string())?;
        db.get_settings().map_err(|e| e.to_string())?
    };
    emit_status(app, "connected", "Connected to Google successfully!");
    app.emit("youtube:settings-changed", &settings.masked());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callback_query_is_parsed() {
        let (c, s, e) = parse_callback("GET /?state=abc&code=4%2F0Ab HTTP/1.1\r\nHost: x\r\n\r\n");
        assert_eq!(c.as_deref(), Some("4/0Ab"));
        assert_eq!(s.as_deref(), Some("abc"));
        assert_eq!(e, None);
        let (_, _, e) = parse_callback("GET /?error=access_denied HTTP/1.1");
        assert_eq!(e.as_deref(), Some("access_denied"));
    }

    #[test]
    fn expiry_rules() {
        assert!(is_token_expired(None));
        assert!(is_token_expired(Some(chrono::Utc::now().timestamp() + 30)));
        assert!(!is_token_expired(Some(chrono::Utc::now().timestamp() + 3600)));
    }
}
