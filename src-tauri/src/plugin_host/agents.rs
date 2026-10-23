//! `agents.*` (plugin-system.md §6.4) — the hook point for AP-1.
//!
//! Permissions are checked by the dispatch table (`agents:read` /
//! `agents:launch`); the work is delegated to an [`AgentsBackend`] that the
//! agent framework installs with [`set_agents_backend`]. Until one is
//! installed the methods are reported unavailable (`api.has('agents.launch')`
//! is false) and fail with `unsupported`.

use super::{AppExtension, PluginHostState};
use parking_lot::RwLock;
use quadflow_core::plugins::host::{HostCall, HostEnv, MethodSpec, PermReq, Sink, SubscriptionGuard, TopicSpec};
use quadflow_core::CoreError;
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Manager, Runtime};

/// Everything `agents.*` needs from the agent framework (agent-providers.md §5).
/// JSON in/out so this crate does not depend on AP-1's types; AP-1 returns its
/// typed structs serialized (`ProviderInfo[]`, `DetectionResult`, `ModelInfo[]`,
/// `TerminalHandle`).
pub trait AgentsBackend: Send + Sync {
    fn providers(&self) -> Result<Value, CoreError>;
    fn detect(&self, provider_id: &str) -> Result<Value, CoreError>;
    fn models(&self, provider_id: &str) -> Result<Value, CoreError>;
    /// Launch on behalf of `plugin_id`; `options` is `LaunchAgentOptions`.
    fn launch(&self, plugin_id: &str, options: Value) -> Result<Value, CoreError>;
    /// Push `{terminalId, providerId, sessionId}` for every linked session
    /// until the returned guard is dropped.
    fn on_session_linked(&self, sink: Sink) -> Result<SubscriptionGuard, CoreError>;
    /// The id `"default"` resolves to (setting `agents.defaultProvider`, else the
    /// first installed provider), if any provider exists. API 1.4.
    fn default_provider_id(&self) -> Option<String> {
        None
    }
    /// Non-interactive run of `provider_id` (prompt on stdin) in `cwd`; returns stdout. API 1.4.
    fn one_shot(&self, _provider_id: &str, _cwd: &std::path::Path, _prompt: &str) -> Result<String, CoreError> {
        Err(CoreError::unsupported("agents.oneShot is not available"))
    }
    /// `[{ providerId, root, glob, cwdSegments }]` of every active provider. API 1.4.
    fn session_roots(&self) -> Result<Value, CoreError> {
        Ok(Value::Array(Vec::new()))
    }
    /// Root of the active project (default `cwd` of `agents.oneShot`).
    fn active_project_root(&self) -> Option<std::path::PathBuf> {
        None
    }
}

#[derive(Default)]
pub struct AgentsSlot(RwLock<Option<Arc<dyn AgentsBackend>>>);

impl AgentsSlot {
    pub fn present(&self) -> bool {
        self.0.read().is_some()
    }
    fn get(&self) -> Result<Arc<dyn AgentsBackend>, CoreError> {
        self.0.read().clone().ok_or_else(|| CoreError::unsupported("the agent framework is not available"))
    }
}

/// Install the agent framework behind `agents.*` (called by AP-1 at startup).
pub fn set_agents_backend<R: Runtime>(app: &AppHandle<R>, backend: Arc<dyn AgentsBackend>) {
    if let Some(s) = app.try_state::<PluginHostState>() {
        *s.agents.0.write() = Some(backend);
    }
}

/// The app's agent framework (AP-1 `AgentsState`) behind `agents.*`.
pub(super) struct AppAgentsBackend {
    pub app: AppHandle<tauri::Wry>,
}

impl AppAgentsBackend {
    fn parts(&self) -> Result<(Arc<crate::agents::AgentsState>, Arc<quadflow_core::Core>), CoreError> {
        let a = self
            .app
            .try_state::<Arc<crate::agents::AgentsState>>()
            .ok_or_else(|| CoreError::unsupported("the agent framework is not available"))?
            .inner()
            .clone();
        let c = self
            .app
            .try_state::<crate::core_state::CoreState>()
            .ok_or_else(|| CoreError::internal("core state missing"))?
            .core
            .clone();
        Ok((a, c))
    }
}

