//! Model catalog (agent-providers.md §6): `catalog/models.json` of the public
//! repo, fetched raw from the default branch with ETag, cached 6 h in
//! `<cache>/models.json`, with a snapshot compiled into the binary as fallback.
//! Invalid model entries are dropped individually; a document with the wrong
//! `schemaVersion` (or not JSON) is rejected as a whole.

use super::models::validate_model_id;
use super::spec::provider_id_re;
use crate::error::{CoreError, Result};
use crate::model::Timestamp;
use crate::paths::AppPaths;
use crate::store::{atomic_write_json, read_file};
use crate::time::now_ms;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::time::Duration;

pub const SCHEMA_VERSION: u64 = 1;
/// Snapshot of `catalog/models.json` at build time.
pub const BUNDLED: &str = include_str!("../../../../catalog/models.json");
pub const CACHE_FILE: &str = "models.json";
pub const MAX_AGE_MS: i64 = 6 * 3600 * 1000;
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
pub const MAX_BYTES: usize = 256 * 1024;
/// Env override for the catalog URL (https only).
pub const ENV_CATALOG_URL: &str = "QUADFLOW_CATALOG_URL";
/// Setting (namespace `agents`) overriding the catalog URL.
pub const SETTING_CATALOG_URL: &str = "catalogUrl";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum AgentCatalogSource {
    Remote,
    Cache,
    Bundled,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CatalogModelKind {
    Alias,
    #[default]
    Model,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    pub id: String,
    pub label: String,
    pub short_label: Option<String>,
    pub kind: CatalogModelKind,
    pub context_window: Option<u64>,
    pub default: bool,
    pub deprecated: bool,
    pub efforts: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Catalog {
    pub updated_at: String,
    pub providers: BTreeMap<String, Vec<CatalogModel>>,
    pub source: AgentCatalogSource,
    /// Entries ignored while parsing.
    pub warnings: Vec<String>,
    /// When the cache was last confirmed against the remote (ms).
    pub fetched_at: Option<Timestamp>,
}

impl Catalog {
    pub fn models_for(&self, key: &str) -> &[CatalogModel] {
        self.providers.get(key).map(Vec::as_slice).unwrap_or(&[])
    }
}

/// `{ updatedAt, source, fetchedAt, warnings }` for Settings → Agents.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentCatalogStatus {
    pub updated_at: String,
    pub source: AgentCatalogSource,
    pub fetched_at: Option<Timestamp>,
    pub warnings: Vec<String>,
    /// The URL refreshed from (`None` = no remote configured).
    pub url: Option<String>,
    /// Last refresh error (offline, HTTP status, rejected document).
    pub error: Option<String>,
}

impl Catalog {
    pub fn status(&self, url: Option<String>, error: Option<String>) -> AgentCatalogStatus {
        AgentCatalogStatus {
            updated_at: self.updated_at.clone(),
            source: self.source,
            fetched_at: self.fetched_at,
            warnings: self.warnings.clone(),
            url,
            error,
        }
    }
}

/// Parse a catalog document. Whole-document errors → `Err`; bad entries become warnings.
pub fn parse(bytes: &[u8]) -> Result<(Catalog, Vec<String>)> {
    let doc: Value = serde_json::from_slice(bytes).map_err(|e| CoreError::invalid_input(format!("model catalog is not JSON: {e}")))?;
    parse_value(&doc)
}

fn parse_value(doc: &Value) -> Result<(Catalog, Vec<String>)> {
    let obj = doc.as_object().ok_or_else(|| CoreError::invalid_input("model catalog must be a JSON object"))?;
    if obj.get("schemaVersion").and_then(Value::as_u64) != Some(SCHEMA_VERSION) {
        return Err(CoreError::incompatible(format!(
            "model catalog schemaVersion {} is not supported (expected {SCHEMA_VERSION})",
            obj.get("schemaVersion").map(|v| v.to_string()).unwrap_or_else(|| "missing".into())
        )));
    }
    let providers = obj
        .get("providers")
        .and_then(Value::as_object)
        .ok_or_else(|| CoreError::invalid_input("model catalog has no providers object"))?;
    let mut warnings = Vec::new();
    let mut out = BTreeMap::new();
    for (key, p) in providers {
        if !provider_id_re().is_match(key) {
            warnings.push(format!("provider {key:?}: invalid provider key, ignored"));
            continue;
        }
        let Some(models) = p.get("models").and_then(Value::as_array) else {
            warnings.push(format!("provider {key:?}: no models array, ignored"));
            continue;
        };
        let mut seen = HashSet::new();
        let mut list = Vec::new();
        for (i, m) in models.iter().enumerate() {
            match parse_model(m) {
                Ok(model) => {
                    if seen.insert(model.id.clone()) {
                        list.push(model);
                    } else {
                        warnings.push(format!("{key}[{i}] {:?}: duplicate id, ignored", model.id));
                    }
                }
                Err(why) => warnings.push(format!("{key}[{i}]: {why}, ignored")),
            }
        }
        out.insert(key.clone(), list);
    }
    for w in &warnings {
        tracing::warn!("model catalog: {w}");
    }
    let catalog = Catalog {
        updated_at: obj.get("updatedAt").and_then(Value::as_str).unwrap_or_default().to_string(),
        providers: out,
        source: AgentCatalogSource::Bundled,
        warnings: warnings.clone(),
        fetched_at: None,
    };
    Ok((catalog, warnings))
}

fn parse_model(m: &Value) -> std::result::Result<CatalogModel, String> {
    let o = m.as_object().ok_or("not an object")?;
    let id = o.get("id").and_then(Value::as_str).ok_or("missing id")?;
    validate_model_id(id).map_err(|e| e.message)?;
    let label = o.get("label").and_then(Value::as_str).map(str::trim).unwrap_or_default();
    if label.is_empty() || label.chars().count() > 60 || label.chars().any(char::is_control) {
        return Err(format!("{id:?}: label must be 1-60 printable chars"));
    }
    let short_label = match o.get("shortLabel") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if !s.trim().is_empty() && s.chars().count() <= 8 && !s.chars().any(char::is_control) => {
            Some(s.trim().to_string())
        }
        Some(_) => return Err(format!("{id:?}: shortLabel must be 1-8 chars")),
    };
    let kind = match o.get("kind").and_then(Value::as_str) {
        None => CatalogModelKind::Model,
        Some("model") => CatalogModelKind::Model,
        Some("alias") => CatalogModelKind::Alias,
        Some(k) => return Err(format!("{id:?}: unknown kind {k:?}")),
    };
    let context_window = match o.get("contextWindow") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.as_u64().filter(|n| *n >= 1).ok_or_else(|| format!("{id:?}: contextWindow must be a positive integer"))?),
    };
    let flag = |k: &str| -> std::result::Result<bool, String> {
        match o.get(k) {
            None | Some(Value::Null) => Ok(false),
            Some(Value::Bool(b)) => Ok(*b),
            Some(_) => Err(format!("{id:?}: {k} must be a boolean")),
        }
    };
    let efforts = match o.get("efforts") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|e| e.as_str().filter(|s| super::validate_effort(s).is_ok()).map(str::to_string))
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| format!("{id:?}: efforts must be [a-z]+ strings"))?,
        Some(_) => return Err(format!("{id:?}: efforts must be an array")),
    };
    Ok(CatalogModel {
        id: id.to_string(),
        label: label.to_string(),
        short_label,
        kind,
        context_window,
        default: flag("default")?,
        deprecated: flag("deprecated")?,
        efforts,
    })
}

