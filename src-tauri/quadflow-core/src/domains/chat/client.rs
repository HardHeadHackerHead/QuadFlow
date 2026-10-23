//! OpenAI-compatible HTTP client (Ollama, LM Studio, OpenRouter, OpenAI, …).
//! Blocking (core has no async runtime); streaming reads the SSE body line by
//! line. Error messages never contain the API key (it only travels in the
//! `Authorization` header).

use super::model::{ChatRole, ChatUsage};
use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::time::Duration;

/// Everything needed to call the configured endpoint.
#[derive(Clone)]
pub struct ChatRequestConfig {
    pub endpoint: String,
    pub api_key: Option<String>,
    pub temperature: f64,
    pub max_tokens: u32,
    pub timeout_seconds: u32,
}

impl std::fmt::Debug for ChatRequestConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChatRequestConfig")
            .field("endpoint", &self.endpoint)
            .field("api_key", &self.api_key.as_ref().map(|_| "<set>"))
            .field("temperature", &self.temperature)
            .field("max_tokens", &self.max_tokens)
            .field("timeout_seconds", &self.timeout_seconds)
            .finish()
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct ApiMessage {
    pub role: &'static str,
    pub content: String,
}

impl ApiMessage {
    pub fn new(role: ChatRole, content: impl Into<String>) -> Self {
        Self { role: role.as_str(), content: content.into() }
    }
}

#[derive(Serialize)]
struct CompletionRequest<'a> {
    model: &'a str,
    messages: &'a [ApiMessage],
    temperature: f64,
    max_tokens: u32,
    stream: bool,
}

#[derive(Deserialize)]
struct WireUsage {
    prompt_tokens: Option<u32>,
    completion_tokens: Option<u32>,
    total_tokens: Option<u32>,
}

impl From<WireUsage> for ChatUsage {
    fn from(u: WireUsage) -> Self {
        ChatUsage { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, total_tokens: u.total_tokens }
    }
}

#[derive(Deserialize)]
struct WireMessage {
    content: Option<String>,
}

#[derive(Deserialize)]
struct WireChoice {
    message: Option<WireMessage>,
    delta: Option<WireMessage>,
}

#[derive(Deserialize)]
struct WireResponse {
    #[serde(default)]
    choices: Vec<WireChoice>,
    usage: Option<WireUsage>,
    error: Option<serde_json::Value>,
}

/// A completed answer.
#[derive(Clone, Debug, PartialEq)]
pub struct Completion {
    pub content: String,
    pub usage: Option<ChatUsage>,
}

/// `endpoint` must be an absolute http(s) URL.
pub fn validate_endpoint(endpoint: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(endpoint.trim())
        .map_err(|e| CoreError::invalid_input(format!("invalid chat endpoint {endpoint:?}: {e}")))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(CoreError::invalid_input(format!(
            "invalid chat endpoint {endpoint:?}: expected an http:// or https:// URL"
        )));
    }
    Ok(url)
}

fn completions_url(endpoint: &str) -> Result<String> {
    validate_endpoint(endpoint)?;
    Ok(format!("{}/chat/completions", endpoint.trim().trim_end_matches('/')))
}

fn client(timeout_seconds: u32) -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(timeout_seconds.max(1) as u64))
        .connect_timeout(Duration::from_secs(timeout_seconds.clamp(1, 15) as u64))
        .build()
        .map_err(|e| CoreError::internal(format!("could not build HTTP client: {e}")))
}

fn send_error(endpoint: &str, timeout_seconds: u32, e: reqwest::Error) -> CoreError {
    let detail = serde_json::json!({ "endpoint": endpoint });
    if e.is_timeout() {
        CoreError::external(format!(
            "The chat endpoint at {endpoint} did not answer within {timeout_seconds} s. \
             Increase the timeout in Chat settings, or use a smaller model."
        ))
        .with_details(detail)
    } else if e.is_connect() {
        CoreError::external(format!(
            "Could not connect to the chat endpoint at {endpoint}. Check the endpoint URL \
             (Settings > Integrations) and that the server is running."
        ))
        .with_details(detail)
    } else {
        CoreError::external(format!("Request to the chat endpoint at {endpoint} failed: {e}")).with_details(detail)
    }
}

fn truncate(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let end = s.char_indices().nth(max).map(|(i, _)| i).unwrap_or(s.len());
        format!("{}…", &s[..end])
    }
}

/// Turn an `{"error": …}` body into a readable message.
fn error_text(v: &serde_json::Value) -> String {
    v.get("message")
        .and_then(|m| m.as_str())
        .map(str::to_string)
        .or_else(|| v.as_str().map(str::to_string))
        .unwrap_or_else(|| v.to_string())
}