fn to_json<T: serde::Serialize>(v: T) -> Result<Value, CoreError> {
    serde_json::to_value(v).map_err(|e| CoreError::internal(format!("serialize: {e}")))
}

impl AgentsBackend for AppAgentsBackend {
    fn providers(&self) -> Result<Value, CoreError> {
        let (a, c) = self.parts()?;
        to_json(a.providers(&c)?.list().iter().map(|e| e.info()).collect::<Vec<_>>())
    }
    fn detect(&self, provider_id: &str) -> Result<Value, CoreError> {
        let (a, c) = self.parts()?;
        let e = a.provider(&c, provider_id)?;
        to_json(a.detect(&e, false))
    }
    fn models(&self, provider_id: &str) -> Result<Value, CoreError> {
        let (a, c) = self.parts()?;
        to_json(a.models(&c, provider_id)?)
    }
    fn launch(&self, plugin_id: &str, options: Value) -> Result<Value, CoreError> {
        let (a, c) = self.parts()?;
        // `projectRoot` (plugin-API extra) selects the project; default = active.
        let root = match options.get("projectRoot").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
            Some(r) => std::path::PathBuf::from(r),
            None => self
                .app
                .state::<crate::core_state::CoreState>()
                .active_project_root()
                .ok_or_else(|| CoreError::project_not_found("no project is open (pass projectRoot)"))?,
        };
        let mut opts = options.clone();
        if let Some(o) = opts.as_object_mut() {
            o.remove("projectRoot");
        }
        let opts: quadflow_core::agents::AgentLaunchOptions = serde_json::from_value(opts)
            .map_err(|e| CoreError::invalid_input(format!("agents.launch: options: {e}")))?;
        let terms = self.app.state::<Arc<crate::terminal::TerminalManager>>().inner().clone();
        let actor = quadflow_core::Actor::plugin(plugin_id);
        let r = a.launch(&self.app, &c, &actor, &terms, &root, opts)?;
        let info = terms.get_terminal_info(&r.terminal_id).ok();
        Ok(serde_json::json!({
            "id": r.terminal_id,
            "pid": info.as_ref().and_then(|i| i.pid),
            "cwd": info.map(|i| i.cwd).unwrap_or_default(),
            "createdTerminal": r.created_terminal,
            "binding": to_json(r.binding)?,
        }))
    }
    fn on_session_linked(&self, sink: Sink) -> Result<SubscriptionGuard, CoreError> {
        use tauri::Listener;
        struct Unlisten(AppHandle<tauri::Wry>, tauri::EventId);
        impl Drop for Unlisten {
            fn drop(&mut self) {
                self.0.unlisten(self.1);
            }
        }
        let id = self.app.listen("agent-session-linked", move |e| {
            if let Ok(v) = serde_json::from_str::<Value>(e.payload()) {
                sink(v);
            }
        });
        Ok(SubscriptionGuard::new(Unlisten(self.app.clone(), id)))
    }
    fn default_provider_id(&self) -> Option<String> {
        let (a, c) = self.parts().ok()?;
        a.provider(&c, quadflow_core::agents::DEFAULT_PROVIDER_ALIAS).ok().map(|e| e.spec.id)
    }
    fn one_shot(&self, provider_id: &str, cwd: &std::path::Path, prompt: &str) -> Result<String, CoreError> {
        let (a, c) = self.parts()?;
        let e = a.provider(&c, provider_id)?;
        let det = a.detect(&e, false);
        quadflow_core::agents::one_shot::one_shot(&e.spec, &det, prompt, cwd, &a.env)
    }
    fn session_roots(&self) -> Result<Value, CoreError> {
        let (a, c) = self.parts()?;
        let roots: Vec<Value> = a
            .session_roots(&c)
            .into_iter()
            .map(|r| {
                serde_json::json!({
                    "providerId": r.provider_id,
                    "root": r.root.to_string_lossy(),
                    "glob": r.glob,
                    "cwdSegments": r.cwd_segments,
                })
            })
            .collect();
        Ok(Value::Array(roots))
    }
    fn active_project_root(&self) -> Option<std::path::PathBuf> {
        self.app.try_state::<crate::core_state::CoreState>()?.active_project_root()
    }
}