/// The compiled-in snapshot.
pub fn bundled() -> Catalog {
    parse(BUNDLED.as_bytes()).map(|(c, _)| c).expect("bundled catalog/models.json is valid")
}

/// `<appData>/cache/models.json`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheFile {
    pub etag: Option<String>,
    pub fetched_at: Timestamp,
    pub url: String,
    pub body: Value,
}

pub fn cache_path(paths: &AppPaths) -> PathBuf {
    paths.cache_dir.join(CACHE_FILE)
}

pub fn read_cache(paths: &AppPaths) -> Option<CacheFile> {
    let bytes = read_file(&cache_path(paths)).ok()??;
    serde_json::from_slice(&bytes).ok()
}

fn from_cache(c: &CacheFile) -> Option<Catalog> {
    let (mut cat, _) = parse_value(&c.body).ok()?;
    cat.source = AgentCatalogSource::Cache;
    cat.fetched_at = Some(c.fetched_at);
    Some(cat)
}

/// Cached catalog if valid, else the bundled snapshot.
pub fn load_cached_or_bundled(paths: &AppPaths) -> Catalog {
    read_cache(paths).as_ref().and_then(from_cache).unwrap_or_else(bundled)
}

/// Resolve the catalog URL: env `QUADFLOW_CATALOG_URL`, then setting
/// `agents.catalogUrl`, then the repo default branch. `Ok(None)` while the repo
/// constant is still a placeholder. Only `https://` is accepted.
pub fn catalog_url(env_override: Option<&str>, setting: Option<&str>) -> Result<Option<String>> {
    let pick = env_override.or(setting).map(str::trim).filter(|s| !s.is_empty());
    match pick {
        Some(u) => {
            if !u.starts_with("https://") || u.chars().any(|c| c.is_whitespace() || c.is_control()) {
                return Err(CoreError::invalid_input(format!("model catalog URL must be an https:// URL, got {u:?}")));
            }
            Ok(Some(u.to_string()))
        }
        None if crate::urls::repo_configured() => Ok(Some(crate::urls::raw_default_branch("catalog/models.json"))),
        None => Ok(None),
    }
}

