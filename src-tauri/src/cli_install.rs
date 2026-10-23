//! Install / uninstall the `quadflow` CLI on the user's PATH.
//!
//! On Windows we ship a single binary that dispatches to the GUI when run
//! with no args and the CLI otherwise. This module manages a per-user PATH
//! entry pointing at the directory that contains that binary so users can
//! invoke `quadflow` from any new terminal.
//!
//! Strategy:
//!   - Read HKCU\Environment\Path (REG_EXPAND_SZ-aware).
//!   - Add or remove the bin directory.
//!   - Write back, then broadcast WM_SETTINGCHANGE so newly-spawned
//!     processes (Explorer, new shells) pick up the change without logout.
//!
//! The per-user hive does NOT need elevation. We never touch the system
//! PATH (HKLM\...\Environment\Path) — that requires admin and would step
//! on multi-user installs.
//!
//! macOS / Linux: not implemented yet. The Tauri bundle there is a `.app`
//! or AppImage; the conventional approach is to drop a shim into
//! /usr/local/bin or ~/.local/bin. Stubbed out below.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Current state of the CLI-on-PATH installation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliInstallStatus {
    /// Both halves of install are in place: bin dir is on PATH AND the
    /// `quadflow.cmd` (or unix shim) exists in bin_dir.
    pub installed: bool,
    /// Bin dir IS on PATH (subset of `installed`).
    pub bin_on_path: bool,
    /// The shim file (`quadflow.cmd` on Windows, `quadflow` on Unix) exists.
    pub shim_present: bool,
    /// Path to the shim file (for display in the UI).
    pub shim_path: String,
    /// True if `quadflow` actually resolves on PATH right now (regardless of
    /// whether OUR bin_dir is registered — the user may have a different
    /// quadflow on PATH from another install).
    pub on_path: bool,
    /// Resolved exe path (the GUI binary, which is also the CLI entry point).
    pub exe_path: String,
    /// Path that `where quadflow` returns, if any. May differ from exe_path
    /// when there's another `quadflow` higher in PATH.
    pub resolved_exe_on_path: Option<String>,
    /// Directory that would be (or is) added to PATH.
    pub bin_dir: String,
    /// Output of `quadflow --version` from PATH (None if not on PATH or call fails).
    pub version_on_path: Option<String>,
    /// This running app's version (from CARGO_PKG_VERSION at compile time).
    pub app_version: String,
    /// True iff the on-PATH version matches the running app's version.
    pub version_match: bool,
    /// True if the platform supports automatic installation.
    pub supported: bool,
    /// Human-readable note for the UI (e.g. "Restart shells to pick up").
    pub message: Option<String>,
}

/// Lookup `quadflow` via PATH (where on Windows, which on Unix). Returns
/// the resolved absolute path if any.
fn resolve_quadflow_on_path() -> Option<String> {
    let cmd = if cfg!(windows) { "where" } else { "which" };
    let out = std::process::Command::new(cmd).arg("quadflow").output().ok()?;
    if !out.status.success() { return None; }
    let s = String::from_utf8_lossy(&out.stdout);
    // `where` may return multiple lines; first wins.
    s.lines().next().map(|l| l.trim().to_string()).filter(|l| !l.is_empty())
}

/// Run `quadflow --version` (whichever is on PATH) and return its trimmed stdout.
fn version_on_path() -> Option<String> {
    let mut cmd = if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "quadflow --version"]);
        c
    } else {
        let mut c = std::process::Command::new("quadflow");
        c.arg("--version");
        c
    };
    let out = cmd.output().ok()?;
    if !out.status.success() { return None; }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// Extract the bare X.Y.Z from `--version` output. clap's default --version
/// emits `quadflow 1.0.0`, but accept anything containing a semver-ish chunk.
fn parse_version(s: &str) -> Option<String> {
    let parts: Vec<&str> = s.split_whitespace().collect();
    for p in parts.iter().rev() {
        let bare: &str = p.split('-').next().unwrap_or(p);
        let segs: Vec<&str> = bare.split('.').collect();
        if segs.len() == 3 && segs.iter().all(|s| s.parse::<u32>().is_ok()) {
            return Some((*p).to_string());
        }
    }
    None
}