/// Install [`AppAgentsBackend`] when the app manages AP-1's `AgentsState`.
pub(super) fn install_default(app: &AppHandle<tauri::Wry>, slot: &AgentsSlot) {
    if !slot.present() && app.try_state::<Arc<crate::agents::AgentsState>>().is_some() {
        *slot.0.write() = Some(Arc::new(AppAgentsBackend { app: app.clone() }));
    }
}

pub(super) const METHODS: &[&str] = &[
    "agents.providers",
    "agents.detect",
    "agents.models",
    "agents.usage",
    "agents.launch",
    "agents.oneShot",
    "agents.sessionRoots",
    "agents.prepareWorktree",
    "agents.onSessionLinked",
];

/// `ProviderInfo[]` with `isDefault` (API 1.4): true for the provider `"default"` resolves to.
fn mark_default(mut providers: Value, default_id: Option<&str>) -> Value {
    if let Some(list) = providers.as_array_mut() {
        for p in list {
            let is = default_id.is_some() && p.get("id").and_then(Value::as_str) == default_id;
            if let Some(o) = p.as_object_mut() {
                o.insert("isDefault".into(), Value::Bool(is));
            }
        }
    }
    providers
}

/// The provider of `agents.oneShot`: `requested` (`"default"` resolved), else the
/// default provider when it has a one-shot mode, else the first provider that has one.
fn one_shot_provider(providers: &Value, requested: Option<&str>, default_id: Option<&str>) -> Result<String, CoreError> {
    let list = providers.as_array().cloned().unwrap_or_default();
    let has_one_shot = |id: &str| {
        list.iter().any(|p| p.get("id").and_then(Value::as_str) == Some(id) && p.get("hasOneShot").and_then(Value::as_bool) == Some(true))
    };
    let want = match requested.filter(|r| !r.trim().is_empty()) {
        Some(r) if r != quadflow_core::agents::DEFAULT_PROVIDER_ALIAS => Some(r.to_string()),
        Some(_) => default_id.map(str::to_string),
        None => None,
    };
    if let Some(id) = want {
        if !has_one_shot(&id) {
            return Err(CoreError::unsupported(format!("agent provider {id:?} has no one-shot mode")));
        }
        return Ok(id);
    }
    if let Some(d) = default_id.filter(|d| has_one_shot(d)) {
        return Ok(d.to_string());
    }
    list.iter()
        .filter(|p| p.get("hasOneShot").and_then(Value::as_bool) == Some(true))
        .find_map(|p| p.get("id").and_then(Value::as_str).map(str::to_string))
        .ok_or_else(|| CoreError::unsupported("no enabled agent provider has a one-shot mode"))
}

/// `agents.prepareWorktree` authorization step: the concrete provider id whose
/// `prepareWorktree` hook the frontend host then runs (UI code of its plugin,
/// like `usage`), or `null` when that provider declares no such hook.
fn worktree_provider(providers: &Value, requested: &str, default_id: Option<&str>) -> Result<Value, CoreError> {
    let id = if requested == quadflow_core::agents::DEFAULT_PROVIDER_ALIAS {
        default_id.ok_or_else(|| CoreError::unsupported("no agent provider plugin is enabled"))?.to_string()
    } else {
        requested.to_string()
    };
    let p = providers
        .as_array()
        .into_iter()
        .flatten()
        .find(|p| p.get("id").and_then(Value::as_str) == Some(id.as_str()))
        .ok_or_else(|| CoreError::not_found(format!("agent provider {id:?} not found")))?;
    let has = p.get("hooks").and_then(Value::as_array).is_some_and(|h| h.iter().any(|x| x.as_str() == Some("prepareWorktree")));
    Ok(if has { Value::String(id) } else { Value::Null })
}

/// `agents.usage` authorization step: the ids of the providers whose `usage`
/// hook the caller may have run (`agents:read`), optionally narrowed to one.
/// The hook itself is UI code in the provider's plugin, so the frontend host
/// runs it (`src/agents/providerRegistry.ts`, cooldown there) for exactly the
/// ids this permission-checked call returns.
fn usage_provider_ids(providers: &Value, only: Option<&str>) -> Value {
    let ids = providers
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| {
            p.get("hooks")
                .and_then(Value::as_array)
                .is_some_and(|h| h.iter().any(|x| x.as_str() == Some("usage")))
        })
        .filter_map(|p| p.get("id").and_then(Value::as_str))
        .filter(|id| only.map_or(true, |o| o == *id))
        .map(|id| Value::String(id.to_string()))
        .collect();
    Value::Array(ids)
}

