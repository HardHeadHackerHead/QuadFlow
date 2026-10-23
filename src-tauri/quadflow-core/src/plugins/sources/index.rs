//! Source URLs and the `index.json` format (plugin-system.md §12.1, §12.2):
//! URL resolution, parsing + schema validation, and version selection.

use super::super::manifest::ManifestIssue;
use super::super::permissions::Permission;
use super::super::{check_api_version, schema, Platform};
use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// A parsed source index.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginIndex {
    pub format_version: u32,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    pub plugins: Vec<PluginIndexEntry>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginIndexEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    /// Ships inside the app; listed for discovery / out-of-band updates.
    #[serde(default)]
    pub bundled: bool,
    pub versions: Vec<PluginIndexVersion>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginIndexVersion {
    pub version: String,
    pub api_version: String,
    pub platforms: Vec<Platform>,
    /// https URL of a `.zip`; may contain `{os}-{arch}` for per-platform archives.
    pub url: String,
    pub sha256: PluginIndexDigest,
    pub size: PluginIndexSize,
    pub permissions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub released_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// One digest, or one per `<os>-<arch>` target.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(untagged)]
pub enum PluginIndexDigest {
    One(String),
    PerTarget(BTreeMap<String, String>),
}

/// One size, or one per `<os>-<arch>` target.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(untagged)]
pub enum PluginIndexSize {
    One(u64),
    PerTarget(BTreeMap<String, u64>),
}

/// What the host would download for one index version on this machine.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedVersion {
    pub version: String,
    pub api_version: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
    pub permissions: BTreeSet<Permission>,
    pub notes: Option<String>,
}

/// Host facts used to pick versions.
#[derive(Clone, Debug)]
pub struct HostTarget {
    pub platform: Option<Platform>,
    /// `<os>-<arch>`.
    pub target: Option<String>,
    pub host_api: semver::Version,
}

/// Parse + validate an index document (schema, ids, versions, permissions).
pub fn parse_index(bytes: &[u8]) -> Result<PluginIndex> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|e| CoreError::invalid_input(format!("index is not valid JSON: {e}")))?;
    let issues = schema::validate_index_json(&value);
    if !issues.is_empty() {
        return Err(index_error(&issues));
    }
    let index: PluginIndex =
        serde_json::from_value(value).map_err(|e| CoreError::invalid_input(format!("index does not match the schema: {e}")))?;
    let mut problems = Vec::new();
    for (i, p) in index.plugins.iter().enumerate() {
        if !schema::manifest_id_pattern().is_match(&p.id) {
            problems.push(ManifestIssue::new(format!("/plugins/{i}/id"), format!("invalid plugin id {:?}", p.id)));
        }
        for (j, v) in p.versions.iter().enumerate() {
            let at = format!("/plugins/{i}/versions/{j}");
            if semver::Version::parse(&v.version).is_err() {
                problems.push(ManifestIssue::new(format!("{at}/version"), format!("{:?} is not semver", v.version)));
            }
            for perm in &v.permissions {
                if let Err(e) = Permission::parse(perm) {
                    problems.push(ManifestIssue::new(format!("{at}/permissions"), e));
                }
            }
        }
    }
    if !problems.is_empty() {
        return Err(index_error(&problems));
    }
    Ok(index)
}

fn index_error(issues: &[ManifestIssue]) -> CoreError {
    let first = issues.first().map(|i| i.to_string()).unwrap_or_default();
    let more = if issues.len() > 1 { format!(" (and {} more)", issues.len() - 1) } else { String::new() };
    CoreError::invalid_input(format!("invalid plugin index: {first}{more}"))
        .with_details(serde_json::to_value(issues).unwrap_or_default())
}