fn status_error(endpoint: &str, status: reqwest::StatusCode, body: &str) -> CoreError {
    let msg = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error").map(error_text))
        .unwrap_or_else(|| truncate(body, 300));
    let hint = match status.as_u16() {
        401 | 403 => " Check the API key (Settings > Integrations).",
        404 => " Check the endpoint URL and the model name.",
        _ => "",
    };
    CoreError::external(format!("The chat endpoint returned HTTP {}: {msg}.{hint}", status.as_u16()))
        .with_details(serde_json::json!({ "endpoint": endpoint, "status": status.as_u16() }))
}

fn post(
    cfg: &ChatRequestConfig,
    model: &str,
    messages: &[ApiMessage],
    stream: bool,
) -> Result<reqwest::blocking::Response> {
    let url = completions_url(&cfg.endpoint)?;
    let body = CompletionRequest { model, messages, temperature: cfg.temperature, max_tokens: cfg.max_tokens, stream };
    let mut req = client(cfg.timeout_seconds)?.post(&url).json(&body);
    if let Some(key) = cfg.api_key.as_deref().filter(|k| !k.is_empty()) {
        req = req.bearer_auth(key);
    }
    let resp = req.send().map_err(|e| send_error(&cfg.endpoint, cfg.timeout_seconds, e))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().unwrap_or_default();
        return Err(status_error(&cfg.endpoint, status, &text));
    }
    Ok(resp)
}

fn parse_full(endpoint: &str, text: &str) -> Result<Completion> {
    let r: WireResponse = serde_json::from_str(text).map_err(|e| {
        CoreError::external(format!("The chat endpoint at {endpoint} sent an unreadable answer: {e}"))
    })?;
    if let Some(err) = r.error {
        return Err(CoreError::external(format!("The chat endpoint reported an error: {}", error_text(&err))));
    }
    let content = r
        .choices
        .into_iter()
        .next()
        .and_then(|c| c.message.or(c.delta))
        .and_then(|m| m.content)
        .ok_or_else(|| CoreError::external(format!("The chat endpoint at {endpoint} returned no answer")))?;
    Ok(Completion { content, usage: r.usage.map(Into::into) })
}

/// One request, whole answer at once.
pub fn complete(cfg: &ChatRequestConfig, model: &str, messages: &[ApiMessage]) -> Result<Completion> {
    let resp = post(cfg, model, messages, false)?;
    let text = resp.text().map_err(|e| send_error(&cfg.endpoint, cfg.timeout_seconds, e))?;
    parse_full(&cfg.endpoint, &text)
}

/// One streaming request; `on_delta` gets each piece of the answer as it
/// arrives. Servers that ignore `stream: true` and answer with plain JSON work too.
pub fn stream(
    cfg: &ChatRequestConfig,
    model: &str,
    messages: &[ApiMessage],
    on_delta: &mut dyn FnMut(&str),
) -> Result<Completion> {
    let resp = post(cfg, model, messages, true)?;
    let is_json = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("application/json"));
    if is_json {
        let text = resp.text().map_err(|e| send_error(&cfg.endpoint, cfg.timeout_seconds, e))?;
        let c = parse_full(&cfg.endpoint, &text)?;
        on_delta(&c.content);
        return Ok(c);
    }
    let endpoint = cfg.endpoint.clone();
    let timeout = cfg.timeout_seconds;
    read_sse(BufReader::new(resp), on_delta).map_err(|e| match e {
        SseError::Io(e) => {
            let msg = e.to_string();
            if msg.to_lowercase().contains("timed out") {
                CoreError::external(format!(
                    "The chat endpoint at {endpoint} did not finish its answer within {timeout} s."
                ))
            } else {
                CoreError::external(format!("Reading the answer from {endpoint} failed: {msg}"))
            }
        }
        SseError::Remote(m) => CoreError::external(format!("The chat endpoint reported an error: {m}")),
    })
}

#[derive(Debug)]
pub(crate) enum SseError {
    Io(std::io::Error),
    Remote(String),
}

/// Parse an OpenAI-style `text/event-stream` body.
pub(crate) fn read_sse(reader: impl BufRead, on_delta: &mut dyn FnMut(&str)) -> std::result::Result<Completion, SseError> {
    let mut content = String::new();
    let mut usage = None;
    for line in reader.lines() {
        let line = line.map_err(SseError::Io)?;
        let line = line.trim_end_matches('\r');
        let Some(data) = line.strip_prefix("data:") else { continue };
        let data = data.trim();
        if data == "[DONE]" {
            break;
        }
        if data.is_empty() {
            continue;
        }
        let Ok(chunk) = serde_json::from_str::<WireResponse>(data) else { continue };
        if let Some(err) = chunk.error {
            return Err(SseError::Remote(error_text(&err)));
        }
        if let Some(text) = chunk
            .choices
            .into_iter()
            .next()
            .and_then(|c| c.delta.or(c.message))
            .and_then(|m| m.content)
            .filter(|t| !t.is_empty())
        {
            content.push_str(&text);
            on_delta(&text);
        }
        if let Some(u) = chunk.usage {
            usage = Some(u.into());
        }
    }
    Ok(Completion { content, usage })
}

