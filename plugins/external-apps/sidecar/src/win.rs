//! Win32 side of External Apps: window enumeration, focusing, embedding.
//!
//! Embedding = style surgery (`WS_CHILD`, no caption/frame) + `SetParent` into
//! QuadFlow's main window; the UI then positions the child over its tile in
//! main-window client coordinates (physical px) and hides it whenever the tile
//! is hidden or covered by an overlay.
//!
//! Safety rules:
//!  - only windows this sidecar embedded are touched by `embed.*` (the map);
//!  - QuadFlow's own windows and this process's windows are never listed or
//!    embedded; neither are child windows or windows of an elevated process
//!    (SetParent fails → rolled back);
//!  - a call that sends a message to the foreign window is either async
//!    (`SWP_ASYNCWINDOWPOS`, `ShowWindowAsync`), bounded (`SendMessageTimeoutW`
//!    with `SMTO_ABORTIFHUNG`), or runs on a worker thread with a deadline —
//!    a hung app can stall a worker of this process, never QuadFlow's UI;
//!  - detach restores parent **and owner** separately (`GetParent` returns the
//!    owner for an owned top-level window; restoring that as the parent would
//!    turn the window into a child of its owner);
//!  - the table is persisted to `embeds.json` (cwd = the plugin data dir) so a
//!    crash of this process restores the windows on the next start.

use crate::{hwnd_param, str_param};
use quadflow_sidecar::{json, Host, RpcError, RpcResult, Value};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use windows::core::PWSTR;
use windows::Win32::Foundation::{BOOL, CloseHandle, HMODULE, HWND, LPARAM, MAX_PATH, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{ClientToScreen, RedrawWindow, RDW_ALLCHILDREN, RDW_ERASE, RDW_FRAME, RDW_INVALIDATE};
use windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentProcessId, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, SetFocus, VK_CONTROL, VK_SHIFT};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, DispatchMessageW, GetClassNameW, EnumWindows, GetAncestor, GetClientRect, GetCursorPos, GetDesktopWindow,
    GetForegroundWindow, GetMessageW, GetWindow, GetWindowLongPtrW, GetWindowRect, GetWindowThreadProcessId,
    InternalGetWindowText, IsHungAppWindow, IsIconic, IsWindow, IsWindowVisible, PostThreadMessageW,
    SendMessageTimeoutW, SetForegroundWindow, SetParent, SetWindowLongPtrW, SetWindowPos, ShowWindowAsync,
    TranslateMessage, EVENT_SYSTEM_MOVESIZEEND, EVENT_SYSTEM_MOVESIZESTART, GA_PARENT, GWLP_HWNDPARENT, GWL_EXSTYLE,
    GWL_STYLE, GW_CHILD, GW_HWNDNEXT, GW_OWNER, HWND_TOP, MSG, SMTO_ABORTIFHUNG, SWP_ASYNCWINDOWPOS, SWP_FRAMECHANGED, SWP_HIDEWINDOW,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SW_RESTORE, SW_SHOW,
    WA_ACTIVE, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WM_ACTIVATE, WM_NULL, WM_QUIT, WS_CAPTION, WS_CHILD, WS_CLIPSIBLINGS,
    WS_DLGFRAME, WS_EX_TOOLWINDOW, WS_POPUP, WS_THICKFRAME,
};

const MSG_TIMEOUT_MS: u32 = 500;
const OP_TIMEOUT: Duration = Duration::from_secs(3);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

#[inline]
fn h(v: i64) -> HWND {
    HWND(v as isize as *mut core::ffi::c_void)
}
#[inline]
fn raw(hwnd: HWND) -> i64 {
    hwnd.0 as isize as i64
}

/// Run `f` on a worker thread; `None` if it did not finish in time (the worker
/// is left behind — it is blocked on a hung foreign window, not on us).
fn with_timeout<T: Send + 'static>(timeout: Duration, f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(timeout).ok()
}

