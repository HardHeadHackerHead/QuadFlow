//! PTY-backed terminals.
//!
//! Threading model (per terminal):
//! - **worker thread** owns the PTY master + writer. `write_terminal` and
//!   `resize_terminal` only enqueue a message on its channel, so the Tauri
//!   command never blocks and writes/resizes keep their IPC order.
//! - **reader thread** pumps PTY output to `terminal:data:{id}` events,
//!   decoding UTF-8 across read boundaries.
//! - **waiter thread** owns the child and blocks in `wait()`; it is the single
//!   source of `terminal:exit:{id}` (ConPTY may never deliver EOF to the reader).
//!
//! Every spawn gets a process-wide unique, monotonically increasing
//! `generation`. Terminal ids are reused (workspace switches re-create a
//! terminal under the same id), so the exit event carries the generation and
//! is suppressed when a newer generation already occupies the id.
//!
//! The global `terminals` mutex is only ever held for map lookups/inserts —
//! never across blocking I/O, process spawning or killing.

use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
pub struct TerminalInfo {
    pub id: String,
    pub pid: Option<u32>,
    pub cwd: String,
    /// Spawn generation; matches the `generation` in this terminal's exit event.
    pub generation: u64,
    /// True when `create_terminal` attached to an already-running PTY.
    pub reattached: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTerminalOptions {
    pub cwd: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub id: Option<String>,
    pub shell: Option<String>, // "cmd", "powershell", "pwsh", "bash", "zsh", "sh", or an absolute shell path
    pub init_commands: Option<Vec<String>>, // Commands to run after shell initialization
    /// Extra environment variables for the shell (agent launches, agent-providers.md §8.2).
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
}

/// Payload of `terminal:exit:{id}`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitPayload {
    pub generation: u64,
    pub exit_code: Option<u32>,
}

/// Basic OS info for the frontend (xterm.js `windowsPty` needs the real build).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsInfo {
    /// `std::env::consts::OS`: "windows", "macos", "linux", ...
    pub platform: String,
    /// Windows build number (e.g. 26200); `None` elsewhere or if unknown.
    pub build_number: Option<u32>,
}

pub fn os_info() -> OsInfo {
    OsInfo {
        platform: std::env::consts::OS.to_string(),
        build_number: windows_build_number(),
    }
}

#[cfg(windows)]
fn windows_build_number() -> Option<u32> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;
    let key = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion")
        .ok()?;
    let build: String = key.get_value("CurrentBuildNumber").ok()?;
    build.trim().parse().ok()
}

#[cfg(not(windows))]
fn windows_build_number() -> Option<u32> {
    None
}

// ---------------------------------------------------------------------------
// Pure helpers (unit tested)
// ---------------------------------------------------------------------------

/// Streaming UTF-8 decoder: incomplete multibyte sequences at the end of a
/// chunk are carried into the next one instead of becoming U+FFFD.
#[derive(Default)]
pub(crate) struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    pub(crate) fn decode(&mut self, chunk: &[u8]) -> String {
        let mut buf = std::mem::take(&mut self.pending);
        buf.extend_from_slice(chunk);

        let mut out = String::with_capacity(buf.len());
        let mut rest: &[u8] = &buf;
        loop {
            match std::str::from_utf8(rest) {
                Ok(s) => {
                    out.push_str(s);
                    break;
                }
                Err(e) => {
                    let (valid, after) = rest.split_at(e.valid_up_to());
                    // SAFETY-free: `valid` was just validated.
                    out.push_str(std::str::from_utf8(valid).unwrap_or_default());
                    match e.error_len() {
                        Some(n) => {
                            // Genuinely invalid bytes: replace and keep going.
                            out.push('\u{FFFD}');
                            rest = &after[n..];
                        }
                        None => {
                            // Incomplete sequence at the end: carry it over.
                            self.pending = after.to_vec();
                            break;
                        }
                    }
                }
            }
        }
        out
    }

    /// Flush whatever is left at EOF (lossy).
    pub(crate) fn finish(&mut self) -> String {
        let pending = std::mem::take(&mut self.pending);
        String::from_utf8_lossy(&pending).into_owned()
    }
}

