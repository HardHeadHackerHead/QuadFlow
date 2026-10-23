//! Plugin sidecars (plugin-system.md §10): one supervised child process per
//! plugin, speaking NDJSON JSON-RPC 2.0 over stdio.
//!
//! [`SidecarSupervisor`] owns the processes. The embedding app supplies a
//! [`SidecarHost`]: how to launch a plugin's sidecar ([`resolve`] does the
//! manifest → [`SidecarConfig`] part), how to run `host/call` (the app passes
//! it to the **same** permission-checked dispatch table as UI calls,
//! `plugins::host::dispatch`), and where notifications for the UI go.
//!
//! Lifecycle (§10.2): `Stopped → Starting → Running`; `initialize` handshake
//! (10 s) then `initialized`; requests issued while starting wait. A crash
//! (exit while not stopping, protocol error, failed handshake) fails pending
//! requests with `external`, then — with `restart: onCrash` — restarts after
//! a backoff of 1 s, 2 s, 4 s, 8 s, 16 s, 30 s, 60 s; the 5th crash within 5
//! minutes moves the sidecar to `Failed` (only [`SidecarSupervisor::restart`]
//! leaves it). A run of 10 minutes resets the crash count. Stop (disable,
//! uninstall, update, app exit): `shutdown` (3 s) → `exit` → 2 s → kill the
//! process tree.

pub mod process;
pub mod resolve;
pub mod rpc;

pub use process::{ProcessTree, SidecarLaunch};
pub use resolve::{has_sidecar, resolve, ResolveContext};

use crate::error::{CoreError, Result};
use crate::plugins::manifest::SidecarRestart;
use parking_lot::{Condvar, Mutex};
use rpc::{Line, Message, RpcErrorObj, RpcId};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::{BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

/// Protocol version sent in `initialize`.
pub const PROTOCOL_VERSION: u32 = 1;
/// stderr lines kept in memory per plugin (Plugins settings page).
pub const LOG_TAIL_LINES: usize = 200;
/// Log rotation: size of one file, number of rotated files kept.
pub const LOG_ROTATE_BYTES: u64 = 5 * 1024 * 1024;
pub const LOG_ROTATE_KEEP: u32 = 3;

/// Public state of one plugin's sidecar (`ctx.sidecar.status()`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum PluginSidecarState {
    Stopped,
    Starting,
    Running,
    Restarting,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginSidecarStatus {
    pub plugin_id: String,
    pub state: PluginSidecarState,
    /// Automatic restarts since the sidecar was last started by hand (or the app started).
    pub restarts: u32,
    /// Crashes inside the current 5-minute window.
    pub recent_crashes: u32,
    /// Why it last crashed / failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// OS process id while a process exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
}

/// How to launch one plugin's sidecar.
#[derive(Clone, Debug)]
pub struct SidecarConfig {
    pub launch: SidecarLaunch,
    pub restart: SidecarRestart,
    /// `initialize` params (§10.3).
    pub initialize: Value,
}

/// What the supervisor needs from the embedding app.
pub trait SidecarHost: Send + Sync + 'static {
    /// Launch config for `plugin_id` (fresh on every (re)start, so updates and
    /// setting changes apply). `Err` → the sidecar is `Failed` with that reason.
    fn config(&self, plugin_id: &str) -> Result<SidecarConfig>;
    /// `host/call { method, params }` — must go through `plugins::host::dispatch`
    /// with the plugin's granted permissions.
    fn host_call(&self, plugin_id: &str, method: &str, params: Value) -> Result<Value>;
    /// Sidecar → host notifications other than `host/log` (`host/emit`, `ui/*`, `cli/output`, …).
    fn notification(&self, _plugin_id: &str, _method: &str, _params: Value) {}
    /// A sidecar's status changed.
    fn state_changed(&self, _status: &PluginSidecarStatus) {}
}

