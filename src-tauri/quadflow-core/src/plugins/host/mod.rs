//! The plugin host dispatch table (plugin-system.md §7.1, §11.3).
//!
//! Every privileged host-API call — from a plugin's UI (both isolation modes,
//! through `plugin_invoke`), from a sidecar (PL-7) or from a CLI-mode sidecar
//! (PL-8) — goes through [`dispatch`] (one-shot methods) or [`subscribe`]
//! (streams). Both look the method up in one table (core methods + the
//! [`HostExtension`]s the app adds), compute the permission the call needs,
//! check it against the plugin's **granted** set (`permission_denied` naming
//! the permission otherwise), require the plugin to be `Active`, and run the
//! handler with `Actor::plugin(id)`.
//!
//! Core registers `data.*`, `storage.*`, `settings.*`, `secrets.*`, `fs.*`,
//! `shell.exec`/`shell.spawn`, `http.fetch`, `log.*` and `project.list`; the
//! Tauri app adds terminals, agents, notifications, clipboard, native, dialogs
//! and URL opening (`src-tauri/src/plugin_host/`).

mod data;
mod fs;
mod http;
mod kv;
mod misc;
mod shell;

pub use fs::{resolve_in_root, FsScopeName};

use crate::domains::app::secrets::Secrets;
use crate::error::{CoreError, Result};
use crate::plugins::{LoadedPlugin, Permission, PluginStatus};
use crate::store::ProjectStore;
use crate::{Actor, Core};
use parking_lot::Mutex;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::any::Any;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Instant;

/// One call: who, what, with which (JSON object) params.
pub struct HostCall<'a> {
    pub plugin: &'a LoadedPlugin,
    pub method: &'a str,
    pub params: Value,
}

impl HostCall<'_> {
    /// Required param `name` (camelCase key). Missing / `null` / wrong shape → `invalid_input`.
    pub fn arg<T: DeserializeOwned>(&self, name: &str) -> Result<T> {
        let v = self.params.get(name).cloned().unwrap_or(Value::Null);
        serde_json::from_value(v).map_err(|e| CoreError::invalid_input(format!("{}: param `{name}`: {e}", self.method)))
    }

    /// Optional param: missing / `null` → `None`.
    pub fn opt<T: DeserializeOwned>(&self, name: &str) -> Result<Option<T>> {
        match self.params.get(name) {
            None | Some(Value::Null) => Ok(None),
            Some(v) => serde_json::from_value(v.clone())
                .map(Some)
                .map_err(|e| CoreError::invalid_input(format!("{}: param `{name}`: {e}", self.method))),
        }
    }

    /// Optional param with a default.
    pub fn arg_or_default<T: DeserializeOwned + Default>(&self, name: &str) -> Result<T> {
        Ok(self.opt(name)?.unwrap_or_default())
    }

    pub fn actor(&self) -> Actor {
        Actor::plugin(&self.plugin.id)
    }

    /// Does the plugin hold a permission satisfying `perm`?
    pub fn has(&self, perm: &str) -> bool {
        Permission::parse(perm).is_ok_and(|req| self.plugin.granted.iter().any(|g| g.satisfies(&req)))
    }

    /// `permission_denied` unless the plugin holds `perm`.
    pub fn require(&self, perm: &str) -> Result<()> {
        if self.has(perm) {
            Ok(())
        } else {
            Err(denied(&self.plugin.id, self.method, perm))
        }
    }
}

fn denied(plugin: &str, method: &str, perm: &str) -> CoreError {
    CoreError::permission_denied(format!("plugin {plugin:?} needs permission `{perm}` for {method}"))
        .with_details(serde_json::json!({ "permission": perm, "method": method, "pluginId": plugin }))
}

/// Computes the permissions a call needs from its params. `Ok(vec![])` = none;
/// otherwise **any one** of the returned permissions satisfies the call (the
/// first one is named in the error).
pub type PermFn = fn(&HostEnv, &HostCall) -> Result<Vec<String>>;

