//! Generic agent-provider framework (agent-providers.md §2–§8).
//!
//! Core knows nothing about specific agent CLIs: everything here is driven by a
//! provider's declarative spec (`contributes.agentProvider`, [`spec`]).
//!
//! - [`spec`] parsed manifest block · [`providers`] the set of known providers
//! - [`detect`] resolve the program + version · [`catalog`] / [`models`] model lists
//! - [`launch`] argv builder · [`quote`] per-shell command lines
//! - [`sessions`] session-file scanner · [`claims`] FIFO session discovery
//! - [`one_shot`] non-interactive runs (prompt via stdin) · [`scaffold`] provider template copy

pub mod catalog;
pub mod claims;
pub mod detect;
pub mod launch;
pub mod models;
pub mod one_shot;
pub mod providers;
pub mod quote;
pub mod scaffold;
pub mod sessions;
pub mod spec;

use crate::domains::missions::MissionAgentRole;
use crate::error::{CoreError, Result};
use crate::model::Timestamp;
use serde::{Deserialize, Serialize};

pub use catalog::{AgentCatalogSource, AgentCatalogStatus, Catalog, CatalogModel};
pub use claims::{SessionClaims, SessionLink};
pub use detect::{AgentDetection, DetectCache, ProcessEnv};
pub use launch::{build_launch, LaunchPlan, LaunchRequest};
pub use models::{validate_model_id, AgentCustomModel, AgentModelInfo, AgentModelKind, AgentModelSource, SYSTEM_DEFAULT_MODEL};
pub use providers::{AgentProviderInfo, ProviderEntry, ProviderSet, DEFAULT_PROVIDER_ALIAS};
pub use quote::{command_line, ShellKind};
pub use sessions::{AgentSessionInfo, SessionScanner, SessionsRoot};
pub use spec::{parse_spec, AgentProviderSpec, ProviderRef};

/// Approval modes a provider may support (§5).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum AgentApprovalMode {
    #[default]
    Default,
    Plan,
    AcceptEdits,
    Auto,
    Bypass,
}

impl AgentApprovalMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Plan => "plan",
            Self::AcceptEdits => "accept-edits",
            Self::Auto => "auto",
            Self::Bypass => "bypass",
        }
    }
}

/// Procedural hooks a provider plugin implements (§4.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum AgentHook {
    Usage,
    ContextUsage,
    SessionTitle,
    PrepareWorktree,
}

/// Session strategy as exposed to the shell.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum AgentSessionStrategy {
    Preassign,
    Discover,
    None,
}

/// Session state of a bound terminal (§5): `assigned` = preassigned id,
/// `pending` = discovery running, `linked` = discovered, `unlinked` = gave up.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum AgentSessionState {
    Assigned,
    Pending,
    Linked,
    #[default]
    Unlinked,
}

/// The agent running in a terminal; persisted as `workspace_terminals.agent`
/// (agent-providers.md §5.4). `agent == null` ⇔ plain shell terminal.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentBinding {
    pub provider_id: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub approval_mode: AgentApprovalMode,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub session_state: AgentSessionState,
    #[serde(default)]
    pub launched_at: Timestamp,
    #[serde(default)]
    pub role: Option<MissionAgentRole>,
    #[serde(default)]
    pub role_label: Option<String>,
    #[serde(default = "default_true")]
    pub sync_enabled: bool,
    #[serde(default)]
    pub issue_id: Option<String>,
    #[serde(default)]
    pub mission_id: Option<String>,
    #[serde(default)]
    pub member_id: Option<String>,
}

fn default_true() -> bool {
    true
}

impl AgentBinding {
    pub fn new(provider_id: impl Into<String>, launched_at: Timestamp) -> Self {
        Self {
            provider_id: provider_id.into(),
            model: None,
            approval_mode: AgentApprovalMode::Default,
            effort: None,
            session_id: None,
            session_state: AgentSessionState::Unlinked,
            launched_at,
            role: None,
            role_label: None,
            sync_enabled: true,
            issue_id: None,
            mission_id: None,
            member_id: None,
        }
    }

    /// Everything that ends up in argv or paths must be in the safe charsets.
    pub fn validate(&self) -> Result<()> {
        spec::validate_provider_id(&self.provider_id)?;
        if let Some(m) = &self.model {
            if m != SYSTEM_DEFAULT_MODEL {
                validate_model_id(m)?;
            }
        }
        if let Some(e) = &self.effort {
            validate_effort(e)?;
        }
        if let Some(s) = &self.session_id {
            validate_session_id(s, spec::IdFormat::Any)?;
        }
        if self.role_label.as_ref().is_some_and(|l| l.len() > 100 || l.chars().any(char::is_control)) {
            return Err(CoreError::invalid_input("agent roleLabel must be ≤ 100 chars without control characters"));
        }
        Ok(())
    }
}