/// Resolve a source spec to the URL that is fetched (§12.1).
///
/// - `github:OWNER/REPO[#REF][:PATH]` → raw.githubusercontent.com (`REF` = `HEAD`, `PATH` = `index.json`)
/// - `https://…`
/// - with `allow_dev`: `file://…` and `http://localhost|127.0.0.1[:port]/…` (dev profile, tests)
pub fn resolve_source_url(spec: &str, allow_dev: bool) -> Result<String> {
    let spec = spec.trim();
    if let Some(rest) = spec.strip_prefix("github:") {
        let (repo_ref, path) = match rest.split_once(':') {
            Some((a, p)) => (a, p.trim_start_matches('/')),
            None => (rest, "index.json"),
        };
        let (repo, git_ref) = match repo_ref.split_once('#') {
            Some((r, g)) => (r, g),
            None => (repo_ref, "HEAD"),
        };
        let ok_part = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
        let mut parts = repo.split('/');
        let (owner, name) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        if parts.next().is_some() || !ok_part(owner) || !ok_part(name) {
            return Err(CoreError::invalid_input(format!("{spec:?}: expected github:OWNER/REPO[#REF][:PATH]")));
        }
        if git_ref.is_empty() || git_ref.contains("..") || path.is_empty() || path.split('/').any(|s| s == "..") {
            return Err(CoreError::invalid_input(format!("{spec:?}: invalid ref or path")));
        }
        return Ok(format!("https://raw.githubusercontent.com/{owner}/{name}/{git_ref}/{path}"));
    }
    let parsed = url::Url::parse(spec).map_err(|e| CoreError::invalid_input(format!("{spec:?} is not a URL: {e}")))?;
    match parsed.scheme() {
        "https" if parsed.host_str().is_some() => Ok(parsed.to_string()),
        "file" if allow_dev => Ok(parsed.to_string()),
        "http" if allow_dev && matches!(parsed.host_str(), Some("localhost" | "127.0.0.1")) => Ok(parsed.to_string()),
        "http" | "file" => Err(CoreError::invalid_input(format!(
            "{spec:?}: only https:// sources are allowed (file:// and local http:// only in dev builds)"
        ))),
        other => Err(CoreError::invalid_input(format!("{spec:?}: unsupported URL scheme {other:?}"))),
    }
}

/// Validate an archive URL from an index (same scheme rules as sources).
pub fn check_archive_url(u: &str, allow_dev: bool) -> Result<()> {
    if u.starts_with("github:") {
        return Err(CoreError::invalid_input("archive URLs must be https URLs"));
    }
    resolve_source_url(u, allow_dev).map(|_| ())
}

impl PluginIndexVersion {
    /// Resolve against this host: platform, apiVersion, per-target digest/size.
    pub fn resolve(&self, host: &HostTarget) -> std::result::Result<ResolvedVersion, String> {
        let platform = host.platform.ok_or("this OS is not supported")?;
        if !self.platforms.contains(&platform) {
            return Err(format!("{} does not support {}", self.version, platform.as_str()));
        }
        check_api_version(&self.api_version, &host.host_api)?;
        let target = host.target.clone();
        let sha256 = match &self.sha256 {
            PluginIndexDigest::One(s) => s.clone(),
            PluginIndexDigest::PerTarget(m) => target
                .as_ref()
                .and_then(|t| m.get(t))
                .cloned()
                .ok_or_else(|| format!("{} has no archive for {}", self.version, target.as_deref().unwrap_or("this target")))?,
        };
        let size = match &self.size {
            PluginIndexSize::One(n) => *n,
            PluginIndexSize::PerTarget(m) => target
                .as_ref()
                .and_then(|t| m.get(t))
                .copied()
                .ok_or_else(|| format!("{} has no archive size for {}", self.version, target.as_deref().unwrap_or("this target")))?,
        };
        let url = if self.url.contains("{os}-{arch}") {
            let t = target.as_deref().ok_or("unsupported architecture")?;
            self.url.replace("{os}-{arch}", t)
        } else {
            self.url.clone()
        };
        let permissions = self.permissions.iter().filter_map(|p| Permission::parse(p).ok()).collect();
        Ok(ResolvedVersion {
            version: self.version.clone(),
            api_version: self.api_version.clone(),
            url,
            sha256: sha256.to_ascii_lowercase(),
            size,
            permissions,
            notes: self.notes.clone(),
        })
    }
}

