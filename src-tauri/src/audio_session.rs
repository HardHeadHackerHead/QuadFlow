//! Relabel our Windows audio sessions so the Volume Mixer shows "QuadFlow"
//! instead of "Microsoft Edge WebView2".
//!
//! WebView2 spawns child processes that own their own audio sessions. We walk
//! the session enumerator on the default render endpoint, match sessions whose
//! PID belongs to our process tree, and call SetDisplayName. A background
//! thread re-runs this every 30s so sessions created after startup (audio
//! starts lazily) also get renamed.
//!
//! Also sets an explicit AppUserModelID so the taskbar groups our windows
//! under a single entry rather than letting Windows guess from the exe path.

#![cfg(target_os = "windows")]

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use windows::core::{Interface, HSTRING, PCWSTR};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
    MMDeviceEnumerator,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;

const DISPLAY_NAME: &str = "QuadFlow";

/// Call once, very early in `run()`, before any windows are created so the
/// AppUserModelID takes effect for taskbar grouping. Spawns a background
/// renamer thread that manages its own COM apartment.
pub fn start() {
    unsafe {
        let id = HSTRING::from(quadflow_core::Profile::current().app_identifier());
        if let Err(e) = SetCurrentProcessExplicitAppUserModelID(PCWSTR(id.as_ptr())) {
            log::warn!("audio_session: SetCurrentProcessExplicitAppUserModelID failed: {e:?}");
        }
    }

    let _ = std::thread::Builder::new()
        .name("audio-session-renamer".into())
        .spawn(|| {
            // MTA so we don't collide with the main thread's apartment.
            let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            if hr.is_err() {
                log::warn!("audio_session: CoInitializeEx failed: {hr:?}");
                return;
            }
            loop {
                if let Err(e) = rename_sessions() {
                    log::debug!("audio_session: rename pass failed: {e:?}");
                }
                std::thread::sleep(Duration::from_secs(30));
            }
        });
}

fn rename_sessions() -> windows::core::Result<()> {
    let our_pid = unsafe { GetCurrentProcessId() };
    let family = process_family(our_pid);

    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
        let mgr: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None)?;
        let sessions = mgr.GetSessionEnumerator()?;
        let count = sessions.GetCount()?;

        let display = HSTRING::from(DISPLAY_NAME);
        for i in 0..count {
            let ctrl = sessions.GetSession(i)?;
            let ctrl2: IAudioSessionControl2 = ctrl.cast()?;
            let pid = ctrl2.GetProcessId().unwrap_or(0);
            if pid != 0 && family.contains(&pid) {
                let _ = ctrl.SetDisplayName(PCWSTR(display.as_ptr()), std::ptr::null());
            }
        }
    }
    Ok(())
}

/// Compute our PID + all transitive descendants via the process snapshot.
/// WebView2 audio comes from a child process, so we have to include the tree.
fn process_family(root_pid: u32) -> HashSet<u32> {
    let mut parents: HashMap<u32, u32> = HashMap::new();
    unsafe {
        let snap = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(h) => h,
            Err(_) => {
                let mut only = HashSet::new();
                only.insert(root_pid);
                return only;
            }
        };
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                parents.insert(entry.th32ProcessID, entry.th32ParentProcessID);
                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }

    let mut family = HashSet::new();
    family.insert(root_pid);
    // Fixed-point: keep pulling in children of anything already in the set.
    let mut changed = true;
    while changed {
        changed = false;
        for (&pid, &parent) in &parents {
            if family.contains(&parent) && family.insert(pid) {
                changed = true;
            }
        }
    }
    family
}