fn not_responding() -> RpcError {
    RpcError::with_kind("external", "The window is not responding")
}

fn is_window(v: i64) -> bool {
    unsafe { IsWindow(h(v)).as_bool() }
}

fn pid_of(v: i64) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(h(v), Some(&mut pid)) };
    pid
}

fn thread_of(v: i64) -> u32 {
    unsafe { GetWindowThreadProcessId(h(v), None) }
}

/// Window title without sending WM_GETTEXT (cannot hang on a hung app).
fn title_of(v: i64) -> String {
    let mut buf = [0u16; 512];
    let n = unsafe { InternalGetWindowText(h(v), &mut buf) };
    if n <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..n as usize])
}

fn process_name(pid: u32) -> String {
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut buf = [0u16; MAX_PATH as usize];
        let mut len = buf.len() as u32;
        let name = if QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok() {
            let full = String::from_utf16_lossy(&buf[..len as usize]);
            full.rsplit('\\').next().unwrap_or(&full).to_string()
        } else {
            String::new()
        };
        let _ = CloseHandle(handle);
        name
    }
}

fn style(v: i64) -> isize {
    unsafe { GetWindowLongPtrW(h(v), GWL_STYLE) }
}
fn exstyle(v: i64) -> isize {
    unsafe { GetWindowLongPtrW(h(v), GWL_EXSTYLE) }
}

/// Not hung and answers WM_NULL within the timeout.
fn responsive(v: i64) -> bool {
    unsafe {
        if IsHungAppWindow(h(v)).as_bool() {
            return false;
        }
        let r = SendMessageTimeoutW(h(v), WM_NULL, WPARAM(0), LPARAM(0), SMTO_ABORTIFHUNG, MSG_TIMEOUT_MS, None);
        r.0 != 0
    }
}

fn hotkey_held() -> bool {
    unsafe {
        (GetAsyncKeyState(VK_CONTROL.0 as i32) as u16 & 0x8000) != 0
            && (GetAsyncKeyState(VK_SHIFT.0 as i32) as u16 & 0x8000) != 0
    }
}

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

/// QuadFlow's main window (sent by the UI with every call that needs it).
static MAIN: AtomicI64 = AtomicI64::new(0);

fn set_main(p: &Value) {
    if let Ok(m) = hwnd_param(p, "main") {
        if is_window(m) {
            MAIN.store(m, Ordering::SeqCst);
        }
    }
}

fn main_hwnd() -> Option<i64> {
    let m = MAIN.load(Ordering::SeqCst);
    (m != 0 && is_window(m)).then_some(m)
}

fn quadflow_pid() -> u32 {
    main_hwnd().map(pid_of).unwrap_or(0)
}

fn host() -> &'static OnceLock<Host> {
    static H: OnceLock<Host> = OnceLock::new();
    &H
}

fn ui(name: &str, params: Value) {
    if let Some(h) = host().get() {
        h.ui(name, params);
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    hwnd: i64,
    pid: u32,
    title: String,
    process_name: String,
    /// Tile instance that owns the embed.
    instance_id: String,
    parent: i64,
    orig_style: isize,
    orig_exstyle: isize,
    /// 0 = desktop (a top-level window).
    orig_parent: i64,
    /// 0 = unowned.
    orig_owner: i64,
    orig_rect: [i32; 4],
    #[serde(skip)]
    hung: bool,
}

impl Entry {
    fn record(&self) -> Value {
        json!({
            "hwnd": self.hwnd,
            "pid": self.pid,
            "title": self.title,
            "processName": self.process_name,
            "instanceId": self.instance_id,
            "hung": self.hung,
        })
    }
}

fn table() -> &'static Mutex<HashMap<i64, Entry>> {
    static T: OnceLock<Mutex<HashMap<i64, Entry>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock() -> std::sync::MutexGuard<'static, HashMap<i64, Entry>> {
    table().lock().unwrap_or_else(|e| e.into_inner())
}