/// Where the shell puts a launched agent's terminal (layout is the shell's job).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum AgentLaunchPlacement {
    #[default]
    SplitActive,
    ReplaceEmpty,
    NewTile,
    /// Reuse `terminalId`.
    Terminal,
}

/// §5 `LaunchAgentOptions` (the project root is a separate argument).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentLaunchOptions {
    pub provider_id: String,
    /// Default: the project root. Worktrees allowed.
    #[serde(default)]
    pub cwd: Option<String>,
    /// `null` / `"system-default"` = provider default.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub approval_mode: Option<AgentApprovalMode>,
    #[serde(default)]
    pub effort: Option<String>,
    /// Delivered after start via bracketed paste (never argv).
    #[serde(default)]
    pub prompt: Option<String>,
    /// Default: setting `agents.autoSubmitPrompt`.
    #[serde(default)]
    pub auto_submit: Option<bool>,
    #[serde(default)]
    pub resume_session_id: Option<String>,
    #[serde(default)]
    pub role: Option<MissionAgentRole>,
    #[serde(default)]
    pub role_label: Option<String>,
    /// Links `AgentBinding.issueId` and claims the issue.
    #[serde(default)]
    pub issue_ref: Option<String>,
    #[serde(default)]
    pub mission_id: Option<String>,
    #[serde(default)]
    pub member_id: Option<String>,
    #[serde(default)]
    pub placement: Option<AgentLaunchPlacement>,
    /// Reuse this terminal if it is alive, else create the PTY under this id.
    #[serde(default)]
    pub terminal_id: Option<String>,
    #[serde(default)]
    pub environment_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    /// Default `true`.
    #[serde(default)]
    pub sync_enabled: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentLaunchResult {
    pub terminal_id: String,
    /// `true` when a new PTY was created (the shell must add it to the layout).
    pub created_terminal: bool,
    pub binding: AgentBinding,
}

pub fn validate_effort(e: &str) -> Result<()> {
    if !e.is_empty() && e.len() <= 32 && e.bytes().all(|b| b.is_ascii_lowercase()) {
        Ok(())
    } else {
        Err(CoreError::invalid_input(format!("invalid effort {e:?}: expected [a-z]+")))
    }
}

fn uuid_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").unwrap())
}

/// Session ids end up in argv: `uuid` format is lowercase hyphenated UUID, `any`
/// is the launch safe charset.
pub fn validate_session_id(id: &str, format: spec::IdFormat) -> Result<()> {
    let ok = match format {
        spec::IdFormat::Uuid => uuid_re().is_match(id),
        spec::IdFormat::Any => spec::is_safe_arg(id),
    };
    if ok {
        Ok(())
    } else {
        Err(CoreError::invalid_input(format!("invalid session id {id:?}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn binding_roundtrip_and_defaults() {
        let b: AgentBinding = serde_json::from_value(json!({ "providerId": "beta" })).unwrap();
        assert_eq!(b.approval_mode, AgentApprovalMode::Default);
        assert_eq!(b.session_state, AgentSessionState::Unlinked);
        assert!(b.sync_enabled);
        let mut b = b;
        b.approval_mode = AgentApprovalMode::AcceptEdits;
        b.role = Some(MissionAgentRole::TechLead);
        let v = serde_json::to_value(&b).unwrap();
        assert_eq!(v["approvalMode"], "accept-edits");
        assert_eq!(v["role"], "tech_lead");
        assert_eq!(serde_json::from_value::<AgentBinding>(v).unwrap(), b);
    }

    #[test]
    fn binding_validation_rejects_injection() {
        let mut b = AgentBinding::new("beta", 1);
        b.model = Some("x; rm -rf ~".into());
        assert!(b.validate().is_err());
        b.model = Some("opus[1m]".into());
        b.session_id = Some("$(whoami)".into());
        assert!(b.validate().is_err());
        b.session_id = Some("0f8fad5b-d9cb-469f-a165-70867728950e".into());
        assert!(b.validate().is_ok());
        b.provider_id = "Beta".into();
        assert!(b.validate().is_err());
    }

    #[test]
    fn session_id_formats() {
        assert!(validate_session_id("0f8fad5b-d9cb-469f-a165-70867728950e", spec::IdFormat::Uuid).is_ok());
        assert!(validate_session_id("0F8FAD5B-D9CB-469F-A165-70867728950E", spec::IdFormat::Uuid).is_err());
        assert!(validate_session_id("abc", spec::IdFormat::Uuid).is_err());
        assert!(validate_session_id("abc", spec::IdFormat::Any).is_ok());
        assert!(validate_session_id("a b", spec::IdFormat::Any).is_err());
    }
}
