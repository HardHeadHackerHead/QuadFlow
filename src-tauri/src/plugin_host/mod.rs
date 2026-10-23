//! The Tauri side of the plugin host (plugin-system.md §7.1, §13): managed
//! state for the one dispatch table (`quadflow_core::plugins::host`), the
//! cached plugin registry the permission checks read, live subscriptions, and
//! the [`HostExtension`] with the methods that need the app handle —
//! terminals, agents (hook point for AP-1), notifications, clipboard, native
//! windows/webviews, file dialogs and URL opening.

mod agents;
mod native;
pub mod dev;
pub mod sidecars;
mod terminals;

pub use agents::{set_agents_backend, AgentsBackend};
pub use native::ensure_webview_clip_siblings;

use crate::core_state::CoreState;
use parking_lot::{Mutex, RwLock};
use quadflow_core::domains::app::secrets::Secrets;
use quadflow_core::plugins::host::{self, HostCall, HostEnv, HostExtension, MethodSpec, PermReq, Sink, SubscriptionGuard, TopicSpec};
use quadflow_core::plugins::PluginRegistry;
use quadflow_core::CoreError;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter, Manager, Runtime, Wry};

/// Event the main window listens to for `notifications.system` (shown with
/// the Web Notification API, or as a toast when that is not permitted).
pub const NOTIFICATION_EVENT: &str = "plugin-host:notification";

#[derive(Default)]
pub struct PluginHostState {
    env: OnceLock<Arc<HostEnv>>,
    registry: RwLock<Option<Arc<PluginRegistry>>>,
    subs: Mutex<HashMap<u32, SubscriptionGuard>>,
    next_sub: AtomicU32,
    pub(crate) terminals: Arc<terminals::PluginTerminals>,
    pub(crate) webviews: Arc<native::PluginWebviews>,
    pub(crate) agents: Arc<agents::AgentsSlot>,
    /// Plugin sidecars (PL-7), created on first use.
    pub(crate) sidecars: OnceLock<quadflow_core::plugins::sidecar::SidecarSupervisor>,
}

impl PluginHostState {
    /// The dispatch environment (built on first use).
    pub fn env(&self, app: &AppHandle<Wry>) -> Result<Arc<HostEnv>, CoreError> {
        if let Some(e) = self.env.get() {
            return Ok(Arc::clone(e));
        }
        let core = app.try_state::<CoreState>().ok_or_else(|| CoreError::internal("core state missing"))?;
        let secrets = Secrets::from_env(core.core.profile(), |k| std::env::var(k).ok())?;
        agents::install_default(app, &self.agents);
        let ext = AppExtension {
            app: app.clone(),
            terminals: Arc::clone(&self.terminals),
            webviews: Arc::clone(&self.webviews),
            agents: Arc::clone(&self.agents),
        };
        let env = Arc::new(HostEnv::new(Arc::clone(&core.core), secrets, vec![Arc::new(ext)]));
        let _ = self.env.set(env);
        Ok(Arc::clone(self.env.get().expect("just set")))
    }

    /// The cached registry snapshot (reloaded after `invalidate`).
    pub fn registry(&self, core: &quadflow_core::Core) -> Result<Arc<PluginRegistry>, CoreError> {
        if let Some(r) = self.registry.read().clone() {
            return Ok(r);
        }
        let reg = Arc::new(PluginRegistry::load(&core.paths, &*core.app_db()?)?);
        *self.registry.write() = Some(Arc::clone(&reg));
        Ok(reg)
    }

    pub fn invalidate(&self) {
        *self.registry.write() = None;
    }

    pub fn add_subscription(&self, guard: SubscriptionGuard) -> u32 {
        let id = self.next_sub.fetch_add(1, Ordering::SeqCst) + 1;
        self.subs.lock().insert(id, guard);
        id
    }

    /// Drop a subscription (outside the subscription map lock).
    pub fn remove_subscription(&self, id: u32) {
        let guard = self.subs.lock().remove(&id);
        drop(guard);
    }

    /// Drop every subscription (the shell reloaded).
    pub fn clear_subscriptions(&self) {
        let all: Vec<SubscriptionGuard> = self.subs.lock().drain().map(|(_, g)| g).collect();
        drop(all);
    }
}

/// Registry changed: refresh the permission snapshot.
pub fn invalidate<R: Runtime>(app: &AppHandle<R>) {
    if let Some(s) = app.try_state::<PluginHostState>() {
        s.invalidate();
    }
}

pub fn register<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    // Clean exit: stop sidecars gracefully (shutdown → exit → kill). A crash or
    // forced kill is covered by the Job Object / process group they run in.
    let sidecar_exit = tauri::plugin::Builder::<R>::new("qf-plugin-sidecars")
        .on_event(|app, ev| {
            if let tauri::RunEvent::Exit = ev {
                sidecars::stop_all(app);
            }
        })
        .build();
    builder.manage(PluginHostState::default()).plugin(sidecar_exit)
}