/// The id of the terminal `agents.launch` created (`createdTerminal: true`), if any.
fn adopted_terminal(r: &Value) -> Option<&str> {
    if r.get("createdTerminal").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    r.get("id").and_then(Value::as_str).filter(|s| !s.is_empty())
}

pub(super) fn methods(ext: &AppExtension) -> Vec<MethodSpec> {
    let mut v = Vec::new();
    let s = Arc::clone(&ext.agents);
    v.push(MethodSpec::new("agents.providers", PermReq::One("agents:read"), move |_e: &HostEnv, _c: &HostCall| {
        let b = s.get()?;
        Ok(mark_default(b.providers()?, b.default_provider_id().as_deref()))
    }));
    // API 1.4: where the active providers keep their session transcripts (semantic search).
    let s = Arc::clone(&ext.agents);
    v.push(MethodSpec::new("agents.sessionRoots", PermReq::One("agents:read"), move |_e: &HostEnv, _c: &HostCall| {
        s.get()?.session_roots()
    }));
    let s = Arc::clone(&ext.agents);
    v.push(MethodSpec::new("agents.oneShot", PermReq::One("agents:launch"), move |_e: &HostEnv, c: &HostCall| {
        let b = s.get()?;
        let prompt: String = c.arg("prompt")?;
        if prompt.trim().is_empty() {
            return Err(CoreError::invalid_input("agents.oneShot: prompt must not be empty"));
        }
        let id = one_shot_provider(&b.providers()?, c.opt::<String>("providerId")?.as_deref(), b.default_provider_id().as_deref())?;
        let cwd = match c.opt::<String>("cwd")?.filter(|s| !s.trim().is_empty()) {
            Some(d) => {
                let p = std::path::PathBuf::from(d);
                if !p.is_absolute() || !p.is_dir() {
                    return Err(CoreError::invalid_input(format!("agents.oneShot: cwd {} is not an existing absolute directory", p.display())));
                }
                p
            }
            None => b.active_project_root().ok_or_else(|| CoreError::project_not_found("no project is open (pass cwd)"))?,
        };
        Ok(Value::String(b.one_shot(&id, &cwd, &prompt)?))
    }));
    let s = Arc::clone(&ext.agents);
    v.push(MethodSpec::new("agents.prepareWorktree", PermReq::One("agents:launch"), move |_e: &HostEnv, c: &HostCall| {
        let b = s.get()?;
        let path = std::path::PathBuf::from(c.arg::<String>("worktreePath")?);
        if !path.is_absolute() || !path.is_dir() {
            return Err(CoreError::invalid_input(format!(
                "agents.prepareWorktree: worktreePath {} is not an existing absolute directory",
                path.display()
            )));
        }
        worktree_provider(&b.providers()?, &c.arg::<String>("providerId")?, b.default_provider_id().as_deref())
    }));
    let s = Arc::clone(&ext.agents);
    v.push(MethodSpec::new("agents.detect", PermReq::One("agents:read"), move |_e: &HostEnv, c: &HostCall| {
        s.get()?.detect(&c.arg::<String>("providerId")?)
    }));
    let s = Arc::clone(&ext.agents);
    v.push(MethodSpec::new("agents.models", PermReq::One("agents:read"), move |_e: &HostEnv, c: &HostCall| {
        s.get()?.models(&c.arg::<String>("providerId")?)
    }));
    let s = Arc::clone(&ext.agents);
    v.push(MethodSpec::new("agents.usage", PermReq::One("agents:read"), move |_e: &HostEnv, c: &HostCall| {
        let only = c.params.get("providerId").and_then(Value::as_str).filter(|s| !s.is_empty());
        Ok(usage_provider_ids(&s.get()?.providers()?, only))
    }));
    let (s, app, terms) = (Arc::clone(&ext.agents), ext.app.clone(), Arc::clone(&ext.terminals));
    v.push(MethodSpec::new("agents.launch", PermReq::One("agents:launch"), move |_e: &HostEnv, c: &HostCall| {
        let r = s.get()?.launch(&c.plugin.id, c.params.get("options").cloned().unwrap_or(Value::Null))?;
        // A terminal the launch created belongs to the launching plugin (API 1.2):
        // it may follow its output / exit and kill it, like a `terminals.spawn` one.
        if let Some(id) = adopted_terminal(&r) {
            let title = c.params.pointer("/options/title").and_then(Value::as_str).unwrap_or("Agent");
            terms.adopt(&app, id, &c.plugin.id, title);
        }
        Ok(r)
    }));
    v
}

