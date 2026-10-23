//! The set of known agent providers: `contributes.agentProvider` of every
//! active plugin, plus (GUI only, until the provider plugins ship) providers the
//! shell registers at startup. Plugins win on id collisions.

use super::spec::{parse_spec, AgentProviderSpec, ProviderRef, SessionStrategy};
use super::{AgentApprovalMode, AgentHook, AgentSessionStrategy};
use crate::error::{CoreError, Result};
use crate::plugins::{ManifestIssue, PluginRegistry};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq)]
pub struct ProviderEntry {
    pub plugin_id: String,
    pub plugin_version: String,
    pub spec: AgentProviderSpec,
    /// Plugin root (scaffold sources); `None` for shell-registered providers.
    pub root: Option<PathBuf>,
}

impl ProviderEntry {
    pub fn as_ref(&self) -> ProviderRef<'_> {
        ProviderRef { plugin_id: &self.plugin_id, spec: &self.spec, root: self.root.as_deref() }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentEffortsInfo {
    pub values: Vec<String>,
    pub default: String,
}

/// Provider id meaning "the user's default provider" (setting
/// `agents.defaultProvider`, else the first installed one). Accepted wherever a
/// provider id is stored for later launch (agent definitions, mission members).
pub const DEFAULT_PROVIDER_ALIAS: &str = "default";

/// §5 `ProviderInfo`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentProviderInfo {
    pub id: String,
    pub plugin_id: String,
    pub display_name: String,
    pub short_name: Option<String>,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub context_file: String,
    pub session_strategy: AgentSessionStrategy,
    pub approval_modes: Vec<AgentApprovalMode>,
    pub efforts: Option<AgentEffortsInfo>,
    pub hooks: Vec<AgentHook>,
    pub install_hint: Option<String>,
    pub docs_url: Option<String>,
    pub can_resume: bool,
    pub has_one_shot: bool,
    /// Typed to leave the agent (e.g. `/exit`); `None` = Ctrl-C.
    pub exit_command: Option<String>,
    /// Provider-specific "waiting for input" regexes (`attention.patterns`, §8.6).
    pub attention_patterns: Vec<String>,
}

impl ProviderEntry {
    pub fn info(&self) -> AgentProviderInfo {
        let s = &self.spec;
        let os = crate::plugins::Platform::current().map(|p| p.as_str()).unwrap_or("default");
        AgentProviderInfo {
            id: s.id.clone(),
            plugin_id: self.plugin_id.clone(),
            display_name: s.display_name.clone(),
            short_name: s.short_name.clone(),
            icon: s.icon.clone(),
            color: s.color.clone(),
            context_file: s.context_file.clone(),
            session_strategy: match s.sessions.strategy {
                SessionStrategy::Preassign => AgentSessionStrategy::Preassign,
                SessionStrategy::Discover => AgentSessionStrategy::Discover,
                SessionStrategy::None => AgentSessionStrategy::None,
            },
            approval_modes: s.launch.approval_modes.supported(),
            efforts: s.launch.efforts.as_ref().map(|e| AgentEffortsInfo { values: e.values.clone(), default: e.default.clone() }),
            hooks: s.hooks.clone(),
            install_hint: s.install_hint.get(os).or_else(|| s.install_hint.get("default")).cloned(),
            docs_url: s.docs_url.clone(),
            can_resume: s.launch.resume.is_some(),
            has_one_shot: s.launch.one_shot.is_some(),
            exit_command: s.launch.exit_command.clone(),
            attention_patterns: s.attention.as_ref().map(|a| a.patterns.clone()).unwrap_or_default(),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct ProviderSet {
    entries: Vec<ProviderEntry>,
    /// Plugins whose `agentProvider` block failed to parse.
    pub errors: Vec<(String, Vec<ManifestIssue>)>,
}

impl ProviderSet {
    pub fn from_registry(reg: &PluginRegistry) -> Self {
        let mut set = ProviderSet::default();
        for p in reg.active() {
            let Some(m) = &p.manifest else { continue };
            let Some(block) = &m.contributes.agent_provider else { continue };
            match parse_spec(block) {
                Ok(spec) => set.push(ProviderEntry {
                    plugin_id: p.id.clone(),
                    plugin_version: m.version.clone(),
                    spec,
                    root: Some(p.root.clone()),
                }),
                Err(e) => {
                    tracing::warn!("plugin {}: invalid agentProvider: {e:?}", p.id);
                    set.errors.push((p.id.clone(), e));
                }
            }
        }
        set
    }

    fn push(&mut self, e: ProviderEntry) {
        if self.entries.iter().any(|x| x.spec.id == e.spec.id) {
            tracing::warn!("agent provider {:?} contributed twice; keeping the first", e.spec.id);
            return;
        }
        self.entries.push(e);
    }

    /// Add shell-registered providers (ids already contributed by plugins are skipped).
    pub fn with_extra(mut self, extra: impl IntoIterator<Item = ProviderEntry>) -> Self {
        for e in extra {
            self.push(e);
        }
        self
    }

    pub fn list(&self) -> &[ProviderEntry] {
        &self.entries
    }

    pub fn get(&self, id: &str) -> Option<&ProviderEntry> {
        self.entries.iter().find(|e| e.spec.id == id)
    }

    pub fn require(&self, id: &str) -> Result<&ProviderEntry> {
        self.get(id).ok_or_else(|| CoreError::not_found(format!("agent provider {id:?} (is its plugin enabled?)")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::spec::fixtures;

    fn entry(v: serde_json::Value) -> ProviderEntry {
        ProviderEntry { plugin_id: "p".into(), plugin_version: "1.0.0".into(), spec: parse_spec(&v).unwrap(), root: None }
    }

    #[test]
    fn info_and_dedupe() {
        let set = ProviderSet::default().with_extra([entry(fixtures::preassign()), entry(fixtures::discover()), entry(fixtures::preassign())]);
        assert_eq!(set.list().len(), 2);
        let a = set.require("alpha").unwrap().info();
        assert_eq!(a.session_strategy, AgentSessionStrategy::Preassign);
        assert_eq!(a.approval_modes, [AgentApprovalMode::Default, AgentApprovalMode::Plan, AgentApprovalMode::AcceptEdits, AgentApprovalMode::Bypass]);
        assert_eq!(a.install_hint.as_deref(), Some("npm i -g alpha"));
        assert_eq!(a.hooks, [AgentHook::Usage]);
        let b = set.require("beta").unwrap().info();
        assert_eq!(b.efforts.unwrap().default, "medium");
        assert!(set.require("gamma").is_err());
    }
}
