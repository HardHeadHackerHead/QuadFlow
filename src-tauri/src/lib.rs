mod terminal;
mod title;
mod diagnostics;
mod ai_provider;
pub mod agents;
pub mod bindings;
pub mod commands;
pub mod core_state;
pub mod plugin_host;
pub mod plugin_protocol;
mod git_worktree;
#[cfg(target_os = "windows")]
mod audio_session;
mod cli_install;

use std::sync::Arc;
use std::fs;
use tauri::{AppHandle, State, Manager};
use tauri::webview::WebviewWindowBuilder;
use terminal::{CreateTerminalOptions, TerminalInfo, TerminalManager};
use serde::{Deserialize, Serialize};

// Tauri commands for terminal management.
//
// create/kill are async and run on the blocking pool (spawning and killing
// processes can block). write/resize stay *sync* on purpose: sync commands are
// dispatched in IPC order on the main thread, which keeps keystrokes and
// resizes ordered (async commands are separate tasks and may run out of
// order), and they only enqueue onto the terminal's worker thread — no I/O and
// no lock held across I/O — so they never block the main thread.
#[tauri::command]
async fn create_terminal(
    app: AppHandle,
    manager: State<'_, Arc<TerminalManager>>,
    options: CreateTerminalOptions,
) -> Result<TerminalInfo, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.create_terminal(app, options))
        .await
        .map_err(|e| format!("create_terminal task failed: {}", e))?
}

#[tauri::command]
fn get_os_info() -> terminal::OsInfo {
    terminal::os_info()
}

#[tauri::command]
fn write_terminal(
    manager: State<'_, Arc<TerminalManager>>,
    id: String,
    data: String,
) -> Result<(), String> {
    manager.write_terminal(&id, &data)
}

#[tauri::command]
fn resize_terminal(
    manager: State<'_, Arc<TerminalManager>>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    manager.resize_terminal(&id, cols, rows)
}

#[tauri::command]
async fn kill_terminal(
    manager: State<'_, Arc<TerminalManager>>,
    agents: State<'_, Arc<agents::AgentsState>>,
    id: String,
) -> Result<(), String> {
    agents.claims.release_terminal(&id);
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.kill_terminal(&id))
        .await
        .map_err(|e| format!("kill_terminal task failed: {}", e))?
}

#[tauri::command]
fn get_terminal_info(
    manager: State<'_, Arc<TerminalManager>>,
    id: String,
) -> Result<TerminalInfo, String> {
    manager.get_terminal_info(&id)
}

#[tauri::command]
fn list_terminals(manager: State<'_, Arc<TerminalManager>>) -> Vec<TerminalInfo> {
    manager.list_terminals()
}

/// Read a file from the filesystem
#[tauri::command]
async fn read_file(path: String) -> Result<String, String> {
    // Filesystem / process work: blocking pool, never the main thread.
    tauri::async_runtime::spawn_blocking(move || read_file_blocking(path))
        .await
        .map_err(|e| format!("task failed: {e}"))?
}

