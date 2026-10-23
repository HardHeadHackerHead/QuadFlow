//! HTTP through the host's `http.fetch` (plugin-system.md §6.6): the request is
//! made by QuadFlow with this plugin's `network:<host>` permissions, so the
//! sidecar never talks to the network on its own.

use crate::error::{Result, YouTubeLiveError};
use base64::Engine;
use quadflow_sidecar::{json, Host, Value};
use std::time::Duration;

pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
    /// The body exactly as the host sent it (base64), for binary passthrough.
    pub body_base64: String,
}

impl HttpResponse {
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    pub fn json<T: serde::de::DeserializeOwned>(&self) -> Result<T> {
        serde_json::from_slice(&self.body).map_err(|e| YouTubeLiveError::Json(e.to_string()))
    }
}

#[derive(Clone)]
pub struct Http {
    host: Option<Host>,
}

const TIMEOUT_MS: u64 = 30_000;

impl Http {
    pub fn new(host: Option<Host>) -> Self {
        Self { host }
    }

    pub fn request(&self, method: &str, url: &str, headers: &[(&str, String)], body: Option<String>) -> Result<HttpResponse> {
        let host = self
            .host
            .as_ref()
            .ok_or_else(|| YouTubeLiveError::Http("no host connection (network is only available inside QuadFlow)".into()))?;
        let mut h = serde_json::Map::new();
        for (k, v) in headers {
            h.insert((*k).to_string(), Value::String(v.clone()));
        }
        let mut init = json!({ "method": method, "headers": h, "timeoutMs": TIMEOUT_MS });
        if let Some(b) = body {
            init["body"] = Value::String(b);
        }
        let r = host
            .call_timeout("http.fetch", json!({ "url": url, "init": init }), Duration::from_millis(TIMEOUT_MS + 15_000))
            .map_err(|e| YouTubeLiveError::Http(e.to_string()))?;
        let status = r.get("status").and_then(Value::as_u64).unwrap_or(0) as u16;
        let body_base64 = r.get("bodyBase64").and_then(Value::as_str).unwrap_or_default().to_string();
        let body = base64::engine::general_purpose::STANDARD
            .decode(&body_base64)
            .map_err(|e| YouTubeLiveError::Http(format!("bad response body: {e}")))?;
        Ok(HttpResponse { status, body, body_base64 })
    }

    pub fn get(&self, url: &str) -> Result<HttpResponse> {
        self.request("GET", url, &[], None)
    }

    pub fn get_bearer(&self, url: &str, token: &str) -> Result<HttpResponse> {
        self.request("GET", url, &[("Authorization", format!("Bearer {token}"))], None)
    }

    pub fn post_json(&self, url: &str, bearer: &str, body: &Value) -> Result<HttpResponse> {
        self.request(
            "POST",
            url,
            &[("Authorization", format!("Bearer {bearer}")), ("Content-Type", "application/json".to_string())],
            Some(body.to_string()),
        )
    }

    pub fn post_form(&self, url: &str, form: &[(&str, &str)]) -> Result<HttpResponse> {
        let body = form
            .iter()
            .map(|(k, v)| format!("{}={}", urlencoding::encode(k), urlencoding::encode(v)))
            .collect::<Vec<_>>()
            .join("&");
        self.request("POST", url, &[("Content-Type", "application/x-www-form-urlencoded".to_string())], Some(body))
    }
}