pub enum PermReq {
    /// Implicit (own storage/settings/plugin data, log, …) — or the handler
    /// checks ownership itself (e.g. terminals it spawned vs `terminal:io`).
    None,
    One(&'static str),
    Fn(PermFn),
}

pub type Handler = Arc<dyn Fn(&HostEnv, &HostCall) -> Result<Value> + Send + Sync>;

/// Pushes one stream item to the subscriber.
pub type Sink = Arc<dyn Fn(Value) + Send + Sync>;

/// Keeps a subscription alive; dropping it cancels the stream (unsubscribes,
/// kills a spawned process, stops a watcher, …).
pub struct SubscriptionGuard(#[allow(dead_code)] Box<dyn Any + Send>);

impl SubscriptionGuard {
    pub fn new<T: Any + Send>(inner: T) -> Self {
        Self(Box::new(inner))
    }
    pub fn none() -> Self {
        Self(Box::new(()))
    }
}

pub type SubscribeHandler = Arc<dyn Fn(&HostEnv, &HostCall, Sink) -> Result<SubscriptionGuard> + Send + Sync>;

pub struct MethodSpec {
    pub name: &'static str,
    pub permission: PermReq,
    pub handler: Handler,
}

pub struct TopicSpec {
    pub name: &'static str,
    pub permission: PermReq,
    pub handler: SubscribeHandler,
}

impl MethodSpec {
    pub fn new(
        name: &'static str,
        permission: PermReq,
        f: impl Fn(&HostEnv, &HostCall) -> Result<Value> + Send + Sync + 'static,
    ) -> Self {
        Self { name, permission, handler: Arc::new(f) }
    }
}

impl TopicSpec {
    pub fn new(
        name: &'static str,
        permission: PermReq,
        f: impl Fn(&HostEnv, &HostCall, Sink) -> Result<SubscriptionGuard> + Send + Sync + 'static,
    ) -> Self {
        Self { name, permission, handler: Arc::new(f) }
    }
}

/// Methods contributed by the embedding app (the Tauri shell).
pub trait HostExtension: Send + Sync {
    fn methods(&self) -> Vec<MethodSpec>;
    fn topics(&self) -> Vec<TopicSpec> {
        Vec::new()
    }
    /// Methods this extension declares but cannot serve right now (e.g.
    /// `agents.*` before the agent framework is available). They are reported
    /// as unavailable by [`HostEnv::available`] so `api.has()` is accurate.
    fn unavailable(&self) -> Vec<&'static str> {
        Vec::new()
    }
}

/// Per-process host state shared by all calls.
#[derive(Default)]
pub struct HostSession {
    /// Paths a plugin picked through `ui.pickFile` (fs `absolute` scope
    /// allowlist for this session, §6.7). Keyed by plugin id.
    allow: Mutex<BTreeMap<String, BTreeSet<PathBuf>>>,
    /// Default project root when the call names none. `None` = the app's
    /// active project (`shell.activeProjectId`).
    pub project_override: Mutex<Option<PathBuf>>,
}

impl HostSession {
    pub fn allow_path(&self, plugin_id: &str, path: &Path) {
        let p = dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        self.allow.lock().entry(plugin_id.to_string()).or_default().insert(p);
    }

    /// Is `path` (canonical) one of the plugin's picked paths or inside a picked directory?
    pub fn is_allowed(&self, plugin_id: &str, path: &Path) -> bool {
        self.allow.lock().get(plugin_id).is_some_and(|set| set.iter().any(|a| path == a || path.starts_with(a)))
    }
}

pub struct HostEnv {
    pub core: Arc<Core>,
    pub secrets: Secrets,
    pub session: Arc<HostSession>,
    methods: BTreeMap<&'static str, MethodSpec>,
    topics: BTreeMap<&'static str, TopicSpec>,
    extensions: Vec<Arc<dyn HostExtension>>,
}

impl HostEnv {
    pub fn new(core: Arc<Core>, secrets: Secrets, extensions: Vec<Arc<dyn HostExtension>>) -> Self {
        let mut methods = BTreeMap::new();
        let mut topics = BTreeMap::new();
        for m in core_methods() {
            methods.insert(m.name, m);
        }
        for t in core_topics() {
            topics.insert(t.name, t);
        }
        for ext in &extensions {
            for m in ext.methods() {
                methods.insert(m.name, m);
            }
            for t in ext.topics() {
                topics.insert(t.name, t);
            }
        }
        Self { core, secrets, session: Arc::new(HostSession::default()), methods, topics, extensions }
    }

    fn is_unavailable(&self, name: &str) -> bool {
        self.extensions.iter().any(|e| e.unavailable().contains(&name))
    }

    /// Every method / topic this host serves now (for `api.has()`).
    pub fn available(&self) -> Vec<String> {
        self.methods
            .keys()
            .chain(self.topics.keys())
            .filter(|n| !self.is_unavailable(n))
            .map(|n| n.to_string())
            .collect()
    }

