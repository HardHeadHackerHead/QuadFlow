//! GUI side of the agent framework (agent-providers.md §8): the provider set,
//! detection cache, model catalog, session claims + discovery workers, and the
//! launch flow that spawns/uses a PTY via `TerminalManager`.
//!
//! The Tauri commands in `commands/agents.rs` are thin wrappers over this.

use crate::terminal::{CreateTerminalOptions, TerminalManager};
use parking_lot::Mutex;
use quadflow_core::agents::catalog::{self, AgentCatalogStatus, Catalog};
use quadflow_core::agents::claims::{run_discovery, DiscoveryEvent};
use quadflow_core::agents::launch::bracketed_paste;
use quadflow_core::agents::models::{self as models_mod, ModelSettings, SETTINGS_NS};
use quadflow_core::agents::spec::SessionStrategy;
use quadflow_core::agents::{
    build_launch, command_line, validate_session_id, AgentApprovalMode, AgentBinding, AgentDetection, AgentLaunchOptions,
    AgentLaunchResult, AgentModelInfo, AgentSessionInfo, AgentSessionState, DetectCache, LaunchRequest, ProcessEnv,
    ProviderEntry, ProviderSet, SessionClaims, SessionScanner, ShellKind,
};
use quadflow_core::domains::app::settings;
use quadflow_core::domains::environments;
use quadflow_core::domains::issues::{self, ClaimInput};
use quadflow_core::paths::root_key;
use quadflow_core::plugins::PluginRegistry;
use quadflow_core::time::now_ms;
use quadflow_core::{Actor, Core, CoreError, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri_specta::Event;

/// A discovered session was linked to a terminal (wire name `agent-session-linked`).
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionLinked {
    pub terminal_id: String,
    pub provider_id: String,
    pub session_id: String,
}

/// Discovery gave up on a terminal after 180 s (`agent-session-unlinked`).
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionUnlinked {
    pub terminal_id: String,
    pub provider_id: String,
}

/// The model catalog changed (`agent-catalog-updated`).
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(transparent)]
pub struct AgentCatalogUpdated(pub AgentCatalogStatus);

/// A persisted binding to reconcile on restore (§8.5).
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentRestoreEntry {
    pub terminal_id: String,
    pub cwd: String,
    pub binding: AgentBinding,
}

/// `agents_relaunch` options.
#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentRelaunchOptions {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub approval_mode: Option<AgentApprovalMode>,
    #[serde(default)]
    pub effort: Option<String>,
    /// Resume the binding's session (when it has one).
    #[serde(default)]
    pub resume: bool,
}

pub struct AgentsState {
    pub claims: Arc<SessionClaims>,
    pub scanner: Arc<SessionScanner>,
    pub detect: DetectCache,
    pub env: ProcessEnv,
    catalog: Mutex<Catalog>,
    catalog_error: Mutex<Option<String>>,
    workers: Arc<Mutex<HashSet<(String, String)>>>,
}