/// Whether the waiter of spawn `mine` should emit an exit event, given the
/// generation currently registered under the same id (`None` = removed, e.g.
/// killed). A newer generation owning the id means this exit is stale.
pub(crate) fn should_emit_exit(current: Option<u64>, mine: u64) -> bool {
    match current {
        None => true,
        Some(g) => g == mine,
    }
}

static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

fn next_generation() -> u64 {
    NEXT_GENERATION.fetch_add(1, Ordering::Relaxed)
}

// ---------------------------------------------------------------------------
// Process-tree ownership
// ---------------------------------------------------------------------------

/// Windows Job Object with KILL_ON_JOB_CLOSE: terminating (or dropping) it
/// kills the shell and every descendant (e.g. an agent CLI's node processes).
#[cfg(windows)]
struct JobHandle(windows::Win32::Foundation::HANDLE);

#[cfg(windows)]
unsafe impl Send for JobHandle {}
#[cfg(windows)]
unsafe impl Sync for JobHandle {}

#[cfg(windows)]
impl JobHandle {
    fn for_process(pid: u32) -> windows::core::Result<Self> {
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

        unsafe {
            let job = JobHandle(CreateJobObjectW(None, PCWSTR::null())?);
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )?;
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid)?;
            let assigned = AssignProcessToJobObject(job.0, process);
            let _ = CloseHandle(process);
            assigned?;
            Ok(job)
        }
    }

    fn terminate(&self) -> windows::core::Result<()> {
        unsafe { windows::Win32::System::JobObjects::TerminateJobObject(self.0, 1) }
    }
}

#[cfg(windows)]
impl Drop for JobHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

// ---------------------------------------------------------------------------
// Terminal manager
// ---------------------------------------------------------------------------

enum WorkerMsg {
    Write(Vec<u8>),
    Resize { cols: u16, rows: u16 },
}

struct TerminalEntry {
    id: String,
    generation: u64,
    cwd: String,
    /// The `shell` option the PTY was created with (agent launch quoting).
    shell: Option<String>,
    /// Output observers (agent ready-pattern / idle detection); dropped when closed.
    taps: Arc<Mutex<Vec<mpsc::Sender<String>>>>,
    pid: Option<u32>,
    tx: mpsc::Sender<WorkerMsg>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    /// Cleared by the waiter thread when the child exits.
    alive: Arc<AtomicBool>,
    /// Set when this entry was killed or replaced; the reader stops emitting.
    detached: Arc<AtomicBool>,
    #[cfg(windows)]
    job: Option<JobHandle>,
}

impl TerminalEntry {
    fn info(&self) -> TerminalInfo {
        TerminalInfo {
            id: self.id.clone(),
            pid: self.pid,
            cwd: self.cwd.clone(),
            generation: self.generation,
            reattached: false,
        }
    }

    /// Kill the whole process tree. Must be called without the map lock held.
    fn kill_tree(&self) {
        self.detached.store(true, Ordering::SeqCst);

        #[cfg(windows)]
        {
            if let Some(job) = &self.job {
                match job.terminate() {
                    Ok(()) => return,
                    Err(e) => log::warn!("Terminal {}: TerminateJobObject failed: {}", self.id, e),
                }
            }
            let _ = self.killer.lock().kill();
        }

        #[cfg(unix)]
        {
            // portable-pty spawns the child via setsid(), so pid == pgid.
            // Once the leader has been reaped its pid may be recycled, so only
            // signal the group while the waiter still considers it alive.
            if !self.alive.load(Ordering::SeqCst) {
                return;
            }
            if let Some(pid) = self.pid {
                let pgid = pid as libc::pid_t;
                unsafe {
                    libc::killpg(pgid, libc::SIGHUP);
                }
                // Escalate if the group ignores SIGHUP. Skip once the waiter
                // has reaped the leader so we never signal a recycled pgid.
                let alive = self.alive.clone();
                thread::spawn(move || {
                    thread::sleep(Duration::from_millis(500));
                    if alive.load(Ordering::SeqCst) {
                        unsafe {
                            libc::killpg(pgid, libc::SIGKILL);
                        }
                    }
                });
            } else {
                let _ = self.killer.lock().kill();
            }
        }
    }
}