const STATE_FILE: &str = "embeds.json";

fn persist(map: &HashMap<i64, Entry>) {
    if map.is_empty() {
        let _ = std::fs::remove_file(STATE_FILE);
        return;
    }
    let list: Vec<&Entry> = map.values().collect();
    if let Ok(s) = serde_json::to_string_pretty(&list) {
        if let Err(e) = std::fs::write(STATE_FILE, s) {
            eprintln!("external-apps: could not persist {STATE_FILE}: {e}");
        }
    }
}

fn is_embedded(v: i64) -> bool {
    lock().contains_key(&v)
}

/// Owned by this sidecar's table, else `not_found`.
fn owned(p: &Value) -> Result<i64, RpcError> {
    let v = hwnd_param(p, "hwnd")?;
    if !is_embedded(v) {
        return Err(RpcError::with_kind("not_found", "This window is not embedded by External Apps"));
    }
    Ok(v)
}

// ---------------------------------------------------------------------------
// Startup: host handle, orphan restore, watchdog
// ---------------------------------------------------------------------------

static STARTED: AtomicBool = AtomicBool::new(false);

pub fn start(host_handle: Host) {
    let _ = host().set(host_handle);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    restore_orphans();
    std::thread::spawn(watchdog);
}

/// Windows left embedded by a crash of this process: restore them (pid guard
/// against a recycled HWND).
fn restore_orphans() {
    let Ok(s) = std::fs::read_to_string(STATE_FILE) else { return };
    let list: Vec<Entry> = serde_json::from_str(&s).unwrap_or_default();
    let _ = std::fs::remove_file(STATE_FILE);
    for e in list {
        if is_window(e.hwnd) && pid_of(e.hwnd) == e.pid {
            eprintln!("external-apps: restoring orphaned embedded window {} ({})", e.hwnd, e.title);
            restore(&e);
        }
    }
}

/// Every second: drop destroyed windows, report hung ones.
fn watchdog() {
    loop {
        std::thread::sleep(Duration::from_secs(1));
        let snapshot: Vec<(i64, bool)> = lock().values().map(|e| (e.hwnd, e.hung)).collect();
        if snapshot.is_empty() {
            continue;
        }
        let mut gone = Vec::new();
        let mut hung_changed = Vec::new();
        for (v, was_hung) in snapshot {
            if !is_window(v) {
                gone.push(v);
                continue;
            }
            let hung = unsafe { IsHungAppWindow(h(v)).as_bool() };
            if hung != was_hung {
                hung_changed.push((v, hung));
            }
        }
        if !gone.is_empty() || !hung_changed.is_empty() {
            let mut map = lock();
            for v in &gone {
                map.remove(v);
            }
            for (v, hung) in &hung_changed {
                if let Some(e) = map.get_mut(v) {
                    e.hung = *hung;
                }
            }
            persist(&map);
        }
        for v in gone {
            ui("windowGone", json!({ "hwnd": v }));
        }
        for (v, hung) in hung_changed {
            ui("windowHung", json!({ "hwnd": v, "hung": hung }));
        }
    }
}

// ---------------------------------------------------------------------------
// windows.list / focus
// ---------------------------------------------------------------------------

/// Visible, titled, top-level, not a tool window, not ours.
fn listable(v: i64, own: &[u32]) -> bool {
    unsafe {
        if !IsWindowVisible(h(v)).as_bool() {
            return false;
        }
    }
    if style(v) & WS_CHILD.0 as isize != 0 || exstyle(v) & WS_EX_TOOLWINDOW.0 as isize != 0 {
        return false;
    }
    if title_of(v).trim().is_empty() {
        return false;
    }
    !own.contains(&pid_of(v))
}

fn own_pids() -> Vec<u32> {
    let mut v = vec![unsafe { GetCurrentProcessId() }];
    let q = quadflow_pid();
    if q != 0 {
        v.push(q);
    }
    v
}