impl AgentsState {
    pub fn new(core: &Core) -> Self {
        Self {
            claims: Arc::new(SessionClaims::new()),
            scanner: Arc::new(SessionScanner::new()),
            detect: DetectCache::default(),
            env: ProcessEnv::current(),
            catalog: Mutex::new(catalog::load_cached_or_bundled(&core.paths)),
            catalog_error: Mutex::new(None),
            workers: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    /// Providers contributed by active plugins (`contributes.agentProvider`).
    pub fn providers(&self, core: &Core) -> Result<ProviderSet> {
        let reg = PluginRegistry::load(&core.paths, &*core.app_db()?)?;
        Ok(ProviderSet::from_registry(&reg))
    }

    /// A provider by id; `"default"` (`DEFAULT_PROVIDER_ALIAS`) resolves to
    /// setting `agents.defaultProvider` when active, else the first installed
    /// provider, else the first provider.
    pub fn provider(&self, core: &Core, id: &str) -> Result<ProviderEntry> {
        let set = self.providers(core)?;
        if id != quadflow_core::agents::DEFAULT_PROVIDER_ALIAS {
            return Ok(set.require(id)?.clone());
        }
        let configured: Option<String> = Self::agent_setting(core, "defaultProvider");
        if let Some(e) = configured.as_deref().and_then(|c| set.get(c)) {
            return Ok(e.clone());
        }
        let list = set.list();
        list.iter()
            .find(|e| self.detect(e, false).installed)
            .or_else(|| list.first())
            .cloned()
            .ok_or_else(|| CoreError::unsupported("no agent provider plugin is enabled"))
    }

    pub fn detect(&self, entry: &ProviderEntry, refresh: bool) -> AgentDetection {
        self.detect.get_or_detect(&entry.as_ref(), &self.env, refresh)
    }

    // ---- catalog ----

    fn catalog_url(&self, core: &Core) -> Result<Option<String>> {
        let setting = settings::get_string(&*core.app_db()?, SETTINGS_NS, catalog::SETTING_CATALOG_URL)?;
        catalog::catalog_url(std::env::var(catalog::ENV_CATALOG_URL).ok().as_deref(), setting.as_deref())
    }

    pub fn catalog_status(&self, core: &Core) -> AgentCatalogStatus {
        let url = self.catalog_url(core).ok().flatten();
        self.catalog.lock().status(url, self.catalog_error.lock().clone())
    }

    /// Refresh (forced = ignore the 6 h freshness). Returns the new status and
    /// whether the catalog changed.
    pub fn refresh_catalog(&self, core: &Core, force: bool) -> (AgentCatalogStatus, bool) {
        let url = match self.catalog_url(core) {
            Ok(u) => u,
            Err(e) => {
                *self.catalog_error.lock() = Some(e.message.clone());
                return (self.catalog_status(core), false);
            }
        };
        let Some(url) = url else {
            *self.catalog_error.lock() = Some("no catalog URL configured (public repo not set); using the bundled catalog".into());
            return (self.catalog_status(core), false);
        };
        let res = catalog::refresh(&core.paths, &url, force);
        let changed = match res {
            Ok(cat) => {
                *self.catalog_error.lock() = None;
                let mut cur = self.catalog.lock();
                let changed = cur.providers != cat.providers || cur.updated_at != cat.updated_at || cur.source != cat.source;
                *cur = cat;
                changed
            }
            Err(e) => {
                log::warn!("[agents] catalog refresh failed: {}", e.message);
                *self.catalog_error.lock() = Some(e.message);
                false
            }
        };
        (self.catalog_status(core), changed)
    }

    /// Background startup refresh when the cache is older than 6 h.
    pub fn spawn_startup_refresh(self: &Arc<Self>, app: AppHandle, core: Arc<Core>) {
        let me = self.clone();
        std::thread::spawn(move || {
            let (status, changed) = me.refresh_catalog(&core, false);
            if changed {
                let _ = AgentCatalogUpdated(status).emit(&app);
            }
        });
    }

    // ---- models ----

    pub fn models(&self, core: &Core, provider_id: &str) -> Result<Vec<AgentModelInfo>> {
        quadflow_core::agents::spec::validate_provider_id(provider_id)?;
        // Before the provider is registered, its catalog key is its id.
        let (key, allow_custom) = match self.providers(core)?.get(provider_id) {
            Some(e) => (e.spec.catalog_key().to_string(), e.spec.models.allow_custom),
            None => (provider_id.to_string(), true),
        };
        let s = ModelSettings::load(&*core.app_db()?, provider_id)?;
        Ok(models_mod::models(&key, allow_custom, &self.catalog.lock(), &s))
    }

    // ---- sessions ----

    /// Session roots of every active provider (all projects). For the host method
    /// `agents.sessionRoots` (plugin API 1.4; the semantic-search sidecar indexes them).
    pub fn session_roots(&self, core: &Core) -> Vec<quadflow_core::agents::SessionsRoot> {
        let Ok(set) = self.providers(core) else { return Vec::new() };
        set.list()
            .iter()
            .filter_map(|e| match quadflow_core::agents::SessionsRoot::of(&e.spec, &self.env) {
                Ok(r) => r,
                Err(err) => {
                    log::debug!("[agents] {}: no session root: {}", e.spec.id, err.message);
                    None
                }
            })
            .collect()
    }

    pub fn list_sessions(&self, entry: &ProviderEntry, cwd: &Path) -> Result<Vec<AgentSessionInfo>> {
        self.scanner.list(&entry.spec, cwd, None, &self.env)
    }

    /// Register a launch awaiting its session and make sure a worker runs.
    pub fn discover(self: &Arc<Self>, app: &AppHandle, entry: &ProviderEntry, cwd: &Path, terminal_id: &str, launched_at: i64) {
        self.claims.register_pending(&entry.spec.id, cwd, terminal_id, launched_at);
        self.ensure_worker(app, entry.clone(), root_key(cwd));
    }

    fn ensure_worker(self: &Arc<Self>, app: &AppHandle, entry: ProviderEntry, cwd_key: String) {
        let key = (entry.spec.id.clone(), cwd_key.clone());
        if !self.workers.lock().insert(key.clone()) {
            return;
        }
        let me = self.clone();
        let app = app.clone();
        std::thread::spawn(move || loop {
            let scan = |cwd: &Path, since: i64| match me.scanner.list(&entry.spec, cwd, Some(since), &me.env) {
                Ok(l) => l,
                Err(e) => {
                    log::debug!("[agents] session scan failed: {}", e.message);
                    Vec::new()
                }
            };
            let emit = |e: DiscoveryEvent| match e {
                DiscoveryEvent::Linked(l) => {
                    log::info!("[agents] linked {} session {} to terminal {}", l.provider_id, l.session_id, l.terminal_id);
                    let _ = AgentSessionLinked { terminal_id: l.terminal_id, provider_id: l.provider_id, session_id: l.session_id }
                        .emit(&app);
                }
                DiscoveryEvent::Unlinked { terminal_id, provider_id } => {
                    let _ = AgentSessionUnlinked { terminal_id, provider_id }.emit(&app);
                }
            };
            run_discovery(&me.claims, &entry.spec.id, &cwd_key, &scan, &emit);
            me.workers.lock().remove(&key);
            // A launch registered while we were finishing: keep going.
            if me.claims.group(&entry.spec.id, &cwd_key).is_none() || !me.workers.lock().insert(key.clone()) {
                break;
            }
        });
    }

    /// §8.5: seed claims from persisted bindings; resume discovery for pending ones.
    pub fn restore(self: &Arc<Self>, app: &AppHandle, core: &Core, entries: Vec<AgentRestoreEntry>) -> Result<()> {
        let providers = self.providers(core)?;
        let entries: Vec<AgentRestoreEntry> = entries
            .into_iter()
            .filter(|e| match e.binding.validate() {
                Ok(()) => true,
                Err(err) => {
                    log::warn!("[agents] restore: skipping terminal {}: {}", e.terminal_id, err.message);
                    false
                }
            })
            .collect();
        for e in &entries {
            if let Some(s) = &e.binding.session_id {
                if let Err(other) = self.claims.claim(&e.binding.provider_id, s, &e.terminal_id) {
                    log::warn!("[agents] session {s} is bound to both {other} and {}; keeping {other}", e.terminal_id);
                }
            }
        }
        for e in entries {
            if e.binding.session_id.is_none() && e.binding.session_state == AgentSessionState::Pending && e.binding.sync_enabled {
                if let Some(p) = providers.get(&e.binding.provider_id) {
                    if p.spec.sessions.strategy == SessionStrategy::Discover {
                        self.discover(app, p, Path::new(&e.cwd), &e.terminal_id, e.binding.launched_at);
                    }
                }
            }
        }
        Ok(())
    }

    // ---- launch ----

    fn agent_setting<T: serde::de::DeserializeOwned>(core: &Core, key: &str) -> Option<T> {
        let db = core.app_db().ok()?;
        settings::get_value(&db, SETTINGS_NS, key).ok().flatten().and_then(|v| serde_json::from_value(v).ok())
    }

    /// §8.2. `project_root` = the project the agent works for (QUADFLOW_PROJECT_DIR).
    pub fn launch(
        self: &Arc<Self>,
        app: &AppHandle,
        core: &Arc<Core>,
        actor: &Actor,
        terminals: &Arc<TerminalManager>,
        project_root: &Path,
        opts: AgentLaunchOptions,
    ) -> Result<AgentLaunchResult> {
        let entry = self.provider(core, &opts.provider_id)?;
        let spec = &entry.spec;
        let det = self.detect(&entry, false);
        let det = if det.installed { det } else { self.detect(&entry, true) };
        if !det.installed {
            let mut e = CoreError::unsupported(format!("{} is not installed", spec.display_name));
            if let Some(h) = entry.info().install_hint {
                e = e.with_details(serde_json::json!({ "hint": h }));
            }
            return Err(e);
        }
        let cwd = PathBuf::from(opts.cwd.clone().filter(|c| !c.trim().is_empty()).unwrap_or_else(|| project_root.display().to_string()));
        if !cwd.is_dir() {
            return Err(CoreError::invalid_input(format!("{} is not a directory", cwd.display())));
        }
        let approval_mode = opts.approval_mode.unwrap_or_default();
        let resume = opts.resume_session_id.clone().filter(|s| !s.is_empty());
        let session_id = match (spec.sessions.strategy, &resume) {
            (_, Some(r)) => {
                validate_session_id(r, spec.sessions.id_format)?;
                Some(r.clone())
            }
            (SessionStrategy::Preassign, None) => Some(uuid::Uuid::new_v4().to_string()),
            _ => None,
        };
        let models = self.models(core, &spec.id)?;
        let req = LaunchRequest {
            model: opts.model.clone(),
            approval_mode,
            effort: opts.effort.clone(),
            resume_session_id: resume.clone(),
            cwd: Some(cwd.clone()),
        };
        let preassigned = if resume.is_none() { session_id.as_deref() } else { None };
        let plan = build_launch(spec, &det, &req, preassigned, &models, &self.env)?;

        // Terminal: reuse a live one, else create the PTY.
        let wanted_id = opts.terminal_id.clone().filter(|t| !t.is_empty());
        let reuse = wanted_id.as_deref().is_some_and(|t| terminals.is_alive(t));
        let (terminal_id, shell_opt, created, init_count) = if reuse {
            let id = wanted_id.clone().expect("checked");
            let shell = terminals.terminal_shell(&id).map_err(CoreError::internal)?;
            (id, shell, false, 0)
        } else {
            let (shell, init) = match opts.environment_id.as_deref().filter(|e| !e.is_empty()) {
                Some(key) => {
                    let env = environments::get_by_id_or_name(&*core.app_db()?, key)?;
                    (Some(env.shell_path.clone().unwrap_or_else(|| env.shell.as_str().to_string())), env.init_commands.clone())
                }
                None => (None, Vec::new()),
            };
            let mut env: HashMap<String, String> = plan.env.clone().into_iter().collect();
            env.insert(quadflow_core::paths::ENV_PROJECT_DIR.into(), project_root.display().to_string());
            env.insert("QUADFLOW_ACTOR_KIND".into(), "agent".into());
            env.insert("QUADFLOW_ACTOR_NAME".into(), spec.display_name.clone());
            env.insert("QUADFLOW_PROVIDER_ID".into(), spec.id.clone());
            if let Some(s) = &session_id {
                env.insert("QUADFLOW_SESSION_ID".into(), s.clone());
            }
            // Terminal ids are layout leaf ids (`term:<uuid>`, plugin-system.md §5.2).
            let id = wanted_id.clone().unwrap_or_else(|| format!("term:{}", uuid::Uuid::new_v4()));
            env.insert("QUADFLOW_TERMINAL_ID".into(), id.clone());
            if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
                let mut paths = vec![dir];
                if let Some(p) = std::env::var_os("PATH") {
                    paths.extend(std::env::split_paths(&p));
                }
                if let Ok(joined) = std::env::join_paths(paths) {
                    env.insert("PATH".into(), joined.to_string_lossy().to_string());
                }
            }
            let n = init.len();
            let info = terminals
                .create_terminal(
                    app.clone(),
                    CreateTerminalOptions {
                        cwd: Some(cwd.display().to_string()),
                        cols: None,
                        rows: None,
                        id: Some(id),
                        shell: shell.clone(),
                        init_commands: Some(init).filter(|i| !i.is_empty()),
                        env: Some(env),
                    },
                )
                .map_err(CoreError::internal)?;
            (info.id, shell, true, n)
        };

        let shell_kind = ShellKind::from_shell_option(shell_opt.as_deref());
        let line = command_line(shell_kind, &plan.program, &plan.argv)?;
        let launched_at = now_ms();
        let output = terminals.subscribe_output(&terminal_id).ok();
        let prompt = opts.prompt.clone().filter(|p| !p.trim().is_empty());
        let auto_submit = opts.auto_submit.or_else(|| Self::agent_setting(core, "autoSubmitPrompt")).unwrap_or(true);
        let startup_delay: u64 = Self::agent_setting(core, "startupDelayMs").unwrap_or(3000);
        {
            let terminals = terminals.clone();
            let tid = terminal_id.clone();
            let ready = spec.launch.ready_pattern.clone().and_then(|p| regex::Regex::new(&p).ok());
            let ready_timeout = Duration::from_millis(spec.launch.ready_timeout_ms);
            std::thread::spawn(move || {
                if created {
                    // Let the shell (and its init commands) settle first.
                    std::thread::sleep(Duration::from_millis(600 + 500 * init_count as u64));
                }
                if let Err(e) = terminals.write_terminal(&tid, &format!("{line}\r")) {
                    log::warn!("[agents] launch write failed: {e}");
                    return;
                }
                let Some(prompt) = prompt else { return };
                wait_ready(output, ready, ready_timeout, Duration::from_millis(startup_delay));
                let mut data = bracketed_paste(&prompt);
                if auto_submit {
                    data.push('\r');
                }
                let _ = terminals.write_terminal(&tid, &data);
            });
        }

        let mut binding = AgentBinding::new(spec.id.clone(), launched_at);
        binding.model = opts.model.clone().filter(|m| !m.is_empty());
        binding.approval_mode = approval_mode;
        binding.effort = opts.effort.clone();
        binding.session_id = session_id.clone();
        binding.role = opts.role;
        binding.role_label = opts.role_label.clone();
        binding.sync_enabled = opts.sync_enabled.unwrap_or(true);
        binding.mission_id = opts.mission_id.clone();
        binding.member_id = opts.member_id.clone();
        binding.session_state = match (spec.sessions.strategy, &session_id) {
            (_, Some(_)) if resume.is_some() => AgentSessionState::Linked,
            (SessionStrategy::Preassign, Some(_)) => AgentSessionState::Assigned,
            (SessionStrategy::Discover, None) if binding.sync_enabled => AgentSessionState::Pending,
            _ => AgentSessionState::Unlinked,
        };
        if let Some(s) = &session_id {
            if let Err(other) = self.claims.claim(&spec.id, s, &terminal_id) {
                log::warn!("[agents] session {s} already bound to terminal {other}");
            }
        } else if binding.session_state == AgentSessionState::Pending {
            self.discover(app, &entry, &cwd, &terminal_id, launched_at);
        }
        // The agent is already starting in its terminal: a failed claim (issue
        // claimed elsewhere, unknown ref) must not orphan it, so it is logged.
        if let Some(r) = opts.issue_ref.as_deref().filter(|r| !r.is_empty()) {
            let claimed = core.project(project_root).and_then(|store| {
                issues::claim(
                    &store,
                    actor,
                    r,
                    ClaimInput {
                        agent_label: opts.role_label.clone().unwrap_or_else(|| spec.display_name.clone()),
                        terminal_id: Some(terminal_id.clone()),
                        provider_id: Some(spec.id.clone()),
                        session_id: session_id.clone(),
                    },
                )
            });
            match claimed {
                Ok(issue) => binding.issue_id = Some(issue.id.to_string()),
                Err(e) => log::warn!("[agents] could not claim issue {r} for terminal {terminal_id}: {}", e.message),
            }
        }
        Ok(AgentLaunchResult { terminal_id, created_terminal: created, binding })
    }

    /// Exit the agent in `terminal_id` and launch again (approval-mode toggles, model switches).
    #[allow(clippy::too_many_arguments)]
    pub fn relaunch(
        self: &Arc<Self>,
        app: &AppHandle,
        core: &Arc<Core>,
        actor: &Actor,
        terminals: &Arc<TerminalManager>,
        project_root: &Path,
        terminal_id: &str,
        binding: AgentBinding,
        o: AgentRelaunchOptions,
    ) -> Result<AgentBinding> {
        binding.validate()?;
        let entry = self.provider(core, &binding.provider_id)?;
        if !terminals.is_alive(terminal_id) {
            return Err(CoreError::not_found(format!("terminal {terminal_id}")));
        }
        let cwd = terminals.get_terminal_info(terminal_id).map(|i| i.cwd).map_err(CoreError::internal)?;
        let out = terminals.subscribe_output(terminal_id).ok();
        let exit = entry.spec.launch.exit_command.clone().map(|c| format!("{c}\r")).unwrap_or_else(|| "\x03\x03".into());
        terminals.write_terminal(terminal_id, &exit).map_err(CoreError::internal)?;
        wait_idle(out, Duration::from_millis(1500), Duration::from_secs(5));
        let resume = if o.resume { binding.session_id.clone() } else { None };
        self.claims.release_terminal(terminal_id);
        let r = self.launch(
            app,
            core,
            actor,
            terminals,
            project_root,
            AgentLaunchOptions {
                provider_id: binding.provider_id.clone(),
                cwd: Some(cwd),
                model: o.model.or(binding.model.clone()),
                approval_mode: Some(o.approval_mode.unwrap_or(binding.approval_mode)),
                effort: o.effort.or(binding.effort.clone()),
                resume_session_id: resume,
                role: binding.role,
                role_label: binding.role_label.clone(),
                mission_id: binding.mission_id.clone(),
                member_id: binding.member_id.clone(),
                terminal_id: Some(terminal_id.to_string()),
                placement: Some(quadflow_core::agents::AgentLaunchPlacement::Terminal),
                sync_enabled: Some(binding.sync_enabled),
                ..Default::default()
            },
        )?;
        let mut b = r.binding;
        b.issue_id = binding.issue_id;
        Ok(b)
    }
}

/// Wait for `ready` on the PTY output, else `timeout`; without a pattern, `fallback`.
fn wait_ready(rx: Option<std::sync::mpsc::Receiver<String>>, ready: Option<regex::Regex>, timeout: Duration, fallback: Duration) {
    let (Some(rx), Some(re)) = (rx, ready) else {
        std::thread::sleep(fallback);
        return;
    };
    let start = Instant::now();
    let mut buf = String::new();
    while start.elapsed() < timeout {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(s) => {
                buf.push_str(&s);
                if buf.len() > 64 * 1024 {
                    buf.drain(..buf.len() - 32 * 1024);
                }
                if re.is_match(&buf) {
                    return;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(_) => return,
        }
    }
}

/// Wait until the PTY has been quiet for `idle` (at most `max`).
fn wait_idle(rx: Option<std::sync::mpsc::Receiver<String>>, idle: Duration, max: Duration) {
    let Some(rx) = rx else {
        std::thread::sleep(idle);
        return;
    };
    let start = Instant::now();
    let mut last = Instant::now();
    while start.elapsed() < max && last.elapsed() < idle {
        if rx.recv_timeout(Duration::from_millis(100)).is_ok() {
            last = Instant::now();
        }
    }
}