/// Model ids offered by an endpoint: `GET {endpoint}/models` (OpenAI), then
/// Ollama's `/api/tags` at the server root.
pub fn list_models(endpoint: &str, api_key: Option<&str>, timeout_ms: u64) -> Result<Vec<String>> {
    let url = validate_endpoint(endpoint)?;
    let http = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(timeout_ms.max(100)))
        .build()
        .map_err(|e| CoreError::internal(format!("could not build HTTP client: {e}")))?;
    let models_url = format!("{}/models", endpoint.trim().trim_end_matches('/'));
    let mut req = http.get(&models_url);
    if let Some(k) = api_key.filter(|k| !k.is_empty()) {
        req = req.bearer_auth(k);
    }
    let mut last_err = None;
    match req.send() {
        Ok(r) if r.status().is_success() => {
            if let Ok(v) = r.json::<serde_json::Value>() {
                if let Some(arr) = v.get("data").and_then(|d| d.as_array()) {
                    return Ok(arr.iter().filter_map(|m| m.get("id")?.as_str().map(str::to_string)).collect());
                }
            }
        }
        Ok(r) => last_err = Some(status_error(endpoint, r.status(), &r.text().unwrap_or_default())),
        Err(e) => last_err = Some(send_error(endpoint, (timeout_ms / 1000).max(1) as u32, e)),
    }
    let mut root = url.clone();
    root.set_path("/api/tags");
    root.set_query(None);
    if let Ok(r) = http.get(root).send() {
        if r.status().is_success() {
            if let Ok(v) = r.json::<serde_json::Value>() {
                if let Some(arr) = v.get("models").and_then(|d| d.as_array()) {
                    return Ok(arr.iter().filter_map(|m| m.get("name")?.as_str().map(str::to_string)).collect());
                }
            }
        }
    }
    Err(last_err.unwrap_or_else(|| {
        CoreError::external(format!("The chat endpoint at {endpoint} did not return a model list"))
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sse_stream() {
        let body = "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n\
                    data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\r\n\r\n\
                    data:{\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\
                    : keep-alive comment\n\
                    data: {\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5}}\n\
                    data: [DONE]\n\
                    data: {\"choices\":[{\"delta\":{\"content\":\"ignored\"}}]}\n";
        let mut deltas = Vec::new();
        let c = read_sse(body.as_bytes(), &mut |d| deltas.push(d.to_string())).unwrap();
        assert_eq!(deltas, vec!["Hel", "lo"]);
        assert_eq!(c.content, "Hello");
        assert_eq!(c.usage.unwrap().total_tokens, Some(5));
    }

    #[test]
    fn sse_error_object_fails() {
        let body = "data: {\"error\":{\"message\":\"model not found\"}}\n";
        match read_sse(body.as_bytes(), &mut |_| {}) {
            Err(SseError::Remote(m)) => assert_eq!(m, "model not found"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn validates_endpoints() {
        assert!(validate_endpoint("http://localhost:11434/v1").is_ok());
        assert!(validate_endpoint("https://api.example.com/v1/").is_ok());
        for bad in ["", "localhost:11434", "ftp://x/v1", "not a url"] {
            assert!(validate_endpoint(bad).is_err(), "{bad}");
        }
        assert_eq!(completions_url("http://h:1/v1/").unwrap(), "http://h:1/v1/chat/completions");
    }

    #[test]
    fn status_errors_are_readable_and_hint() {
        let e = status_error("http://h/v1", reqwest::StatusCode::UNAUTHORIZED, r#"{"error":{"message":"bad key"}}"#);
        assert!(e.message.contains("HTTP 401: bad key"), "{}", e.message);
        assert!(e.message.contains("API key"));
        assert_eq!(e.code, crate::error::ErrorCode::External);
    }

    #[test]
    fn debug_never_prints_the_key() {
        let cfg = ChatRequestConfig {
            endpoint: "http://h/v1".into(),
            api_key: Some("sk-secret-value".into()),
            temperature: 0.7,
            max_tokens: 10,
            timeout_seconds: 5,
        };
        assert!(!format!("{cfg:?}").contains("sk-secret-value"));
    }
}