impl PluginIndexEntry {
    /// The highest compatible version (or exactly `requested`). `Err` = why none fits.
    pub fn select(&self, requested: Option<&str>, host: &HostTarget) -> std::result::Result<ResolvedVersion, String> {
        if let Some(req) = requested {
            let v = self
                .versions
                .iter()
                .find(|v| v.version == req)
                .ok_or_else(|| format!("{} has no version {req}", self.id))?;
            return v.resolve(host);
        }
        let mut best: Option<(semver::Version, ResolvedVersion)> = None;
        let mut last_err = format!("{} lists no versions", self.id);
        for v in &self.versions {
            let Ok(sv) = semver::Version::parse(&v.version) else { continue };
            match v.resolve(host) {
                Ok(r) => {
                    if best.as_ref().is_none_or(|(b, _)| sv > *b) {
                        best = Some((sv, r));
                    }
                }
                Err(e) => last_err = e,
            }
        }
        best.map(|(_, r)| r).ok_or(last_err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn host() -> HostTarget {
        HostTarget {
            platform: Platform::current(),
            target: crate::plugins::current_target(),
            host_api: semver::Version::parse("1.2.0").unwrap(),
        }
    }

    #[test]
    fn source_urls() {
        assert_eq!(
            resolve_source_url("github:acme/quadflow:plugins/index.json", false).unwrap(),
            "https://raw.githubusercontent.com/acme/quadflow/HEAD/plugins/index.json"
        );
        assert_eq!(
            resolve_source_url("github:acme/stuff#v2", false).unwrap(),
            "https://raw.githubusercontent.com/acme/stuff/v2/index.json"
        );
        assert!(resolve_source_url("github:acme", false).is_err());
        assert!(resolve_source_url("github:acme/x/y", false).is_err());
        assert!(resolve_source_url("github:acme/x:../../etc", false).is_err());
        assert!(resolve_source_url("https://example.com/index.json", false).is_ok());
        assert!(resolve_source_url("http://example.com/index.json", false).is_err());
        assert!(resolve_source_url("http://example.com/index.json", true).is_err());
        assert!(resolve_source_url("http://127.0.0.1:9/index.json", true).is_ok());
        assert!(resolve_source_url("file:///tmp/index.json", false).is_err());
        assert!(resolve_source_url("file:///tmp/index.json", true).is_ok());
        assert!(resolve_source_url("ftp://x/y", true).is_err());
    }

    fn version(v: &str, api: &str, platforms: serde_json::Value) -> serde_json::Value {
        json!({"version": v, "apiVersion": api, "platforms": platforms, "url": "https://x/{os}-{arch}.zip",
               "sha256": "a".repeat(64), "size": 10, "permissions": ["notifications"]})
    }

    #[test]
    fn parse_and_select() {
        let all = json!(["windows", "macos", "linux"]);
        let doc = json!({"formatVersion": 1, "name": "t", "plugins": [{
            "id": "acme.tool", "name": "Tool", "description": "d",
            "versions": [version("1.0.0", "^1.0.0", all.clone()), version("1.5.0", "^1.0.0", all.clone()),
                         version("2.0.0", "^2.0.0", all.clone()), version("1.9.0", "^1.0.0", json!([]))]
        }]});
        let idx = parse_index(doc.to_string().as_bytes()).unwrap();
        let e = &idx.plugins[0];
        let r = e.select(None, &host()).unwrap();
        assert_eq!(r.version, "1.5.0");
        assert!(r.url.ends_with(&format!("{}.zip", crate::plugins::current_target().unwrap())));
        assert_eq!(e.select(Some("1.0.0"), &host()).unwrap().version, "1.0.0");
        assert!(e.select(Some("2.0.0"), &host()).unwrap_err().contains("major"));
        assert!(e.select(Some("3.0.0"), &host()).is_err());
    }

    #[test]
    fn invalid_indexes_rejected() {
        assert!(parse_index(b"not json").is_err());
        assert!(parse_index(json!({"formatVersion": 2, "name": "x", "plugins": []}).to_string().as_bytes()).is_err());
        let bad_perm = json!({"formatVersion": 1, "name": "x", "plugins": [{"id": "a.b", "name": "n", "description": "d",
            "versions": [{"version": "1.0.0", "apiVersion": "^1", "platforms": ["linux"], "url": "https://x/a.zip",
                          "sha256": "b".repeat(64), "size": 1, "permissions": ["root:everything"]}]}]});
        assert!(parse_index(bad_perm.to_string().as_bytes()).unwrap_err().message.contains("permissions"));
    }
}