type TerminalMap = Arc<Mutex<HashMap<String, Arc<TerminalEntry>>>>;

pub struct TerminalManager {
    terminals: TerminalMap,
    /// Serializes create_terminal so "is there a live PTY for this id?" and
    /// "insert the new one" are atomic — two concurrent creates for the same id
    /// can no longer both spawn a shell. Never held by write/resize/kill.
    create_lock: Mutex<()>,
}

fn resolve_cwd(requested: Option<String>) -> String {
    if let Some(cwd) = requested.filter(|c| !c.trim().is_empty()) {
        if std::path::Path::new(&cwd).is_dir() {
            return cwd;
        }
        log::warn!("Terminal cwd {:?} is not a directory, using the default dir", cwd);
    }
    // Dev profile (and QUADFLOW_PROJECT_DIR): the core's default working dir,
    // never the real home folder. Release: home.
    if let Ok(paths) = quadflow_core::paths::AppPaths::resolve() {
        let env_dir = std::env::var(quadflow_core::paths::ENV_PROJECT_DIR).ok();
        if let Some(dir) = quadflow_core::paths::default_working_dir(paths.profile, env_dir.as_deref(), &paths.data_dir) {
            if std::fs::create_dir_all(&dir).is_ok() {
                return dir.to_string_lossy().to_string();
            }
        }
    }
    dirs::home_dir()
        .or_else(|| std::env::current_dir().ok())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string())
}

#[cfg(windows)]
fn build_shell_command(shell: Option<&str>) -> CommandBuilder {
    match shell {
        Some("cmd") => {
            let mut c = CommandBuilder::new("cmd.exe");
            c.args(["/K"]); // Keep the shell open
            c
        }
        Some("bash") => CommandBuilder::new("bash"),
        Some("pwsh") => {
            let mut c = CommandBuilder::new("pwsh.exe");
            c.args(["-NoLogo"]);
            c
        }
        // An absolute executable path from a detected terminal environment
        // (e.g. Git Bash's bash.exe found by `environments_detect`).
        Some(path) if std::path::Path::new(path).is_absolute() => {
            let exe = std::path::Path::new(path);
            let name = exe.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
            let mut c = CommandBuilder::new(path);
            match name.as_str() {
                "bash" | "zsh" | "sh" => c.args(["--login", "-i"]),
                "cmd" => c.args(["/K"]),
                "powershell" | "pwsh" => c.args(["-NoLogo"]),
                _ => {}
            }
            c
        }
        _ => {
            // Default to PowerShell on Windows
            let mut c = CommandBuilder::new("powershell.exe");
            c.args(["-NoLogo"]);
            c
        }
    }
}

#[cfg(not(windows))]
fn build_shell_command(shell: Option<&str>) -> CommandBuilder {
    // Login shell so GUI-launched apps (notably on macOS) get the user's PATH.
    let program = match shell {
        Some("bash") => "bash".to_string(),
        Some("zsh") => "zsh".to_string(),
        Some("fish") => "fish".to_string(),
        Some("sh") => "sh".to_string(),
        Some("pwsh") => "pwsh".to_string(),
        // Absolute executable path from a detected terminal environment.
        Some(path) if path.starts_with('/') => path.to_string(),
        _ => std::env::var("SHELL")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "/bin/bash".to_string()),
    };
    let mut c = CommandBuilder::new(program);
    c.arg("-l");
    c
}