fn top_level_windows() -> Vec<i64> {
    unsafe extern "system" fn cb(hwnd: HWND, lp: LPARAM) -> BOOL {
        let out = &mut *(lp.0 as *mut Vec<i64>);
        out.push(raw(hwnd));
        BOOL(1)
    }
    let mut out: Vec<i64> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(cb), LPARAM(&mut out as *mut Vec<i64> as isize));
    }
    out
}

pub fn list_windows(p: &Value) -> RpcResult {
    set_main(p);
    let own = own_pids();
    let mut names: HashMap<u32, String> = HashMap::new();
    let mut out = Vec::new();
    for v in top_level_windows() {
        if !listable(v, &own) {
            continue;
        }
        let pid = pid_of(v);
        let name = names.entry(pid).or_insert_with(|| process_name(pid)).clone();
        // Other QuadFlow instances (installed + dev builds) are not offered either.
        if name.is_empty() || name.to_ascii_lowercase().starts_with("quadflow") {
            continue;
        }
        out.push(json!({ "hwnd": v, "pid": pid, "title": title_of(v), "processName": name }));
    }
    // Embedded windows are children now; list them too so the UI can show them.
    for e in lock().values() {
        out.push(json!({ "hwnd": e.hwnd, "pid": e.pid, "title": e.title, "processName": e.process_name, "embeddedBy": e.instance_id }));
    }
    out.sort_by(|a, b| {
        let k = |x: &Value, f: &str| x.get(f).and_then(Value::as_str).unwrap_or("").to_lowercase();
        k(a, "processName").cmp(&k(b, "processName")).then_with(|| k(a, "title").cmp(&k(b, "title")))
    });
    Ok(Value::Array(out))
}

/// Bring a top-level window to the foreground. A background process may not
/// call SetForegroundWindow freely, so we attach to the foreground thread's
/// input for the duration (bounded: the foreground app could be hung).
fn bring_to_front(v: i64) -> bool {
    with_timeout(OP_TIMEOUT, move || unsafe {
        let target = h(v);
        if IsIconic(target).as_bool() {
            let _ = ShowWindowAsync(target, SW_RESTORE);
        }
        let me = GetCurrentThreadId();
        let fg = GetForegroundWindow();
        let fg_thread = if fg.0.is_null() { 0 } else { GetWindowThreadProcessId(fg, None) };
        let attached = fg_thread != 0 && fg_thread != me && AttachThreadInput(me, fg_thread, true).as_bool();
        let _ = BringWindowToTop(target);
        let ok = SetForegroundWindow(target).as_bool();
        if attached {
            let _ = AttachThreadInput(me, fg_thread, false);
        }
        ok
    })
    .unwrap_or(false)
}

/// `windows.focus { hwnd }`: a listed (top-level, not ours) window.
pub fn focus_top_level(p: &Value) -> RpcResult {
    set_main(p);
    let v = hwnd_param(p, "hwnd")?;
    if is_embedded(v) {
        return focus_embedded(p);
    }
    if !is_window(v) || !listable(v, &own_pids()) {
        return Err(RpcError::with_kind("not_found", "Window not found"));
    }
    Ok(json!(bring_to_front(v)))
}

fn matching_window(process: &str, title: Option<&str>) -> Option<i64> {
    let own = own_pids();
    let title = title.map(str::to_lowercase);
    let mut fallback = None;
    for v in top_level_windows() {
        if !listable(v, &own) || !process_name(pid_of(v)).eq_ignore_ascii_case(process) {
            continue;
        }
        match &title {
            Some(t) if !title_of(v).to_lowercase().contains(t.as_str()) => fallback = fallback.or(Some(v)),
            _ => return Some(v),
        }
    }
    fallback
}