fn read_file_blocking(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Request user attention for the window (taskbar flash on Windows)
#[tauri::command]
fn request_attention(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window
            .request_user_attention(Some(tauri::UserAttentionType::Informational))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Window bounds for floating windows
#[derive(Debug, Serialize, Deserialize)]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Create a floating window for a panel (terminal or tool)
/// Uses async to avoid blocking the main thread during window creation
#[tauri::command]
async fn create_floating_window(
    app: AppHandle,
    panel_id: String,
    panel_type: String,
    title: String,
    x: Option<i32>,
    y: Option<i32>,
    width: Option<u32>,
    height: Option<u32>,
) -> Result<String, String> {
    println!("[RUST] create_floating_window START - panel: {}", panel_id);

    // Generate a unique window label
    let window_label = format!("floating-{}", panel_id.replace(":", "-"));
    println!("[RUST] Window label: {}", window_label);

    // Check if window already exists
    println!("[RUST] Checking if window exists...");
    if app.get_webview_window(&window_label).is_some() {
        println!("[RUST] Window already exists, focusing it");
        if let Some(window) = app.get_webview_window(&window_label) {
            let _ = window.set_focus();
        }
        return Ok(window_label);
    }
    println!("[RUST] Window does not exist, creating new one");

    // Build the URL with floating window params
    let url = format!(
        "/index.html?floating=true&panelId={}&panelType={}",
        urlencoding::encode(&panel_id),
        urlencoding::encode(&panel_type)
    );

    println!("[RUST] URL: {}", url);

    let width = width.unwrap_or(800);
    let height = height.unwrap_or(600);
    println!("[RUST] Size: {}x{}", width, height);

    // Clone for the closure
    let window_label_clone = window_label.clone();
    let app_clone = app.clone();

    // Use a channel to get the result back from the main thread
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

    println!("[RUST] Scheduling window creation on main thread...");

    let schedule_result = app.run_on_main_thread(move || {
        println!("[RUST] Running on main thread - creating window builder...");

        let mut window_builder = WebviewWindowBuilder::new(
            &app_clone,
            &window_label_clone,
            tauri::WebviewUrl::App(url.into()),
        )
        .title(&title)
        .inner_size(width as f64, height as f64)
        .min_inner_size(400.0, 300.0)
        .decorations(true)
        .resizable(true)
        .visible(true);

        // Apply position if provided
        if let (Some(x), Some(y)) = (x, y) {
            window_builder = window_builder.position(x as f64, y as f64);
        }

        println!("[RUST] Calling build()...");
        let result = match window_builder.build() {
            Ok(_) => {
                println!("[RUST] Window built successfully!");
                Ok(())
            }
            Err(e) => {
                println!("[RUST] Window build failed: {}", e);
                Err(e.to_string())
            }
        };

        // Send result back through channel
        let _ = tx.send(result);
    });

    if let Err(e) = schedule_result {
        println!("[RUST] Failed to schedule on main thread: {}", e);
        return Err(e.to_string());
    }

    println!("[RUST] Waiting for window creation result...");

    // Wait for the result with a timeout
    match rx.recv_timeout(std::time::Duration::from_secs(10)) {
        Ok(Ok(())) => {
            println!("[RUST] Window creation completed successfully");
            Ok(window_label)
        }
        Ok(Err(e)) => {
            println!("[RUST] Window creation failed: {}", e);
            Err(e)
        }
        Err(e) => {
            println!("[RUST] Timeout or channel error waiting for window: {}", e);
            Err(format!("Window creation timeout: {}", e))
        }
    }
}

/// Close a floating window
#[tauri::command]
fn close_floating_window(app: AppHandle, window_label: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&window_label) {
        window.close().map_err(|e| e.to_string())?;
        log::info!("Closed floating window: {}", window_label);
    }
    Ok(())
}

/// Get the bounds of a floating window
#[tauri::command]
fn get_window_bounds(app: AppHandle, window_label: String) -> Result<WindowBounds, String> {
    let window = app.get_webview_window(&window_label)
        .ok_or_else(|| format!("Window not found: {}", window_label))?;

    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;

    Ok(WindowBounds {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    })
}

/// Focus a floating window
#[tauri::command]
fn focus_floating_window(app: AppHandle, window_label: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&window_label) {
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Configure tauri-plugin-log so:
///  - INFO+ goes to a rotating file `<core logs dir>/quadflow.log` (profile-aware)
///    (rotated when it exceeds the size limit; previous files kept)
///  - INFO+ also tees to stdout so `npm run tauri dev` shows the same lines
///
/// We deliberately do NOT include the `Webview` target. That target emits
/// every backend log line into the WebView's `console`, which on Windows
/// has produced re-emit feedback loops in this project (each `log::warn!`
/// triggers a Tauri event → JS handler → in some cases another
/// log → repeat). File + stdout cover every diagnostic we need; users
/// who want the lines in DevTools can `tail -f quadflow.log` or use the
/// "View logs" button in the Ship panel.
fn build_log_plugin(logs_dir: std::path::PathBuf) -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri_plugin_log::{Target, TargetKind};
    // `RUST_LOG=debug` (a bare level) raises QuadFlow's own crates, e.g. to see
    // the `[startup]` / `[ipc]` timing lines; dependencies stay at Info.
    let own_level = std::env::var("RUST_LOG")
        .ok()
        .and_then(|v| v.trim().parse::<log::LevelFilter>().ok())
        .filter(|l| *l > log::LevelFilter::Info)
        .unwrap_or(log::LevelFilter::Info);
    tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Info)
        .level_for("quadflow_tauri_lib", own_level)
        .level_for("quadflow_core", own_level)
        .max_file_size(8 * 1024 * 1024) // 8 MiB per file before rotation
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
        .targets([
            Target::new(TargetKind::Folder { path: logs_dir, file_name: Some("quadflow".into()) }),
            Target::new(TargetKind::Stdout),
        ])
        .build()
}