/// Run a method for `plugin_id` (blocking; call from a blocking thread).
pub fn invoke(app: &AppHandle<Wry>, plugin_id: &str, method: &str, params: Value) -> Result<Value, CoreError> {
    let state = app.state::<PluginHostState>();
    let env = state.env(app)?;
    let reg = state.registry(&env.core)?;
    let plugin = reg.require(plugin_id)?;
    host::dispatch(&env, HostCall { plugin, method, params })
}

/// Start a stream for `plugin_id`; returns the subscription id.
pub fn subscribe(app: &AppHandle<Wry>, plugin_id: &str, topic: &str, params: Value, sink: Sink) -> Result<u32, CoreError> {
    let state = app.state::<PluginHostState>();
    let env = state.env(app)?;
    let reg = state.registry(&env.core)?;
    let plugin = reg.require(plugin_id)?;
    let guard = host::subscribe(&env, HostCall { plugin, method: topic, params }, sink)?;
    Ok(state.add_subscription(guard))
}

/// Any JSON value over IPC (exports as `JsonValue`; see `quadflow_core::model::JsonValue`).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(transparent)]
#[specta(transparent)]
pub struct PluginHostJson(#[specta(type = quadflow_core::model::JsonValue)] pub Value);

/// A [`Sink`] that forwards into a Tauri channel and drops its subscription
/// once the channel is gone (webview reloaded / closed).
pub struct ChannelSink {
    pub sink: Sink,
    id: Arc<AtomicU32>,
}

impl ChannelSink {
    /// Tell the sink its subscription id (known only after subscribing).
    pub fn bind(&self, id: u32) {
        self.id.store(id, Ordering::SeqCst);
    }
}

pub fn channel_sink(app: &AppHandle<Wry>, channel: tauri::ipc::Channel<PluginHostJson>) -> ChannelSink {
    let id = Arc::new(AtomicU32::new(0));
    let dead = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (app, sid) = (app.clone(), Arc::clone(&id));
    let sink: Sink = Arc::new(move |v: Value| {
        if dead.load(Ordering::SeqCst) {
            return;
        }
        if channel.send(PluginHostJson(v)).is_err() {
            dead.store(true, Ordering::SeqCst);
            let n = sid.load(Ordering::SeqCst);
            if n != 0 {
                // Not inline: the sink may run inside the source's own lock.
                let app = app.clone();
                std::thread::spawn(move || app.state::<PluginHostState>().remove_subscription(n));
            }
        }
    });
    ChannelSink { sink, id }
}

pub(crate) struct AppExtension {
    pub app: AppHandle<Wry>,
    pub terminals: Arc<terminals::PluginTerminals>,
    pub webviews: Arc<native::PluginWebviews>,
    pub agents: Arc<agents::AgentsSlot>,
}

impl HostExtension for AppExtension {
    fn methods(&self) -> Vec<MethodSpec> {
        let mut v = Vec::new();
        v.extend(terminals::methods(self));
        v.extend(agents::methods(self));
        v.extend(native::methods(self));
        v.extend(misc_methods(self));
        v
    }

    fn topics(&self) -> Vec<TopicSpec> {
        let mut v = terminals::topics(self);
        v.extend(agents::topics(self));
        v
    }

    fn unavailable(&self) -> Vec<&'static str> {
        let mut v = Vec::new();
        if !self.agents.present() {
            v.extend(agents::METHODS);
        }
        if !cfg!(any(windows, target_os = "macos")) {
            v.push("native.mainWindowHandle");
        }
        if !cfg!(windows) {
            v.push("native.allowSetForeground");
        }
        v
    }
}

fn url_allowed(url: &str) -> Result<(), CoreError> {
    let lower = url.trim().to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:") {
        Ok(())
    } else {
        Err(CoreError::invalid_input(format!("shell.openExternal: only http(s) and mailto URLs are allowed, got {url:?}")))
    }
}