/// `windows.focusMatch { processName, windowTitle? }` (Window Link): the
/// process's window whose title contains `windowTitle`, else any of its windows.
pub fn focus_match(p: &Value) -> RpcResult {
    set_main(p);
    let process = str_param(p, "processName").ok_or_else(|| RpcError::invalid_params("processName is required"))?;
    let title = str_param(p, "windowTitle");
    Ok(match matching_window(&process, title.as_deref()) {
        Some(v) => json!({ "found": true, "focused": bring_to_front(v), "hwnd": v }),
        None => json!({ "found": false, "focused": false }),
    })
}

/// First listable window of `pid` (launcher focus).
fn window_of_pid(pid: u32) -> Option<i64> {
    let own = own_pids();
    top_level_windows().into_iter().find(|v| pid_of(*v) == pid && listable(*v, &own))
}

pub fn focus_pid(pid: u32) -> bool {
    match window_of_pid(pid) {
        Some(v) => bring_to_front(v),
        None => false,
    }
}

/// `apps.findWindow { pid, processName?, timeoutMs? }`: wait for the launched
/// process's main window (falls back to a window of the same executable, for
/// launchers that hand off to another process).
pub fn find_window_for_pid(p: &Value) -> RpcResult {
    set_main(p);
    let pid = p.get("pid").and_then(Value::as_u64).ok_or_else(|| RpcError::invalid_params("pid is required"))? as u32;
    let process = str_param(p, "processName");
    let timeout = Duration::from_millis(p.get("timeoutMs").and_then(Value::as_u64).unwrap_or(10_000).min(60_000));
    let before: Vec<i64> = p
        .get("exclude")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_default();
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(v) = window_of_pid(pid) {
            return Ok(json!({ "hwnd": v, "pid": pid, "title": title_of(v), "processName": process_name(pid) }));
        }
        if let Some(name) = &process {
            let own = own_pids();
            if let Some(v) = top_level_windows()
                .into_iter()
                .find(|v| !before.contains(v) && listable(*v, &own) && process_name(pid_of(*v)).eq_ignore_ascii_case(name))
            {
                let wpid = pid_of(v);
                return Ok(json!({ "hwnd": v, "pid": wpid, "title": title_of(v), "processName": process_name(wpid) }));
            }
        }
        if Instant::now() >= deadline {
            return Ok(Value::Null);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

// ---------------------------------------------------------------------------
// embed.*
// ---------------------------------------------------------------------------

fn class_of(v: i64) -> String {
    let mut buf = [0u16; 128];
    let n = unsafe { GetClassNameW(h(v), &mut buf) };
    if n <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..n as usize])
}

/// QuadFlow's webview host window (`WRY_WEBVIEW`, a sibling of the embedded
/// window) is created without `WS_CLIPSIBLINGS`, so it paints over every
/// sibling above it and the embedded window stays invisible (it still gets
/// input). Add the style once. The host does this itself since plugin API 1.4
/// (`ensure_webview_clip_siblings`); kept for older hosts.
fn ensure_clip_siblings(main: i64) {
    let mut c = unsafe { GetWindow(h(main), GW_CHILD) }.map(raw).unwrap_or(0);
    while c != 0 {
        if class_of(c) == "WRY_WEBVIEW" && style(c) & WS_CLIPSIBLINGS.0 as isize == 0 {
            let st = style(c);
            let _ = with_timeout(OP_TIMEOUT, move || unsafe {
                SetWindowLongPtrW(h(c), GWL_STYLE, st | WS_CLIPSIBLINGS.0 as isize);
            });
        }
        c = unsafe { GetWindow(h(c), GW_HWNDNEXT) }.map(raw).unwrap_or(0);
    }
}

