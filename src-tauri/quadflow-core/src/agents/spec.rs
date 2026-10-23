//! `contributes.agentProvider` parsed (agent-providers.md §3). The JSON Schema
//! (`packages/plugin-api/schema/agent-provider.schema.json`) is checked first;
//! [`parse_spec`] then deserializes and compiles every regex the spec carries.

use crate::error::{CoreError, Result};
use crate::plugins::schema::validate_agent_provider_json;
use crate::plugins::ManifestIssue;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::OnceLock;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProviderSpec {
    pub id: String,
    pub display_name: String,
    #[serde(default)]
    pub short_name: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub docs_url: Option<String>,
    #[serde(default)]
    pub install_hint: BTreeMap<String, String>,
    pub detect: DetectSpec,
    pub launch: LaunchSpec,
    #[serde(default)]
    pub models: ModelsSpec,
    pub sessions: SessionsSpec,
    pub context_file: String,
    #[serde(default)]
    pub scaffold: Option<ScaffoldSpec>,
    #[serde(default)]
    pub attention: Option<AttentionSpec>,
    #[serde(default)]
    pub hooks: Vec<super::AgentHook>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectSpec {
    pub command: String,
    pub version_args: Vec<String>,
    #[serde(default = "default_version_regex")]
    pub version_regex: String,
    #[serde(default)]
    pub min_version: Option<String>,
    #[serde(default)]
    pub extra_paths: ExtraPaths,
}

fn default_version_regex() -> String {
    r"(\d+\.\d+\.\d+)".into()
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtraPaths {
    #[serde(default)]
    pub windows: Vec<String>,
    #[serde(default)]
    pub macos: Vec<String>,
    #[serde(default)]
    pub linux: Vec<String>,
}

impl ExtraPaths {
    /// Templates for the OS this binary runs on.
    pub fn current(&self) -> &[String] {
        if cfg!(windows) {
            &self.windows
        } else if cfg!(target_os = "macos") {
            &self.macos
        } else {
            &self.linux
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResumePosition {
    Prefix,
    #[default]
    Suffix,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchSpec {
    pub args: Vec<String>,
    #[serde(default)]
    pub model: Option<Vec<String>>,
    #[serde(default)]
    pub session_id: Option<Vec<String>>,
    #[serde(default)]
    pub resume: Option<Vec<String>>,
    #[serde(default)]
    pub resume_position: ResumePosition,
    #[serde(default)]
    pub efforts: Option<EffortsSpec>,
    #[serde(default)]
    pub approval_modes: ApprovalModesSpec,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub exit_command: Option<String>,
    #[serde(default)]
    pub ready_pattern: Option<String>,
    #[serde(default = "default_ready_timeout")]
    pub ready_timeout_ms: u64,
    #[serde(default)]
    pub one_shot: Option<OneShotSpec>,
}

fn default_ready_timeout() -> u64 {
    15_000
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffortsSpec {
    pub values: Vec<String>,
    pub default: String,
    pub args: Vec<String>,
    #[serde(default = "yes")]
    pub omit_when_default: bool,
}

fn yes() -> bool {
    true
}

/// Approval mode → extra argv. `None` = the provider does not support it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ApprovalModesSpec {
    #[serde(default)]
    pub default: Option<Vec<String>>,
    #[serde(default)]
    pub plan: Option<Vec<String>>,
    #[serde(default, rename = "accept-edits")]
    pub accept_edits: Option<Vec<String>>,
    #[serde(default)]
    pub auto: Option<Vec<String>>,
    #[serde(default)]
    pub bypass: Option<Vec<String>>,
}

impl ApprovalModesSpec {
    pub fn get(&self, mode: super::AgentApprovalMode) -> Option<&Vec<String>> {
        use super::AgentApprovalMode as M;
        match mode {
            M::Default => self.default.as_ref(),
            M::Plan => self.plan.as_ref(),
            M::AcceptEdits => self.accept_edits.as_ref(),
            M::Auto => self.auto.as_ref(),
            M::Bypass => self.bypass.as_ref(),
        }
    }

    /// Supported modes in canonical order. `default` is always supported
    /// (with no extra args) even when the manifest omits it.
    pub fn supported(&self) -> Vec<super::AgentApprovalMode> {
        use super::AgentApprovalMode as M;
        [M::Default, M::Plan, M::AcceptEdits, M::Auto, M::Bypass]
            .into_iter()
            .filter(|m| *m == M::Default || self.get(*m).is_some())
            .collect()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OneShotSpec {
    pub args: Vec<String>,
    #[serde(default)]
    pub prompt_via: Option<String>,
    #[serde(default = "default_one_shot_timeout")]
    pub timeout_ms: u64,
}

fn default_one_shot_timeout() -> u64 {
    120_000
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsSpec {
    #[serde(default)]
    pub catalog_key: Option<String>,
    #[serde(default = "yes")]
    pub allow_custom: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionStrategy {
    Preassign,
    Discover,
    None,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IdFormat {
    #[default]
    Uuid,
    Any,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonlField {
    #[serde(default, rename = "match")]
    pub match_fields: BTreeMap<String, String>,
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IdFrom {
    FileStem(bool),
    FileStemRegex(String),
    Jsonl(JsonlField),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CwdFrom {
    Dir(bool),
    Jsonl(JsonlField),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsSpec {
    pub strategy: SessionStrategy,
    #[serde(default)]
    pub id_format: IdFormat,
    #[serde(default)]
    pub dir: Option<String>,
    #[serde(default)]
    pub glob: Option<String>,
    #[serde(default)]
    pub id_from: Option<IdFrom>,
    #[serde(default)]
    pub cwd_from: Option<CwdFrom>,
    #[serde(default = "default_header_lines")]
    pub header_lines: usize,
    #[serde(default = "default_max_files")]
    pub max_files: usize,
}

fn default_header_lines() -> usize {
    20
}
fn default_max_files() -> usize {
    2000
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaffoldSpec {
    pub from: String,
    pub into: String,
    #[serde(default)]
    pub json_merge: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionSpec {
    #[serde(default)]
    pub patterns: Vec<String>,
    #[serde(default = "default_debounce")]
    pub debounce_ms: u64,
}

fn default_debounce() -> u64 {
    800
}

impl AgentProviderSpec {
    pub fn catalog_key(&self) -> &str {
        self.models.catalog_key.as_deref().unwrap_or(&self.id)
    }
}

/// A provider as contributed by a plugin.
#[derive(Clone, Copy, Debug)]
pub struct ProviderRef<'a> {
    pub plugin_id: &'a str,
    pub spec: &'a AgentProviderSpec,
    /// Plugin root (scaffold sources). `None` for providers without a plugin dir.
    pub root: Option<&'a Path>,
}

/// The launch argv safe charset (§3 `$defs.safeArg`).
pub fn safe_arg_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z0-9._:\[\]@=/+,-]{1,256}$").unwrap())
}

pub fn is_safe_arg(s: &str) -> bool {
    safe_arg_re().is_match(s)
}

/// Provider id pattern (§3 `id`).
pub fn provider_id_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-z][a-z0-9-]{1,31}$").unwrap())
}

pub fn validate_provider_id(id: &str) -> Result<()> {
    if provider_id_re().is_match(id) {
        Ok(())
    } else {
        Err(CoreError::invalid_input(format!("invalid provider id {id:?}: expected [a-z][a-z0-9-]{{1,31}}")))
    }
}

fn issue(path: &str, message: impl Into<String>) -> ManifestIssue {
    ManifestIssue { path: path.into(), message: message.into() }
}

/// Schema-validate and parse an `agentProvider` block. Errors are reported with
/// JSON-pointer paths relative to the block.
pub fn parse_spec(v: &Value) -> std::result::Result<AgentProviderSpec, Vec<ManifestIssue>> {
    let errs = validate_agent_provider_json(v);
    if !errs.is_empty() {
        return Err(errs);
    }
    let spec: AgentProviderSpec = serde_json::from_value(v.clone()).map_err(|e| vec![issue("", e.to_string())])?;
    let mut errs = Vec::new();
    let mut re = |path: &str, pat: &str| {
        if let Err(e) = Regex::new(pat) {
            errs.push(issue(path, format!("invalid regex: {e}")));
        }
    };
    re("/detect/versionRegex", &spec.detect.version_regex);
    if let Some(p) = &spec.launch.ready_pattern {
        re("/launch/readyPattern", p);
    }
    if let Some(IdFrom::FileStemRegex(p)) = &spec.sessions.id_from {
        re("/sessions/idFrom/fileStemRegex", p);
    }
    if let Some(a) = &spec.attention {
        for (i, p) in a.patterns.iter().enumerate() {
            re(&format!("/attention/patterns/{i}"), p);
        }
    }
    if let Some(m) = &spec.detect.min_version {
        if semver::Version::parse(m).is_err() {
            errs.push(issue("/detect/minVersion", format!("{m:?} is not a semver version")));
        }
    }
    if let Some(e) = &spec.launch.efforts {
        if !e.values.contains(&e.default) {
            errs.push(issue("/launch/efforts/default", "must be one of efforts.values"));
        }
        if !e.args.iter().any(|a| a.contains("{effort}")) {
            errs.push(issue("/launch/efforts/args", "must use {effort}"));
        }
    }
    let s = &spec.sessions;
    if s.strategy != SessionStrategy::None {
        if s.dir.is_none() || s.glob.is_none() || s.id_from.is_none() {
            errs.push(issue("/sessions", "preassign/discover need dir, glob and idFrom"));
        }
        if let Some(g) = &s.glob {
            if g.contains("..") || g.starts_with('/') {
                errs.push(issue("/sessions/glob", "must be a relative glob without .."));
            } else if globset::Glob::new(g).is_err() {
                errs.push(issue("/sessions/glob", "invalid glob"));
            }
        }
    }
    if s.strategy == SessionStrategy::Discover && s.cwd_from.is_none() {
        errs.push(issue("/sessions/cwdFrom", "discover needs cwdFrom"));
    }
    if s.strategy == SessionStrategy::Preassign && spec.launch.session_id.is_none() {
        errs.push(issue("/launch/sessionId", "preassign needs launch.sessionId"));
    }
    if let Some(sc) = &spec.scaffold {
        for (p, v) in [("/scaffold/from", &sc.from), ("/scaffold/into", &sc.into)] {
            if v.split('/').any(|seg| seg == ".." || seg.is_empty() && v != ".") || v.starts_with('/') {
                errs.push(issue(p, "must be a relative path without .."));
            }
        }
    }
    if errs.is_empty() {
        Ok(spec)
    } else {
        Err(errs)
    }
}

#[cfg(test)]
pub(crate) mod fixtures {
    //! Provider specs used by the tests in `agents::*` — generic names on
    //! purpose (core holds no knowledge of real agent CLIs).
    use serde_json::{json, Value};

    /// Preassign-style provider (session id passed at launch).
    pub fn preassign() -> Value {
        json!({
            "id": "alpha", "displayName": "Alpha Agent", "shortName": "Alpha", "color": "#112233",
            "installHint": { "default": "npm i -g alpha" },
            "detect": { "command": "alpha", "versionArgs": ["--version"] },
            "launch": {
                "args": [],
                "model": ["--model", "{model}"],
                "sessionId": ["--session", "{sessionId}"],
                "resume": ["--resume", "{sessionId}"],
                "efforts": { "values": ["low", "medium", "high", "max"], "default": "high", "args": ["--effort", "{effort}"] },
                "approvalModes": {
                    "default": [], "plan": ["--permission-mode", "plan"],
                    "accept-edits": ["--permission-mode", "acceptEdits"], "bypass": ["--skip-permissions"]
                },
                "exitCommand": "/exit",
                "oneShot": { "args": ["-p"], "promptVia": "stdin" }
            },
            "models": { "catalogKey": "alpha" },
            "sessions": {
                "strategy": "preassign", "idFormat": "uuid",
                "dir": "{home}/.alpha/projects/{cwd|nonalnum-dash}", "glob": "*.jsonl",
                "idFrom": { "fileStem": true }, "cwdFrom": { "dir": true }
            },
            "contextFile": "ALPHA.md",
            "hooks": ["usage"]
        })
    }

    /// Discover-style provider (session file found after launch).
    pub fn discover() -> Value {
        json!({
            "id": "beta", "displayName": "Beta Agent",
            "detect": { "command": "beta", "versionArgs": ["--version"] },
            "launch": {
                "args": [],
                "model": ["--model", "{model}"],
                "resume": ["resume", "{sessionId}"],
                "resumePosition": "prefix",
                "efforts": { "values": ["low", "medium", "high"], "default": "medium", "args": ["-c", "model_reasoning_effort={effort}"] },
                "approvalModes": { "default": [], "auto": ["--approve-all"] },
                "exitCommand": "/quit",
                "oneShot": { "args": ["exec", "-"], "promptVia": "stdin" }
            },
            "models": {},
            "sessions": {
                "strategy": "discover", "idFormat": "uuid",
                "dir": "{home}/.beta/sessions", "glob": "**/rollout-*.jsonl",
                "idFrom": { "jsonl": { "match": { "type": "session_meta" }, "path": "payload.id" } },
                "cwdFrom": { "jsonl": { "match": { "type": "session_meta" }, "path": "payload.cwd" } },
                "headerLines": 20
            },
            "contextFile": "AGENTS.md"
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fixtures_parse() {
        let a = parse_spec(&fixtures::preassign()).unwrap();
        assert_eq!(a.catalog_key(), "alpha");
        assert_eq!(a.sessions.strategy, SessionStrategy::Preassign);
        assert_eq!(a.launch.approval_modes.supported().len(), 4);
        let b = parse_spec(&fixtures::discover()).unwrap();
        assert_eq!(b.catalog_key(), "beta");
        assert_eq!(b.launch.resume_position, ResumePosition::Prefix);
        assert!(matches!(b.sessions.id_from, Some(IdFrom::Jsonl(_))));
    }

    #[test]
    fn schema_rejects_unsafe_templates_and_ids() {
        let mut v = fixtures::preassign();
        v["launch"]["model"] = json!(["--model", "{model}; rm -rf ~"]);
        v["id"] = json!("Bad_Id");
        v["detect"]["command"] = json!("alpha && evil");
        let errs = parse_spec(&v).unwrap_err();
        assert!(errs.iter().any(|e| e.path == "/launch/model/1"), "{errs:?}");
        assert!(errs.iter().any(|e| e.path == "/id"), "{errs:?}");
        assert!(errs.iter().any(|e| e.path == "/detect/command"), "{errs:?}");
    }

    #[test]
    fn semantic_checks() {
        let mut v = fixtures::preassign();
        v["launch"]["efforts"]["default"] = json!("ultra");
        v["detect"]["versionRegex"] = json!("(unclosed");
        v["sessions"]["glob"] = json!("../*.jsonl");
        let errs = parse_spec(&v).unwrap_err();
        let paths: Vec<_> = errs.iter().map(|e| e.path.as_str()).collect();
        assert!(paths.contains(&"/launch/efforts/default"), "{paths:?}");
        assert!(paths.contains(&"/detect/versionRegex"), "{paths:?}");
        assert!(paths.contains(&"/sessions/glob"), "{paths:?}");

        let mut v = fixtures::discover();
        v["sessions"].as_object_mut().unwrap().remove("cwdFrom");
        assert!(parse_spec(&v).unwrap_err().iter().any(|e| e.path == "/sessions/cwdFrom"));
    }

    #[test]
    fn manifest_validation_uses_real_agent_schema() {
        let manifest = json!({
            "id": "beta", "name": "Beta", "version": "1.0.0", "apiVersion": "^1.0.0",
            "contributes": { "agentProvider": { "id": "beta" } }
        });
        let errs = crate::plugins::schema::validate_manifest_json(&manifest);
        assert!(errs.iter().any(|e| e.path.starts_with("/contributes/agentProvider")), "{errs:?}");
    }
}