/// Reveal the diagnostics directory in the OS file manager. Returns the
/// path so the frontend can also display it inline. Replaces the old
/// `open_logs_folder` — same behaviour, name reflects what it actually
/// shows now (logs + crash JSONs + system/build info + bundles).
#[tauri::command]
fn open_diagnostics_folder() -> Result<String, String> {
    let dir = diagnostics::dir()
        .ok_or_else(|| "no diagnostics directory available on this platform".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;
    let path = dir.display().to_string();
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("explorer").arg(&dir).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(&dir).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(&dir).spawn();
    }
    diagnostics::record("info", "diagnostics", format!("opened folder {path}"));
    Ok(path)
}

/// Generate a single zip archive containing all logs, crash reports,
/// and metadata files — ready to attach to a bug report. Reveals the
/// archive in the OS file manager and returns its absolute path.
#[tauri::command]
async fn generate_diagnostic_bundle(app: AppHandle) -> Result<String, String> {
    // Filesystem / process work: blocking pool, never the main thread.
    tauri::async_runtime::spawn_blocking(move || generate_diagnostic_bundle_blocking(app))
        .await
        .map_err(|e| format!("task failed: {e}"))?
}

fn generate_diagnostic_bundle_blocking(app: AppHandle) -> Result<String, String> {
    let active = app.try_state::<core_state::CoreState>().and_then(|s| s.active_project_root());
    let path = diagnostics::generate_bundle(active).map_err(|e| format!("bundle: {e}"))?;
    #[cfg(target_os = "windows")]
    {
        // /select highlights the file in the parent folder so the user
        // can see exactly which archive was just produced.
        let _ = std::process::Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(parent) = path.parent() {
            #[cfg(target_os = "macos")]
            let _ = std::process::Command::new("open").arg(parent).spawn();
            #[cfg(target_os = "linux")]
            let _ = std::process::Command::new("xdg-open").arg(parent).spawn();
        }
    }
    diagnostics::record(
        "info",
        "diagnostics",
        format!("generated bundle {}", path.display()),
    );
    Ok(path.display().to_string())
}

/// Frontend → backend bridge for `window.onerror` and
/// `window.addEventListener('unhandledrejection')`. Persists the report
/// as a `CrashReport` JSON next to the Rust ones so a single bundle
/// captures every crash source.
#[tauri::command]
fn report_frontend_error(payload: diagnostics::FrontendErrorReport) -> Result<String, String> {
    let path = diagnostics::record_frontend_error(payload);
    Ok(path.map(|p| p.display().to_string()).unwrap_or_default())
}

/// Frontend-driven breadcrumb. Used by `useEffect` boundaries, button
/// click handlers, and any other place the UI wants to leave a trail.
/// Cheap; the breadcrumb ring is in-memory.
#[tauri::command]
fn record_breadcrumb(
    level: String,
    category: String,
    message: String,
    fields: Option<serde_json::Map<String, serde_json::Value>>,
) -> Result<(), String> {
    diagnostics::record_with_fields(&level, &category, message, fields.unwrap_or_default());
    Ok(())
}

/// Snapshot recent breadcrumbs so the frontend can show a "what just
/// happened" panel without round-tripping through disk.
#[tauri::command]
fn get_recent_breadcrumbs() -> Vec<diagnostics::Breadcrumb> {
    diagnostics::snapshot_breadcrumbs()
}