/// Timing knobs (tests shrink them).
#[derive(Clone, Debug)]
pub struct SupervisorOptions {
    pub backoff: Vec<Duration>,
    pub crash_window: Duration,
    /// The crash that brings the count inside `crash_window` to this number → `Failed`.
    pub max_crashes: usize,
    /// A run at least this long resets the crash count.
    pub stable_run: Duration,
    pub init_timeout: Duration,
    pub request_timeout: Duration,
    pub shutdown_timeout: Duration,
    pub exit_grace: Duration,
    /// `<logs>/plugins/<id>.log`; `None` = memory only.
    pub logs_dir: Option<PathBuf>,
}

impl Default for SupervisorOptions {
    fn default() -> Self {
        let s = Duration::from_secs;
        Self {
            backoff: vec![s(1), s(2), s(4), s(8), s(16), s(30), s(60)],
            crash_window: s(5 * 60),
            max_crashes: 5,
            stable_run: s(10 * 60),
            init_timeout: s(10),
            request_timeout: s(30),
            shutdown_timeout: s(3),
            exit_grace: s(2),
            logs_dir: None,
        }
    }
}

/// Methods a plugin UI may not send to its sidecar directly (§10.3).
pub fn check_ui_method(method: &str) -> Result<()> {
    let reserved = ["$/", "host/", "cli/", "ui/", "agentProvider/"];
    if method.is_empty()
        || method.len() > 256
        || reserved.iter().any(|p| method.starts_with(p))
        || matches!(method, "initialize" | "initialized" | "shutdown" | "exit")
    {
        return Err(CoreError::invalid_input(format!("sidecar method {method:?} is reserved or invalid")));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Connection to one running process
// ---------------------------------------------------------------------------

type Reply = mpsc::Sender<Result<Value>>;

struct Conn {
    stdin: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<i64, Reply>>,
    next_id: AtomicI64,
    tree: ProcessTree,
    child: Mutex<Child>,
}

impl Conn {
    fn send(&self, m: &Message) -> Result<()> {
        let mut g = self.stdin.lock();
        let w = g.as_mut().ok_or_else(|| CoreError::external("sidecar stdin is closed"))?;
        rpc::write_message(w, m).map_err(|e| CoreError::external(format!("write to sidecar: {e}")))
    }

    fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.send(&Message::Notification { method: method.into(), params })
    }

    fn call(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().insert(id, tx);
        if let Err(e) = self.send(&Message::Request { id: RpcId::Num(id), method: method.into(), params }) {
            self.pending.lock().remove(&id);
            return Err(e);
        }
        match rx.recv_timeout(timeout) {
            Ok(r) => r,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.pending.lock().remove(&id);
                let _ = self.notify("$/cancelRequest", json!({ "id": id }));
                Err(CoreError::external(format!("sidecar request {method} timed out after {} ms", timeout.as_millis())))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(CoreError::external("sidecar exited")),
        }
    }

    fn complete(&self, id: &RpcId, result: std::result::Result<Value, RpcErrorObj>) {
        let RpcId::Num(n) = id else { return };
        if let Some(tx) = self.pending.lock().remove(n) {
            let _ = tx.send(result.map_err(|e| e.to_core()));
        }
    }

    fn fail_all(&self, reason: &str) {
        let all: Vec<Reply> = self.pending.lock().drain().map(|(_, tx)| tx).collect();
        for tx in all {
            let _ = tx.send(Err(CoreError::external(format!("sidecar exited: {reason}"))));
        }
    }
}

// ---------------------------------------------------------------------------
// Per-plugin slot
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
enum Phase {
    Stopped,
    Starting,
    Running,
    Restarting { attempt: u32 },
    Stopping,
    Failed { reason: String },
}

struct SlotState {
    phase: Phase,
    /// Bumped on every start / stop; stale threads compare and bail out.
    generation: u64,
    conn: Option<Arc<Conn>>,
    restart: SidecarRestart,
    restarts: u32,
    crashes: VecDeque<Instant>,
    last_error: Option<String>,
    started: Option<Instant>,
}

struct Slot {
    id: String,
    st: Mutex<SlotState>,
    cv: Condvar,
    log: Mutex<PluginLog>,
}

struct PluginLog {
    tail: VecDeque<String>,
    file: Option<PathBuf>,
}

impl PluginLog {
    fn push(&mut self, line: String) {
        if self.tail.len() >= LOG_TAIL_LINES {
            self.tail.pop_front();
        }
        if let Some(path) = &self.file {
            append_rotating(path, &line);
        }
        self.tail.push_back(line);
    }
}

fn append_rotating(path: &PathBuf, line: &str) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::metadata(path).map(|m| m.len() >= LOG_ROTATE_BYTES).unwrap_or(false) {
        let name = |i: u32| PathBuf::from(format!("{}.{i}", path.display()));
        let _ = std::fs::remove_file(name(LOG_ROTATE_KEEP));
        for i in (1..LOG_ROTATE_KEEP).rev() {
            let _ = std::fs::rename(name(i), name(i + 1));
        }
        let _ = std::fs::rename(path, name(1));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

struct Inner {
    opts: SupervisorOptions,
    host: Arc<dyn SidecarHost>,
    slots: Mutex<BTreeMap<String, Arc<Slot>>>,
}

#[derive(Clone)]
pub struct SidecarSupervisor {
    inner: Arc<Inner>,
}

impl SidecarSupervisor {
    pub fn new(host: Arc<dyn SidecarHost>, opts: SupervisorOptions) -> Self {
        Self { inner: Arc::new(Inner { opts, host, slots: Mutex::new(BTreeMap::new()) }) }
    }

    fn slot(&self, plugin: &str) -> Arc<Slot> {
        let mut slots = self.inner.slots.lock();
        Arc::clone(slots.entry(plugin.to_string()).or_insert_with(|| {
            Arc::new(Slot {
                id: plugin.to_string(),
                st: Mutex::new(SlotState {
                    phase: Phase::Stopped,
                    generation: 0,
                    conn: None,
                    restart: SidecarRestart::OnCrash,
                    restarts: 0,
                    crashes: VecDeque::new(),
                    last_error: None,
                    started: None,
                }),
                cv: Condvar::new(),
                log: Mutex::new(PluginLog {
                    tail: VecDeque::new(),
                    file: self.inner.opts.logs_dir.as_ref().map(|d| d.join("plugins").join(format!("{plugin}.log"))),
                }),
            })
        }))
    }

    fn existing(&self, plugin: &str) -> Option<Arc<Slot>> {
        self.inner.slots.lock().get(plugin).cloned()
    }

    /// Send a request (starting the sidecar on demand) and wait for its result.
    pub fn request(&self, plugin: &str, method: &str, params: Value, timeout: Option<Duration>) -> Result<Value> {
        let timeout = timeout.unwrap_or(self.inner.opts.request_timeout);
        let conn = self.inner.ensure_running(&self.slot(plugin), timeout)?;
        conn.call(method, params, timeout)
    }

    /// Send a notification (starting the sidecar on demand).
    pub fn notify(&self, plugin: &str, method: &str, params: Value) -> Result<()> {
        let conn = self.inner.ensure_running(&self.slot(plugin), self.inner.opts.request_timeout)?;
        conn.notify(method, params)
    }

    /// Notify a sidecar only if it is running (never starts one).
    pub fn notify_if_running(&self, plugin: &str, method: &str, params: Value) {
        if let Some(slot) = self.existing(plugin) {
            let conn = {
                let st = slot.st.lock();
                st.conn.clone().filter(|_| st.phase == Phase::Running)
            };
            if let Some(c) = conn {
                let _ = c.notify(method, params);
            }
        }
    }

    /// Notify every running sidecar.
    pub fn broadcast(&self, method: &str, params: Value) {
        let ids: Vec<String> = self.inner.slots.lock().keys().cloned().collect();
        for id in ids {
            self.notify_if_running(&id, method, params.clone());
        }
    }

    /// Start in the background if stopped (activation `onStartup`). Does not wait.
    pub fn ensure_started(&self, plugin: &str) {
        let slot = self.slot(plugin);
        let mut st = slot.st.lock();
        if st.phase == Phase::Stopped {
            self.inner.begin_start(&slot, &mut st);
        }
    }

    pub fn status(&self, plugin: &str) -> PluginSidecarStatus {
        match self.existing(plugin) {
            Some(slot) => self.inner.status_of(&slot),
            None => PluginSidecarStatus {
                plugin_id: plugin.to_string(),
                state: PluginSidecarState::Stopped,
                restarts: 0,
                recent_crashes: 0,
                last_error: None,
                pid: None,
            },
        }
    }

    /// Statuses of every sidecar this supervisor has seen.
    pub fn statuses(&self) -> Vec<PluginSidecarStatus> {
        let slots: Vec<Arc<Slot>> = self.inner.slots.lock().values().cloned().collect();
        slots.iter().map(|s| self.inner.status_of(s)).collect()
    }

    /// The last [`LOG_TAIL_LINES`] stderr / `host/log` lines.
    pub fn logs(&self, plugin: &str) -> Vec<String> {
        self.existing(plugin).map(|s| s.log.lock().tail.iter().cloned().collect()).unwrap_or_default()
    }

    /// Graceful stop; returns once the process is gone. Clears `Failed` and the crash count.
    pub fn stop(&self, plugin: &str) {
        if let Some(slot) = self.existing(plugin) {
            self.inner.stop_slot(&slot);
        }
    }

    /// Stop every sidecar (app exit), in parallel.
    pub fn stop_all(&self) {
        let slots: Vec<Arc<Slot>> = self.inner.slots.lock().values().cloned().collect();
        let threads: Vec<_> = slots
            .into_iter()
            .map(|s| {
                let inner = Arc::clone(&self.inner);
                std::thread::spawn(move || inner.stop_slot(&s))
            })
            .collect();
        for t in threads {
            let _ = t.join();
        }
    }

    /// Stop (if needed) and start again — also leaves `Failed`. Does not wait for `Running`.
    pub fn restart(&self, plugin: &str) {
        let slot = self.slot(plugin);
        self.inner.stop_slot(&slot);
        let mut st = slot.st.lock();
        st.restarts = 0;
        if st.phase == Phase::Stopped {
            self.inner.begin_start(&slot, &mut st);
        }
    }
}

impl Inner {
    fn status_of(&self, slot: &Slot) -> PluginSidecarStatus {
        let st = slot.st.lock();
        let (state, failed) = match &st.phase {
            Phase::Stopped | Phase::Stopping => (PluginSidecarState::Stopped, None),
            Phase::Starting => (PluginSidecarState::Starting, None),
            Phase::Running => (PluginSidecarState::Running, None),
            Phase::Restarting { .. } => (PluginSidecarState::Restarting, None),
            Phase::Failed { reason } => (PluginSidecarState::Failed, Some(reason.clone())),
        };
        PluginSidecarStatus {
            plugin_id: slot.id.clone(),
            state,
            restarts: st.restarts,
            recent_crashes: st.crashes.len() as u32,
            last_error: failed.or_else(|| st.last_error.clone()),
            pid: st.conn.as_ref().map(|c| c.tree.pid()),
        }
    }

    fn changed(&self, slot: &Slot) {
        slot.cv.notify_all();
        let s = self.status_of(slot);
        self.host.state_changed(&s);
    }

    fn log(&self, slot: &Slot, kind: &str, line: &str) {
        let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        slot.log.lock().push(format!("{ts} [{kind}] {line}"));
    }

    /// Wait (up to `timeout`) for a running connection, starting the sidecar if stopped.
    fn ensure_running(self: &Arc<Self>, slot: &Arc<Slot>, timeout: Duration) -> Result<Arc<Conn>> {
        let deadline = Instant::now() + timeout;
        let mut st = slot.st.lock();
        loop {
            match &st.phase {
                Phase::Running => {
                    if let Some(c) = &st.conn {
                        return Ok(Arc::clone(c));
                    }
                }
                Phase::Stopped => {
                    self.begin_start(slot, &mut st);
                    continue;
                }
                Phase::Failed { reason } => {
                    return Err(CoreError::external(format!("sidecar of {:?} failed: {reason}", slot.id)))
                }
                _ => {}
            }
            if slot.cv.wait_until(&mut st, deadline).timed_out() {
                return Err(CoreError::external(format!(
                    "sidecar of {:?} did not become ready within {} ms",
                    slot.id,
                    timeout.as_millis()
                )));
            }
        }
    }

    /// Stopped/Restarting → Starting; the process is spawned on a new thread.
    fn begin_start(self: &Arc<Self>, slot: &Arc<Slot>, st: &mut SlotState) {
        st.generation += 1;
        st.phase = Phase::Starting;
        let generation = st.generation;
        let (inner, slot2) = (Arc::clone(self), Arc::clone(slot));
        std::thread::spawn(move || inner.start(&slot2, generation));
        // Status event outside the caller's lock.
        let (inner, slot2) = (Arc::clone(self), Arc::clone(slot));
        std::thread::spawn(move || inner.changed(&slot2));
    }

    fn is_current(&self, slot: &Slot, generation: u64) -> bool {
        let st = slot.st.lock();
        st.generation == generation && st.phase == Phase::Starting
    }

    fn start(self: &Arc<Self>, slot: &Arc<Slot>, generation: u64) {
        let cfg = match self.host.config(&slot.id) {
            Ok(c) => c,
            Err(e) => {
                let mut st = slot.st.lock();
                if st.generation == generation && st.phase == Phase::Starting {
                    st.phase = Phase::Failed { reason: e.message.clone() };
                    st.last_error = Some(e.message.clone());
                    drop(st);
                    self.log(slot, "host", &format!("cannot start: {}", e.message));
                    self.changed(slot);
                }
                return;
            }
        };
        slot.st.lock().restart = cfg.restart;
        let (mut child, tree) = match process::spawn(&cfg.launch) {
            Ok(x) => x,
            Err(e) => {
                let reason = format!("spawn {}: {e}", cfg.launch.program.display());
                self.log(slot, "host", &reason);
                self.crashed(slot, generation, reason);
                return;
            }
        };
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let conn = Arc::new(Conn {
            stdin: Mutex::new(child.stdin.take()),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicI64::new(1),
            tree,
            child: Mutex::new(child),
        });
        {
            let mut st = slot.st.lock();
            if st.generation != generation || st.phase != Phase::Starting {
                drop(st);
                conn.tree.kill();
                let _ = conn.child.lock().wait();
                return;
            }
            st.conn = Some(Arc::clone(&conn));
            st.started = Some(Instant::now());
        }
        self.log(slot, "host", &format!("started pid {}", conn.tree.pid()));
        if let Some(err) = stderr {
            let (inner, slot2) = (Arc::clone(self), Arc::clone(slot));
            std::thread::spawn(move || {
                let mut r = BufReader::new(err);
                while let Ok(Line::Text(l)) = rpc::read_line(&mut r, 64 * 1024) {
                    inner.log(&slot2, "stderr", &l);
                }
            });
        }
        if let Some(out) = stdout {
            let (inner, slot2, conn2) = (Arc::clone(self), Arc::clone(slot), Arc::clone(&conn));
            std::thread::spawn(move || inner.read_loop(&slot2, generation, &conn2, out));
        }

        // Handshake.
        match conn.call("initialize", cfg.initialize, self.opts.init_timeout) {
            Ok(_) => {
                let _ = conn.notify("initialized", json!({}));
                let mut st = slot.st.lock();
                if st.generation == generation && st.phase == Phase::Starting {
                    st.phase = Phase::Running;
                    drop(st);
                    self.changed(slot);
                }
            }
            Err(e) => {
                if self.is_current(slot, generation) {
                    let reason = format!("initialize failed: {}", e.message);
                    self.log(slot, "host", &reason);
                    slot.st.lock().last_error = Some(reason);
                }
                // The read loop sees the exit and treats it as a crash.
                conn.tree.kill();
            }
        }
    }

    fn read_loop(self: &Arc<Self>, slot: &Arc<Slot>, generation: u64, conn: &Arc<Conn>, out: std::process::ChildStdout) {
        let mut r = BufReader::new(out);
        let reason = loop {
            match rpc::read_line(&mut r, rpc::MAX_LINE_BYTES) {
                Ok(Line::Text(l)) if l.trim().is_empty() => continue,
                Ok(Line::Text(l)) => match Message::parse(&l) {
                    Ok(m) => self.handle(slot, conn, m),
                    Err(e) => break format!("protocol error: {e}"),
                },
                Ok(Line::TooLong) => break format!("protocol error: line longer than {} bytes", rpc::MAX_LINE_BYTES),
                Ok(Line::Eof) => break "sidecar exited".to_string(),
                Err(e) => break format!("read from sidecar: {e}"),
            }
        };
        // Whatever the reason, the process must be gone before the next start.
        conn.tree.kill();
        *conn.stdin.lock() = None;
        let status = conn.child.lock().wait();
        let reason = match status {
            Ok(s) if reason == "sidecar exited" => format!("sidecar exited ({s})"),
            _ => reason,
        };
        conn.fail_all(&reason);
        self.exited(slot, generation, reason);
    }

    fn handle(self: &Arc<Self>, slot: &Arc<Slot>, conn: &Arc<Conn>, m: Message) {
        match m {
            Message::Response { id, result } => conn.complete(&id, result),
            Message::Request { id, method, params } => {
                let (inner, plugin, conn) = (Arc::clone(self), slot.id.clone(), Arc::clone(conn));
                std::thread::spawn(move || {
                    let result = if method == "host/call" {
                        let target = params.get("method").and_then(Value::as_str).map(str::to_string);
                        match target {
                            Some(t) => inner
                                .host
                                .host_call(&plugin, &t, params.get("params").cloned().unwrap_or(Value::Null))
                                .map_err(|e| RpcErrorObj::from_core(&e)),
                            None => Err(RpcErrorObj {
                                code: rpc::INVALID_REQUEST,
                                message: "host/call needs params.method".into(),
                                data: Some(json!({ "code": "invalid_input" })),
                            }),
                        }
                    } else {
                        Err(RpcErrorObj {
                            code: rpc::METHOD_NOT_FOUND,
                            message: format!("unknown host method {method:?}"),
                            data: Some(json!({ "code": "invalid_input" })),
                        })
                    };
                    let _ = conn.send(&Message::Response { id, result });
                });
            }
            Message::Notification { method, params } => {
                if method == "host/log" {
                    let level = params.get("level").and_then(Value::as_str).unwrap_or("info").to_string();
                    let msg = params.get("message").map(|m| m.as_str().map(str::to_string).unwrap_or(m.to_string()));
                    let msg = msg.unwrap_or_default();
                    log::info!(target: "plugin", "[sidecar:{}] {level}: {msg}", slot.id);
                    self.log(slot, &level, &msg);
                } else {
                    self.host.notification(&slot.id, &method, params);
                }
            }
        }
    }

    /// The process of `generation` is gone.
    fn exited(self: &Arc<Self>, slot: &Arc<Slot>, generation: u64, reason: String) {
        let mut st = slot.st.lock();
        if st.generation != generation {
            return;
        }
        st.conn = None;
        match st.phase {
            Phase::Stopping => {
                st.phase = Phase::Stopped;
                drop(st);
                self.log(slot, "host", "stopped");
                self.changed(slot);
            }
            Phase::Running | Phase::Starting => {
                drop(st);
                self.log(slot, "host", &format!("crashed: {reason}"));
                self.crashed(slot, generation, reason);
            }
            _ => {}
        }
    }

    fn crashed(self: &Arc<Self>, slot: &Arc<Slot>, generation: u64, reason: String) {
        let mut st = slot.st.lock();
        if st.generation != generation || !matches!(st.phase, Phase::Running | Phase::Starting) {
            return;
        }
        let now = Instant::now();
        if st.started.is_some_and(|t| now.duration_since(t) >= self.opts.stable_run) {
            st.crashes.clear();
        }
        st.crashes.push_back(now);
        while st.crashes.front().is_some_and(|t| now.duration_since(*t) > self.opts.crash_window) {
            st.crashes.pop_front();
        }
        // Prefer the more specific handshake error over "exited".
        let reason = match st.last_error.take() {
            Some(e) if e.starts_with("initialize failed") => e,
            _ => reason,
        };
        st.last_error = Some(reason.clone());
        st.conn = None;
        let n = st.crashes.len();
        if st.restart == SidecarRestart::Never {
            st.phase = Phase::Failed { reason: format!("{reason} (restart: never)") };
        } else if n >= self.opts.max_crashes {
            st.phase = Phase::Failed {
                reason: format!("crashed {n} times within {} s; last: {reason}", self.opts.crash_window.as_secs()),
            };
        } else {
            let attempt = n as u32;
            st.phase = Phase::Restarting { attempt };
            st.restarts += 1;
            let delay = self.opts.backoff.get(n - 1).or(self.opts.backoff.last()).copied().unwrap_or_default();
            let (inner, slot2) = (Arc::clone(self), Arc::clone(slot));
            std::thread::spawn(move || inner.restart_after(&slot2, generation, delay));
        }
        drop(st);
        self.changed(slot);
    }

    fn restart_after(self: &Arc<Self>, slot: &Arc<Slot>, generation: u64, delay: Duration) {
        let deadline = Instant::now() + delay;
        let mut st = slot.st.lock();
        while st.generation == generation && matches!(st.phase, Phase::Restarting { .. }) {
            if slot.cv.wait_until(&mut st, deadline).timed_out() {
                break;
            }
        }
        if st.generation == generation && matches!(st.phase, Phase::Restarting { .. }) {
            self.begin_start(slot, &mut st);
        }
    }

    fn stop_slot(self: &Arc<Self>, slot: &Arc<Slot>) {
        let mut st = slot.st.lock();
        let conn = match st.phase {
            Phase::Stopped => {
                st.crashes.clear();
                return;
            }
            Phase::Running | Phase::Starting | Phase::Stopping => st.conn.clone(),
            Phase::Restarting { .. } | Phase::Failed { .. } => None,
        };
        let Some(conn) = conn else {
            st.generation += 1;
            st.phase = Phase::Stopped;
            st.crashes.clear();
            st.last_error = None;
            drop(st);
            self.changed(slot);
            return;
        };
        st.phase = Phase::Stopping;
        let generation = st.generation;
        drop(st);
        self.changed(slot);

        let _ = conn.call("shutdown", json!({}), self.opts.shutdown_timeout);
        let _ = conn.notify("exit", json!({}));
        let wait = |d: Duration| {
            let deadline = Instant::now() + d;
            let mut st = slot.st.lock();
            while st.generation == generation && st.phase == Phase::Stopping {
                if slot.cv.wait_until(&mut st, deadline).timed_out() {
                    break;
                }
            }
            st.phase != Phase::Stopping || st.generation != generation
        };
        if !wait(self.opts.exit_grace) {
            self.log(slot, "host", "did not exit after shutdown; killing");
            conn.tree.kill();
            wait(Duration::from_secs(5));
        }
        let mut st = slot.st.lock();
        if st.generation == generation {
            st.generation += 1;
            st.phase = Phase::Stopped;
            st.conn = None;
        }
        st.crashes.clear();
        st.last_error = None;
        drop(st);
        self.changed(slot);
    }
}

#[cfg(test)]
mod tests;