fn misc_methods(ext: &AppExtension) -> Vec<MethodSpec> {
    let mut v = Vec::new();

    let app = ext.app.clone();
    v.push(MethodSpec::new("shell.openExternal", PermReq::One("shell:open-external"), move |_env: &HostEnv, c: &HostCall| {
        use tauri_plugin_opener::OpenerExt;
        let url: String = c.arg("url")?;
        url_allowed(&url)?;
        app.opener().open_url(url, None::<&str>).map_err(|e| CoreError::external(format!("open url: {e}")))?;
        Ok(Value::Null)
    }));

    // Reveal: the path is resolved and permission-checked by `fs.resolve`
    // (same scope rules as `fs.*` reads).
    let app = ext.app.clone();
    v.push(MethodSpec::new("shell.revealInFileManager", PermReq::None, move |env: &HostEnv, c: &HostCall| {
        use tauri_plugin_opener::OpenerExt;
        let resolved = host::dispatch(env, HostCall { plugin: c.plugin, method: "fs.resolve", params: c.params.clone() })?;
        let path = resolved.as_str().unwrap_or_default().to_string();
        app.opener().reveal_item_in_dir(&path).map_err(|e| CoreError::external(format!("reveal {path}: {e}")))?;
        Ok(Value::Null)
    }));

    let app = ext.app.clone();
    v.push(MethodSpec::new("notifications.system", PermReq::One("notifications"), move |_env: &HostEnv, c: &HostCall| {
        let title: String = c.arg("title")?;
        let body: Option<String> = c.opt("body")?;
        if title.trim().is_empty() || title.len() > 200 || body.as_ref().is_some_and(|b| b.len() > 2000) {
            return Err(CoreError::invalid_input("notifications.system: title 1–200 chars, body ≤ 2000"));
        }
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.request_user_attention(Some(tauri::UserAttentionType::Informational));
        }
        app.emit_to("main", NOTIFICATION_EVENT, json!({ "pluginId": c.plugin.id, "title": title, "body": body }))
            .map_err(|e| CoreError::internal(format!("emit notification: {e}")))?;
        Ok(Value::Null)
    }));

    v.push(MethodSpec::new("clipboard.readText", PermReq::One("clipboard:read"), |_env: &HostEnv, _c: &HostCall| {
        let mut cb = clipboard()?;
        Ok(Value::String(cb.get_text().unwrap_or_default()))
    }));
    v.push(MethodSpec::new("clipboard.writeText", PermReq::One("clipboard:write"), |_env: &HostEnv, c: &HostCall| {
        clipboard()?.set_text(c.arg::<String>("text")?).map_err(|e| CoreError::external(format!("clipboard: {e}")))?;
        Ok(Value::Null)
    }));
    v.push(MethodSpec::new("clipboard.writeImage", PermReq::One("clipboard:write"), |_env: &HostEnv, c: &HostCall| {
        use base64::Engine;
        let png = base64::engine::general_purpose::STANDARD
            .decode(c.arg::<String>("pngBase64")?)
            .map_err(|e| CoreError::invalid_input(format!("clipboard.writeImage: pngBase64: {e}")))?;
        let img = xcap::image::load_from_memory_with_format(&png, xcap::image::ImageFormat::Png)
            .map_err(|e| CoreError::invalid_input(format!("clipboard.writeImage: not a PNG: {e}")))?
            .to_rgba8();
        let (w, h) = img.dimensions();
        clipboard()?
            .set_image(arboard::ImageData { width: w as usize, height: h as usize, bytes: img.into_raw().into() })
            .map_err(|e| CoreError::external(format!("clipboard: {e}")))?;
        Ok(Value::Null)
    }));

    // ui.pickFile: a native dialog; picked paths join the plugin's fs
    // `absolute` allowlist for this session (§6.7), no extra permission.
    let app = ext.app.clone();
    v.push(MethodSpec::new("ui.pickFile", PermReq::None, move |env: &HostEnv, c: &HostCall| {
        use tauri_plugin_dialog::DialogExt;
        let directory: bool = c.arg_or_default("directory")?;
        let multiple: bool = c.arg_or_default("multiple")?;
        let filters: Vec<PickFilter> = c.arg_or_default("filters")?;
        let mut dlg = app.dialog().file();
        for f in &filters {
            let exts: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
            dlg = dlg.add_filter(&f.name, &exts);
        }
        let picked: Option<Vec<tauri_plugin_dialog::FilePath>> = match (directory, multiple) {
            (true, true) => dlg.blocking_pick_folders(),
            (true, false) => dlg.blocking_pick_folder().map(|p| vec![p]),
            (false, true) => dlg.blocking_pick_files(),
            (false, false) => dlg.blocking_pick_file().map(|p| vec![p]),
        };
        let Some(picked) = picked else { return Ok(Value::Null) };
        let mut out = Vec::new();
        for p in picked {
            if let Ok(path) = p.into_path() {
                env.session.allow_path(&c.plugin.id, &path);
                out.push(path.display().to_string());
            }
        }
        Ok(json!(out))
    }));

    v
}

#[derive(serde::Deserialize, Default)]
struct PickFilter {
    name: String,
    #[serde(default)]
    extensions: Vec<String>,
}

fn clipboard() -> Result<arboard::Clipboard, CoreError> {
    arboard::Clipboard::new().map_err(|e| CoreError::unsupported(format!("clipboard unavailable: {e}")))
}