#[tauri::command]
fn get_diagnostics_metadata() -> serde_json::Value {
    serde_json::json!({
        "build": diagnostics::build_info(),
        "system": diagnostics::system_info(),
        "log_dir": diagnostics::dir().map(|p| p.display().to_string()),
    })
}

/// Windows-only: register a top-level Structured Exception Handler so
/// that hardware exceptions (stack overflow `0xC00000FD`, access
/// violation `0xC0000005`, illegal instruction, divide-by-zero, …)
/// land in `crash.log` with the exception code + a Rust backtrace
/// before the OS kills the process. The Rust `panic_hook` does NOT
/// catch these — they're SEH faults, not Rust panics.
///
/// We register the filter once at process start and never remove it.
/// On exception, we write to disk and return `EXCEPTION_CONTINUE_SEARCH`
/// so the OS still produces its standard "process exited with status
/// 0xc00000fd" diagnostics — the goal is breadcrumbs, not recovery.
#[cfg(target_os = "windows")]
fn install_windows_seh_log_hook() {
    // Minimal FFI for SEH + stack walk + module base lookup.
    // Stable Win32 ABIs since NT 5.0 / Windows XP.
    #[repr(C)]
    struct ExceptionRecord {
        exception_code: u32,
        exception_flags: u32,
        exception_record: *mut ExceptionRecord,
        exception_address: *mut std::ffi::c_void,
    }
    #[repr(C)]
    struct ExceptionPointers {
        exception_record: *mut ExceptionRecord,
    }
    type TopLevelExceptionFilter =
        unsafe extern "system" fn(info: *mut ExceptionPointers) -> i32;

    extern "system" {
        fn SetUnhandledExceptionFilter(
            filter: Option<TopLevelExceptionFilter>,
        ) -> Option<TopLevelExceptionFilter>;
        fn SetThreadStackGuarantee(stack_size_in_bytes: *mut u32) -> i32;
        fn GetModuleHandleA(name: *const i8) -> *mut std::ffi::c_void;
        fn RtlCaptureStackBackTrace(
            frames_to_skip: u32,
            frames_to_capture: u32,
            back_trace: *mut *mut std::ffi::c_void,
            back_trace_hash: *mut u32,
        ) -> u16;
    }

    // Reserve 256 KB of stack space below the guard page for handling
    // stack-overflow exceptions. Without this, when the regular stack
    // is exhausted, the SEH filter has near-zero room and crashes
    // before producing useful output. Recommended value per MSDN.
    unsafe {
        let mut sz: u32 = 256 * 1024;
        SetThreadStackGuarantee(&mut sz as *mut u32);
    }

    unsafe extern "system" fn handler(info: *mut ExceptionPointers) -> i32 {
        const EXCEPTION_CONTINUE_SEARCH: i32 = 0;

        let _ = std::panic::catch_unwind(|| {
            let info = info.as_ref();
            let (code, addr) = if let Some(p) = info {
                if let Some(rec) = p.exception_record.as_ref() {
                    (rec.exception_code, rec.exception_address as usize)
                } else {
                    (0, 0)
                }
            } else {
                (0, 0)
            };
            let label = match code {
                0xC0000005 => "ACCESS_VIOLATION",
                0xC00000FD => "STACK_OVERFLOW",
                0xC000001D => "ILLEGAL_INSTRUCTION",
                0xC0000094 => "INTEGER_DIVIDE_BY_ZERO",
                0xC0000096 => "PRIVILEGED_INSTRUCTION",
                _ => "UNKNOWN",
            };

            let exe_base = GetModuleHandleA(std::ptr::null()) as usize;
            let fault_rva = addr.wrapping_sub(exe_base);
            let location = Some(format!(
                "exe_base=0x{exe_base:X}, addr=0x{addr:X}, rva=0x{fault_rva:X}"
            ));
            let message = format!(
                "SEH 0x{code:08X} ({label}) at addr=0x{addr:X} (rva=0x{fault_rva:X})"
            );

            let mut report = diagnostics::build_report(
                diagnostics::CrashKind::SehFault,
                message,
                location,
            );

            // Raw stack walk — zero-allocation, works on the
            // SetThreadStackGuarantee-reserved exception stack.
            let mut frames: [*mut std::ffi::c_void; 96] = [std::ptr::null_mut(); 96];
            let captured = RtlCaptureStackBackTrace(
                0,
                frames.len() as u32,
                frames.as_mut_ptr(),
                std::ptr::null_mut(),
            ) as usize;
            for i in 0..captured {
                let f_addr = frames[i] as usize;
                report.raw_frames.push(diagnostics::RawFrame {
                    index: i as u32,
                    address: format!("0x{:X}", f_addr),
                    rva: format!("0x{:X}", f_addr.wrapping_sub(exe_base)),
                });
            }

            // Symbolized backtrace — best-effort; the
            // SetThreadStackGuarantee 256 KB cushion gives dbghelp
            // enough room even when the regular stack is exhausted.
            report.symbolized_backtrace =
                Some(format!("{}", std::backtrace::Backtrace::force_capture()));

            // Persist. write_crash_report does its own fsync on Windows.
            let _ = diagnostics::write_crash_report(&report);
        });

        EXCEPTION_CONTINUE_SEARCH
    }

    unsafe {
        let _ = SetUnhandledExceptionFilter(Some(handler));
    }
}

