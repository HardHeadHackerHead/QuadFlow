//! `http.fetch` (plugin-system.md §6.6): executed in Rust with `network:<host>`
//! (exact host; `network:<host>:<port>` pins the port) or `network:*`.
//! http/https only, redirects are not followed across hosts (a redirect is
//! returned to the plugin), 50 MiB response cap. Bodies travel as base64.

use super::{HostCall, HostEnv, MethodSpec, PermReq};
use crate::error::{CoreError, Result};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::io::Read;
use std::time::Duration;

pub const HTTP_MAX_RESPONSE_BYTES: u64 = 50 * 1024 * 1024;
pub const HTTP_DEFAULT_TIMEOUT_MS: u64 = 30_000;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct FetchInit {
    method: Option<String>,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    /// Text body.
    body: Option<String>,
    /// Binary body (base64); wins over `body`.
    body_base64: Option<String>,
    timeout_ms: Option<u64>,
}

fn parse_url(c: &HostCall) -> Result<reqwest::Url> {
    let raw: String = c.arg("url")?;
    let url = reqwest::Url::parse(&raw).map_err(|e| CoreError::invalid_input(format!("http.fetch: invalid url {raw:?}: {e}")))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(CoreError::invalid_input(format!("http.fetch: only http and https URLs are allowed, got {raw:?}")));
    }
    if url.host_str().is_none() {
        return Err(CoreError::invalid_input(format!("http.fetch: url {raw:?} has no host")));
    }
    Ok(url)
}

fn fetch_perm(_: &HostEnv, c: &HostCall) -> Result<Vec<String>> {
    let url = parse_url(c)?;
    let host = url.host_str().unwrap_or_default().trim_matches(['[', ']']).to_ascii_lowercase();
    let mut alts = Vec::new();
    if let Some(port) = url.port() {
        alts.push(format!("network:{host}:{port}"));
    }
    alts.push(format!("network:{host}"));
    alts.push("network:*".into());
    Ok(alts)
}

pub(super) fn methods() -> Vec<MethodSpec> {
    vec![MethodSpec::new("http.fetch", PermReq::Fn(fetch_perm), |_env: &HostEnv, c: &HostCall| {
        let url = parse_url(c)?;
        let init: FetchInit = c.arg_or_default("init")?;
        let method = reqwest::Method::from_bytes(init.method.as_deref().unwrap_or("GET").to_ascii_uppercase().as_bytes())
            .map_err(|_| CoreError::invalid_input("http.fetch: invalid method"))?;
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_millis(init.timeout_ms.unwrap_or(HTTP_DEFAULT_TIMEOUT_MS).clamp(1, 10 * 60_000)))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| CoreError::internal(format!("http client: {e}")))?;
        let mut req = client.request(method, url.clone());
        for (k, v) in &init.headers {
            req = req.header(k, v);
        }
        if let Some(b64) = &init.body_base64 {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|e| CoreError::invalid_input(format!("http.fetch: bodyBase64: {e}")))?;
            req = req.body(bytes);
        } else if let Some(text) = init.body {
            req = req.body(text);
        }
        let resp = req.send().map_err(|e| CoreError::external(format!("http.fetch {url}: {e}")))?;
        let status = resp.status().as_u16();
        let mut headers = Map::new();
        for (k, v) in resp.headers() {
            headers.insert(k.as_str().to_string(), Value::String(v.to_str().unwrap_or_default().to_string()));
        }
        if resp.content_length().is_some_and(|n| n > HTTP_MAX_RESPONSE_BYTES) {
            return Err(CoreError::external(format!("http.fetch: response is larger than {HTTP_MAX_RESPONSE_BYTES} bytes")));
        }
        let mut body = Vec::new();
        resp.take(HTTP_MAX_RESPONSE_BYTES + 1)
            .read_to_end(&mut body)
            .map_err(|e| CoreError::external(format!("http.fetch {url}: {e}")))?;
        if body.len() as u64 > HTTP_MAX_RESPONSE_BYTES {
            return Err(CoreError::external(format!("http.fetch: response is larger than {HTTP_MAX_RESPONSE_BYTES} bytes")));
        }
        Ok(json!({
            "status": status,
            "headers": headers,
            "bodyBase64": base64::engine::general_purpose::STANDARD.encode(&body),
        }))
    })]
}