pub fn attach(p: &Value) -> RpcResult {
    set_main(p);
    let v = hwnd_param(p, "hwnd")?;
    let instance_id = str_param(p, "instanceId").ok_or_else(|| RpcError::invalid_params("instanceId is required"))?;
    let main = main_hwnd().ok_or_else(|| RpcError::invalid_params("main (QuadFlow's window handle) is required"))?;

    if let Some(e) = lock().get(&v) {
        if e.instance_id == instance_id {
            return Ok(e.record());
        }
        return Err(RpcError::with_kind("invalid_input", "This window is already embedded in another tile"));
    }
    if !is_window(v) {
        return Err(RpcError::with_kind("not_found", "The window no longer exists"));
    }
    let pid = pid_of(v);
    if own_pids().contains(&pid) || v == main {
        return Err(RpcError::with_kind("invalid_input", "QuadFlow's own windows cannot be embedded"));
    }
    if style(v) & WS_CHILD.0 as isize != 0 {
        return Err(RpcError::with_kind("invalid_input", "Only top-level windows can be embedded"));
    }
    if !responsive(v) {
        return Err(not_responding());
    }
    ensure_clip_siblings(main);

    let mut rect = RECT::default();
    unsafe { GetWindowRect(h(v), &mut rect) }.map_err(|e| RpcError::new(e.to_string()))?;
    let orig_style = style(v);
    let orig_exstyle = exstyle(v);
    let orig_owner = unsafe { GetWindow(h(v), GW_OWNER) }.map(raw).unwrap_or(0);
    let parent = raw(unsafe { GetAncestor(h(v), GA_PARENT) });
    let desktop = raw(unsafe { GetDesktopWindow() });
    let orig_parent = if parent == desktop { 0 } else { parent };

    let entry = Entry {
        hwnd: v,
        pid,
        title: title_of(v),
        process_name: process_name(pid),
        instance_id,
        parent: main,
        orig_style,
        orig_exstyle,
        orig_parent,
        orig_owner,
        orig_rect: [rect.left, rect.top, rect.right, rect.bottom],
        hung: false,
    };
    // In the table (and on disk) before mutating, so a crash mid-way is restored.
    {
        let mut map = lock();
        map.insert(v, entry.clone());
        persist(&map);
    }

    let done = with_timeout(OP_TIMEOUT, move || unsafe {
        let target = h(v);
        let clear = (WS_POPUP.0 | WS_CAPTION.0 | WS_THICKFRAME.0 | WS_DLGFRAME.0) as isize;
        SetWindowLongPtrW(target, GWL_STYLE, (orig_style & !clear) | WS_CHILD.0 as isize);
        if SetParent(target, h(main)).is_err() {
            SetWindowLongPtrW(target, GWL_STYLE, orig_style);
            return Err(());
        }
        // Start hidden; the tile shows it once it knows its bounds.
        let _ = SetWindowPos(
            target,
            HWND_TOP,
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOSIZE | SWP_NOMOVE | SWP_HIDEWINDOW | SWP_ASYNCWINDOWPOS,
        );
        Ok(())
    });
    match done {
        Some(Ok(())) => Ok(entry.record()),
        Some(Err(())) => {
            let mut map = lock();
            map.remove(&v);
            persist(&map);
            Err(RpcError::with_kind(
                "permission_denied",
                "Failed to embed the window (access denied). Windows of an elevated (administrator) process can't be \
                 embedded unless QuadFlow also runs elevated.",
            ))
        }
        None => {
            // Stuck half-way: try to put it back in the background, keep the entry
            // so detach/exit retries the restore.
            let e = entry.clone();
            std::thread::spawn(move || restore(&e));
            let mut map = lock();
            map.remove(&v);
            persist(&map);
            Err(not_responding())
        }
    }
}