    /// Project root for a call: `params.projectRoot`, else the session override,
    /// else the active project. None → `project_not_found`.
    pub fn project_root(&self, call: &HostCall) -> Result<PathBuf> {
        if let Some(root) = call.opt::<String>("projectRoot")?.filter(|r| !r.trim().is_empty()) {
            return Ok(PathBuf::from(root));
        }
        if let Some(p) = self.session.project_override.lock().clone() {
            return Ok(p);
        }
        let db = self.core.app_db()?;
        match crate::domains::app::projects::active(&db)? {
            Some(p) => Ok(PathBuf::from(p.root)),
            None => Err(CoreError::project_not_found("no project is open (pass projectRoot)")),
        }
    }

    /// The project store for a call (see [`HostEnv::project_root`]).
    pub fn store(&self, call: &HostCall) -> Result<Arc<ProjectStore>> {
        let root = self.project_root(call)?;
        self.core.project(&root)
    }
}

fn check_permission(env: &HostEnv, call: &HostCall, req: &PermReq) -> Result<()> {
    let needed: Vec<String> = match req {
        PermReq::None => return Ok(()),
        PermReq::One(p) => vec![p.to_string()],
        PermReq::Fn(f) => f(env, call)?,
    };
    if needed.is_empty() || needed.iter().any(|p| call.has(p)) {
        Ok(())
    } else {
        Err(denied(&call.plugin.id, call.method, &needed[0]))
    }
}

fn check_active(call: &HostCall) -> Result<()> {
    if call.plugin.status == PluginStatus::Active {
        Ok(())
    } else {
        Err(CoreError::permission_denied(format!(
            "plugin {:?} is not active ({})",
            call.plugin.id,
            call.plugin.status.label()
        )))
    }
}

fn normalize_params(call: &mut HostCall) -> Result<()> {
    match &call.params {
        Value::Null => call.params = Value::Object(Default::default()),
        Value::Object(_) => {}
        _ => return Err(CoreError::invalid_input(format!("{}: params must be an object", call.method))),
    }
    Ok(())
}

/// Run a one-shot host method.
pub fn dispatch(env: &HostEnv, mut call: HostCall) -> Result<Value> {
    let started = Instant::now();
    let res = (|| {
        let spec = env
            .methods
            .get(call.method)
            .ok_or_else(|| CoreError::invalid_input(format!("unknown host method {:?}", call.method)))?;
        normalize_params(&mut call)?;
        check_permission(env, &call, &spec.permission)?;
        check_active(&call)?;
        if env.is_unavailable(call.method) {
            return Err(CoreError::unsupported(format!("{} is not available in this QuadFlow build", call.method)));
        }
        (spec.handler)(env, &call)
    })();
    log::debug!(
        "[plugin-host] {} {} {} {}ms",
        call.plugin.id,
        call.method,
        if res.is_ok() { "ok" } else { "err" },
        started.elapsed().as_millis()
    );
    res
}

/// Start a stream. The guard must be kept until the subscriber unsubscribes.
pub fn subscribe(env: &HostEnv, mut call: HostCall, sink: Sink) -> Result<SubscriptionGuard> {
    let spec = env
        .topics
        .get(call.method)
        .ok_or_else(|| CoreError::invalid_input(format!("unknown host topic {:?}", call.method)))?;
    normalize_params(&mut call)?;
    check_permission(env, &call, &spec.permission)?;
    check_active(&call)?;
    if env.is_unavailable(call.method) {
        return Err(CoreError::unsupported(format!("{} is not available in this QuadFlow build", call.method)));
    }
    let res = (spec.handler)(env, &call, sink);
    log::debug!("[plugin-host] {} subscribe {} {}", call.plugin.id, call.method, if res.is_ok() { "ok" } else { "err" });
    res
}

/// `serde_json::to_value` with the crate error.
pub(crate) fn json<T: serde::Serialize>(v: T) -> Result<Value> {
    serde_json::to_value(v).map_err(|e| CoreError::internal(format!("serialize host result: {e}")))
}

fn core_methods() -> Vec<MethodSpec> {
    let mut v = Vec::new();
    v.extend(misc::methods());
    v.extend(data::methods());
    v.extend(kv::methods());
    v.extend(fs::methods());
    v.extend(shell::methods());
    v.extend(http::methods());
    v
}

fn core_topics() -> Vec<TopicSpec> {
    let mut v = Vec::new();
    v.extend(data::topics());
    v.extend(fs::topics());
    v.extend(shell::topics());
    v
}

/// The names of the core methods (no extensions), for tests and docs.
pub fn core_method_names() -> &'static [String] {
    static NAMES: OnceLock<Vec<String>> = OnceLock::new();
    NAMES.get_or_init(|| core_methods().iter().map(|m| m.name.to_string()).collect())
}

#[cfg(test)]
mod tests;