/// App version baked in at compile time.
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Decorate a platform `status()` with version + on-PATH info.
fn enrich_with_version(mut s: CliInstallStatus) -> CliInstallStatus {
    let resolved = resolve_quadflow_on_path();
    let on_path = resolved.is_some();
    let raw_version = if on_path { version_on_path() } else { None };
    let bare_version = raw_version.as_deref().and_then(parse_version);
    let version_match = bare_version.as_deref() == Some(APP_VERSION);
    s.on_path = on_path;
    s.resolved_exe_on_path = resolved;
    s.version_on_path = raw_version;
    s.app_version = APP_VERSION.to_string();
    s.version_match = version_match;
    s
}

fn current_exe_dir() -> Result<(PathBuf, PathBuf), String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe failed: {}", e))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "exe has no parent directory".to_string())?
        .to_path_buf();
    Ok((exe, dir))
}

#[cfg(windows)]
mod platform {
    use super::*;
    use winreg::enums::*;
    use winreg::types::FromRegValue;
    use winreg::{RegKey, RegValue};

    /// Read HKCU\Environment\Path preserving its original type (REG_SZ vs
    /// REG_EXPAND_SZ). Returns ("", REG_EXPAND_SZ) if the value is missing.
    fn read_user_path() -> Result<(String, RegType), String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let env = hkcu
            .open_subkey_with_flags("Environment", KEY_READ)
            .map_err(|e| format!("open HKCU\\Environment: {}", e))?;
        match env.get_raw_value("Path") {
            Ok(rv) => {
                let s = String::from_reg_value(&rv).map_err(|e| format!("decode Path: {}", e))?;
                let vt = rv.vtype.clone();
                Ok((s, vt))
            }
            Err(_) => Ok((String::new(), RegType::REG_EXPAND_SZ)),
        }
    }

    fn write_user_path(value: &str, vtype: RegType) -> Result<(), String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (env, _) = hkcu
            .create_subkey("Environment")
            .map_err(|e| format!("open/create HKCU\\Environment: {}", e))?;
        // Re-encode as UTF-16LE the way Windows expects.
        let utf16: Vec<u8> = value
            .encode_utf16()
            .chain(std::iter::once(0))
            .flat_map(|w| w.to_le_bytes())
            .collect();
        // Preserve REG_SZ vs REG_EXPAND_SZ; coerce anything weird to EXPAND_SZ
        // since PATH typically wants %VAR% expansion.
        let preserved = match vtype {
            RegType::REG_SZ => RegType::REG_SZ,
            _ => RegType::REG_EXPAND_SZ,
        };
        let rv = RegValue {
            bytes: utf16,
            vtype: preserved,
        };
        env.set_raw_value("Path", &rv)
            .map_err(|e| format!("write HKCU\\Environment\\Path: {}", e))
    }

    /// Tell every top-level window that the environment changed so newly
    /// spawned processes (new cmd/PowerShell tabs, Explorer file dialogs)
    /// see the updated PATH without requiring logout. Existing processes
    /// keep their old environment block — that's a Windows constant, not
    /// something we can fix.
    fn broadcast_env_change() {
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::{LPARAM, WPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{
            SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
        };
        let env: Vec<u16> = "Environment\0".encode_utf16().collect();
        unsafe {
            let _ = SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                WPARAM(0),
                LPARAM(env.as_ptr() as isize),
                SMTO_ABORTIFHUNG,
                5000,
                None,
            );
        }
        // Drop env after the call so the buffer outlives SendMessage.
        let _ = env;
        // PCWSTR is unused here but keeps the import linked on minimal feature sets.
        let _: Option<PCWSTR> = None;
    }

    fn split_path(s: &str) -> Vec<String> {
        s.split(';')
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect()
    }

    fn paths_equal(a: &str, b: &str) -> bool {
        // Windows paths are case-insensitive and tolerant of trailing slashes.
        let norm = |p: &str| {
            p.trim_end_matches(['\\', '/'])
                .to_ascii_lowercase()
                .replace('/', "\\")
        };
        norm(a) == norm(b)
    }

    pub fn status() -> Result<CliInstallStatus, String> {
        let (exe, dir) = current_exe_dir()?;
        let dir_str = dir.to_string_lossy().to_string();
        let (current, _) = read_user_path()?;
        let bin_on_path = split_path(&current).iter().any(|p| paths_equal(p, &dir_str));
        let cmd_shim = dir.join("quadflow.cmd");
        let sh_shim = dir.join("quadflow");
        let shim_present = cmd_shim.exists() && sh_shim.exists();
        // For display, prefer the .cmd path (the primary on Windows); if
        // somehow only the sh shim exists, show that instead.
        let shim_path = if cmd_shim.exists() { cmd_shim } else { sh_shim }
            .to_string_lossy().to_string();
        Ok(CliInstallStatus {
            installed: bin_on_path && shim_present,
            bin_on_path,
            shim_present,
            shim_path,
            on_path: false,                  // filled by enrich_with_version
            exe_path: exe.to_string_lossy().to_string(),
            resolved_exe_on_path: None,      // filled by enrich_with_version
            bin_dir: dir_str,
            version_on_path: None,           // filled by enrich_with_version
            app_version: String::new(),      // filled by enrich_with_version
            version_match: false,            // filled by enrich_with_version
            supported: true,
            message: None,
        })
    }

    /// Write `quadflow.cmd` (cmd/PowerShell) AND `quadflow` (sh script
    /// for Git Bash / MSYS / WSL / Cygwin) shims that both call the actual
    /// app exe. cmd/PowerShell find `.cmd` via PATHEXT; sh-style shells
    /// look for an extensionless executable in PATH and won't auto-run
    /// `.cmd` files — they need the no-extension shim.
    /// Returns the .cmd path (primary, for display).
    fn write_shim(bin_dir: &std::path::Path, exe_path: &std::path::Path) -> Result<std::path::PathBuf, String> {
        let cmd_shim = bin_dir.join("quadflow.cmd");
        let sh_shim = bin_dir.join("quadflow");
        let exe_str = exe_path.display().to_string();
        // Forward slashes work in both cmd and bash on Windows when the
        // path is quoted. Git Bash / MSYS will pass the Windows path
        // through to CreateProcess as-is.
        let exe_fwd = exe_str.replace('\\', "/");

        // .cmd body — relative to its own location if exe is a sibling.
        let cmd_body = if exe_path.parent() == Some(bin_dir) {
            let exe_name = exe_path.file_name().and_then(|n| n.to_str()).unwrap_or("quadflow-tauri.exe");
            format!("@echo off\r\n\"%~dp0{exe_name}\" %*\r\n")
        } else {
            format!("@echo off\r\n\"{exe_str}\" %*\r\n")
        };
        std::fs::write(&cmd_shim, cmd_body)
            .map_err(|e| format!("write {}: {}", cmd_shim.display(), e))?;

        // sh body. exec replaces the shell process so signals + exit codes
        // pass through cleanly. Quoting the path handles spaces (the user's
        // dir contains "Quads Lab").
        let sh_body = format!(
            "#!/usr/bin/env sh\n\
             # Auto-generated by QuadFlow CLI install. Do not edit.\n\
             exec \"{exe_fwd}\" \"$@\"\n"
        );
        std::fs::write(&sh_shim, sh_body)
            .map_err(|e| format!("write {}: {}", sh_shim.display(), e))?;

        // Mark the sh script executable. On NTFS this is a no-op (Git Bash
        // doesn't honor +x bits) — but the shim still runs because Git
        // Bash will execute any extensionless file via /bin/sh if the
        // shebang says so. Leave the call out to avoid Windows-only API.

        Ok(cmd_shim)
    }

    fn remove_shim(bin_dir: &std::path::Path) {
        for name in &["quadflow.cmd", "quadflow"] {
            let p = bin_dir.join(name);
            if p.exists() { let _ = std::fs::remove_file(p); }
        }
    }

    pub fn install() -> Result<CliInstallStatus, String> {
        let (exe, dir) = current_exe_dir()?;
        let dir_str = dir.to_string_lossy().to_string();
        // 1. Drop the shim FIRST. If write fails we error out before
        //    polluting PATH.
        let shim = write_shim(&dir, &exe)?;
        // 2. Add bin_dir to user PATH if not already there.
        let (current, vtype) = read_user_path()?;
        let mut entries = split_path(&current);
        let already = entries.iter().any(|p| paths_equal(p, &dir_str));
        if !already {
            entries.push(dir_str.clone());
            let joined = entries.join(";");
            write_user_path(&joined, vtype)?;
            broadcast_env_change();
        }
        let mut s = status()?;
        s.message = Some(format!(
            "Wrote {shim_name} (+ sh shim for Git Bash/WSL) and added bin dir to PATH. \
             Open a new terminal — works in cmd, PowerShell, AND Git Bash.",
            shim_name = shim.file_name().and_then(|n| n.to_str()).unwrap_or("quadflow.cmd")
        ));
        Ok(s)
    }

    /// Variant of install that REMOVES our bin_dir from PATH if it's
    /// already there (anywhere) and re-adds it at the FRONT, then
    /// rewrites the shims. Use case: user has a published QuadFlow on
    /// PATH and is now testing a dev build — they want the dev build's
    /// `quadflow` to win until they uninstall it. Or vice versa.
    pub fn install_force_priority() -> Result<CliInstallStatus, String> {
        let (exe, dir) = current_exe_dir()?;
        let dir_str = dir.to_string_lossy().to_string();
        let shim = write_shim(&dir, &exe)?;
        let (current, vtype) = read_user_path()?;
        let mut entries: Vec<String> = split_path(&current)
            .into_iter()
            .filter(|p| !paths_equal(p, &dir_str))
            .collect();
        entries.insert(0, dir_str.clone());
        let joined = entries.join(";");
        write_user_path(&joined, vtype)?;
        broadcast_env_change();
        let mut s = status()?;
        s.message = Some(format!(
            "Promoted {} to the FRONT of your user PATH so this build's `quadflow` wins. \
             Open a fresh terminal to confirm.",
            shim.file_name().and_then(|n| n.to_str()).unwrap_or("quadflow.cmd")
        ));
        Ok(s)
    }

    pub fn uninstall() -> Result<CliInstallStatus, String> {
        let (_exe, dir) = current_exe_dir()?;
        let dir_str = dir.to_string_lossy().to_string();
        // 1. Remove the shim — if other apps still need this dir on PATH
        //    (unlikely, it's our build dir, but be safe), this leaves the
        //    PATH entry alone.
        remove_shim(&dir);
        // 2. Remove bin_dir from PATH.
        let (current, vtype) = read_user_path()?;
        let entries = split_path(&current);
        let filtered: Vec<String> = entries
            .into_iter()
            .filter(|p| !paths_equal(p, &dir_str))
            .collect();
        let joined = filtered.join(";");
        write_user_path(&joined, vtype)?;
        broadcast_env_change();
        let mut s = status()?;
        s.message = Some("Removed quadflow.cmd shim and PATH entry.".to_string());
        Ok(s)
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;

    pub fn status() -> Result<CliInstallStatus, String> {
        let (exe, dir) = current_exe_dir()?;
        Ok(CliInstallStatus {
            installed: false,
            bin_on_path: false,
            shim_present: false,
            shim_path: dir.join("quadflow").to_string_lossy().to_string(),
            on_path: false,
            exe_path: exe.to_string_lossy().to_string(),
            resolved_exe_on_path: None,
            bin_dir: dir.to_string_lossy().to_string(),
            version_on_path: None,
            app_version: String::new(),
            version_match: false,
            supported: false,
            message: Some(
                "Automatic PATH install is Windows-only for now. Add the bin directory to your shell rc manually."
                    .to_string(),
            ),
        })
    }

    pub fn install() -> Result<CliInstallStatus, String> {
        Err("Automatic PATH install is not supported on this platform yet.".to_string())
    }

    pub fn install_force_priority() -> Result<CliInstallStatus, String> {
        Err("Automatic PATH install is not supported on this platform yet.".to_string())
    }

    pub fn uninstall() -> Result<CliInstallStatus, String> {
        Err("Automatic PATH install is not supported on this platform yet.".to_string())
    }
}

/// These touch PATH / the registry and run `quadflow --version`: keep them off
/// the main thread (sync commands block all IPC while they run).
async fn off_main<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| format!("task failed: {e}"))?
}

#[tauri::command]
pub async fn cli_install_status() -> Result<CliInstallStatus, String> {
    off_main(|| platform::status().map(enrich_with_version)).await
}

#[tauri::command]
pub async fn cli_install_to_path() -> Result<CliInstallStatus, String> {
    off_main(|| platform::install().map(enrich_with_version)).await
}

/// Same as install but PROMOTES our bin_dir to the front of PATH so this
/// build's `quadflow` shadows whichever was previously resolving. Use to
/// switch between dev / prod / multiple side-by-side QuadFlow installs.
#[tauri::command]
pub async fn cli_switch_to_this_build() -> Result<CliInstallStatus, String> {
    off_main(|| platform::install_force_priority().map(enrich_with_version)).await
}

#[tauri::command]
pub async fn cli_uninstall_from_path() -> Result<CliInstallStatus, String> {
    off_main(|| platform::uninstall().map(enrich_with_version)).await
}