/// Put a window back exactly as it was: parent, owner, styles, rect, shown.
fn restore(e: &Entry) {
    let e = e.clone();
    let v = e.hwnd;
    let ok = with_timeout(OP_TIMEOUT, move || unsafe {
        let target = h(v);
        if !IsWindow(target).as_bool() {
            return;
        }
        let parent = if e.orig_parent != 0 && IsWindow(h(e.orig_parent)).as_bool() { h(e.orig_parent) } else { HWND::default() };
        let _ = SetParent(target, parent);
        SetWindowLongPtrW(target, GWL_STYLE, e.orig_style);
        SetWindowLongPtrW(target, GWL_EXSTYLE, e.orig_exstyle);
        if parent.0.is_null() {
            // Owner is a separate relationship for top-level windows.
            let owner = if e.orig_owner != 0 && IsWindow(h(e.orig_owner)).as_bool() { e.orig_owner } else { 0 };
            SetWindowLongPtrW(target, GWLP_HWNDPARENT, owner as isize);
        }
        let [l, t, r, b] = e.orig_rect;
        let _ = SetWindowPos(
            target,
            HWND::default(),
            l,
            t,
            (r - l).max(0),
            (b - t).max(0),
            SWP_FRAMECHANGED | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_ASYNCWINDOWPOS,
        );
        let _ = ShowWindowAsync(target, SW_SHOW);
    });
    if ok.is_none() {
        eprintln!("external-apps: restoring window {v} timed out (not responding)");
    }
}

pub fn detach(p: &Value) -> RpcResult {
    set_main(p);
    let v = owned(p)?;
    let entry = {
        let mut map = lock();
        let e = map.remove(&v);
        persist(&map);
        e
    };
    if let Some(e) = entry {
        restore(&e);
        // Hand it back in front of QuadFlow.
        if p.get("focus").and_then(Value::as_bool).unwrap_or(true) {
            let _ = bring_to_front(v);
        }
    }
    Ok(Value::Null)
}

pub fn detach_all() {
    let entries: Vec<Entry> = {
        let mut map = lock();
        let all = map.drain().map(|(_, e)| e).collect();
        persist(&map);
        all
    };
    // Restores run in parallel so one hung window cannot delay the others.
    let workers: Vec<_> = entries.into_iter().map(|e| std::thread::spawn(move || restore(&e))).collect();
    for w in workers {
        let _ = w.join();
    }
}

/// `embed.bounds { hwnd, x, y, width, height, visible }` — main-window client
/// coordinates, physical px. Asynchronous: never waits for the foreign app.
pub fn set_bounds(p: &Value) -> RpcResult {
    set_main(p);
    let v = owned(p)?;
    let n = |k: &str| p.get(k).and_then(Value::as_f64).unwrap_or(0.0).round() as i32;
    let visible = p.get("visible").and_then(Value::as_bool).unwrap_or(true);
    let (x, y, w, hh) = (n("x"), n("y"), n("width").max(0), n("height").max(0));
    let show = visible && w > 0 && hh > 0;
    unsafe {
        let mut flags = SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS | SWP_NOOWNERZORDER;
        flags |= if show { SWP_SHOWWINDOW } else { SWP_HIDEWINDOW | SWP_NOMOVE | SWP_NOSIZE };
        // Keep it above the webview child while shown.
        let after = if show { HWND_TOP } else { HWND::default() };
        if !show {
            flags |= SWP_NOZORDER;
        }
        SetWindowPos(h(v), after, x, y, w, hh, flags).map_err(|e| RpcError::new(e.to_string()))?;
        if show {
            // Queue a full repaint (posted, never waits): a reparented window does not
            // always repaint itself after being hidden and moved.
            let _ = RedrawWindow(h(v), None, None, RDW_INVALIDATE | RDW_ERASE | RDW_FRAME | RDW_ALLCHILDREN);
        }
    }
    Ok(Value::Null)
}

pub fn focus_embedded(p: &Value) -> RpcResult {
    set_main(p);
    let v = owned(p)?;
    let ok = with_timeout(OP_TIMEOUT, move || unsafe {
        let target = h(v);
        let _ = SendMessageTimeoutW(target, WM_ACTIVATE, WPARAM(WA_ACTIVE as usize), LPARAM(0), SMTO_ABORTIFHUNG, MSG_TIMEOUT_MS, None);
        let me = GetCurrentThreadId();
        let t = thread_of(v);
        let attached = t != 0 && AttachThreadInput(me, t, true).as_bool();
        let r = SetFocus(target).is_ok();
        if attached {
            let _ = AttachThreadInput(me, t, false);
        }
        r
    });
    match ok {
        Some(r) => Ok(json!(r)),
        None => Err(not_responding()),
    }
}