/// Is the cache for `url` younger than 6 h?
pub fn cache_is_fresh(paths: &AppPaths, url: &str, now: Timestamp) -> bool {
    read_cache(paths).is_some_and(|c| c.url == url && now - c.fetched_at < MAX_AGE_MS && from_cache(&c).is_some())
}

/// Fetch `url` (unless the cache is fresh and `!force`) and update the cache.
/// On any failure the previous cache is kept and the error is returned; callers
/// fall back to [`load_cached_or_bundled`].
pub fn refresh(paths: &AppPaths, url: &str, force: bool) -> Result<Catalog> {
    let now = now_ms();
    let prev = read_cache(paths).filter(|c| c.url == url);
    if !force {
        if let Some(c) = &prev {
            if now - c.fetched_at < MAX_AGE_MS {
                if let Some(cat) = from_cache(c) {
                    return Ok(cat);
                }
            }
        }
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .user_agent(concat!("QuadFlow/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| CoreError::external(format!("http client: {e}")))?;
    let mut req = client.get(url);
    if let Some(etag) = prev.as_ref().and_then(|c| c.etag.as_deref()) {
        req = req.header(reqwest::header::IF_NONE_MATCH, etag);
    }
    let resp = req.send().map_err(|e| CoreError::external(format!("fetching model catalog: {e}")))?;
    let status = resp.status();
    if status == reqwest::StatusCode::NOT_MODIFIED {
        if let Some(mut c) = prev {
            c.fetched_at = now;
            atomic_write_json(&cache_path(paths), &c)?;
            return from_cache(&c).ok_or_else(|| CoreError::corrupt(&cache_path(paths), "cached catalog is invalid"));
        }
        return Err(CoreError::external("model catalog: 304 without a cached copy"));
    }
    if !status.is_success() {
        return Err(CoreError::external(format!("model catalog fetch failed: HTTP {status}")));
    }
    let etag = resp.headers().get(reqwest::header::ETAG).and_then(|v| v.to_str().ok()).map(str::to_string);
    let mut body = Vec::new();
    use std::io::Read;
    resp.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut body)
        .map_err(|e| CoreError::external(format!("reading model catalog: {e}")))?;
    if body.len() > MAX_BYTES {
        return Err(CoreError::invalid_input(format!("model catalog exceeds {MAX_BYTES} bytes")));
    }
    let doc: Value =
        serde_json::from_slice(&body).map_err(|e| CoreError::invalid_input(format!("model catalog is not JSON: {e}")))?;
    let (mut cat, _) = parse_value(&doc)?;
    std::fs::create_dir_all(&paths.cache_dir).map_err(|e| CoreError::io(&paths.cache_dir, e))?;
    atomic_write_json(&cache_path(paths), &CacheFile { etag, fetched_at: now, url: url.to_string(), body: doc })?;
    cat.source = AgentCatalogSource::Remote;
    cat.fetched_at = Some(now);
    Ok(cat)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

    #[test]
    fn bundled_catalog_is_valid_and_matches_schema() {
        let (cat, warnings) = parse(BUNDLED.as_bytes()).unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");
        assert!(cat.providers.values().all(|m| !m.is_empty()));
        // CI check: catalog/models.json validates against catalog/models.schema.json.
        let schema: Value = serde_json::from_str(include_str!("../../../../catalog/models.schema.json")).unwrap();
        let v = jsonschema::draft202012::options().should_validate_formats(true).build(&schema).unwrap();
        let doc: Value = serde_json::from_str(BUNDLED).unwrap();
        let errs: Vec<String> = v.iter_errors(&doc).map(|e| format!("{}: {e}", e.instance_path)).collect();
        assert!(errs.is_empty(), "{errs:?}");
    }

    #[test]
    fn invalid_entries_dropped_individually() {
        let doc = json!({
            "schemaVersion": 1, "updatedAt": "2026-10-01",
            "providers": {
                "alpha": { "models": [
                    { "id": "good-1", "label": "Good" },
                    { "id": "x; rm -rf ~", "label": "Evil" },
                    { "id": "$(whoami)", "label": "Evil" },
                    { "id": "a\nb", "label": "Newline" },
                    { "id": "ok'quote", "label": "Quote" },
                    { "id": "nolabel" },
                    { "id": "big", "label": "Big", "contextWindow": -5 },
                    { "id": "good-1", "label": "Dup" },
                    { "id": "opus[1m]", "label": "Opus 1M", "kind": "alias", "default": true },
                    42
                ]},
                "Bad Key": { "models": [] },
                "future-provider": { "models": [{ "id": "f1", "label": "F1", "unknownField": true }] }
            }
        });
        let (cat, warnings) = parse(doc.to_string().as_bytes()).unwrap();
        let ids: Vec<_> = cat.models_for("alpha").iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["good-1", "opus[1m]"]);
        assert_eq!(cat.models_for("alpha")[0].label, "Good", "first duplicate wins");
        assert!(cat.models_for("alpha")[1].default);
        assert_eq!(warnings.len(), 9, "{warnings:?}");
        assert!(!cat.providers.contains_key("Bad Key"));
        assert_eq!(cat.models_for("future-provider").len(), 1, "unknown providers kept");
    }

    #[test]
    fn whole_document_rejected() {
        assert!(parse(b"not json").is_err());
        assert!(parse(json!({"schemaVersion": 2, "providers": {}}).to_string().as_bytes()).is_err());
        assert!(parse(json!({"providers": {}}).to_string().as_bytes()).is_err());
    }

    #[test]
    fn url_resolution() {
        assert_eq!(catalog_url(Some("https://e.com/m.json"), Some("https://s.com")).unwrap().as_deref(), Some("https://e.com/m.json"));
        assert_eq!(catalog_url(None, Some("https://s.com/x")).unwrap().as_deref(), Some("https://s.com/x"));
        assert!(catalog_url(Some("http://e.com"), None).is_err());
        assert!(catalog_url(None, Some("file:///etc/passwd")).is_err());
        let default = catalog_url(None, None).unwrap();
        assert_eq!(default.is_some(), crate::urls::repo_configured());
    }

    /// Minimal HTTP server: answers each connection with the next canned response
    /// and records the request headers.
    fn serve(responses: Vec<String>) -> (String, std::sync::mpsc::Receiver<String>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/models.json", l.local_addr().unwrap());
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for resp in responses {
                let (mut s, _) = l.accept().unwrap();
                let mut r = BufReader::new(s.try_clone().unwrap());
                let mut head = String::new();
                loop {
                    let mut line = String::new();
                    if r.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                        break;
                    }
                    head.push_str(&line);
                }
                tx.send(head).unwrap();
                s.write_all(resp.as_bytes()).unwrap();
            }
        });
        (url, rx)
    }

    #[test]
    fn refresh_with_etag_and_cache() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = AppPaths::under(tmp.path());
        let body = json!({"schemaVersion":1,"updatedAt":"2026-10-20","providers":{"alpha":{"models":[{"id":"m1","label":"M1"},{"id":"bad id","label":"x"}]}}}).to_string();
        let ok = format!("HTTP/1.1 200 OK\r\nETag: \"v1\"\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let not_modified = "HTTP/1.1 304 Not Modified\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string();
        let bad = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_string();
        let (url, heads) = serve(vec![ok, not_modified, bad]);

        let cat = refresh(&paths, &url, false).unwrap();
        assert_eq!(cat.source, AgentCatalogSource::Remote);
        assert_eq!(cat.models_for("alpha").len(), 1);
        assert_eq!(cat.warnings.len(), 1);
        assert!(!heads.recv().unwrap().to_lowercase().contains("if-none-match"));
        assert!(cache_is_fresh(&paths, &url, now_ms()));

        // Fresh cache: no request at all.
        assert_eq!(refresh(&paths, &url, false).unwrap().source, AgentCatalogSource::Cache);

        // Forced: conditional request, 304 keeps the body and touches fetchedAt.
        let before = read_cache(&paths).unwrap().fetched_at;
        std::thread::sleep(Duration::from_millis(5));
        let cat = refresh(&paths, &url, true).unwrap();
        assert!(heads.recv().unwrap().to_lowercase().contains("if-none-match: \"v1\""));
        assert_eq!(cat.models_for("alpha").len(), 1);
        assert!(read_cache(&paths).unwrap().fetched_at > before);

        // A rejected document keeps the previous cache.
        assert!(refresh(&paths, &url, true).is_err());
        let fallback = load_cached_or_bundled(&paths);
        assert_eq!(fallback.source, AgentCatalogSource::Cache);
        assert_eq!(fallback.models_for("alpha")[0].id, "m1");
    }

    #[test]
    fn no_cache_falls_back_to_bundled() {
        let tmp = tempfile::tempdir().unwrap();
        let c = load_cached_or_bundled(&AppPaths::under(tmp.path()));
        assert_eq!(c.source, AgentCatalogSource::Bundled);
        assert!(!c.providers.is_empty());
    }
}