pub(super) fn topics(ext: &AppExtension) -> Vec<TopicSpec> {
    let s = Arc::clone(&ext.agents);
    vec![TopicSpec::new("agents.onSessionLinked", PermReq::One("agents:read"), move |_e: &HostEnv, _c: &HostCall, sink: Sink| {
        s.get()?.on_session_linked(sink)
    })]
}

#[cfg(test)]
mod tests {
    use super::{adopted_terminal, mark_default, one_shot_provider, usage_provider_ids, worktree_provider};

    fn providers() -> serde_json::Value {
        json!([
            { "id": "a", "hasOneShot": false, "hooks": [] },
            { "id": "b", "hasOneShot": true, "hooks": ["prepareWorktree"] },
            { "id": "c", "hasOneShot": true, "hooks": [] }
        ])
    }

    #[test]
    fn providers_mark_the_default() {
        let v = mark_default(providers(), Some("c"));
        let flags: Vec<bool> = v.as_array().unwrap().iter().map(|p| p["isDefault"].as_bool().unwrap()).collect();
        assert_eq!(flags, vec![false, false, true]);
        let v = mark_default(providers(), None);
        assert!(v.as_array().unwrap().iter().all(|p| p["isDefault"] == json!(false)));
    }

    #[test]
    fn one_shot_picks_a_provider_with_a_one_shot_mode() {
        let p = providers();
        assert_eq!(one_shot_provider(&p, None, Some("c")).unwrap(), "c");
        // The default has no one-shot mode: the first provider that has one.
        assert_eq!(one_shot_provider(&p, None, Some("a")).unwrap(), "b");
        assert_eq!(one_shot_provider(&p, Some("default"), Some("c")).unwrap(), "c");
        assert_eq!(one_shot_provider(&p, Some("c"), Some("b")).unwrap(), "c");
        assert!(one_shot_provider(&p, Some("a"), None).is_err());
        assert!(one_shot_provider(&json!([]), None, None).is_err());
    }

    #[test]
    fn worktree_provider_resolves_default_and_needs_the_hook() {
        let p = providers();
        assert_eq!(worktree_provider(&p, "default", Some("b")).unwrap(), json!("b"));
        assert_eq!(worktree_provider(&p, "c", Some("b")).unwrap(), json!(null));
        assert!(worktree_provider(&p, "nope", None).is_err());
        assert!(worktree_provider(&p, "default", None).is_err());
    }

    #[test]
    fn only_created_terminals_are_adopted() {
        assert_eq!(adopted_terminal(&json!({ "id": "t1", "createdTerminal": true })), Some("t1"));
        assert_eq!(adopted_terminal(&json!({ "id": "t1", "createdTerminal": false })), None);
        assert_eq!(adopted_terminal(&json!({ "id": "", "createdTerminal": true })), None);
        assert_eq!(adopted_terminal(&json!({ "createdTerminal": true })), None);
    }
    use serde_json::json;

    #[test]
    fn usage_ids_are_the_providers_with_a_usage_hook() {
        let p = json!([
            { "id": "provider-a", "hooks": ["usage", "contextUsage"] },
            { "id": "provider-b", "hooks": ["usage"] },
            { "id": "gemini", "hooks": [] },
            { "id": "other" }
        ]);
        assert_eq!(usage_provider_ids(&p, None), json!(["provider-a", "provider-b"]));
        assert_eq!(usage_provider_ids(&p, Some("provider-b")), json!(["provider-b"]));
        assert_eq!(usage_provider_ids(&p, Some("gemini")), json!([]));
    }
}