/// Write in 1KB chunks with a brief pause so a slow consumer (ConPTY's ~4KB
/// input buffer, e.g. while an agent CLI handles a paste) can drain. This runs
/// on the per-terminal worker thread, never under a shared lock.
fn write_chunked(writer: &mut (dyn Write + Send), bytes: &[u8]) -> std::io::Result<()> {
    const CHUNK_SIZE: usize = 1024;
    if bytes.len() <= CHUNK_SIZE {
        writer.write_all(bytes)?;
        return writer.flush();
    }
    for chunk in bytes.chunks(CHUNK_SIZE) {
        writer.write_all(chunk)?;
        writer.flush()?;
        thread::sleep(Duration::from_millis(5));
    }
    Ok(())
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            terminals: Arc::new(Mutex::new(HashMap::new())),
            create_lock: Mutex::new(()),
        }
    }

    fn get(&self, id: &str) -> Result<Arc<TerminalEntry>, String> {
        self.terminals
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Terminal {} not found", id))
    }

    /// Blocking: spawns a process. Call from a blocking-capable thread.
    pub fn create_terminal(
        &self,
        app: AppHandle,
        options: CreateTerminalOptions,
    ) -> Result<TerminalInfo, String> {
        let _create_guard = self.create_lock.lock();

        // Reattach to an existing live PTY with this id; otherwise evict the
        // dead/stale entry (its threads see `detached` / a newer generation).
        if let Some(ref id) = options.id {
            let stale = {
                let mut terminals = self.terminals.lock();
                match terminals.get(id) {
                    Some(existing) if existing.alive.load(Ordering::SeqCst) => {
                        return Ok(TerminalInfo {
                            reattached: true,
                            ..existing.info()
                        });
                    }
                    Some(_) => terminals.remove(id),
                    None => None,
                }
            };
            if let Some(stale) = stale {
                log::info!("Terminal {} PTY is dead, creating fresh", id);
                // Make sure nothing of the old tree survives (outside the lock).
                stale.kill_tree();
            }
        }

        let cols = options.cols.unwrap_or(120);
        let rows = options.rows.unwrap_or(30);

        let pty_pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to open pty: {}", e))?;

        let cwd = resolve_cwd(options.cwd.clone());
        let mut cmd = build_shell_command(options.shell.as_deref());
        cmd.cwd(&cwd);
        // Set TERM so CLI apps (agent TUIs, vim, etc.) know the terminal capabilities.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        if let Some(env) = &options.env {
            for (k, v) in env {
                cmd.env(k, v);
            }
        }

        let mut reader = pty_pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone reader: {}", e))?;
        let mut writer = pty_pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to take writer: {}", e))?;

        let mut child = pty_pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn shell: {}", e))?;
        // Drop our copy of the slave so the reader sees EOF when the child
        // side closes (Unix); the master keeps the PTY itself alive.
        drop(pty_pair.slave);
        let master: Box<dyn MasterPty + Send> = pty_pair.master;

        let pid = child.process_id();
        let killer = child.clone_killer();

        #[cfg(windows)]
        let job = pid.and_then(|pid| match JobHandle::for_process(pid) {
            Ok(job) => Some(job),
            Err(e) => {
                log::warn!("Failed to assign terminal pid {} to a job object: {}", pid, e);
                None
            }
        });

        // Terminal ids are their layout leaf ids (plugin-system.md §5.2: `term:<id>`).
        let id = options.id.clone().unwrap_or_else(|| format!("term:{}", Uuid::new_v4()));
        let generation = next_generation();
        let alive = Arc::new(AtomicBool::new(true));
        let detached = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel::<WorkerMsg>();

        let taps: Arc<Mutex<Vec<mpsc::Sender<String>>>> = Arc::new(Mutex::new(Vec::new()));
        let entry = Arc::new(TerminalEntry {
            id: id.clone(),
            generation,
            cwd: cwd.clone(),
            shell: options.shell.clone(),
            taps: taps.clone(),
            pid,
            tx: tx.clone(),
            killer: Mutex::new(killer),
            alive: alive.clone(),
            detached: detached.clone(),
            #[cfg(windows)]
            job,
        });
        self.terminals.lock().insert(id.clone(), entry.clone());

        // Worker: owns writer + master. Exits (closing the PTY) once every
        // sender is gone, i.e. the entry was removed and init commands are done.
        {
            let id = id.clone();
            thread::spawn(move || {
                for msg in rx {
                    match msg {
                        WorkerMsg::Write(bytes) => {
                            if let Err(e) = write_chunked(writer.as_mut(), &bytes) {
                                log::warn!("Terminal {} write failed: {}", id, e);
                            }
                        }
                        WorkerMsg::Resize { cols, rows } => {
                            if let Err(e) = master.resize(PtySize {
                                rows,
                                cols,
                                pixel_width: 0,
                                pixel_height: 0,
                            }) {
                                log::warn!("Terminal {} resize failed: {}", id, e);
                            }
                        }
                    }
                }
                drop(writer);
                drop(master);
            });
        }

        // Reader: PTY output -> terminal:data:{id}
        let (reader_done_tx, reader_done_rx) = mpsc::channel::<()>();
        {
            let id = id.clone();
            let app = app.clone();
            let detached = detached.clone();
            let taps = taps.clone();
            thread::spawn(move || {
                let event = format!("terminal:data:{}", id);
                let mut decoder = Utf8StreamDecoder::default();
                let mut buffer = [0u8; 8192];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(n) => {
                            let data = decoder.decode(&buffer[..n]);
                            if !data.is_empty() && !detached.load(Ordering::Relaxed) {
                                {
                                    let mut t = taps.lock();
                                    if !t.is_empty() {
                                        t.retain(|tx| tx.send(data.clone()).is_ok());
                                    }
                                }
                                let _ = app.emit(&event, data);
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(e) => {
                            log::debug!("Terminal {} read ended: {}", id, e);
                            break;
                        }
                    }
                }
                let tail = decoder.finish();
                if !tail.is_empty() && !detached.load(Ordering::Relaxed) {
                    let _ = app.emit(&event, tail);
                }
                let _ = reader_done_tx.send(());
            });
        }

        // Waiter: the single source of terminal:exit:{id}.
        {
            let id = id.clone();
            let terminals = self.terminals.clone();
            let alive = alive.clone();
            thread::spawn(move || {
                let exit_code = match child.wait() {
                    Ok(status) => Some(status.exit_code()),
                    Err(e) => {
                        log::warn!("Terminal {} wait failed: {}", id, e);
                        None
                    }
                };
                alive.store(false, Ordering::SeqCst);
                // Let trailing output reach the frontend before the exit
                // notice. ConPTY may never EOF, hence the timeout.
                let _ = reader_done_rx.recv_timeout(Duration::from_millis(300));

                let current = terminals.lock().get(&id).map(|e| e.generation);
                if should_emit_exit(current, generation) {
                    let _ = app.emit(
                        &format!("terminal:exit:{}", id),
                        TerminalExitPayload {
                            generation,
                            exit_code,
                        },
                    );
                } else {
                    log::debug!("Suppressed stale exit for terminal {} gen {}", id, generation);
                }
            });
        }

        // Init commands go through the worker queue, after the shell settles.
        if let Some(init_commands) = options.init_commands.filter(|c| !c.is_empty()) {
            let tx = tx.clone();
            thread::spawn(move || {
                // Wait for shell to initialize (e.g., vcvarsall.bat needs the shell ready)
                thread::sleep(Duration::from_millis(300));
                for cmd in init_commands {
                    if tx.send(WorkerMsg::Write(format!("{}\r", cmd).into_bytes())).is_err() {
                        break;
                    }
                    // Give each command time to complete (vcvarsall.bat is slow)
                    thread::sleep(Duration::from_millis(500));
                }
            });
        }
        drop(tx);

        Ok(entry.info())
    }

    /// Non-blocking: enqueues on the terminal's worker thread.
    pub fn write_terminal(&self, id: &str, data: &str) -> Result<(), String> {
        let entry = self.get(id)?;
        entry
            .tx
            .send(WorkerMsg::Write(data.as_bytes().to_vec()))
            .map_err(|_| format!("Terminal {} is closed", id))
    }

    /// Non-blocking: enqueues on the terminal's worker thread.
    pub fn resize_terminal(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        if cols == 0 || rows == 0 {
            return Ok(());
        }
        let entry = self.get(id)?;
        entry
            .tx
            .send(WorkerMsg::Resize { cols, rows })
            .map_err(|_| format!("Terminal {} is closed", id))
    }

    /// Removes the terminal and kills its whole process tree. The waiter then
    /// emits the exit event (unless a newer generation took the id meanwhile).
    pub fn kill_terminal(&self, id: &str) -> Result<(), String> {
        let entry = self
            .terminals
            .lock()
            .remove(id)
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        entry.kill_tree();
        Ok(())
    }

    /// The `shell` option a live terminal was created with (`None` = platform default).
    pub fn terminal_shell(&self, id: &str) -> Result<Option<String>, String> {
        Ok(self.get(id)?.shell.clone())
    }

    /// Whether a live PTY with this id exists.
    pub fn is_alive(&self, id: &str) -> bool {
        self.get(id).map(|e| e.alive.load(Ordering::SeqCst)).unwrap_or(false)
    }

    /// Receive this terminal's output from now on (until the receiver is dropped).
    pub fn subscribe_output(&self, id: &str) -> Result<mpsc::Receiver<String>, String> {
        let entry = self.get(id)?;
        let (tx, rx) = mpsc::channel();
        entry.taps.lock().push(tx);
        Ok(rx)
    }

    pub fn get_terminal_info(&self, id: &str) -> Result<TerminalInfo, String> {
        Ok(self.get(id)?.info())
    }

    pub fn list_terminals(&self) -> Vec<TerminalInfo> {
        self.terminals.lock().values().map(|t| t.info()).collect()
    }
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoder_passes_ascii_through() {
        let mut d = Utf8StreamDecoder::default();
        assert_eq!(d.decode(b"hello"), "hello");
        assert_eq!(d.finish(), "");
    }

    #[test]
    fn decoder_carries_split_multibyte_sequences() {
        let text = "a€b😀c"; // 3-byte and 4-byte chars
        let bytes = text.as_bytes();
        // Every possible split point, including mid-character.
        for split in 0..=bytes.len() {
            let mut d = Utf8StreamDecoder::default();
            let mut out = d.decode(&bytes[..split]);
            out.push_str(&d.decode(&bytes[split..]));
            out.push_str(&d.finish());
            assert_eq!(out, text, "split at {}", split);
        }
    }

    #[test]
    fn decoder_handles_byte_at_a_time() {
        let text = "日本語 ✓ 😀";
        let mut d = Utf8StreamDecoder::default();
        let mut out = String::new();
        for b in text.as_bytes() {
            out.push_str(&d.decode(std::slice::from_ref(b)));
        }
        out.push_str(&d.finish());
        assert_eq!(out, text);
    }

    #[test]
    fn decoder_replaces_invalid_bytes_and_continues() {
        let mut d = Utf8StreamDecoder::default();
        assert_eq!(d.decode(b"a\xFFb"), "a\u{FFFD}b");
        // Truncated sequence at EOF is flushed lossily.
        assert_eq!(d.decode(b"x\xE2\x82"), "x");
        assert_eq!(d.finish(), "\u{FFFD}");
    }

    #[test]
    fn exit_emitted_only_for_current_or_removed_generation() {
        assert!(should_emit_exit(None, 3)); // killed / removed
        assert!(should_emit_exit(Some(3), 3)); // still the registered spawn
        assert!(!should_emit_exit(Some(4), 3)); // id reused by a newer spawn
    }

    #[test]
    fn generations_are_unique_and_increasing() {
        let a = next_generation();
        let b = next_generation();
        assert!(b > a);
    }

    #[test]
    fn resolve_cwd_falls_back_for_missing_dir() {
        let tmp = std::env::temp_dir().to_string_lossy().to_string();
        assert_eq!(resolve_cwd(Some(tmp.clone())), tmp);
        let fallback = resolve_cwd(Some("/definitely/not/a/real/dir/xyz".into()));
        assert_ne!(fallback, "/definitely/not/a/real/dir/xyz");
        assert!(!resolve_cwd(None).is_empty());
    }
}