pub fn list_embedded() -> RpcResult {
    Ok(Value::Array(lock().values().map(Entry::record).collect()))
}

// ---------------------------------------------------------------------------
// drag.* — drop a foreign window onto QuadFlow to embed it
// ---------------------------------------------------------------------------

static MONITOR_THREAD: AtomicU32 = AtomicU32::new(0);
static MONITOR_RUNNING: AtomicBool = AtomicBool::new(false);
static REQUIRE_HOTKEY: AtomicBool = AtomicBool::new(true);
static DRAGGING: AtomicI64 = AtomicI64::new(0);

/// Cursor (screen px) inside QuadFlow's main client area?
fn cursor_in_main(pt: POINT) -> bool {
    let Some(m) = main_hwnd() else { return false };
    unsafe {
        let mut r = RECT::default();
        if GetClientRect(h(m), &mut r).is_err() {
            return false;
        }
        let mut origin = POINT { x: 0, y: 0 };
        let _ = ClientToScreen(h(m), &mut origin);
        pt.x >= origin.x && pt.y >= origin.y && pt.x < origin.x + r.right && pt.y < origin.y + r.bottom
    }
}

unsafe extern "system" fn win_event(_hook: HWINEVENTHOOK, event: u32, hwnd: HWND, id_object: i32, _c: i32, _t: u32, _time: u32) {
    if id_object != 0 {
        return; // OBJID_WINDOW only
    }
    let v = raw(hwnd);
    if event == EVENT_SYSTEM_MOVESIZESTART {
        if is_window(v) && listable(v, &own_pids()) && !is_embedded(v) {
            DRAGGING.store(v, Ordering::SeqCst);
        }
    } else if event == EVENT_SYSTEM_MOVESIZEEND {
        if DRAGGING.swap(0, Ordering::SeqCst) != v {
            return;
        }
        let mut pt = POINT::default();
        let _ = GetCursorPos(&mut pt);
        let hotkey = hotkey_held();
        if cursor_in_main(pt) && (hotkey || !REQUIRE_HOTKEY.load(Ordering::SeqCst)) {
            let pid = pid_of(v);
            ui("drop", json!({ "hwnd": v, "pid": pid, "title": title_of(v), "processName": process_name(pid) }));
        }
    }
}

fn monitor_thread() {
    unsafe {
        MONITOR_THREAD.store(GetCurrentThreadId(), Ordering::SeqCst);
        let hook = SetWinEventHook(
            EVENT_SYSTEM_MOVESIZESTART,
            EVENT_SYSTEM_MOVESIZEEND,
            HMODULE::default(),
            Some(win_event),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        );
        if hook.is_invalid() {
            eprintln!("external-apps: SetWinEventHook failed; drag-to-embed unavailable");
        } else {
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            let _ = UnhookWinEvent(hook);
        }
        MONITOR_THREAD.store(0, Ordering::SeqCst);
        MONITOR_RUNNING.store(false, Ordering::SeqCst);
    }
}

pub fn drag_start(p: &Value) -> RpcResult {
    set_main(p);
    REQUIRE_HOTKEY.store(p.get("requireHotkey").and_then(Value::as_bool).unwrap_or(true), Ordering::SeqCst);
    if !MONITOR_RUNNING.swap(true, Ordering::SeqCst) {
        std::thread::spawn(monitor_thread);
    }
    Ok(Value::Null)
}

pub fn drag_stop() -> RpcResult {
    if MONITOR_RUNNING.swap(false, Ordering::SeqCst) {
        let t = MONITOR_THREAD.load(Ordering::SeqCst);
        if t != 0 {
            unsafe {
                let _ = PostThreadMessageW(t, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
    }
    Ok(Value::Null)
}