/// Capture Rust panics from any thread as structured `CrashReport` JSON.
/// Reentrancy-safe via a thread-local flag — if the hook itself panics,
/// the second entry short-circuits to a stderr line instead of looping
/// (which previously caused stack overflows).
fn install_panic_log_hook() {
    use std::cell::Cell;
    thread_local! {
        static IN_HOOK: Cell<bool> = const { Cell::new(false) };
    }
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let already_in = IN_HOOK.with(|f| f.replace(true));
        if already_in {
            eprintln!("[crash] panic hook re-entered (suppressed): {info}");
            prev(info);
            return;
        }
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            // panic_info.location() gives file:line if the panic carried it.
            let location = info.location().map(|l| format!("{}:{}", l.file(), l.line()));
            let message = info
                .payload()
                .downcast_ref::<&'static str>()
                .map(|s| s.to_string())
                .or_else(|| info.payload().downcast_ref::<String>().cloned())
                .unwrap_or_else(|| format!("{info}"));

            let mut report = diagnostics::build_report(
                diagnostics::CrashKind::RustPanic,
                message,
                location,
            );
            // Symbolized backtrace via dbghelp / std::backtrace.
            report.symbolized_backtrace =
                Some(format!("{}", std::backtrace::Backtrace::force_capture()));
            let _ = diagnostics::write_crash_report(&report);
        }));
        IN_HOOK.with(|f| f.set(false));
        prev(info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Pins the closure type produced by `generate_handler!` when it is stored in a binding.
fn as_invoke_handler<F: Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static>(f: F) -> F {
    f
}

/// A command dispatch that held the main thread this long blocks the UI and
/// all IPC: sync commands doing real I/O must be `async` + `spawn_blocking`.
const SLOW_DISPATCH_WARN: std::time::Duration = std::time::Duration::from_millis(100);

fn log_slow_dispatch(cmd: &str, took: std::time::Duration) {
    if took >= SLOW_DISPATCH_WARN {
        log::warn!("[ipc] `{cmd}` blocked the main thread for {} ms", took.as_millis());
    } else if took >= std::time::Duration::from_millis(10) {
        log::debug!("[ipc] `{cmd}` dispatch took {} ms", took.as_millis());
    }
}

/// Startup timeline. The logger is installed by a plugin, so marks taken
/// before the Tauri builder runs are buffered and flushed from `setup`.
struct StartupMarks {
    t0: std::time::Instant,
    marks: Vec<(&'static str, u128)>,
}

impl StartupMarks {
    fn new() -> Self {
        Self { t0: std::time::Instant::now(), marks: Vec::new() }
    }
    fn mark(&mut self, what: &'static str) {
        self.marks.push((what, self.t0.elapsed().as_millis()));
    }
    fn flush(&self) {
        for (what, ms) in &self.marks {
            log::debug!("[startup] {what}: +{ms} ms");
        }
    }
}

pub fn run() {
    let mut startup = StartupMarks::new();
    // Install the panic hook BEFORE anything else so panics in plugin
    // init / setup hooks land on disk. We can't use the log macros yet
    // (logger isn't installed), so we write straight to a file in the
    // standard log dir. File is named with the panic timestamp so a
    // crashy build leaves a paper trail of every attempt.
    install_panic_log_hook();

    // Initialize the diagnostics module: ensures the log dir exists,
    // captures system+build info to disk, records the boot breadcrumb.
    // Must run AFTER install_panic_log_hook so any panic during
    // diagnostics::init() lands in the structured crash format.
    diagnostics::init();

    // Windows-only: catch hardware exceptions (stack overflow,
    // access violation, …) that the Rust panic hook does NOT see.
    // Writes the exception code + a backtrace to crash.log before the
    // OS terminates the process.
    #[cfg(target_os = "windows")]
    install_windows_seh_log_hook();

    // Replace Tauri's default async runtime with one that uses larger
    // worker stacks. The Windows default for tokio worker threads is
    // 2 MB, which has been observed to overflow during startup on this
    // codebase (some combination of deep async chains + signal-style
    // callbacks). 8 MB is the same headroom a regular `cargo test`
    // thread gets and is plenty for any reasonable call chain. This
    // does NOT mask infinite recursion — if a real cycle exists it
    // will still overflow, just take longer; the SEH hook above will
    // catch the eventual crash and dump a backtrace.
    //
    // `on_thread_start` runs on each worker thread before it picks up
    // tasks. On Windows we use it to call `SetThreadStackGuarantee` so
    // the SEH unhandled-exception filter has 256 KB of headroom below
    // the guard page when an overflow fires — without that, the
    // filter runs on a sliver of stack and can't write a useful
    // crash.log entry.
    let async_runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_stack_size(8 * 1024 * 1024)
        .on_thread_start(|| {
            #[cfg(target_os = "windows")]
            unsafe {
                extern "system" {
                    fn SetThreadStackGuarantee(stack_size: *mut u32) -> i32;
                }
                let mut sz: u32 = 256 * 1024;
                let _ = SetThreadStackGuarantee(&mut sz as *mut u32);
            }
            // Drop a breadcrumb so we have a record of every worker
            // thread that came online — useful when reading reports
            // from multi-threaded crashes.
            diagnostics::record("debug", "tokio", "worker thread started");
        })
        .build()
        .expect("tokio runtime");
    tauri::async_runtime::set(async_runtime.handle().clone());
    // Keep the runtime alive for the lifetime of the process.
    std::mem::forget(async_runtime);
    startup.mark("diagnostics + async runtime");
    // Note: we used to call `env_logger::init()` here. tauri-plugin-log
    // (registered in the Builder below) installs a `log::Log` global
    // and ALSO writes to a rotating file in the core logs dir.
    // Only one logger can be set; let the plugin own it.

    // Windows: relabel our Volume Mixer entries and set AppUserModelID so
    // WebView2's audio session doesn't surface as "Microsoft Edge WebView2".
    // Must run before any window is created for taskbar grouping to take.
    #[cfg(target_os = "windows")]
    audio_session::start();

    let terminal_manager = Arc::new(TerminalManager::new());
    startup.mark("audio session + terminal manager");


    // quadflow-core state (profile-aware paths; dev builds never touch release data).
    let core = core_state::CoreState::from_env().expect("quadflow-core: could not resolve app paths");
    log::info!(
        "[core] profile={} data_dir={}",
        core.core.profile().as_str(),
        core.core.paths.data_dir.display()
    );
    let agents_state = Arc::new(agents::AgentsState::new(&core.core));
    startup.mark("core + agents state");
    let specta = bindings::builder();
    // Bindings are regenerated by the `export_bindings` test (`npm run check`).
    // A running app only rewrites the source tree when explicitly asked, so a
    // stale dev exe can never overwrite newer bindings.
    #[cfg(debug_assertions)]
    if std::env::var_os("QUADFLOW_EXPORT_BINDINGS").is_some() {
        let specta = specta.clone();
        std::thread::spawn(move || {
            if let Err(e) = bindings::export(&specta) {
                log::warn!("[core] {e}");
            }
        });
    }
    let specta_for_events = specta.clone();
    let core_logs_dir = core.core.paths.logs_dir.clone();
    startup.mark("specta bindings");

    let mut builder = tauri::Builder::default()
        .manage(core)
        .plugin(build_log_plugin(core_logs_dir))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(terminal_manager)
        .manage(agents_state);

    // `qfplugin://` asset protocol for plugin UI bundles + assets (plugin-system.md §8.2).
    builder = plugin_protocol::register(builder);
    // Plugin host API dispatch state (plugin-system.md §7.1).
    builder = plugin_host::register(builder);

    builder
        .setup(move |app| {
            startup.mark("tauri builder + plugins");
            // quadflow-core: typed events + bus → `data-changed` bridge.
            specta_for_events.mount_events(app);
            if let Some(state) = app.try_state::<core_state::CoreState>() {
                state.bridge_events(app.handle());
                // App-DB writes of other processes (the CLI) → `External` change events (§8.3).
                state.start_app_db_watch();
                // Windows: the webview host window clips siblings, so windows a plugin embeds
                // next to it are painted (the host owns this, not the embedding sidecar).
                plugin_host::ensure_webview_clip_siblings(app.handle());
                // Plugin update checks (PL-9): background thread, 30 s after startup.
                commands::plugins::start_update_checks(&state.core);
                // Model catalog: background refresh when the cache is older than 6 h.
                if let Some(agents) = app.try_state::<Arc<agents::AgentsState>>() {
                    agents.inner().spawn_startup_refresh(app.handle().clone(), state.core.clone());
                }
            }

            startup.mark("setup hook");
            startup.flush();
            Ok(())
        })
        .invoke_handler({
            // Typed (tauri-specta) commands are routed by name. Every data domain
            // is typed (DL-11); the untyped generate_handler! table below only
            // holds shell/native commands (terminals, windows, diagnostics,
            // …) until they move into plugins (MIG-*).
            let typed_names = bindings::command_names(&specta);
            let typed = specta.invoke_handler();
            let untyped = as_invoke_handler(tauri::generate_handler![
            // Diagnostics / logs / crash reporting
            open_diagnostics_folder,
            generate_diagnostic_bundle,
            report_frontend_error,
            record_breadcrumb,
            get_recent_breadcrumbs,
            get_diagnostics_metadata,
            // Terminal commands
            create_terminal,
            write_terminal,
            resize_terminal,
            kill_terminal,
            get_terminal_info,
            list_terminals,
            get_os_info,
            read_file,
            request_attention,
            // Env file viewer
            // Code editor window
            // Floating window commands
            create_floating_window,
            close_floating_window,
            get_window_bounds,
            focus_floating_window,
            // Title generation via the chat endpoint (local titles: plugins/local-titles)
            title::generate_title_via_api,
            // CLI on PATH (Settings → Integrations)
            cli_install::cli_install_status,
            cli_install::cli_install_to_path,
            cli_install::cli_switch_to_this_build,
            cli_install::cli_uninstall_from_path,
            // Git Worktree commands
            git_worktree::create_worktree,
            git_worktree::list_worktrees,
            git_worktree::delete_worktree,
            git_worktree::get_worktree_status,
            git_worktree::merge_worktree_branch,
            git_worktree::prune_worktrees,
            ]);
            move |invoke: tauri::ipc::Invoke| {
                // Sync (non-`async`) commands run inline here, on the main
                // thread, and block every other IPC call and the event loop
                // while they run. Time each dispatch so a slow one is visible.
                let started = std::time::Instant::now();
                let cmd = invoke.message.command().to_string();
                let handled = if typed_names.contains(cmd.as_str()) {
                    typed(invoke)
                } else {
                    untyped(invoke)
                };
                log_slow_dispatch(&cmd, started.elapsed());
                handled
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
